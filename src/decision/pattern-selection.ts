import type { PatternName, PatternResult, RejectedPattern } from '@/types/domain';

export interface PatternSelection {
  top: PatternResult;
  sameDir: PatternResult[];
  fusionConfidence: number;
  // Паттерны, сработавшие на этой же свече, но не ставшие top — для
  // постмортема убыточной сделки важно видеть, что альтернативный
  // (возможно, встречный) сигнал был отклонён, а не просто отсутствовал.
  // См. RejectedPattern в types/domain.ts.
  rejected: RejectedPattern[];
}

// SMC/ICT-based structural patterns (liquidity sweep, order blocks, FVGs)
// rest on 5+ independently-checked conditions — volume, ATR-displacement,
// BOS/CHoCH, session, OB/FVG confluence — so a 0.72 confidence there reflects
// a genuinely more corroborated setup than a 0.72 (or even a slightly higher)
// confidence on a single-candle formation like hammer/doji/pin-bar, which is
// mostly geometry plus a couple of context factors. Before this priority
// existed, selectTopPattern() picked purely by raw confidence — so a
// one-candle pattern could silently "hide" a higher-quality SMC setup firing
// in the opposite direction on the same bar (see the "Реакция на снятие
// ликвидности" audit, finding #4: "selectTopPattern может спрятать LSR под
// свечной узор"). Patterns not listed default to priority 0 (lowest); ties
// within the same class still fall back to raw confidence, so this only
// changes outcomes when classes actually conflict.
const PATTERN_CLASS_PRIORITY: Partial<Record<PatternName, number>> = {
  'liquidity-sweep-reaction': 2,
  'liquidity-sweep': 2,
  'strong-order-block-reaction': 2,
  'order-block-continuation': 2,
  'order-block-breaker': 2,
  'order-block-nested': 2,
  'fvg-nested': 2,
  'fvg-breaker-block': 2,
  'fvg-rejection': 2,
  'fvg-return': 2,
  'harmonic-pattern': 2,
  'impulse-breakout': 1,
  'consolidation-breakout': 1,
  'macd-deceleration-continuation': 1,
  'mean-reversion': 1,
  'rising-three-methods': 1,
  'falling-three-methods': 1,
};

function classPriority(p: PatternResult): number {
  return PATTERN_CLASS_PRIORITY[p.name] ?? 0;
}

export function selectTopPattern(patterns: PatternResult[]): PatternSelection | null {
  if (patterns.length === 0) return null;
  const top = [...patterns].sort((a, b) => {
    const classDiff = classPriority(b) - classPriority(a);
    if (classDiff !== 0) return classDiff;
    return b.confidence - a.confidence;
  })[0];
  const sameDir = patterns.filter((p) => p.direction === top.direction);
  const fusionConfidence = sameDir.length >= 2
    ? Math.min(1, top.confidence + 0.1 * (sameDir.length - 1))
    : top.confidence;

  // Всё, что НЕ вошло в sameDir (top + согласные с ним по направлению) —
  // либо противоположное направление, либо тот же класс/направление, но с
  // более низким приоритетом класса (при равном направлении и sameDir уже
  // включает все паттерны того же направления независимо от confidence, так
  // что "lower-confidence" здесь фактически недостижим для sameDir-паттернов
  // — они все top.direction; оставлен как явный случай на будущее, если
  // sameDir когда-либо станет более строгим).
  const rejected: RejectedPattern[] = patterns
    .filter((p) => p !== top && !sameDir.includes(p))
    .map((p) => ({
      name: p.name,
      direction: p.direction,
      confidence: p.confidence,
      reasonNotSelected: p.direction !== top.direction
        ? 'opposite-direction'
        : classPriority(p) < classPriority(top)
        ? 'lower-class-priority'
        : 'lower-confidence',
    }));

  return { top, sameDir, fusionConfidence, rejected };
}
