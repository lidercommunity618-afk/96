import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Signal, SignalDirection, SignalOutcome, Timeframe, Candle } from '@/types/domain';
import { TIMEFRAME_SECONDS } from '@/data/symbols';
// Аудит (синхронизация с демо-счётом): useDemoAccountStore теперь —
// единственный источник исхода, который видит пользователь ("ИСТОРИЯ
// СИГНАЛОВ" + винрейт в StatusBar), для любого сигнала, по которому была
// реально открыта демо-сделка. Раньше эти два стора не были связаны вовсе:
// checkExpiries()/resolveFromHistory() ниже считали РЕАЛЬНЫЙ результат
// сделки и писали только в history (то, что видно в "Последние сделки"),
// а analytics.updateSignalOutcome() выставлялся из совершенно другого
// расчёта (SL/TP-модель в outcome-scheduler.ts) — отсюда расхождение.
// Циклического импорта нет: useAnalyticsStore.ts не импортирует этот файл.
import { useAnalyticsStore } from './useAnalyticsStore';
import { updateSignalOutcome as persistSignalOutcome } from '@/lib/signal-persistence';

type Stage = 0 | 1 | 2 | 3;
type InstrumentKey = string;

interface InstrumentMartingaleState {
  stage: Stage;
  halted: boolean;
}

export interface DemoTrade {
  signalId: string;
  stake: number;
  profitPercent: number;
  direction: SignalDirection;
  openedAt: number;
  entryPrice: number | null;
  fallbackEntryPrice: number;
  expiryAt: number;
  symbolId: string;
  timeframe: Timeframe;
  candleTime: number;
  stage: Stage;
  stakeConfigAtOpen: { stage0Amount: number; stageAmounts: [number, number, number] };
}

export interface DemoTradeHistoryEntry {
  signalId: string;
  outcome: 'win' | 'loss' | 'tie';
  pnl: number;
  balanceAfter: number;
  closedAt: number;
  resolutionType?: 'normal' | 'fallback';
  symbolId: string;
  timeframe: Timeframe;
  stage: number;
  seriesReset: 'win' | 'loss_final_stage' | null;
}

interface LegacyDemoAccountPersistedState {
  balance?: number;
  baseStake?: number;
  stage0Amount?: number;
  stagePercents?: [number, number, number];
  stageAmounts?: [number, number, number];
  consecutiveLosses?: number;
  currentStake?: number;
  martingale?: Record<string, { stage: 0 | 1 | 2 | 3; halted?: boolean }>;
  profitPercent?: number;
  autoTradeEnabled?: boolean;
  martingaleEnabled?: boolean;
  openTrades?: Record<string, unknown>;
  history?: unknown[];
}

interface DemoAccountPersistedShape {
  balance: number;
  stage0Amount: number;
  stageAmounts: [number, number, number];
  profitPercent: number;
  autoTradeEnabled: boolean;
  martingaleEnabled: boolean;
  martingale: Record<InstrumentKey, InstrumentMartingaleState>;
  openTrades: Record<string, unknown>;
  history: unknown[];
}

interface DemoAccountState {
  balance: number;
  stage0Amount: number;
  stageAmounts: [number, number, number];
  profitPercent: number;
  autoTradeEnabled: boolean;
  // Переключатель системы мартингейла (только демо-счёт). true — поведение
  // как раньше (удвоение/повышение ставки по стадиям 0-3 после убытка).
  // false — каждая убыточная сделка закрывается в минус ставки, но стадия
  // мартингейла НЕ повышается: следующая ставка остаётся равна stage0Amount.
  martingaleEnabled: boolean;
  martingale: Record<InstrumentKey, InstrumentMartingaleState>;
  openTrades: Record<string, DemoTrade>;
  history: DemoTradeHistoryEntry[];
  openTrade: (signal: Signal, knownOpenPrice?: number) => void;
  confirmEntryPrice: (symbolId: string, timeframe: Timeframe, candleTime: number, openPrice: number) => void;
  checkExpiries: (currentPrice: number, nowMs: number, symbolId: string, timeframe: Timeframe) => void;
  resolveFromHistory: (symbolId: string, timeframe: Timeframe, candles: Candle[]) => void;
  setStage0Amount: (amount: number) => void;
  setStageAmount: (stage: 1 | 2 | 3, amount: number) => void;
  setProfitPercent: (v: number) => void;
  setAutoTradeEnabled: (v: boolean) => void;
  setMartingaleEnabled: (v: boolean) => void;
  setBalance: (v: number) => void;
  resetAccount: () => void;
}

const DEFAULT_BALANCE = 1000;
const DEFAULT_STAGE0_AMOUNT = 10;
const DEFAULT_STAGE_AMOUNTS: [number, number, number] = [25, 50, 100];
// Only used to migrate legacy (pre-v5) persisted state that stored stages 1-3 as percentages.
const DEFAULT_STAGE_PERCENTS_LEGACY: [number, number, number] = [250, 500, 1000];
const DEFAULT_PROFIT_PERCENT = 80;
const MAX_HISTORY = 30;

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function instrumentKey(symbolId: string, timeframe: Timeframe): InstrumentKey {
  return `${symbolId}:${timeframe}`;
}

// Тот же маппинг, что уже использовался для DemoTradeHistoryEntry.outcome
// ('win' | 'loss' | 'tie'), но приведённый к SignalOutcome ('tie' -> по ТЗ
// продукта сделка вничью помечается на сигнале как "Тайм-аут").
function pnlToSignalOutcome(pnl: number): SignalOutcome {
  return pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'timeout';
}

// Синхронно (без setTimeout/микротасков) прокидывает результат реальной
// демо-сделки в analytics.signals ("ИСТОРИЯ СИГНАЛОВ") и в БД. Вызывается
// из checkExpiries()/resolveFromHistory() РОВНО в момент закрытия сделки —
// это единственное место, которое теперь выставляет отображаемый/
// сохраняемый outcome сигнала, по которому была открыта демо-сделка.
function syncSignalOutcome(signalId: string, outcome: SignalOutcome): void {
  useAnalyticsStore.getState().updateSignalOutcome(signalId, outcome);
  void persistSignalOutcome(signalId, outcome);
}

export function getStageStake(
  stage: Stage,
  stage0Amount: number,
  stageAmounts: [number, number, number],
): number {
  if (stage === 0) return round2(stage0Amount);
  return round2(stageAmounts[stage - 1]);
}

function resolveTrade(
  trade: DemoTrade,
  closePrice: number,
  closedAtMs: number,
  currentState: InstrumentMartingaleState,
  martingaleEnabled: boolean,
): {
  pnl: number;
  balanceAfter: number;
  newMartingale: InstrumentMartingaleState;
  seriesReset: 'win' | 'loss_final_stage' | null;
} {
  void closedAtMs;
  const entryPrice = trade.entryPrice ?? trade.fallbackEntryPrice;
  const isWin =
    trade.direction === 'buy'
      ? closePrice > entryPrice
      : closePrice < entryPrice;
  const isTie = closePrice === entryPrice;

  let pnl: number;
  let balanceAfter = 0;
  let newMartingale: InstrumentMartingaleState = { ...currentState };
  let seriesReset: 'win' | 'loss_final_stage' | null = null;

  if (isTie) {
    pnl = 0;
    balanceAfter = round2(/* balance + */ trade.stake);
    newMartingale = { ...currentState };
  } else if (isWin) {
    pnl = round2(trade.stake * trade.profitPercent / 100);
    balanceAfter = round2(/* balance + */ trade.stake + pnl);
    newMartingale = { stage: 0, halted: false };
    seriesReset = 'win';
  } else {
    pnl = -trade.stake;
    if (!martingaleEnabled) {
      // Мартингейл выключен: сделка закрыта в убыток (минус ставка), но
      // стадия НЕ повышается — следующая ставка на этот инструмент
      // остаётся равна stage0Amount (без удвоения/повышения по стадиям).
      newMartingale = { stage: 0, halted: false };
      seriesReset = null;
    } else if (trade.stage >= 3) {
      newMartingale = { stage: 0, halted: false };
      seriesReset = 'loss_final_stage';
    } else {
      newMartingale = { stage: (trade.stage + 1) as Stage, halted: false };
      seriesReset = null;
    }
  }

  return { pnl, balanceAfter, newMartingale, seriesReset };
}

export const useDemoAccountStore = create<DemoAccountState>()(
  persist(
    (set, get) => ({
      balance: DEFAULT_BALANCE,
      stage0Amount: DEFAULT_STAGE0_AMOUNT,
      stageAmounts: DEFAULT_STAGE_AMOUNTS,
      profitPercent: DEFAULT_PROFIT_PERCENT,
      autoTradeEnabled: true,
      martingaleEnabled: true,
      martingale: {},
      openTrades: {},
      history: [],

      openTrade: (signal, knownOpenPrice) => {
        const state = get();
        const key = instrumentKey(signal.symbolId, signal.timeframe);
        if (state.martingale[key]?.halted === true) return;

        if (!state.autoTradeEnabled) return;
        if (state.openTrades[signal.id]) return;

        // Аудит, п.2: без этой проверки по инструменту может быть открыто
        // несколько параллельных сделок на один и тот же symbolId:timeframe
        // (например, пока предыдущая сделка "зависла" orphan'ом и ждёт
        // resolveFromHistory — см. resolveFromHistory ниже). Параллельные
        // сделки на одной стадии мартингейла резолвятся вразнобой и создают
        // впечатление, что стадии 2/3 "пропускаются", а прибыль зачисляется
        // пачкой через несколько сделок. Гарантируем: на инструмент — не
        // больше одной открытой сделки одновременно.
        const hasOpenTradeForInstrument = Object.values(state.openTrades).some(
          (t) => t.symbolId === signal.symbolId && t.timeframe === signal.timeframe,
        );
        if (hasOpenTradeForInstrument) return;

        const currentStage: Stage = state.martingale[key]?.stage ?? 0;
        const desiredStake = getStageStake(currentStage, state.stage0Amount, state.stageAmounts);

        if (state.balance < desiredStake) {
          set({
            martingale: {
              ...state.martingale,
              [key]: { stage: 0, halted: true },
            },
          });
          return;
        }

        const tfSeconds = TIMEFRAME_SECONDS[signal.timeframe];
        const newCandleTime = signal.time + tfSeconds;
        const trade: DemoTrade = {
          signalId: signal.id,
          stake: desiredStake,
          profitPercent: state.profitPercent,
          direction: signal.direction,
          openedAt: Date.now(),
          entryPrice: knownOpenPrice ?? null,
          fallbackEntryPrice: signal.entryPrice,
          expiryAt: (newCandleTime + tfSeconds) * 1000,
          symbolId: signal.symbolId,
          timeframe: signal.timeframe,
          candleTime: newCandleTime,
          stage: currentStage,
          stakeConfigAtOpen: {
            stage0Amount: state.stage0Amount,
            stageAmounts: state.stageAmounts,
          },
        };
        set({
          balance: round2(state.balance - desiredStake),
          openTrades: { ...state.openTrades, [signal.id]: trade },
        });
      },

      confirmEntryPrice: (symbolId, timeframe, candleTime, openPrice) => {
        const state = get();
        let changed = false;
        const openTrades = { ...state.openTrades };
        for (const [id, trade] of Object.entries(openTrades)) {
          if (
            trade.symbolId === symbolId &&
            trade.timeframe === timeframe &&
            trade.candleTime === candleTime &&
            trade.entryPrice === null
          ) {
            openTrades[id] = { ...trade, entryPrice: openPrice };
            changed = true;
          }
        }
        if (changed) set({ openTrades });
      },

      checkExpiries: (currentPrice, nowMs, symbolId, timeframe) => {
        const state = get();
        const expired = Object.values(state.openTrades)
          .filter((t) => t.symbolId === symbolId && t.timeframe === timeframe && nowMs >= t.expiryAt)
          .sort((a, b) => a.expiryAt - b.expiryAt);

        if (expired.length === 0) return;

        let newBalance = state.balance;
        const newMartingale = { ...state.martingale };
        const remainingTrades = { ...state.openTrades };
        const newEntries: DemoTradeHistoryEntry[] = [];

        for (const trade of expired) {
          const key = instrumentKey(trade.symbolId, trade.timeframe);
          const currentState: InstrumentMartingaleState = newMartingale[key] ?? { stage: 0, halted: false };
          const result = resolveTrade(trade, currentPrice, nowMs, currentState, state.martingaleEnabled);

          newBalance = round2(newBalance + result.balanceAfter);
          newMartingale[key] = result.newMartingale;

          delete remainingTrades[trade.signalId];
          // Аудит (синхронизация с демо-счётом): выставляем исход сигнала
          // синхронно, в том же проходе, что и сам результат сделки —
          // "ИСТОРИЯ СИГНАЛОВ" и винрейт в StatusBar обновляются в тот же
          // кадр, без задержек, и всегда 1:1 совпадают с тем, что видно
          // здесь же в "Последние сделки".
          syncSignalOutcome(trade.signalId, pnlToSignalOutcome(result.pnl));
          newEntries.push({
            signalId: trade.signalId,
            outcome: result.pnl > 0 ? 'win' : result.pnl < 0 ? 'loss' : 'tie',
            pnl: result.pnl,
            balanceAfter: newBalance,
            closedAt: nowMs,
            symbolId: trade.symbolId,
            timeframe: trade.timeframe,
            stage: trade.stage,
            seriesReset: result.seriesReset,
          });
        }

        const newHistory = [...newEntries.reverse(), ...state.history].slice(0, MAX_HISTORY);

        set({
          balance: newBalance,
          martingale: newMartingale,
          openTrades: remainingTrades,
          history: newHistory,
        });
        useAnalyticsStore.getState().recomputeStats();
      },

      resolveFromHistory: (symbolId, timeframe, candles) => {
        const state = get();
        const orphans = Object.values(state.openTrades)
          .filter((t) => t.symbolId === symbolId && t.timeframe === timeframe);

        if (orphans.length === 0) return;
        if (candles.length === 0) return;

        const lastCandleTime = candles[candles.length - 1].time;
        const earliestLoadedTime = candles[0].time;

        let newBalance = state.balance;
        const newMartingale = { ...state.martingale };
        const remainingTrades = { ...state.openTrades };
        let resolved = false;
        const newEntries: DemoTradeHistoryEntry[] = [];

        for (const trade of orphans) {
          let entryCandle = candles.find((c) => c.time === trade.candleTime);
          let resolutionType: 'normal' | 'fallback';

          if (!entryCandle) {
            if (trade.candleTime < earliestLoadedTime) {
              entryCandle = candles[0];
              resolutionType = 'fallback';
            } else {
              continue;
            }
          } else {
            resolutionType = 'normal';
          }

          if (entryCandle.time === lastCandleTime) continue;

          // БАГ (расхождение "сигнал должен быть в прибыли" vs демо-счёт в
          // минусе несколько сделок подряд): orphan-сделки попадают сюда,
          // когда живой поток свечей не доставил событие "новая свеча" для
          // ИМЕННО candleTime этой сделки, пока она была открыта — вкладка
          // была свёрнута/выгружена браузером, произошёл reload или
          // reconnect/resync (см. комментарии в handleCandle/pre-close.ts).
          // В этом случае trade.entryPrice так и остаётся null, а
          // resolveTrade() ниже молча берёт trade.fallbackEntryPrice —
          // это signal.entryPrice, то есть цена ЗАКРЫТИЯ ЕЩЁ ФОРМИРУЮЩЕЙСЯ
          // свечи В МОМЕНТ СИГНАЛА (см. pre-close.ts), а не реальная цена
          // открытия свечи входа. Между этими двумя точками цена уже могла
          // заметно уйти — как раз то самое движение, из-за которого
          // сигнал выглядит выигрышным "на глаз" (относительно реального
          // входа), а демо-счёт резолвит его в минус относительно чужой,
          // устаревшей цены. Реальная цена открытия свечи входа при этом
          // уже есть в загруженной истории (entryCandle.open) — просто не
          // использовалась. Подтверждаем entryPrice отсюда, если она ещё
          // не была подтверждена вживую (confirmEntryPrice).
          const resolvedTrade: DemoTrade = trade.entryPrice === null
            ? { ...trade, entryPrice: entryCandle.open }
            : trade;

          const closedAtMs = (entryCandle.time + TIMEFRAME_SECONDS[timeframe]) * 1000;
          const key = instrumentKey(trade.symbolId, trade.timeframe);
          const currentState: InstrumentMartingaleState = newMartingale[key] ?? { stage: 0, halted: false };
          const result = resolveTrade(resolvedTrade, entryCandle.close, closedAtMs, currentState, state.martingaleEnabled);

          newBalance = round2(newBalance + result.balanceAfter);
          newMartingale[key] = result.newMartingale;

          delete remainingTrades[trade.signalId];
          resolved = true;
          // См. комментарий в checkExpiries() — тот же синхронный источник
          // истины для orphan-сделок, доразрешаемых по загруженной истории.
          syncSignalOutcome(trade.signalId, pnlToSignalOutcome(result.pnl));
          newEntries.push({
            signalId: trade.signalId,
            outcome: result.pnl > 0 ? 'win' : result.pnl < 0 ? 'loss' : 'tie',
            pnl: result.pnl,
            balanceAfter: newBalance,
            closedAt: closedAtMs,
            resolutionType,
            symbolId: trade.symbolId,
            timeframe: trade.timeframe,
            stage: trade.stage,
            seriesReset: result.seriesReset,
          });
        }

        if (!resolved) return;

        const newHistory = [...newEntries.reverse(), ...state.history].slice(0, MAX_HISTORY);

        set({
          balance: newBalance,
          martingale: newMartingale,
          openTrades: remainingTrades,
          history: newHistory,
        });
        useAnalyticsStore.getState().recomputeStats();
      },

      setStage0Amount: (amount) => set({ stage0Amount: Math.max(0, amount) }),
      setStageAmount: (stage, amount) =>
        set((s) => {
          const newAmounts = [...s.stageAmounts] as [number, number, number];
          newAmounts[stage - 1] = Math.max(0, amount);
          return { stageAmounts: newAmounts };
        }),
      setProfitPercent: (v) => set({ profitPercent: v }),
      setAutoTradeEnabled: (v) => set({ autoTradeEnabled: v }),
      setMartingaleEnabled: (v) => set({ martingaleEnabled: v }),
      setBalance: (v) =>
        set((s) => {
          if (v <= 0) return { balance: v };
          const newMartingale: Record<InstrumentKey, InstrumentMartingaleState> = {};
          for (const [key, ms] of Object.entries(s.martingale)) {
            newMartingale[key] = { stage: ms.stage, halted: false };
          }
          return { balance: v, martingale: newMartingale };
        }),
      resetAccount: () => {
        set((s) => ({
          balance: DEFAULT_BALANCE,
          stage0Amount: s.stage0Amount,
          stageAmounts: s.stageAmounts,
          profitPercent: s.profitPercent,
          autoTradeEnabled: s.autoTradeEnabled,
          martingaleEnabled: s.martingaleEnabled,
          martingale: {},
          openTrades: {},
          history: [],
        }));
        // Bug fix: resetAccount() cleared the demo balance and trade
        // history but left the analytics signal history ("ИСТОРИЯ
        // СИГНАЛОВ") and StatusBar win/loss counters untouched. After a
        // reset the balance restarts at $1000 (fresh wins push it above),
        // while the stats still counted pre-reset signals — producing the
        // impossible-looking state of balance > $1000 with more losses
        // than wins. Clear both stores together so they stay consistent.
        useAnalyticsStore.getState().clearSignalHistory();
      },
    }),
    {
      name: 'demo-account',
      storage: createJSONStorage(() => localStorage),
      version: 6,
      migrate: migrateDemoAccountState,
    },
  ),
);

export function migrateDemoAccountState(
  persistedStateRaw: unknown,
  version: number,
): DemoAccountPersistedShape {
  const persistedState = persistedStateRaw as LegacyDemoAccountPersistedState;
  const s: LegacyDemoAccountPersistedState = { ...persistedState };
  if (version < 2) {
    delete s.consecutiveLosses;
    delete s.currentStake;
    s.martingale = s.martingale ?? {};
  }
  if (version < 3) {
    if (s.baseStake != null) {
      s.stage0Amount = s.baseStake;
    } else if (s.stage0Amount == null) {
      s.stage0Amount = DEFAULT_STAGE0_AMOUNT;
    }
    delete s.baseStake;
    if (!s.stagePercents) s.stagePercents = DEFAULT_STAGE_PERCENTS_LEGACY;
  }
  if (version < 4) {
    if (s.martingale) {
      for (const key of Object.keys(s.martingale)) {
        const entry = s.martingale[key];
        if (entry && entry.halted === undefined) {
          s.martingale[key] = { stage: entry.stage, halted: false };
        }
      }
    }
    // v3 data could still carry baseStake instead of stage0Amount
    if (s.stage0Amount == null && s.baseStake != null) {
      s.stage0Amount = s.baseStake;
      delete s.baseStake;
    }
  }
  if (version < 5) {
    // Stages 1-3 used to be stored as percentages of stage0Amount.
    // Convert them once into absolute dollar amounts so existing users
    // keep the same effective stake sizes after the upgrade.
    if (!s.stageAmounts) {
      const base = s.stage0Amount ?? DEFAULT_STAGE0_AMOUNT;
      const percents = s.stagePercents ?? DEFAULT_STAGE_PERCENTS_LEGACY;
      s.stageAmounts = [
        round2((base * percents[0]) / 100),
        round2((base * percents[1]) / 100),
        round2((base * percents[2]) / 100),
      ];
    }
    delete s.stagePercents;
  }
  if (version < 6) {
    // Новая настройка: по умолчанию мартингейл включён, чтобы поведение
    // для существующих пользователей не менялось после обновления.
    if (s.martingaleEnabled == null) {
      s.martingaleEnabled = true;
    }
  }
  return {
    balance: s.balance ?? DEFAULT_BALANCE,
    stage0Amount: s.stage0Amount ?? DEFAULT_STAGE0_AMOUNT,
    stageAmounts: s.stageAmounts ?? DEFAULT_STAGE_AMOUNTS,
    profitPercent: s.profitPercent ?? DEFAULT_PROFIT_PERCENT,
    autoTradeEnabled: s.autoTradeEnabled ?? true,
    martingaleEnabled: s.martingaleEnabled ?? true,
    martingale: (s.martingale ?? {}) as Record<InstrumentKey, InstrumentMartingaleState>,
    openTrades: s.openTrades ?? {},
    history: s.history ?? [],
  };
}
