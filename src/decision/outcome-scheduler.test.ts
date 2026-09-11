import { describe, it, expect } from 'vitest';
import type { Candle, Signal } from '@/types/domain';
import { OutcomeScheduler, resolveOutcome } from './outcome-scheduler';

function makeSignal(overrides: Partial<Signal> & { id: string; time: number }): Signal {
  return {
    symbolId: 'A', timeframe: '5m', direction: 'buy', strength: 'moderate',
    score: 3, calibratedProbability: null, entryPrice: 100, stopLoss: 95,
    takeProfit: 110, reason: 'test', indicators: {} as unknown as Signal['indicators'],
    pattern: null, outcome: 'pending', frozenAt: null, isRevised: false,
    isPreClose: false, revisionNote: null, barsToResolve: 5, spread: null,
    spreadSource: null, recommendedExpiry: 300, featureVector: [0],
    factors: [], rejectedPatterns: [], engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
    chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
    marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
    ...overrides,
  };
}

function candle(time: number, close: number, high: number, low: number): Candle {
  return { time, open: close, high, low, close, volume: 100 };
}

describe('OutcomeScheduler.schedule — dedup by signal.id', () => {
  it('only tracks one pending entry when schedule() is called twice for the same signal.id', () => {
    // Воспроизводит реальный сценарий: pre-close (maybeTriggerPreClose)
    // и подстраховка в maybeEvaluateSignal (isClosed === true) для одной и
    // той же свечи оба вызывают scheduler.schedule(signal) с одинаковым
    // signal.id (см. generateSignalId — id детерминирован по
    // symbolId:timeframe:candleTime).
    const scheduler = new OutcomeScheduler();
    const signal = makeSignal({ id: 'A:5m:1000', time: 1000 });
    const signalCopy = makeSignal({ id: 'A:5m:1000', time: 1000 }); // другой объект, тот же id

    scheduler.schedule(signal);
    scheduler.schedule(signalCopy);

    expect(scheduler.getPendingCount()).toBe(1);
  });

  it('does not call onResolve twice for the same signal.id once outcome is reached', () => {
    const scheduler = new OutcomeScheduler();
    const signal = makeSignal({ id: 'A:5m:1000', time: 1000, direction: 'buy', takeProfit: 110, stopLoss: 95, barsToResolve: 3 });
    const signalCopy = makeSignal({ id: 'A:5m:1000', time: 1000, direction: 'buy', takeProfit: 110, stopLoss: 95, barsToResolve: 3 });

    scheduler.schedule(signal);
    scheduler.schedule(signalCopy);

    const resolvedCalls: Array<{ signalId: string; outcome: string }> = [];
    const allCandles = [candle(1000, 100, 101, 99), candle(1300, 111, 112, 108)];

    scheduler.onCandleClosed(allCandles, (resolved) => {
      resolvedCalls.push({ signalId: resolved.signalId, outcome: resolved.outcome });
    });

    expect(resolvedCalls).toHaveLength(1);
    expect(resolvedCalls[0]).toEqual({ signalId: 'A:5m:1000', outcome: 'win' });
    expect(scheduler.getPendingCount()).toBe(0);
  });

  it('still tracks two distinct signals with different ids independently', () => {
    const scheduler = new OutcomeScheduler();
    scheduler.schedule(makeSignal({ id: 'A:5m:1000', time: 1000 }));
    scheduler.schedule(makeSignal({ id: 'A:5m:1300', time: 1300 }));

    expect(scheduler.getPendingCount()).toBe(2);
  });

  it('updates tradeOpened from false to true when schedule() is called again with the same id', () => {
    // Воспроизводит баг расхождения "Последние сделки" vs "История сигналов":
    // pre-close кладёт сигнал с tradeOpened: false (сделка не открылась из-за
    // guard'а "одна сделка на инструмент"), затем при реальном закрытии
    // свечи maybeEvaluateSignal открывает сделку и вызывает schedule() с
    // tradeOpened: true. Без обновления в очереди остаётся устаревший false,
    // и maybeResolveOutcomes позже перезапишет корректный исход от
    // useDemoAccountStore своим собственным (неправильным).
    const scheduler = new OutcomeScheduler();
    const signalNotTraded = makeSignal({ id: 'A:5m:1000', time: 1000, tradeOpened: false });
    const signalTraded = makeSignal({ id: 'A:5m:1000', time: 1000, tradeOpened: true });

    scheduler.schedule(signalNotTraded);
    scheduler.schedule(signalTraded);

    expect(scheduler.getPendingCount()).toBe(1);
    const pending = scheduler.getPendingList();
    expect(pending[0].signal.tradeOpened).toBe(true);
  });
});

// Аудит (синхронизация с демо-счётом): resolveOutcome раньше проверял
// касание stopLoss/takeProfit в течение barsToResolve будущих свечей.
// Теперь исход зависит ИСКЛЮЧИТЕЛЬНО от close первой свечи после сигнала
// vs entryPrice — ровно как реальная демо-сделка (resolveTrade).
describe('resolveOutcome — ignores stopLoss/takeProfit/barsToResolve', () => {
  it('returns "win" for a buy whose first candle after the signal closes above entry, even though low touched stopLoss', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'buy',
      entryPrice: 100, stopLoss: 95, takeProfit: 110, barsToResolve: 5,
    });
    // Low (94) dips well below stopLoss (95) intrabar, but the CLOSE (101)
    // is still above entry — old SL/TP logic would have called this a
    // 'loss' (stop touched); the new logic must call it a 'win'.
    const candlesAfter = [candle(1300, 101, 102, 94)];

    const resolved = resolveOutcome(signal, candlesAfter);

    expect(resolved).toEqual({ signalId: 'A:5m:1000', outcome: 'win' });
  });

  it('returns "win" for a buy even when the close never reached takeProfit', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'buy',
      entryPrice: 100, stopLoss: 95, takeProfit: 110, barsToResolve: 5,
    });
    // Close (100.5) is above entry but nowhere near takeProfit (110) — old
    // SL/TP logic would still be waiting (pending, not yet resolved) up to
    // barsToResolve; the new logic resolves immediately as 'win'.
    const candlesAfter = [candle(1300, 100.5, 100.6, 100.2)];

    const resolved = resolveOutcome(signal, candlesAfter);

    expect(resolved).toEqual({ signalId: 'A:5m:1000', outcome: 'win' });
  });

  it('resolves using only the FIRST candle after the signal, regardless of barsToResolve', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'buy',
      entryPrice: 100, stopLoss: 95, takeProfit: 110, barsToResolve: 5,
    });
    // First candle after the signal closes below entry (loss). A later
    // candle within the old barsToResolve window closes far above entry —
    // under the old model this might eventually flip to a win; the new
    // model must lock in the outcome from the very first candle only.
    const candlesAfter = [
      candle(1300, 98, 99, 97),
      candle(1600, 120, 121, 119),
    ];

    const resolved = resolveOutcome(signal, candlesAfter);

    expect(resolved).toEqual({ signalId: 'A:5m:1000', outcome: 'loss' });
  });

  it('returns "loss" for a sell whose first candle closes above entry, even though it never touched stopLoss', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'sell',
      entryPrice: 100, stopLoss: 105, takeProfit: 90, barsToResolve: 5,
    });
    const candlesAfter = [candle(1300, 101, 102, 100.5)];

    const resolved = resolveOutcome(signal, candlesAfter);

    expect(resolved).toEqual({ signalId: 'A:5m:1000', outcome: 'loss' });
  });

  it('returns "timeout" on an exact tie (close === entryPrice), independent of stopLoss/takeProfit', () => {
    const signal = makeSignal({
      id: 'A:5m:1000', time: 1000, direction: 'buy',
      entryPrice: 100, stopLoss: 95, takeProfit: 110, barsToResolve: 5,
    });
    const candlesAfter = [candle(1300, 100, 100.5, 99.5)];

    const resolved = resolveOutcome(signal, candlesAfter);

    expect(resolved).toEqual({ signalId: 'A:5m:1000', outcome: 'timeout' });
  });

  it('returns null when the signal is not pending (already resolved)', () => {
    const signal = makeSignal({ id: 'A:5m:1000', time: 1000, outcome: 'win' });
    const candlesAfter = [candle(1300, 101, 102, 99)];

    expect(resolveOutcome(signal, candlesAfter)).toBeNull();
  });

  it('returns null when there are no candles after the signal yet', () => {
    const signal = makeSignal({ id: 'A:5m:1000', time: 1000 });

    expect(resolveOutcome(signal, [])).toBeNull();
  });
});
