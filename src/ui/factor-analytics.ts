import type { Signal, SignalFactorKind } from '@/types/domain';

// Реальные проблемы, п.3 / Анализ_приложения, п.6 ("то, ради чего всё
// затевается"): factors[] копился в БД/сторе, но нигде в UI не было видно
// "какой индикатор чаще в убыточных сделках" — только вручную, через
// экспорт по одной сделке и вставку в чат с ИИ. Эта группировка — прямое
// развитие уже существующей идеи калибровки (calibration-model.ts тюнит
// веса модели по историческим исходам), только на уровне читаемых
// факторов, а не сырого featureVector.

export interface FactorStatRow {
  name: string;
  kind: SignalFactorKind;
  // Все резолвнутые (win/loss/timeout) сделки, где участвовал этот фактор —
  // используется как мера надёжности выборки (см. MIN_FACTOR_SAMPLES).
  sampleCount: number;
  // Только win/loss из sampleCount — знаменатель для winRate (timeout не
  // "выигрыш" и не "проигрыш", тот же подход, что в
  // useAnalyticsStore.recomputeStats()).
  decidedCount: number;
  wins: number;
  winRate: number | null;
}

// Ниже этого порога winRate по фактору статистически ненадёжен (буквально
// "1 из 2" или "2 из 3") — помечается в UI как "мало данных" вместо того,
// чтобы выглядеть как уверенный сигнал. То же значение, что MIN_SAMPLES в
// calibration-model.ts, для согласованности порогов по всему приложению.
export const MIN_FACTOR_SAMPLES = 5;

export function computeFactorStats(signals: Signal[]): FactorStatRow[] {
  // Тот же фильтр, что и в calibration-buckets.ts: только реально
  // проторгованные (tradeOpened !== false) сигналы с уже наступившим
  // исходом (outcome !== 'pending') — pending-сигналы и "непроторгованные"
  // не должны искажать статистику по факторам.
  const resolved = signals.filter((s) => s.tradeOpened !== false && s.outcome !== 'pending');

  const byName = new Map<string, { kind: SignalFactorKind; sampleCount: number; decidedCount: number; wins: number }>();
  for (const s of resolved) {
    const isDecided = s.outcome === 'win' || s.outcome === 'loss';
    // BUGFIX (аудит калибровки Этапа 2, п.2 — "двойной подсчёт для
    // STRATEGY_BONUS_PATTERNS"): паттерны из STRATEGY_BONUS_PATTERNS дают
    // ДВА SignalFactor с одинаковым `name` в одном и том же сигнале — один
    // из direction-prediction.ts (kind 'pattern', contribution всегда 0,
    // оставлен только для постмортема — см. isStrategyBonusPattern там же)
    // и один из signal-builder.ts (kind 'strategy', реальный бонус). Раньше
    // цикл ниже проходил по s.factors без дедупликации и считал sampleCount/
    // decidedCount/wins дважды для одной и той же сделки. Один сигнал —
    // максимум один вклад в счётчики на каждое уникальное имя фактора,
    // независимо от того, сколько раз оно встретилось в factors[].
    // Показываемый kind предпочитает 'strategy' — это тот фактический вклад,
    // который реально участвовал в score (тогда как 'pattern'-запись для
    // этих паттернов — заведомо нулевой плейсхолдер).
    const namesInSignal = new Map<string, SignalFactorKind>();
    for (const f of s.factors ?? []) {
      const prevKind = namesInSignal.get(f.name);
      if (prevKind === undefined || (prevKind !== 'strategy' && f.kind === 'strategy')) {
        namesInSignal.set(f.name, f.kind);
      }
    }
    for (const [name, kind] of namesInSignal) {
      const existing = byName.get(name) ?? { kind, sampleCount: 0, decidedCount: 0, wins: 0 };
      existing.sampleCount += 1;
      if (isDecided) {
        existing.decidedCount += 1;
        if (s.outcome === 'win') existing.wins += 1;
      }
      if (kind === 'strategy') existing.kind = 'strategy';
      byName.set(name, existing);
    }
  }

  return Array.from(byName.entries())
    .map(([name, v]) => ({
      name,
      kind: v.kind,
      sampleCount: v.sampleCount,
      decidedCount: v.decidedCount,
      wins: v.wins,
      winRate: v.decidedCount > 0 ? v.wins / v.decidedCount : null,
    }))
    // По sampleCount, не по winRate — раздел, в первую очередь, отвечает на
    // "какой фактор чаще всего участвует в сделках", а надёжность winRate
    // per-row уже видна из MIN_FACTOR_SAMPLES-бейджа.
    .sort((a, b) => b.sampleCount - a.sampleCount);
}
