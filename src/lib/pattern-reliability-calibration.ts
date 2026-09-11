import type { PatternName } from '@/types/domain';
import type { FactorStatRow } from '@/ui/factor-analytics';
import { MIN_FACTOR_SAMPLES } from '@/ui/factor-analytics';
import {
  PATTERN_RELIABILITY_MULTIPLIER,
  STRATEGY_BONUS_PATTERNS,
  PATTERN_LABELS_RU,
  RELIABILITY_MULTIPLIER_MIN,
  RELIABILITY_MULTIPLIER_MAX,
} from './pattern-categories';

// Этап 2 плана калибровки ("КАЛИБРОВКА" + "АНАЛИТИКА ПО ФАКТОРАМ" →
// самообучение): раньше PATTERN_RELIABILITY_MULTIPLIER правился вручную —
// кто-то смотрел на таблицу "АНАЛИТИКА ПО ФАКТОРАМ" и вписывал число в
// pattern-categories.ts. Этот модуль автоматизирует именно этот шаг —
// пересчитывает множитель по формуле из плана и возвращает предпросмотр
// "было/станет" для явного подтверждения пользователем (см.
// CalibrationPanel.tsx), не трогая саму логрегрессию (это отдельный,
// более рискованный Этап 3).

// 0.5 = условный безубыток "1 из 2" для равновероятной монеты — тот же
// baseline, что описан в исходном плане Этапа 2.
const BREAKEVEN_WIN_RATE = 0.5;

const ALL_PATTERN_NAMES = new Set<string>(Object.keys(PATTERN_LABELS_RU));
const STRATEGY_BONUS_NAME_SET = new Set<string>(STRATEGY_BONUS_PATTERNS);

function isPatternName(name: string): name is PatternName {
  return ALL_PATTERN_NAMES.has(name);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function suggestedMultiplierFromWinRate(winRate: number): number {
  return clamp(winRate / BREAKEVEN_WIN_RATE, RELIABILITY_MULTIPLIER_MIN, RELIABILITY_MULTIPLIER_MAX);
}

export interface ReliabilitySuggestion {
  name: PatternName;
  label: string;
  decidedCount: number;
  wins: number;
  winRate: number;
  before: number;
  after: number;
  changed: boolean;
}

/**
 * Строит предпросмотр "было/станет" из уже посчитанной таблицы
 * АНАЛИТИКА ПО ФАКТОРАМ (computeFactorStats). Ничего не применяет и не
 * мутирует — чистая функция, применение — отдельный шаг
 * (toMultiplierUpdates + applyReliabilityMultiplierUpdatesForSymbol), вызываемый
 * только после явного подтверждения пользователем.
 *
 * Строки исключаются из предпросмотра, если:
 * - decidedCount < MIN_FACTOR_SAMPLES — тот же порог, что и в самой
 *   таблице "АНАЛИТИКА ПО ФАКТОРАМ", ниже него winRate статистически
 *   ненадёжен (см. factor-analytics.ts).
 * - имя не является PatternName — computeFactorStats агрегирует ВСЕ
 *   факторы (индикаторы 'rsi'/'ema', структурные 'bos', фильтры и т.д.),
 *   а PATTERN_RELIABILITY_MULTIPLIER применяется только к паттернам.
 * - паттерн входит в STRATEGY_BONUS_PATTERNS. Для них
 *   reliabilityMultiplier в direction-prediction.ts НИКОГДА не участвует
 *   в score (isStrategyBonusPattern делает triggerContribution
 *   принудительно 0 независимо от множителя) — пересчёт для них был бы
 *   мёртвым кодом, создающим иллюзию калибровки без реального эффекта.
 *   (Отдельно от этого: computeFactorStats раньше задваивал их
 *   sampleCount/decidedCount из-за двух SignalFactor с одинаковым name —
 *   этот баг исправлен в самом computeFactorStats дедупликацией по имени
 *   на сигнал, так что таблица "АНАЛИТИКА ПО ФАКТОРАМ" для них теперь
 *   показывает корректные числа для постмортема, но множитель для них
 *   всё равно не имеет смысла пересчитывать — см. причину выше.)
 */
export function computeReliabilitySuggestions(
  factorStats: FactorStatRow[],
  currentOverrides: Partial<Record<PatternName, number>> = PATTERN_RELIABILITY_MULTIPLIER,
): ReliabilitySuggestion[] {
  const suggestions: ReliabilitySuggestion[] = [];
  for (const row of factorStats) {
    if (row.decidedCount < MIN_FACTOR_SAMPLES) continue;
    if (row.winRate === null) continue;
    if (!isPatternName(row.name)) continue;
    if (STRATEGY_BONUS_NAME_SET.has(row.name)) continue;

    const before = currentOverrides[row.name] ?? 1;
    const after = Math.round(suggestedMultiplierFromWinRate(row.winRate) * 100) / 100;
    suggestions.push({
      name: row.name,
      label: PATTERN_LABELS_RU[row.name] ?? row.name,
      decidedCount: row.decidedCount,
      wins: row.wins,
      winRate: row.winRate,
      before,
      after,
      changed: Math.abs(after - before) >= 0.01,
    });
  }
  // Сначала те, что реально изменятся, затем по размеру выборки — так
  // предпросмотр сразу показывает самое важное сверху, а не сортируется
  // так, что "без изменений" вперемешку с реальными правками.
  return suggestions.sort((a, b) => {
    if (a.changed !== b.changed) return a.changed ? -1 : 1;
    return b.decidedCount - a.decidedCount;
  });
}

/** Превращает предпросмотр в объект для applyReliabilityMultiplierUpdatesForSymbol. */
export function toMultiplierUpdates(
  suggestions: ReliabilitySuggestion[],
): Partial<Record<PatternName, number>> {
  const updates: Partial<Record<PatternName, number>> = {};
  for (const s of suggestions) {
    updates[s.name] = s.after;
  }
  return updates;
}
