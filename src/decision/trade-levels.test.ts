import { describe, it, expect } from 'vitest';
import { computeBreakoutTradeLevels, computeLiquiditySweepTradeLevels, computeTradeLevels } from '@/decision/trade-levels';

describe('computeBreakoutTradeLevels (Пункт 6 — structural SL/TP for impulse-breakout)', () => {
  it('places a buy stop below the breakout candle low, never inside its body', () => {
    // Breakout candle: low=99.8, high=104.3; entry at close=104.
    const levels = computeBreakoutTradeLevels(104, 'buy', 99.8, 104.3, 2);
    expect(levels.stopLoss).toBeLessThan(99.8);
  });

  it('places a sell stop above the breakout candle high, never inside its body', () => {
    const levels = computeBreakoutTradeLevels(96, 'sell', 95.7, 100.2, 2);
    expect(levels.stopLoss).toBeGreaterThan(100.2);
  });

  it('keeps R:R fixed at 2.0 regardless of how far the stop sits from entry', () => {
    const levels = computeBreakoutTradeLevels(104, 'buy', 99.8, 104.3, 2);
    const risk = Math.abs(levels.entry - levels.stopLoss);
    const reward = Math.abs(levels.takeProfit - levels.entry);
    expect(reward / risk).toBeCloseTo(2.0, 6);
  });

  it('never places the stop inside the signal candle even at the shared atrMultiplier minimum (0.5), unlike the fixed-ATR stop it replaces', () => {
    // Breakout candle body is required to be >=1x ATR by the pattern's own
    // entry gate. At the old shared computeTradeLevels() with the user's
    // minimum atrMultiplier (0.5), the stop would land 0.5*ATR from entry —
    // inside a >=1*ATR candle body. computeBreakoutTradeLevels is immune to
    // this because it isn't parameterized by atrMultiplier at all; it's
    // anchored to the actual breakout candle extreme.
    const atrValue = 2;
    const entry = 104; // close
    const breakoutLow = 99.8; // candle body/range comfortably >1x ATR below entry
    const oldStyleStop = computeTradeLevels(entry, atrValue, 0.5, 'buy').stopLoss; // = 103
    expect(oldStyleStop).toBeGreaterThan(breakoutLow); // old stop sits inside the candle
    const newLevels = computeBreakoutTradeLevels(entry, 'buy', breakoutLow, 104.3, atrValue);
    expect(newLevels.stopLoss).toBeLessThan(breakoutLow); // new stop sits beyond it
  });
});

describe('computeLiquiditySweepTradeLevels (audit finding #6 — structural SL/TP for liquidity-sweep-reaction)', () => {
  it('places a buy stop below the sweep bar low, never at a fixed ATR distance from entry', () => {
    // Sweep bar: low=97.6, high=99.9. Entry (displacement close) at 100.5.
    const levels = computeLiquiditySweepTradeLevels(100.5, 'buy', 97.6, 99.9, null, 1.2);
    expect(levels.stopLoss).toBeLessThan(97.6);
    expect(levels.stopLoss).toBeCloseTo(97.6 - 1.2 * 0.1, 6);
  });

  it('places a sell stop above the sweep bar high', () => {
    const levels = computeLiquiditySweepTradeLevels(99.5, 'sell', 99.6, 102.4, null, 1.2);
    expect(levels.stopLoss).toBeGreaterThan(102.4);
    expect(levels.stopLoss).toBeCloseTo(102.4 + 1.2 * 0.1, 6);
  });

  it('falls back to 2x stopDistance when no opposite zone is supplied', () => {
    const levels = computeLiquiditySweepTradeLevels(100.5, 'buy', 97.6, 99.9, null, 1.2);
    const risk = Math.abs(levels.entry - levels.stopLoss);
    const reward = Math.abs(levels.takeProfit - levels.entry);
    expect(reward / risk).toBeCloseTo(2.0, 6);
  });

  it('targets the nearest opposite liquidity zone when it clears the minimum R:R', () => {
    // Stop distance ≈ 100.5 - (97.6 - 0.12) = 3.02. A zone at 110 gives
    // reward ≈ 9.5, RR ≈ 3.15 — comfortably above the 1.5 minimum.
    const levels = computeLiquiditySweepTradeLevels(100.5, 'buy', 97.6, 99.9, 110, 1.2);
    expect(levels.takeProfit).toBe(110);
  });

  it('falls back to 2x stopDistance when the opposite zone is too close for the minimum R:R', () => {
    // Zone at 101 gives reward ≈ 0.5 against a stop distance ≈ 3.02 — RR well
    // under 1.5, so the structural target must be rejected in favor of the
    // fallback (which is always exactly RR=2.0 by construction).
    const levels = computeLiquiditySweepTradeLevels(100.5, 'buy', 97.6, 99.9, 101, 1.2);
    const risk = Math.abs(levels.entry - levels.stopLoss);
    const reward = Math.abs(levels.takeProfit - levels.entry);
    expect(reward / risk).toBeCloseTo(2.0, 6);
    expect(levels.takeProfit).not.toBe(101);
  });

  it('mirrors zone-target selection for sell trades (zone must be below entry)', () => {
    // Stop distance ≈ (102.4 + 0.12) - 99.5 = 3.02. Zone at 90 gives
    // reward ≈ 9.5 → RR ≈ 3.15, clears the minimum.
    const levels = computeLiquiditySweepTradeLevels(99.5, 'sell', 99.6, 102.4, 90, 1.2);
    expect(levels.takeProfit).toBe(90);
  });
});
