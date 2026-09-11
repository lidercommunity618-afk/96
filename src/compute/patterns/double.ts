import type { Candle, PatternResult, SignalStrength, SignalDirection } from '@/types/domain';
import { clamp01, averageVolume } from '@/compute/indicators/helpers';
import type { PatternContext } from './pattern-context';
import {
  sessionBoost,
  htfAlignment,
  volumeFactor,
  isAsiaOrClosed,
  nextCandleConfirmation,
  hasPrecedingBullish,
  hasPrecedingBearish,
  atrFactor,
  penetrationFactor,
  tweezerVolumeFactor,
} from './pattern-context';

const ENGULFING_THRESHOLD = 1.0;

function strengthForConfidence(confidence: number): SignalStrength {
  if (confidence >= 0.75) return 'strong';
  if (confidence >= 0.5) return 'moderate';
  return 'weak';
}

// ─────────────────────────────────────────────────────────────────────────
// Bullish / Bearish Engulfing — context-aware (HTF approximation, session,
// volume, ATR, optional next-candle confirmation).
// prevCandle = candles[index-1], curCandle = candles[index] (the engulfing
// candle itself), confirmCandle = candles[index+1] (optional 3rd-candle
// confirmation per the methodology — not mandatory, only a multiplier).
// ─────────────────────────────────────────────────────────────────────────

export function detectBullishEngulfing(ctx: PatternContext): PatternResult | null {
  const { candles, index, structure, session, indicators } = ctx;
  const prevCandle = candles[index - 1];
  const curCandle = candles[index];
  const confirmCandle = candles[index + 1];
  if (!prevCandle || !curCandle || !confirmCandle) return null;

  const prevBody = Math.abs(prevCandle.close - prevCandle.open);
  const curBody = Math.abs(curCandle.close - curCandle.open);
  if (prevCandle.close >= prevCandle.open) return null;
  if (curCandle.close <= curCandle.open) return null;
  if (curBody < prevBody * ENGULFING_THRESHOLD) return null;
  if (!(curCandle.open <= prevCandle.close && curCandle.close >= prevCandle.open)) return null;

  const direction: SignalDirection = 'buy';

  // Обязателен предшествующий противотрендовый (медвежий) импульс.
  if (!hasPrecedingBearish(candles, index - 1, 5) && structure.trend !== 'down') return null;
  if (isAsiaOrClosed(session)) return null;

  const avgVol = averageVolume(candles, 20, index);
  const volumeRatio = avgVol > 0 ? curCandle.volume / avgVol : 0;
  if (volumeRatio < 1.0) return null;

  const atrValue = indicators?.atr ?? null;
  const curRange = curCandle.high - curCandle.low;
  if (atrValue != null && curRange < 0.8 * atrValue) return null;

  const conf = nextCandleConfirmation(curCandle, confirmCandle, direction);
  if (conf.contradicted) return null;

  const upperWick = curCandle.high - Math.max(curCandle.open, curCandle.close);
  const lowerWick = Math.min(curCandle.open, curCandle.close) - curCandle.low;
  const shortWicks = curBody > 0 && (upperWick + lowerWick) < 0.15 * curBody;
  const fullWickEngulf = curCandle.high >= prevCandle.high && curCandle.low <= prevCandle.low;

  const bodyRatio = Math.min(3, curBody / (prevBody || 1e-9));
  const base = clamp01(
    Math.min(0.30, bodyRatio * 0.10) +
    (fullWickEngulf ? 0.10 : 0) +
    (shortWicks ? 0.10 : 0),
  );

  const confidence = clamp01(
    base
    * htfAlignment(structure, direction)
    * sessionBoost(session)
    * volumeFactor(volumeRatio)
    * conf.multiplier
    * atrFactor(curRange, atrValue),
  );

  if (confidence < 0.55) return null;

  return {
    name: 'bullish-engulfing',
    direction,
    confidence,
    strength: strengthForConfidence(confidence),
    time: confirmCandle.time,
    volumeConfirmed: volumeRatio >= 1.5,
    confirmedByNextCandle: conf.confirmed,
  };
}

export function detectBearishEngulfing(ctx: PatternContext): PatternResult | null {
  const { candles, index, structure, session, indicators } = ctx;
  const prevCandle = candles[index - 1];
  const curCandle = candles[index];
  const confirmCandle = candles[index + 1];
  if (!prevCandle || !curCandle || !confirmCandle) return null;

  const prevBody = Math.abs(prevCandle.close - prevCandle.open);
  const curBody = Math.abs(curCandle.close - curCandle.open);
  if (prevCandle.close <= prevCandle.open) return null;
  if (curCandle.close >= curCandle.open) return null;
  if (curBody < prevBody * ENGULFING_THRESHOLD) return null;
  if (!(curCandle.open >= prevCandle.close && curCandle.close <= prevCandle.open)) return null;

  const direction: SignalDirection = 'sell';

  // Обязателен предшествующий противотрендовый (бычий) импульс.
  if (!hasPrecedingBullish(candles, index - 1, 5) && structure.trend !== 'up') return null;
  if (isAsiaOrClosed(session)) return null;

  const avgVol = averageVolume(candles, 20, index);
  const volumeRatio = avgVol > 0 ? curCandle.volume / avgVol : 0;
  if (volumeRatio < 1.0) return null;

  const atrValue = indicators?.atr ?? null;
  const curRange = curCandle.high - curCandle.low;
  if (atrValue != null && curRange < 0.8 * atrValue) return null;

  const conf = nextCandleConfirmation(curCandle, confirmCandle, direction);
  if (conf.contradicted) return null;

  const upperWick = curCandle.high - Math.max(curCandle.open, curCandle.close);
  const lowerWick = Math.min(curCandle.open, curCandle.close) - curCandle.low;
  const shortWicks = curBody > 0 && (upperWick + lowerWick) < 0.15 * curBody;
  const fullWickEngulf = curCandle.high >= prevCandle.high && curCandle.low <= prevCandle.low;

  const bodyRatio = Math.min(3, curBody / (prevBody || 1e-9));
  const base = clamp01(
    Math.min(0.30, bodyRatio * 0.10) +
    (fullWickEngulf ? 0.10 : 0) +
    (shortWicks ? 0.10 : 0),
  );

  const confidence = clamp01(
    base
    * htfAlignment(structure, direction)
    * sessionBoost(session)
    * volumeFactor(volumeRatio)
    * conf.multiplier
    * atrFactor(curRange, atrValue),
  );

  if (confidence < 0.55) return null;

  return {
    name: 'bearish-engulfing',
    direction,
    confidence,
    strength: strengthForConfidence(confidence),
    time: confirmCandle.time,
    volumeConfirmed: volumeRatio >= 1.5,
    confirmedByNextCandle: conf.confirmed,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Bullish / Bearish Harami — UNCHANGED (out of scope for this refactor).
// ─────────────────────────────────────────────────────────────────────────

export function detectBullishHarami(prev: Candle, cur: Candle): PatternResult | null {
  const prevBody = Math.abs(prev.close - prev.open);
  const curBody = Math.abs(cur.close - cur.open);
  if (prev.close >= prev.open) return null;
  if (cur.close <= cur.open) return null;
  if (curBody >= prevBody) return null;
  if (cur.open >= prev.close && cur.close <= prev.open) {
    const confidence = clamp01(0.4 + (1 - curBody / prevBody) * 0.2);
    return {
      name: 'bullish-harami',
      direction: 'buy',
      confidence,
      strength: strengthForConfidence(confidence),
      time: cur.time,
    };
  }
  return null;
}

export function detectBearishHarami(prev: Candle, cur: Candle): PatternResult | null {
  const prevBody = Math.abs(prev.close - prev.open);
  const curBody = Math.abs(cur.close - cur.open);
  if (prev.close <= prev.open) return null;
  if (cur.close >= cur.open) return null;
  if (curBody >= prevBody) return null;
  if (cur.open <= prev.close && cur.close >= prev.open) {
    const confidence = clamp01(0.4 + (1 - curBody / prevBody) * 0.2);
    return {
      name: 'bearish-harami',
      direction: 'sell',
      confidence,
      strength: strengthForConfidence(confidence),
      time: cur.time,
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Piercing Line / Dark Cloud Cover — context-aware. Strict 50% penetration
// rule preserved. Confirmation is optional (multiplier only, not a gate),
// except an explicit contradiction from the confirming candle cancels it.
// ─────────────────────────────────────────────────────────────────────────

export function detectPiercingLine(ctx: PatternContext): PatternResult | null {
  const { candles, index, structure, session, indicators } = ctx;
  const prevCandle = candles[index - 1];
  const curCandle = candles[index];
  const confirmCandle = candles[index + 1];
  if (!prevCandle || !curCandle || !confirmCandle) return null;

  if (prevCandle.close >= prevCandle.open) return null;
  if (curCandle.close <= curCandle.open) return null;
  if (curCandle.open >= prevCandle.low) return null;
  const midpoint = (prevCandle.open + prevCandle.close) / 2;
  if (curCandle.close <= midpoint) return null;
  if (curCandle.close >= prevCandle.open) return null;

  const direction: SignalDirection = 'buy';
  const prevBody = Math.abs(prevCandle.close - prevCandle.open);
  const atrValue = indicators?.atr ?? null;
  const curBody = Math.abs(curCandle.close - curCandle.open);
  if (atrValue != null && (prevBody < 0.5 * atrValue || curBody < 0.5 * atrValue)) return null;

  if (!hasPrecedingBearish(candles, index - 1, 5) && structure.trend !== 'down') return null;
  if (isAsiaOrClosed(session)) return null;

  const avgVol = averageVolume(candles, 20, index);
  const volumeRatio = avgVol > 0 ? curCandle.volume / avgVol : 0;
  if (volumeRatio < 1.3) return null;

  const conf = nextCandleConfirmation(curCandle, confirmCandle, direction);
  if (conf.contradicted) return null;

  const prevBodyBottom = Math.min(prevCandle.open, prevCandle.close);
  const penetrationRatio = prevBody > 0 ? (curCandle.close - prevBodyBottom) / prevBody : 0;

  const base = 0.50;
  const confidence = clamp01(
    base
    * htfAlignment(structure, direction)
    * sessionBoost(session)
    * volumeFactor(volumeRatio)
    * penetrationFactor(penetrationRatio)
    * conf.multiplier,
  );

  if (confidence < 0.5) return null;

  return {
    name: 'piercing-line',
    direction,
    confidence,
    strength: strengthForConfidence(confidence),
    time: confirmCandle.time,
    volumeConfirmed: volumeRatio >= 1.5,
    confirmedByNextCandle: conf.confirmed,
  };
}

export function detectDarkCloudCover(ctx: PatternContext): PatternResult | null {
  const { candles, index, structure, session, indicators } = ctx;
  const prevCandle = candles[index - 1];
  const curCandle = candles[index];
  const confirmCandle = candles[index + 1];
  if (!prevCandle || !curCandle || !confirmCandle) return null;

  if (prevCandle.close <= prevCandle.open) return null;
  if (curCandle.close >= curCandle.open) return null;
  if (curCandle.open <= prevCandle.high) return null;
  const midpoint = (prevCandle.open + prevCandle.close) / 2;
  if (curCandle.close >= midpoint) return null;
  if (curCandle.close <= prevCandle.open) return null;

  const direction: SignalDirection = 'sell';
  const prevBody = Math.abs(prevCandle.close - prevCandle.open);
  const atrValue = indicators?.atr ?? null;
  const curBody = Math.abs(curCandle.close - curCandle.open);
  if (atrValue != null && (prevBody < 0.5 * atrValue || curBody < 0.5 * atrValue)) return null;

  if (!hasPrecedingBullish(candles, index - 1, 5) && structure.trend !== 'up') return null;
  if (isAsiaOrClosed(session)) return null;

  const avgVol = averageVolume(candles, 20, index);
  const volumeRatio = avgVol > 0 ? curCandle.volume / avgVol : 0;
  if (volumeRatio < 1.3) return null;

  const conf = nextCandleConfirmation(curCandle, confirmCandle, direction);
  if (conf.contradicted) return null;

  const prevBodyTop = Math.max(prevCandle.open, prevCandle.close);
  const penetrationRatio = prevBody > 0 ? (prevBodyTop - curCandle.close) / prevBody : 0;

  const base = 0.50;
  const confidence = clamp01(
    base
    * htfAlignment(structure, direction)
    * sessionBoost(session)
    * volumeFactor(volumeRatio)
    * penetrationFactor(penetrationRatio)
    * conf.multiplier,
  );

  if (confidence < 0.5) return null;

  return {
    name: 'dark-cloud-cover',
    direction,
    confidence,
    strength: strengthForConfidence(confidence),
    time: confirmCandle.time,
    volumeConfirmed: volumeRatio >= 1.5,
    confirmedByNextCandle: conf.confirmed,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Tweezer Bottom / Tweezer Top — context-aware. Per the methodology's
// explicit "golden rule" ("never enter without 3rd-candle confirmation —
// on its own, the pattern is only a warning"), confirmation is MANDATORY
// here (same treatment as Hanging Man / Inverted Hammer): no confirmation
// means no signal at all, not just a lower confidence.
// ─────────────────────────────────────────────────────────────────────────

const TWEEZER_TOLERANCE = 0.001;

export function detectTweezerBottom(ctx: PatternContext): PatternResult | null {
  const { candles, index, structure, session, indicators } = ctx;
  const prevCandle = candles[index - 1];
  const curCandle = candles[index];
  const confirmCandle = candles[index + 1];
  if (!prevCandle || !curCandle || !confirmCandle) return null;

  const tolerance = Math.max(prevCandle.low, curCandle.low) * TWEEZER_TOLERANCE;
  if (Math.abs(prevCandle.low - curCandle.low) > tolerance) return null;
  if (curCandle.close <= curCandle.open) return null;

  const direction: SignalDirection = 'buy';

  if (!hasPrecedingBearish(candles, index - 1, 5) && structure.trend !== 'down') return null;
  if (isAsiaOrClosed(session)) return null;

  const rsi = indicators?.rsi ?? null;
  if (rsi != null && rsi > 50) return null;

  const conf = nextCandleConfirmation(curCandle, confirmCandle, direction);
  if (!conf.confirmed) return null; // обязательное подтверждение — золотое правило методички

  const base = 0.40;
  const rsiFactor = rsi == null ? 1.0
    : rsi < 30 ? 1.10
    : rsi <= 35 ? 1.00
    : rsi <= 50 ? 0.85
    : 0.70;

  const confidence = clamp01(
    base
    * htfAlignment(structure, direction)
    * sessionBoost(session)
    * tweezerVolumeFactor(curCandle.volume, prevCandle.volume)
    * conf.multiplier
    * rsiFactor,
  );

  if (confidence < 0.5) return null;

  return {
    name: 'tweezer-bottom',
    direction,
    confidence,
    strength: strengthForConfidence(confidence),
    time: confirmCandle.time,
    confirmedByNextCandle: true,
  };
}

export function detectTweezerTop(ctx: PatternContext): PatternResult | null {
  const { candles, index, structure, session, indicators } = ctx;
  const prevCandle = candles[index - 1];
  const curCandle = candles[index];
  const confirmCandle = candles[index + 1];
  if (!prevCandle || !curCandle || !confirmCandle) return null;

  const tolerance = Math.max(prevCandle.high, curCandle.high) * TWEEZER_TOLERANCE;
  if (Math.abs(prevCandle.high - curCandle.high) > tolerance) return null;
  if (curCandle.close >= curCandle.open) return null;

  const direction: SignalDirection = 'sell';

  if (!hasPrecedingBullish(candles, index - 1, 5) && structure.trend !== 'up') return null;
  if (isAsiaOrClosed(session)) return null;

  const rsi = indicators?.rsi ?? null;
  if (rsi != null && rsi < 50) return null;

  const conf = nextCandleConfirmation(curCandle, confirmCandle, direction);
  if (!conf.confirmed) return null; // обязательное подтверждение — золотое правило методички

  const base = 0.40;
  const rsiFactor = rsi == null ? 1.0
    : rsi > 70 ? 1.10
    : rsi >= 65 ? 1.00
    : rsi >= 50 ? 0.85
    : 0.70;

  const confidence = clamp01(
    base
    * htfAlignment(structure, direction)
    * sessionBoost(session)
    * tweezerVolumeFactor(curCandle.volume, prevCandle.volume)
    * conf.multiplier
    * rsiFactor,
  );

  if (confidence < 0.5) return null;

  return {
    name: 'tweezer-top',
    direction,
    confidence,
    strength: strengthForConfidence(confidence),
    time: confirmCandle.time,
    confirmedByNextCandle: true,
  };
}
