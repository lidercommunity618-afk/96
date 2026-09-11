import type { Signal, SignalOutcome } from '@/types/domain';

export interface SpreadAdjustedOutcome {
  outcome: SignalOutcome;
  spreadCostR: number;
}

// Аудит (синхронизация с демо-счётом): раньше спред сравнивался с
// расстоянием до signal.takeProfit — но take-profit больше не участвует в
// определении исхода (см. outcome-scheduler.ts::resolveOutcome), поэтому и
// здесь takeProfit больше нельзя использовать как точку отсчёта. Спред
// теперь сравнивается с фактическим движением цены на экспирации
// (expiryClosePrice vs entryPrice) — тем же движением, которое определило
// исход. Это чисто внутренняя коррекция для обучения калибровочной модели
// (см. tick-store/outcomes.ts) — на выплату демо-счёта спред не влияет.
export function applySpreadToOutcome(
  outcome: SignalOutcome,
  signal: Signal,
  spread: number,
  expiryClosePrice: number,
): SpreadAdjustedOutcome {
  const move = Math.abs(expiryClosePrice - signal.entryPrice);
  const spreadCostR = move > 0 ? spread / move : 0;

  if (outcome === 'win' && move <= spread) {
    // Движение цены не превышает спред — реального выигрыша по факту нет.
    return { outcome: 'timeout', spreadCostR };
  }
  return { outcome, spreadCostR };
}
