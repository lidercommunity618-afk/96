import type { IndicatorSnapshot } from '@/types/domain';

export interface TradeLevels {
  entry: number;
  stopLoss: number;
  takeProfit: number;
}

export function computeTradeLevels(
  entryPrice: number,
  atr: number,
  atrMultiplier: number,
  direction: 'buy' | 'sell',
): TradeLevels {
  const stopDistance = atr * atrMultiplier;
  const isBuy = direction === 'buy';
  return {
    entry: entryPrice,
    stopLoss: isBuy ? entryPrice - stopDistance : entryPrice + stopDistance,
    takeProfit: isBuy ? entryPrice + stopDistance * 2 : entryPrice - stopDistance * 2,
  };
}

// Shared by live trading and backtest. TP is always fixed at 2x the stop
// distance (see computeTradeLevels), so R:R is always exactly 2.0 by
// construction — there is no meaningful R:R threshold to gate on here.
// (There used to be a `riskRewardRatio(levels) < MIN_RR` check, but since
// R:R is always 2.0 for any stopDistance > 0, that condition could only
// ever be true when risk <= 0 — already covered by the atrValue <= 0 gate
// in signal-builder.ts. It was dead code that misleadingly suggested R:R
// was a configurable quality filter, so it was removed. If a real R:R
// filter is wanted, takeProfit needs to depend on something other than a
// hardcoded multiplier — e.g. nearby S/R or order-block levels.)
export function estimateTradeLevels(
  entryPrice: number,
  atr: number,
  atrMultiplier: number,
  direction: 'buy' | 'sell',
): TradeLevels {
  return computeTradeLevels(entryPrice, atr, atrMultiplier, direction);
}

// Structural stop/target for breakout-type strategies (currently
// impulse-breakout). The shared computeTradeLevels() above places the stop
// at an arbitrary atrMultiplier*ATR distance from entry — for a breakout
// that is methodologically backwards: the signal candle's body is already
// required to be >=1x ATR (>=1.2x when volume is unreliable, see
// impulse-breakout.ts), so at the userʼs minimum atrMultiplier (0.5) the
// stop sits *inside* the very candle that generated the signal, guaranteeing
// an almost immediate stop-out. A breakout stop belongs beyond the extreme
// of the breakout candle itself (the level that was just taken out), not at
// a fixed ATR distance from close.
export function computeBreakoutTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  breakoutCandleLow: number,
  breakoutCandleHigh: number,
  atrValue: number,
  buffer: number = 0.1,
): TradeLevels {
  const stopLoss =
    direction === 'buy'
      ? breakoutCandleLow - atrValue * buffer
      : breakoutCandleHigh + atrValue * buffer;
  const stopDistance = Math.abs(entryPrice - stopLoss);
  return {
    entry: entryPrice,
    stopLoss,
    takeProfit:
      direction === 'buy'
        ? entryPrice + stopDistance * 2
        : entryPrice - stopDistance * 2,
  };
}

// Structural stop/target for liquidity-sweep-reaction (audit finding #6:
// previously this pattern used the shared computeTradeLevels()'s flat
// atrMultiplier*ATR stop with a fixed 2.0 R:R, which ignores the very
// structure the pattern already detected — the sweep bar's own extreme is
// the ICT-correct place for the stop, and the nearest opposite-side
// liquidity zone (OB/FVG) is the ICT-correct take-profit target, not an
// arbitrary multiple.
//
// - SL: buy -> sweepBarLow - buffer*ATR; sell -> sweepBarHigh + buffer*ATR.
//   If the actual sweep was shallower than atrMultiplier*ATR the old formula
//   would have made the stop wider than necessary for no reason; if the
//   sweep was deeper, the old stop could land *inside* the zone that was
//   just swept, getting stopped out by noise before the real move.
// - TP: the nearest opposite-side OB/FVG edge beyond entry (precomputed by
//   the detector via nearestOppositeZonePrice, since it already has
//   smartMoney in scope) — but only if that target clears the minimum R:R;
//   otherwise fall back to the shared 2x-stopDistance target, exactly like
//   computeBreakoutTradeLevels. See strategy doc §7-8 and audit finding #6.
export function computeLiquiditySweepTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  sweepBarLow: number,
  sweepBarHigh: number,
  nearestOppositeZone: number | null,
  atrValue: number,
  buffer: number = 0.1,
  minRR: number = 1.5,
): TradeLevels {
  const stopLoss =
    direction === 'buy'
      ? sweepBarLow - atrValue * buffer
      : sweepBarHigh + atrValue * buffer;
  const stopDistance = Math.abs(entryPrice - stopLoss);

  const fallbackTakeProfit =
    direction === 'buy'
      ? entryPrice + stopDistance * 2
      : entryPrice - stopDistance * 2;

  if (nearestOppositeZone !== null && stopDistance > 0) {
    const rewardDistance = Math.abs(nearestOppositeZone - entryPrice);
    if (rewardDistance / stopDistance >= minRR) {
      return { entry: entryPrice, stopLoss, takeProfit: nearestOppositeZone };
    }
  }

  return { entry: entryPrice, stopLoss, takeProfit: fallbackTakeProfit };
}

// Structural TP for order-block-continuation (audit finding #3: targetZone
// was computed by findTargetZone() in the detector but never used — the signal
// fell through to estimateTradeLevels with a flat ATR×2 TP that ignores real
// market structure). Uses the same pattern as computeLiquiditySweepTradeLevels:
// structural target is used only if it yields RR >= minRR, otherwise falls back
// to the shared computeTradeLevels TP. Stop loss stays at the shared ATR-based
// level — OBC doesn't have a structural stop like breakout/sweep do.
export function computeOrderBlockContinuationTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  targetZone: number | undefined,
  atrValue: number,
  atrMultiplier: number,
  minRR: number = 1.5,
): TradeLevels {
  const base = computeTradeLevels(entryPrice, atrValue, atrMultiplier, direction);
  if (targetZone === undefined) return base;

  const stopDistance = Math.abs(entryPrice - base.stopLoss);
  const rewardDistance = Math.abs(targetZone - entryPrice);
  if (stopDistance > 0 && rewardDistance / stopDistance >= minRR) {
    return { ...base, takeProfit: targetZone };
  }
  return base;
}

// Structural SL/TP for harmonic patterns (Gartley/Butterfly/AB=CD) — same
// two-step approach as computeLiquiditySweepTradeLevels/
// computeOrderBlockContinuationTradeLevels above. The detector precomputes
// harmonicStop (beyond point D/X, with an ATR buffer already baked in) and
// harmonicTarget (a Fibonacci projection off point D). The structural
// SL/TP pair is used only if it clears minRR; otherwise falls back entirely
// to the shared ATR-based computeTradeLevels (stop included — unlike OBC,
// a harmonic pattern has no separate "generic" stop of its own to keep).
export function computeHarmonicTradeLevels(
  entryPrice: number,
  direction: 'buy' | 'sell',
  harmonicStop: number | undefined,
  harmonicTarget: number | undefined,
  atrValue: number,
  atrMultiplier: number,
  minRR: number = 1.5,
): TradeLevels {
  const base = computeTradeLevels(entryPrice, atrValue, atrMultiplier, direction);
  if (harmonicStop === undefined || harmonicTarget === undefined) return base;

  const stopDistance = Math.abs(entryPrice - harmonicStop);
  const rewardDistance = Math.abs(harmonicTarget - entryPrice);
  if (stopDistance > 0 && rewardDistance / stopDistance >= minRR) {
    return { entry: entryPrice, stopLoss: harmonicStop, takeProfit: harmonicTarget };
  }
  return base;
}

export function avgRangeFromSnapshot(
  candles: { high: number; low: number }[],
  period: number,
): number {
  const slice = candles.slice(-period);
  if (slice.length === 0) return 0;
  let sum = 0;
  for (const c of slice) sum += c.high - c.low;
  return sum / slice.length;
}

export function fallbackAtr(snapshot: IndicatorSnapshot, candles: { high: number; low: number }[], period: number): number {
  if (snapshot.atr !== null && snapshot.atr > 0) return snapshot.atr;
  return avgRangeFromSnapshot(candles, period);
}
