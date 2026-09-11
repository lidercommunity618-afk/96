import type {
  Candle,
  IndicatorConfig,
  PatternResult,
  Signal,
  SignalDirection,
  SignalStrength,
  Snapshot,
  Timeframe,
  FeatureName,
  Tick,
  SignalComponentToggles,
  SignalFactor,
  RejectedPattern,
} from '@/types/domain';
import { DEFAULT_SIGNAL_TOGGLES, EMPTY_CHART_CONTEXT } from '@/types/domain';
import type { CalibrationModel } from './calibration-model';
import { MIN_SAMPLES, MAX_SAMPLES } from './calibration-model';
import { estimateTradeLevels, computeBreakoutTradeLevels, computeLiquiditySweepTradeLevels, computeOrderBlockContinuationTradeLevels, computeHarmonicTradeLevels, fallbackAtr } from './trade-levels';
import { recommendedExpiry } from './recommended-expiry';
import { estimateSpread } from './spread-estimate';
import { computeDirectionScore } from './direction-prediction';
import { applySignalFilters, REGIME_GATE_ADX_THRESHOLD } from './signal-filters';
import { selectTopPattern } from './pattern-selection';
import { getSessionRegime, type SessionRegime } from '@/compute/session-regime';

const REVISION_DELTA_THRESHOLD = 3.0;

// Audit finding #10/D3 ("Реакция на снятие ликвидности"): additional
// liquidity-sweep-reaction-specific spread gate, scaled to this trade's own
// planned stopDistance rather than to ATR (see the gate site in buildSignal
// for why the shared ATR-relative gate is too permissive for M1 scalping
// stops). k=0.4 is the midpoint of the doc-recommended 0.3-0.5 range.
const LSR_SPREAD_GATE_MULTIPLIER = 0.4;

export const FEATURE_KEYS = [
  'rsi', 'ema_cross', 'macd_hist', 'bb_width', 'atr',
  'vwap', 'impulse_vel', 'regime_trend', 'regime_vol',
  'bos', 'choch', 'pattern_conf',
] as const;

export const FEATURE_COUNT = FEATURE_KEYS.length;

export interface FeatureVector {
  values: number[];
  keys: string[];
}

export function buildFeatureVector(snapshot: Snapshot): FeatureVector {
  const ind = snapshot.indicators;
  const map = new Map<string, number>();

  if (ind.rsi !== null) map.set('rsi', ind.rsi / 100);
  if (ind.emaFast !== null && ind.emaSlow !== null) {
    map.set('ema_cross', ind.emaSlow !== 0 ? (ind.emaFast - ind.emaSlow) / ind.emaSlow : 0);
  }
  if (ind.macdHistogram !== null) map.set('macd_hist', ind.macdHistogram);
  if (ind.bollingerUpper !== null && ind.bollingerLower !== null) {
    const width = ind.bollingerUpper - ind.bollingerLower;
    map.set('bb_width', width !== 0 ? width / (ind.bollingerMiddle ?? 1) : 0);
  }
  if (ind.atr !== null) map.set('atr', ind.atr);
  if (ind.vwap !== null) map.set('vwap', ind.vwap);
  if (ind.impulseVelocity !== null) map.set('impulse_vel', ind.impulseVelocity);
  if (snapshot.regime === 'trend') map.set('regime_trend', 1);
  if (snapshot.regime === 'high-volatility') map.set('regime_vol', 1);
  if (snapshot.structure.bos) map.set('bos', 1);
  if (snapshot.structure.choch) map.set('choch', 1);

  const selection = selectTopPattern(snapshot.patterns);
  if (selection) {
    map.set('pattern_conf', selection.fusionConfidence * (selection.top.direction === 'buy' ? 1 : -1));
  }

  const values = FEATURE_KEYS.map((k) => map.get(k) ?? 0);
  return { values, keys: [...FEATURE_KEYS] };
}

// Единая точка правды для порога "сильного" сигнала — используется и здесь
// (классификация strength), и в DecisionEngine (см. engine.ts,
// strongSignalsOnly/режим "Система мартингейла") для гейта score ПЕРЕД
// генерацией сигнала. Дублирование магического числа 4 в двух местах уже
// однажды создавало риск рассинхронизации (аудит scoreThreshold от
// 2026-09-06) — здесь экспортируем константу, чтобы оба потребителя всегда
// были согласованы по определению.
export const STRONG_SIGNAL_SCORE_THRESHOLD = 4;
const MODERATE_SIGNAL_SCORE_THRESHOLD = 3;

function strengthFor(score: number): SignalStrength {
  if (score >= STRONG_SIGNAL_SCORE_THRESHOLD) return 'strong';
  if (score >= MODERATE_SIGNAL_SCORE_THRESHOLD) return 'moderate';
  return 'weak';
}

interface EvidenceResult {
  direction: SignalDirection | null;
  score: number;
  reasons: string[];
  pattern: PatternResult | null;
  // См. SignalFactor/RejectedPattern в types/domain.ts. factors параллелен
  // reasons (та же информация, структурированно); rejectedPatterns — то,
  // что было отклонено selectTopPattern() на этой же свече.
  factors: SignalFactor[];
  rejectedPatterns: RejectedPattern[];
}

function isSessionAllowed(session: SessionRegime, filter: IndicatorConfig['sessionFilter']): boolean {
  // 'closed' (weekend / no active forex session) is MarketHoursConfig's
  // concern, not this quality filter's — crypto symbols trade 24/7 with no
  // session-liquidity pattern, so we don't want this forex-oriented gate to
  // silently block them. Only the 5 named sessions are actually gated.
  if (session === 'closed') return true;
  return filter[session];
}

function evaluateEvidence(
  candles: Candle[],
  snapshot: Snapshot,
  entryPrice: number,
  toggles: SignalComponentToggles,
  activeFeatures: FeatureName[],
  atrPeriod: number,
  rsiOverbought: number,
  rsiOversold: number,
  // FIX (аудит калибровки Этапа 2, п.4): прокидываем symbolId дальше в
  // computeDirectionScore, чтобы PATTERN_RELIABILITY_MULTIPLIER читался
  // per-symbol, а не глобально — см. pattern-categories.ts. Опционален по
  // той же причине, что и в computeDirectionScore (обратная совместимость).
  symbolId?: string,
): EvidenceResult {
  const { direction, score: dirScore, reasons: dirReasons, factors: dirFactors } = computeDirectionScore(candles, snapshot, toggles, activeFeatures, atrPeriod, rsiOverbought, rsiOversold, symbolId);

  // Отклонённые паттерны нужны для постмортема независимо от toggles.trigger
  // — даже если "триггер" как компонент выключен, полезно знать, что на
  // этой свече вообще что-то конкурирующее сработало, поэтому selection
  // считается один раз безусловно, а toggles.trigger применяется только к
  // тому, что из него используется как реальный триггер сигнала (topPattern).
  const fullSelection = selectTopPattern(snapshot.patterns);
  const topPattern = toggles.trigger ? fullSelection?.top ?? null : null;
  const rejectedPatterns = fullSelection?.rejected ?? [];

  // Tie on the weighted direction score: no directional evidence to act on,
  // so this is "no signal" rather than falling through to the buy/sell
  // filter and bonus logic below (which require a concrete direction).
  if (direction === null) {
    return { direction: null, score: 0, reasons: dirReasons, pattern: topPattern, factors: dirFactors, rejectedPatterns };
  }

  // Collect additional indicator evidence for the score
  const extraReasons: string[] = [];
  const extraFactors: SignalFactor[] = [];
  let indicatorBonus = 0;

  function pushExtra(kind: SignalFactor['kind'], name: string, contribution: number, argument: string, value: number | null = null): void {
    extraReasons.push(argument);
    extraFactors.push({ kind, name, direction, contribution, argument, value });
  }

  // BUGFIX (факторный анализ): RSI oversold/overbought (25% винрейт, N=10) и
  // Bollinger touch (0% винрейт, N=8) double-confirmation бонусы удалены —
  // тот же провальный фактор, что и в direction-prediction.ts components,
  // не должен давать дополнительный бонус здесь тоже. RSI/Bollinger
  // по-прежнему логируются в factors через direction-prediction.ts (с
  // contribution=0) для постмортема.

  // Strategy bonuses for OBC and MDM patterns — additive evidence on top of
  // the base dirScore, scaled by each pattern's confidence.
  //
  // BUGFIX (аудит 2026-09-06, найден сразу после устранения двойного учёта):
  // раньше этот блок применял бонус, только если topPattern вообще
  // существует, не проверяя, что topPattern.direction совпадает с итоговым
  // direction сигнала. Пока trigger (вес 1.5) голосовал в computeDirectionScore
  // за сторону topPattern, это было маловероятным крайним случаем — trigger
  // обычно и определял direction. После фикса двойного учёта (см. коммент
  // ниже в computeDirectionScore/direction-prediction.ts) components.trigger
  // для этих 10 стратегийных паттернов обнулён — их единственный голос в
  // определении direction исчез, и without ЭТОЙ проверки бонус за BUY-паттерн
  // мог достаться SELL-сигналу (структура/BOS/MACD/EMA перетягивают
  // direction в другую сторону, а +0.55 всё равно приплюсовывался к SELL).
  // Подтверждено на buildSignal(): order-block-continuation (BUY, conf=1.0)
  // → итоговый signal.direction: 'sell' с reason 'OBC strategy (+0.55)'.
  // Теперь бонус начисляется, только если паттерн согласен с итоговым
  // направлением; иначе он не голосует и не участвует в score вообще (не
  // штрафуется в противоположную сторону — это отдельный вопрос политики,
  // не входит в рамки этого фикса).
  if (topPattern && topPattern.direction === direction) {
    if (topPattern.name === 'order-block-continuation') {
      const bonus = 0.55 * topPattern.confidence;
      indicatorBonus += bonus;
      pushExtra('strategy', topPattern.name, bonus, `OBC strategy (+${bonus.toFixed(2)})`, topPattern.confidence);
    } else if (topPattern.name === 'macd-deceleration-continuation') {
      const bonus = 0.35 * topPattern.confidence;
      indicatorBonus += bonus;
      pushExtra('strategy', topPattern.name, bonus, `MDM strategy (+${bonus.toFixed(2)})`, topPattern.confidence);
    } else if (topPattern.name === 'fvg-nested') {
      // Doc §3 Strategy C: "Приоритет: Максимальный" — highest bonus of
      // the four FVG strategies, above OBC.
      const bonus = 0.65 * topPattern.confidence;
      indicatorBonus += bonus;
      pushExtra('strategy', topPattern.name, bonus, `FVG Nested strategy (+${bonus.toFixed(2)})`, topPattern.confidence);
    } else if (topPattern.name === 'fvg-breaker-block') {
      const bonus = 0.5 * topPattern.confidence;
      indicatorBonus += bonus;
      pushExtra('strategy', topPattern.name, bonus, `FVG Breaker Block strategy (+${bonus.toFixed(2)})`, topPattern.confidence);
    } else if (topPattern.name === 'fvg-rejection') {
      const bonus = 0.4 * topPattern.confidence;
      indicatorBonus += bonus;
      pushExtra('strategy', topPattern.name, bonus, `FVG Rejection strategy (+${bonus.toFixed(2)})`, topPattern.confidence);
    } else if (topPattern.name === 'fvg-return') {
      const bonus = 0.35 * topPattern.confidence;
      indicatorBonus += bonus;
      pushExtra('strategy', topPattern.name, bonus, `FVG Return strategy (+${bonus.toFixed(2)})`, topPattern.confidence);
    } else if (topPattern.name === 'order-block-nested') {
      // No source-doc priority for these two (they're new, not part of the
      // original "Стратегии на FVG" spec) — weighted below fvg-nested's
      // doc-mandated "Максимальный приоритет" on the same multi-timeframe
      // confluence idea, but above the single-zone OB strategies.
      const bonus = 0.45 * topPattern.confidence;
      indicatorBonus += bonus;
      pushExtra('strategy', topPattern.name, bonus, `OB Nested strategy (+${bonus.toFixed(2)})`, topPattern.confidence);
    } else if (topPattern.name === 'order-block-breaker') {
      const bonus = 0.4 * topPattern.confidence;
      indicatorBonus += bonus;
      pushExtra('strategy', topPattern.name, bonus, `OB Breaker Block strategy (+${bonus.toFixed(2)})`, topPattern.confidence);
    } else if (topPattern.name === 'impulse-breakout') {
      // 0.40 is a starting weight — lower than order-block-continuation's
      // 0.55 since impulse-breakout is methodologically simpler and doesn't
      // use OB/FVG confluence. Should be recalibrated via CalibrationModel
      // against real trade outcomes rather than hand-tuned further.
      const bonus = 0.40 * topPattern.confidence;
      indicatorBonus += bonus;
      pushExtra('strategy', topPattern.name, bonus, `Impulse Breakout strategy (+${bonus.toFixed(2)})`, topPattern.confidence);
    } else if (topPattern.name === 'liquidity-sweep-reaction') {
      // Audit finding #4/C1: liquidity-sweep-reaction was the only one of
      // this family of SMC/ICT M1 strategies with no personal bonus here —
      // it only counted through the generic components.trigger (weight 1.5),
      // same as a bare candlestick pattern, despite passing a stricter bar
      // (volume/ATR-displacement + BOS/CHoCH + session + OB/FVG confluence)
      // than several patterns that already had a bonus. 0.5 sits alongside
      // fvg-breaker-block's 0.50 — comparable methodological weight; should
      // be recalibrated via CalibrationModel against real outcomes rather
      // than hand-tuned further.
      const bonus = 0.5 * topPattern.confidence;
      indicatorBonus += bonus;
      pushExtra('strategy', topPattern.name, bonus, `Liquidity Sweep Reaction (+${bonus.toFixed(2)})`, topPattern.confidence);
    } else if (topPattern.name === 'harmonic-pattern') {
      // Harmonic patterns (Gartley/Butterfly/AB=CD) — same personal-bonus
      // mechanism as the other strategy patterns above. 0.5 is a starting
      // weight, on par with liquidity-sweep-reaction/fvg-breaker-block;
      // should be recalibrated via CalibrationModel against real outcomes
      // rather than hand-tuned further. Must stay in STRATEGY_BONUS_PATTERNS
      // (pattern-categories.ts) so its components.trigger contribution is
      // zeroed in direction-prediction.ts — see invariant in project docs
      // about avoiding double-counting the same pattern's evidence.
      const bonus = 0.5 * topPattern.confidence;
      indicatorBonus += bonus;
      pushExtra('strategy', topPattern.name, bonus, `Harmonic Pattern strategy (+${bonus.toFixed(2)})`, topPattern.confidence);
    }
  }

  // Apply false-signal filters
  const filterResult = applySignalFilters(candles, snapshot, direction, dirScore, toggles, activeFeatures);
  const filteredScore = (dirScore + indicatorBonus) * filterResult.scoreMultiplier;

  // Фильтры (context penalty, confirmation bonus, CHoCH warning, invalidation)
  // не дают числовой вклад per-reason на своём уровне (signal-filters.ts
  // возвращает только scoreMultiplier целиком на все reasons сразу) — здесь
  // они заворачиваются в SignalFactor как есть, с общим scoreMultiplier в
  // value, а не с индивидуальным contribution (который у одиночного фильтра
  // посчитать нельзя без переписывания signal-filters.ts).
  const filterFactors: SignalFactor[] = filterResult.reasons.map((r) => ({
    kind: 'filter',
    name: 'signal-filter',
    direction,
    contribution: 0,
    argument: r,
    value: filterResult.scoreMultiplier,
  }));

  if (filterResult.invalidated) {
    return {
      direction,
      score: 0,
      reasons: [...dirReasons, ...filterResult.reasons],
      pattern: topPattern,
      factors: [...dirFactors, ...filterFactors],
      rejectedPatterns,
    };
  }

  const allReasons = [...dirReasons, ...extraReasons, ...filterResult.reasons];
  const allFactors = [...dirFactors, ...extraFactors, ...filterFactors];

  return { direction, score: filteredScore, reasons: allReasons, pattern: topPattern, factors: allFactors, rejectedPatterns };
}

export function sigmoidFallback(score: number): number {
  const raw = 1 / (1 + Math.exp(-score / 5));
  // BUGFIX (аудит 2026-09-05): пока обученной calibration-модели нет
  // (< MIN_SAMPLES реальных исходов, см. calibration-model.ts), это
  // единственный источник calibratedProbability — и раньше он был
  // неограничен, то есть score=24 давал 99% "вероятности" безо всякой
  // статистики за спиной. Реальный инцидент: 6 сигналов подряд с
  // fallback-вероятностью 0.77-0.99 — и все 6 в минус. Теперь значение
  // зажато в [0.35, 0.65]: оно по-прежнему монотонно по score (сильнее
  // сетап -> ближе к 0.65), но больше не выдаёт себя за уверенный прогноз
  // там, где прогноза по сути нет — см. также Signal.calibrationSource,
  // которое явно помечает такие сигналы как 'fallback'.
  return Math.max(0.35, Math.min(0.65, raw));
}

export interface BuildSignalParams {
  symbolId: string;
  timeframe: Timeframe;
  candles: Candle[];
  config: IndicatorConfig;
  atrMultiplier: number;
  activeFeatures: FeatureName[];
  snapshot: Snapshot;
  calibration: CalibrationModel | null;
  tick: Tick | null;
  barsToResolve: number;
  scoreThreshold?: number;
  signalToggles?: SignalComponentToggles;
  priorityThreshold?: number;
}

export function buildSignal(params: BuildSignalParams): Signal | null {
  const { symbolId, timeframe, candles, config, atrMultiplier, activeFeatures, snapshot, calibration, tick, barsToResolve, scoreThreshold, signalToggles = DEFAULT_SIGNAL_TOGGLES, priorityThreshold } = params;

  const hasEnabledSource = signalToggles.structure || signalToggles.zones || signalToggles.liquidity || signalToggles.trigger || signalToggles.indicator || signalToggles.bos || signalToggles.macd || signalToggles.meanReversion;
  if (!hasEnabledSource) return null;

  const warmup = Math.max(config.emaSlow, config.bbPeriod, config.macdSlow, config.rsiPeriod, config.atrPeriod) + 5;
  if (candles.length < warmup) return null;

  const lastCandle = candles[candles.length - 1];

  // Задача 1.2 — session/kill-zone gate. Applied BEFORE any score
  // computation: outside an enabled trading window, no signal is built at
  // all (not a DirectionComponents penalty, a hard pre-filter).
  const sessionRegime = getSessionRegime(lastCandle.time * 1000);
  if (!isSessionAllowed(sessionRegime, config.sessionFilter)) return null;

  const entryPrice = lastCandle.close;
  const evidence = evaluateEvidence(candles, snapshot, entryPrice, signalToggles, activeFeatures, config.atrPeriod, config.rsiOverbought, config.rsiOversold, symbolId);
  // Explicit no-signal check: a tied direction score must never produce a
  // signal, regardless of what the score threshold happens to be set to.
  if (evidence.direction === null) return null;
  const threshold = scoreThreshold ?? config.scoreThreshold;
  if (evidence.score < threshold) return null;

  // NOTE (аудит-приоритет "минимум по числу независимых kind (≥3
  // источника)"): рассматривался хардкод-гейт по количеству различных
  // SignalFactorKind с ненулевым вкладом. Отклонён после проверки против
  // существующего test-suite: в этой кодовой базе EMA/MACD/RSI/Bollinger
  // все относятся к ОДНОМУ kind='indicator' (см. featureCalibration.ts +
  // direction-prediction.ts), поэтому корректное согласие EMA+MACD —
  // штатный, намеренно протестированный сценарий сигнала (см. buildSignal
  // describe-блок в signal-builder.test.ts) — тоже дало бы всего 1 kind и
  // блокировалось бы этим гейтом наравне с настоящим случаем из диагноза
  // (06:46, всего EMA+FVG). Жёсткий гейт по kind — неверный инструмент для
  // этой структуры данных; правильная реализация требует считать
  // независимые ИМЕНОВАННЫЕ факторы (не их категорию) и/или сделать это
  // настраиваемым порогом в IndicatorConfig, а не константой здесь — не
  // реализовано в этом фиксе, чтобы не вносить регрессию без более широкого
  // пересмотра модели факторов.

  const atrValue = fallbackAtr(snapshot.indicators, candles, config.atrPeriod);
  if (atrValue <= 0) return null;

  // Задача 1.3 — pre-entry spread gate. estimateSpread() was previously only
  // consulted post-factum (apply-spread.ts, when resolving win/loss/timeout)
  // — an abnormally wide spread (e.g. around a news spike) could never stop
  // a signal from being created, only make it lose after the fact. Moving
  // the same estimate earlier lets an anomalous spread block entry outright.
  const spreadInfo = estimateSpread(symbolId, tick);
  if (spreadInfo.spread > atrValue * config.spreadGateMultiplier) return null;

  // Audit finding #9/D2: apply-spread.ts already prices spread into the
  // OUTCOME (win/loss/timeout resolution), but the entry itself was always
  // modelled at a perfect fill on lastCandle.close, with zero cost. Half the
  // spread in the direction of entry is the standard approximation of
  // average slippage for a market order, and matters proportionally more
  // here than on higher timeframes — on M1 scalping with a stop that's often
  // a fraction of ATR, even 0.1-0.3 pips of difference between modelled and
  // real entry visibly changes the actual R:R.
  const tradeEntryPrice = evidence.direction === 'buy'
    ? entryPrice + spreadInfo.spread / 2
    : entryPrice - spreadInfo.spread / 2;

  // impulse-breakout gets a structural stop (beyond the breakout candle's
  // extreme) instead of the shared atrMultiplier*ATR stop used by most other
  // strategies — see trade-levels.ts computeBreakoutTradeLevels for why a
  // fixed-ATR stop is unsafe for a breakout specifically (at the userʼs
  // minimum atrMultiplier, the stop would sit inside the signal candleʼs
  // own body). Falls back to the shared estimateTradeLevels if the pattern
  // somehow didn't carry breakout extremes (e.g. an older cached result).
  const impulseBreakoutPattern =
    evidence.pattern?.name === 'impulse-breakout' &&
    evidence.pattern.breakoutLow !== undefined &&
    evidence.pattern.breakoutHigh !== undefined
      ? evidence.pattern
      : null;

  // liquidity-sweep-reaction gets the same structural treatment (audit
  // finding #6): stop beyond the swept extreme, target the nearest opposite
  // liquidity zone (precomputed in the detector) with a fixed-2x-ATR
  // fallback and a MIN_RR safety filter — instead of the shared
  // atrMultiplier*ATR stop / flat 2.0 R:R that ignores the sweep's own
  // structure entirely.
  const liquiditySweepReactionPattern =
    evidence.pattern?.name === 'liquidity-sweep-reaction' &&
    evidence.pattern.sweepLow !== undefined &&
    evidence.pattern.sweepHigh !== undefined
      ? evidence.pattern
      : null;

  // order-block-continuation gets a structural TP (audit finding #3):
  // findTargetZone() in the detector already computes the nearest OB/FVG/S-R
  // level in the trade direction, but it was never wired through — the signal
  // fell back to a flat ATR×2 TP. Now we use the structural target when it
  // gives RR >= 1.5, with the same ATR×2 fallback otherwise.
  const obcPattern =
    evidence.pattern?.name === 'order-block-continuation' &&
    evidence.pattern.targetZone !== undefined
      ? evidence.pattern
      : null;

  // harmonic-pattern (Gartley/Butterfly/AB=CD) gets a structural SL/TP built
  // from the D/X point and the Fibonacci projection off D — see
  // computeHarmonicTradeLevels in trade-levels.ts.
  const harmonicPattern =
    evidence.pattern?.name === 'harmonic-pattern' &&
    evidence.pattern.harmonicStop !== undefined &&
    evidence.pattern.harmonicTarget !== undefined
      ? evidence.pattern
      : null;

  const levels = impulseBreakoutPattern
    ? computeBreakoutTradeLevels(
        tradeEntryPrice,
        evidence.direction,
        impulseBreakoutPattern.breakoutLow!,
        impulseBreakoutPattern.breakoutHigh!,
        atrValue,
      )
    : liquiditySweepReactionPattern
    ? computeLiquiditySweepTradeLevels(
        tradeEntryPrice,
        evidence.direction,
        liquiditySweepReactionPattern.sweepLow!,
        liquiditySweepReactionPattern.sweepHigh!,
        liquiditySweepReactionPattern.oppositeZonePrice ?? null,
        atrValue,
      )
    : obcPattern
    ? computeOrderBlockContinuationTradeLevels(
        tradeEntryPrice,
        evidence.direction,
        obcPattern.targetZone,
        atrValue,
        atrMultiplier,
      )
    : harmonicPattern
    ? computeHarmonicTradeLevels(
        tradeEntryPrice,
        evidence.direction,
        harmonicPattern.harmonicStop,
        harmonicPattern.harmonicTarget,
        atrValue,
        atrMultiplier,
      )
    : estimateTradeLevels(tradeEntryPrice, atrValue, atrMultiplier, evidence.direction);

  // Audit finding #10/D3: the general spreadGateMultiplier=3 gate above is
  // relative to ATR, not to this specific trade's planned stop — on M1
  // scalping where the stop is often a fraction of ATR, a spread of up to
  // 3x ATR can be wider than the stop itself, i.e. the gate almost never
  // fires exactly when it's needed (abnormal spread widening around news/
  // session opens). liquidity-sweep-reaction gets an additional, stricter
  // gate scaled to its OWN stopDistance instead — left as an addition, not a
  // replacement, so the other 9 M1 strategies and the user's SettingsPanel
  // default are untouched.
  if (liquiditySweepReactionPattern) {
    const stopDistance = Math.abs(tradeEntryPrice - levels.stopLoss);
    if (spreadInfo.spread > stopDistance * LSR_SPREAD_GATE_MULTIPLIER) return null;
  }

  const featureVec = buildFeatureVector(snapshot);
  // BUGFIX (аудит 2026-09-06, п.7): ADX < REGIME_GATE_HARD_VETO_ADX_THRESHOLD
  // (20) уже не доходит сюда вовсе — сигнал обнулён и отфильтрован выше по
  // score < threshold (см. signal-filters.ts, п.1). Здесь остаётся только
  // мягкая зона [20, REGIME_GATE_ADX_THRESHOLD) — сигнал прошёл, но
  // соответствующий чоп-риск (см. 4 сделки 2026-09-05) обосновывает более
  // длинную экспирацию, а не только штраф очков.
  const isRangeWithWeakTrend = snapshot.regime === 'range' && snapshot.indicators.adx !== null && snapshot.indicators.adx < REGIME_GATE_ADX_THRESHOLD;
  const expiry = recommendedExpiry(timeframe, atrValue, entryPrice, isRangeWithWeakTrend);

  let calibratedProbability: number | null;
  let calibrationSource: 'model' | 'fallback';
  if (calibration && calibration.isReady()) {
    calibratedProbability = calibration.predict(featureVec.values);
    calibrationSource = 'model';
  } else {
    calibratedProbability = sigmoidFallback(evidence.score);
    calibrationSource = 'fallback';
  }

  // Приоритетный фильтр: если задан priorityThreshold, сигнал создаётся
  // только если его вероятность >= порога. Все сигналы, прошедшие этот
  // фильтр, гарантированно вызывают приоритетный баннер и звук —
  // см. notifySignal в tick-store/shared.ts.
  //
  // BUGFIX (аудит 2026-09-05, п.2 — реальный найденный баг, не гипотеза):
  // этот гейт ПРИМЕНЯЕТСЯ ТОЛЬКО к calibrationSource === 'model'. Раньше он
  // одинаково душил и 'model', и 'fallback' — а sigmoidFallback() ЧЕРЕЗ
  // СТРОКУ ВЫШЕ зажат в [0.35, 0.65] (см. её собственный BUGFIX-комментарий
  // от того же дня). При дефолтном priorityThreshold = 0.75
  // (settingsStore.ts) это означало: `calibratedProbability < priorityThreshold`
  // было истинным для абсолютно любого сигнала, пока calibration.isReady()
  // не станет true (>= MIN_SAMPLES = 100 резолвнутых исходов, см.
  // calibration-model.ts) — buildSignal() возвращал null на каждом баре,
  // без единого исключения. А исходы, из которых берутся сэмплы для
  // калибровки, могут появиться ТОЛЬКО из уже созданных сигналов — то есть
  // это не "сигналы реже", а полный, самоподдерживающийся тупик: 0 сигналов
  // -> 0 исходов -> калибровка никогда не станет isReady() -> 0 сигналов
  // навсегда, для любого свежего запуска приложения или (исторически, до
  // деактивации 2026-09-06 — см. useAnalyticsStore.ts::maybeRunAutoCleanup)
  // после автоудаления истории раз в сутки, которое каждый день само
  // стирало накопленные исходы и, по сути, возвращало бы приложение в это
  // же состояние.
  //
  // Fallback-вероятность в принципе не является калиброванной оценкой
  // уверенности — она намеренно зажата в узкий диапазон именно ПОТОМУ, что
  // не должна выдавать себя за такую оценку (см. её комментарий). Сравнивать
  // её с priorityThreshold, придуманным как порог РЕАЛЬНОЙ калиброванной
  // уверенности (слайдер 0.5-0.95 в SettingsPanel), некорректно категориально
  // — не только количественно. Пока модели нет, порог просто не применяется;
  // как только calibration.isReady() (100+ исходов) — calibrationSource
  // становится 'model', и фильтр начинает работать как задумано.
  // BUGFIX (аудит 2026-09-11, "0 сигналов после 100 исходов"): z-score
  // нормализация (фикс 2026-09-10) устранила насыщение predict() на константе,
  // но не устранила фундаментальную проблему: логистическая регрессия,
  // обученная ровно на MIN_SAMPLES (100) сэмплов с L2-регуляризацией, даёт
  // предсказания, сгруппированные вокруг базового винрейта. Если реальный
  // винрейт < 50% (что нормально для агрессивного M1-скальпинга), bias модели
  // отрицательный, и predict() возвращает < 0.5 для ПОЧТИ ЛЮБОГО входа.
  // Предыдущая версия фикса начинала ramp с 0.5 — но это всё равно выше, чем
  // предсказание модели с винрейтом < 50%, поэтому гейт блокировал все
  // сигналы. Тот же самоподдерживающийся тупик: 0 сигналов → 0 исходов →
  // модель никогда не дообучается.
  //
  // Фикс: confidence ramp начинается с 0 (гейт отключён) при MIN_SAMPLES и
  // линейно растёт до полного priorityThreshold при MAX_SAMPLES. На 100
  // сэмплах прогноз модели ненадёжен — нельзя фильтровать по нему вообще.
  // К 500 сэмплам модель достаточно обучена, и полный порог корректен.
  const modelSampleCount = calibration?.getSampleCount() ?? 0;
  const rampFraction =
    modelSampleCount >= MAX_SAMPLES
      ? 1
      : Math.max(0, (modelSampleCount - MIN_SAMPLES) / (MAX_SAMPLES - MIN_SAMPLES));
  const rampFloor = priorityThreshold !== undefined
    ? priorityThreshold * rampFraction
    : 0;

  if (
    priorityThreshold !== undefined &&
    calibrationSource !== 'fallback' &&
    calibratedProbability !== null &&
    calibratedProbability < rampFloor
  ) {
    return null;
  }

  return {
    id: generateSignalId(symbolId, timeframe, lastCandle.time),
    symbolId,
    direction: evidence.direction,
    strength: strengthFor(evidence.score),
    score: evidence.score,
    calibratedProbability,
    calibrationSource,
    entryPrice: levels.entry,
    stopLoss: levels.stopLoss,
    takeProfit: levels.takeProfit,
    reason: evidence.reasons.join('; '),
    indicators: snapshot.indicators,
    pattern: evidence.pattern?.name ?? null,
    time: lastCandle.time,
    timeframe,
    outcome: 'pending',
    frozenAt: null,
    isRevised: false,
    isPreClose: false,
    revisionNote: null,
    barsToResolve,
    spread: spreadInfo.spread,
    spreadSource: spreadInfo.source,
    recommendedExpiry: expiry,
    featureVector: featureVec.values,
    factors: evidence.factors,
    rejectedPatterns: evidence.rejectedPatterns,
    engineConfigSnapshot: {
      indicatorConfig: config,
      signalToggles,
      activeFeatures,
      atrMultiplier,
    },
    chartContext: {
      ...EMPTY_CHART_CONTEXT,
      // candlesAfter/excursion заполняются позже, в момент резолва исхода
      // (см. tick-store/outcomes.ts) — будущих свечей на момент создания
      // сигнала ещё не существует. candlesBefore доступны прямо сейчас.
      //
      // Фикс (Реальные проблемы, п.1): раньше срез заканчивался на
      // `candles.length - 1` (исключая последний индекс) — то есть саму
      // свечу сигнала (lastCandle, её же time идёт в signal.time чуть
      // ниже). candlesAfter в outcomes.ts/outcome-scheduler.ts берёт
      // только строго `c.time > signal.time`, тоже без свечи входа. В
      // сумме candlesBefore + candlesAfter НЕ содержали саму свечу входа
      // вообще — а ради визуальной реконструкции входа (замена скриншота)
      // это самая важная свеча в chartContext. Теперь конец среза —
      // `candles.length` (включительно), поэтому lastCandle — последний
      // элемент candlesBefore, а candlesAfter (по-прежнему строго после)
      // достраивает её с другой стороны без дублирования.
      candlesBefore: candles.slice(Math.max(0, candles.length - CONTEXT_CANDLES_BEFORE), candles.length),
    },
    marketContext: {
      regime: snapshot.regime,
      structure: snapshot.structure,
      session: sessionRegime,
    },
  };
}

// Сколько свечей ДО сигнала (включительно, считая саму свечу входа —
// см. фикс выше) сохранять в chartContext.candlesBefore — для
// реконструкции визуального контекста входа без скриншота (см. постмортем-
// отчёт в lib/trade-report.ts). 20 свечей достаточно, чтобы увидеть
// структуру (BOS/CHoCH, OB/FVG зоны), не раздувая объект сигнала.
const CONTEXT_CANDLES_BEFORE = 20;

export function generateSignalId(symbolId: string, timeframe: Timeframe, candleTime: number): string {
  return `${symbolId}:${timeframe}:${candleTime}`;
}

export function shouldRevise(currentScore: number, previousScore: number): boolean {
  return Math.abs(currentScore - previousScore) > REVISION_DELTA_THRESHOLD;
}

export function reviseSignal(
  signal: Signal,
  newScore: number,
  newReasons: string,
  newSnapshot: Snapshot,
  calibration: CalibrationModel | null,
  // Опционально — структурированная атрибуция пересчитанного сигнала.
  // Необязательный параметр (а не обязательный) для обратной совместимости
  // с существующими вызовами/тестами: без него revised.factors/
  // rejectedPatterns/engineConfigSnapshot/chartContext остаются от исходного
  // signal, что лучше, чем стирать их в пустоту, если вызывающий код ещё не
  // пересчитал новую атрибуцию.
  extras?: Partial<Pick<Signal, 'factors' | 'rejectedPatterns' | 'engineConfigSnapshot' | 'chartContext' | 'marketContext'>>,
): Signal {
  const featureVec = buildFeatureVector(newSnapshot);
  let calibratedProbability: number;
  let calibrationSource: 'model' | 'fallback';
  if (calibration && calibration.isReady()) {
    calibratedProbability = calibration.predict(featureVec.values);
    calibrationSource = 'model';
  } else {
    calibratedProbability = sigmoidFallback(newScore);
    calibrationSource = 'fallback';
  }

  return {
    ...signal,
    factors: extras?.factors ?? signal.factors,
    rejectedPatterns: extras?.rejectedPatterns ?? signal.rejectedPatterns,
    engineConfigSnapshot: extras?.engineConfigSnapshot ?? signal.engineConfigSnapshot,
    chartContext: extras?.chartContext ?? signal.chartContext,
    marketContext: extras?.marketContext ?? signal.marketContext,
    score: newScore,
    reason: newReasons,
    indicators: newSnapshot.indicators,
    calibratedProbability,
    calibrationSource,
    isRevised: true,
    revisionNote: `Score changed from ${signal.score} to ${newScore}`,
  };
}
