import { describe, it, expect } from 'vitest';
import type { FactorStatRow } from '@/ui/factor-analytics';
import { MIN_FACTOR_SAMPLES } from '@/ui/factor-analytics';
import {
  computeReliabilitySuggestions,
  toMultiplierUpdates,
  suggestedMultiplierFromWinRate,
} from './pattern-reliability-calibration';
import { STRATEGY_BONUS_PATTERNS, RELIABILITY_MULTIPLIER_MIN, RELIABILITY_MULTIPLIER_MAX } from './pattern-categories';

function row(overrides: Partial<FactorStatRow>): FactorStatRow {
  return {
    name: 'doji',
    kind: 'pattern',
    sampleCount: 10,
    decidedCount: 10,
    wins: 5,
    winRate: 0.5,
    ...overrides,
  };
}

describe('suggestedMultiplierFromWinRate', () => {
  it('maps a 50% (breakeven) winRate to multiplier 1', () => {
    expect(suggestedMultiplierFromWinRate(0.5)).toBe(1);
  });

  it('clamps very high winRate to RELIABILITY_MULTIPLIER_MAX', () => {
    expect(suggestedMultiplierFromWinRate(1)).toBe(RELIABILITY_MULTIPLIER_MAX);
  });

  it('clamps very low winRate to RELIABILITY_MULTIPLIER_MIN', () => {
    expect(suggestedMultiplierFromWinRate(0)).toBe(RELIABILITY_MULTIPLIER_MIN);
  });
});

describe('computeReliabilitySuggestions', () => {
  it('suggests a lowered multiplier for a low-winRate pattern with enough samples', () => {
    const stats = [row({ name: 'inside-bar', decidedCount: 19, wins: 5, winRate: 5 / 19 })];
    const suggestions = computeReliabilitySuggestions(stats, {});
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].name).toBe('inside-bar');
    expect(suggestions[0].after).toBeLessThan(1);
    expect(suggestions[0].after).toBeGreaterThanOrEqual(RELIABILITY_MULTIPLIER_MIN);
  });

  it('excludes rows below MIN_FACTOR_SAMPLES decidedCount', () => {
    const stats = [row({ name: 'doji', decidedCount: MIN_FACTOR_SAMPLES - 1, winRate: 0.9 })];
    expect(computeReliabilitySuggestions(stats, {})).toEqual([]);
  });

  it('excludes rows whose name is not a valid PatternName (indicators, structure, filters)', () => {
    const stats = [
      row({ name: 'rsi', kind: 'indicator', decidedCount: 20, winRate: 0.2 }),
      row({ name: 'bos', kind: 'bos', decidedCount: 20, winRate: 0.2 }),
      row({ name: 'signal-filter', kind: 'filter', decidedCount: 20, winRate: 0.2 }),
    ];
    expect(computeReliabilitySuggestions(stats, {})).toEqual([]);
  });

  it('excludes STRATEGY_BONUS_PATTERNS entries, even if they look like eligible pattern rows', () => {
    expect(STRATEGY_BONUS_PATTERNS.length).toBeGreaterThan(0);
    const stats = STRATEGY_BONUS_PATTERNS.map((name) =>
      row({ name, decidedCount: 20, wins: 4, winRate: 0.2 }),
    );
    expect(computeReliabilitySuggestions(stats, {})).toEqual([]);
  });

  it('excludes rows with a null winRate (no decided trades)', () => {
    const stats = [row({ name: 'doji', decidedCount: MIN_FACTOR_SAMPLES, winRate: null })];
    expect(computeReliabilitySuggestions(stats, {})).toEqual([]);
  });

  it('reports "before" from the provided currentOverrides, not hardcoded 1', () => {
    const stats = [row({ name: 'doji', decidedCount: 10, wins: 5, winRate: 0.5 })];
    const suggestions = computeReliabilitySuggestions(stats, { doji: 0.7 });
    expect(suggestions[0].before).toBe(0.7);
    expect(suggestions[0].after).toBe(1);
    expect(suggestions[0].changed).toBe(true);
  });

  it('marks changed=false when the recomputed multiplier matches the current override', () => {
    const stats = [row({ name: 'doji', decidedCount: 10, wins: 5, winRate: 0.5 })];
    const suggestions = computeReliabilitySuggestions(stats, { doji: 1 });
    expect(suggestions[0].changed).toBe(false);
  });

  it('sorts changed suggestions before unchanged ones', () => {
    const stats = [
      row({ name: 'doji', decidedCount: 10, wins: 5, winRate: 0.5 }), // unchanged (before=1)
      row({ name: 'hammer', decidedCount: 10, wins: 2, winRate: 0.2 }), // changed
    ];
    const suggestions = computeReliabilitySuggestions(stats, { doji: 1, hammer: 1 });
    expect(suggestions[0].name).toBe('hammer');
    expect(suggestions[0].changed).toBe(true);
  });
});

describe('toMultiplierUpdates', () => {
  it('builds a name -> after map from suggestions', () => {
    const stats = [row({ name: 'doji', decidedCount: 10, wins: 2, winRate: 0.2 })];
    const suggestions = computeReliabilitySuggestions(stats, {});
    const updates = toMultiplierUpdates(suggestions);
    expect(updates.doji).toBe(suggestions[0].after);
    expect(Object.keys(updates)).toHaveLength(1);
  });
});
