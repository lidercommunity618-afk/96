#!/usr/bin/env tsx
import { generateSyntheticHarmonicDataset, type HarmonicGroundTruth } from './synthetic/harmonic-data';
import { detectHarmonicPattern } from '@/compute/patterns/harmonic-pattern';
import { simulate, type SimulatedTrade } from './simulator';
import { computeSplitMetrics, computeMetrics } from './metrics';
import { generateReport } from './report';
import { DEFAULT_INDICATOR_CONFIG, ALL_FEATURES } from '@/types/domain';
import type { Candle } from '@/types/domain';

// ─────────────────────────────────────────────────────────────────────────
// Аудит модуля "гармонические паттерны" на синтетических данных со
// встроенным ground truth (см. synthetic/harmonic-data.ts). Два независимых
// прогона:
//
// 1) ПРЯМАЯ проверка детектора (detectHarmonicPattern) на каждом внедрённом
//    паттерне — измеряет geometry/timing-точность самого модуля
//    (тип/направление/PRZ/SL/TP), в обход всего decision-слоя (score,
//    фильтры, session-гейты), которые к самой геометрии гармоник отношения
//    не имеют.
//
// 2) Полный прогон через существующую инфраструктуру бэктестинга проекта
//    (simulate → computeSplitMetrics → generateReport), как и требуется —
//    показывает, что реально долетает до сигнала/сделки после всего
//    decision-конвейера (score, приоритет паттернов, фильтры и т.д.).
// ─────────────────────────────────────────────────────────────────────────

const HARMONIC_CONFIG = {
  minLegAtr: DEFAULT_INDICATOR_CONFIG.harmonicMinLegAtr,
  fibTolerancePct: DEFAULT_INDICATOR_CONFIG.harmonicFibTolerancePct,
  htfFactor: DEFAULT_INDICATOR_CONFIG.harmonicHtfFactor,
  minRR: DEFAULT_INDICATOR_CONFIG.harmonicMinRR,
};

const DETECTOR_WINDOW = 500; // тот же порядок, что windowSize в backtest/config.ts

interface DetectorAuditRow {
  idx: number;
  kind: string;
  orientation: number;
  expectedDirection: 'buy' | 'sell';
  detectedAtIndex: number | null;
  detectedType: string | null;
  detectedDirection: string | null;
  confidence: number | null;
  typeMatch: boolean;
  directionMatch: boolean;
  przContainsD: boolean | null;
  stopOnCorrectSide: boolean | null;
  targetOnCorrectSide: boolean | null;
  falsePositivesBeforeD: number;
}

function auditDetectorDirectly(candles: Candle[], patterns: HarmonicGroundTruth[]): DetectorAuditRow[] {
  const rows: DetectorAuditRow[] = [];

  patterns.forEach((p, idx) => {
    const dIndex = p.points.d.index;
    const dTime = p.points.d.time;

    // Ложные срабатывания ДО подтверждения D: детектор в принципе не должен
    // вернуть этот сетап (тем же D.time), пока ZigZag его ещё не подтвердил.
    let falsePositivesBeforeD = 0;
    for (let i = Math.max(0, dIndex - 5); i < dIndex; i++) {
      const window = candles.slice(Math.max(0, i - DETECTOR_WINDOW + 1), i + 1);
      const res = detectHarmonicPattern(window, undefined, undefined, undefined, undefined, HARMONIC_CONFIG);
      if (
        res &&
        Math.abs(res.time - dTime) <= HARMONIC_CONFIG.htfFactor * 60 * 2 &&
        res.harmonicType === p.kind &&
        res.direction === p.expectedDirection
      ) {
        falsePositivesBeforeD++;
      }
    }

    let hit: ReturnType<typeof detectHarmonicPattern> | null = null;
    let hitAtIndex: number | null = null;
    for (let i = dIndex; i <= p.confirmationSearchEnd && i < candles.length; i++) {
      const window = candles.slice(Math.max(0, i - DETECTOR_WINDOW + 1), i + 1);
      const res = detectHarmonicPattern(window, undefined, undefined, undefined, undefined, HARMONIC_CONFIG);
      // Совпадение по точному времени НЕ требуем: время D, которое
      // возвращает детектор, — это время начала HTF-свечи (после
      // ресэмплинга по htfFactor), а не время конкретной сырой свечи,
      // на которой сформировался экстремум внутри этой HTF-группы — оно
      // предсказуемо отличается от «сырого» времени ground truth на
      // величину до (htfFactor-1) сырых баров (см. docs/audit,
      // BUGFIX zigzag.ts alignToAbsoluteHtfBoundary). Поэтому сверяем
      // по близости времени (окно в 2 HTF-свечи) + типу + направлению.
      if (
        res &&
        Math.abs(res.time - dTime) <= HARMONIC_CONFIG.htfFactor * 60 * 2 &&
        res.harmonicType === p.kind &&
        res.direction === p.expectedDirection
      ) {
        hit = res;
        hitAtIndex = i;
        break;
      }
    }

    const typeMatch = hit?.harmonicType === p.kind;
    const directionMatch = hit?.direction === p.expectedDirection;
    const dPrice = p.points.d.price;

    rows.push({
      idx,
      kind: p.kind,
      orientation: p.orientation,
      expectedDirection: p.expectedDirection,
      detectedAtIndex: hitAtIndex,
      detectedType: hit?.harmonicType ?? null,
      detectedDirection: hit?.direction ?? null,
      confidence: hit?.confidence ?? null,
      typeMatch: !!hit && typeMatch,
      directionMatch: !!hit && directionMatch,
      przContainsD: hit
        ? (() => {
            // Небольшой эпсилон (0.15% от цены D) нужен только для ab-cd:
            // там PRZ — математически ТОЧКА (cdRange=[1,1], т.к. по
            // определению CD/AB=1.0), а не диапазон, поэтому шум округления
            // HTF-группировки (доли процента) иначе всегда даёт "не
            // содержит", даже когда PRZ фактически стоит вплотную к D.
            // Для XABCD-типов PRZ — полноценный диапазон (обычно куда шире
            // эпсилона), так что допуск ничего не маскирует.
            const eps = Math.abs(dPrice) * 0.0015;
            return dPrice >= (hit.przLow ?? -Infinity) - eps && dPrice <= (hit.przHigh ?? Infinity) + eps;
          })()
        : null,
      stopOnCorrectSide: hit
        ? p.expectedDirection === 'buy'
          ? (hit.harmonicStop ?? Infinity) < dPrice
          : (hit.harmonicStop ?? -Infinity) > dPrice
        : null,
      targetOnCorrectSide: hit
        ? p.expectedDirection === 'buy'
          ? (hit.harmonicTarget ?? -Infinity) > dPrice
          : (hit.harmonicTarget ?? Infinity) < dPrice
        : null,
      falsePositivesBeforeD,
    });
  });

  return rows;
}

function printDetectorReport(rows: DetectorAuditRow[]): void {
  console.log('\n' + '═'.repeat(100));
  console.log('  ПРЯМАЯ ПРОВЕРКА ДЕТЕКТОРА (detectHarmonicPattern) НА ВСТРОЕННЫХ ПАТТЕРНАХ');
  console.log('═'.repeat(100));
  const header = ['#', 'kind', 'orient', 'expectDir', 'detIdx', 'detType', 'detDir', 'conf', 'type✓', 'dir✓', 'PRZ∋D', 'SL✓', 'TP✓', 'FP<D'];
  console.log(header.join(' | '));
  for (const r of rows) {
    console.log(
      [
        r.idx,
        r.kind,
        r.orientation,
        r.expectedDirection,
        r.detectedAtIndex ?? 'MISS',
        r.detectedType ?? '-',
        r.detectedDirection ?? '-',
        r.confidence !== null ? r.confidence.toFixed(3) : '-',
        r.typeMatch ? 'Y' : 'N',
        r.directionMatch ? 'Y' : 'N',
        r.przContainsD === null ? '-' : r.przContainsD ? 'Y' : 'N',
        r.stopOnCorrectSide === null ? '-' : r.stopOnCorrectSide ? 'Y' : 'N',
        r.targetOnCorrectSide === null ? '-' : r.targetOnCorrectSide ? 'Y' : 'N',
        r.falsePositivesBeforeD,
      ].join(' | '),
    );
  }
  const total = rows.length;
  const detected = rows.filter((r) => r.detectedAtIndex !== null).length;
  const typeOk = rows.filter((r) => r.typeMatch).length;
  const dirOk = rows.filter((r) => r.directionMatch).length;
  const przOk = rows.filter((r) => r.przContainsD).length;
  const slOk = rows.filter((r) => r.stopOnCorrectSide).length;
  const tpOk = rows.filter((r) => r.targetOnCorrectSide).length;
  const fpTotal = rows.reduce((s, r) => s + r.falsePositivesBeforeD, 0);
  console.log('─'.repeat(100));
  console.log(`  Detected:        ${detected}/${total}`);
  console.log(`  Type match:      ${typeOk}/${total}`);
  console.log(`  Direction match: ${dirOk}/${total}`);
  console.log(`  PRZ contains D:  ${przOk}/${detected || 1}`);
  console.log(`  Stop correct side:   ${slOk}/${detected || 1}`);
  console.log(`  Target correct side: ${tpOk}/${detected || 1}`);
  console.log(`  False positives before D confirmed: ${fpTotal}`);
  console.log('═'.repeat(100) + '\n');
}

function runFullBacktest(candles: Candle[]): { trades: SimulatedTrade[]; harmonicTrades: SimulatedTrade[] } {
  const trades = simulate(candles, {
    symbol: 'SYNTH-HARMONIC',
    timeframe: '1m',
    indicatorConfig: { ...DEFAULT_INDICATOR_CONFIG },
    atrMultiplier: 2,
    activeFeatures: [...ALL_FEATURES],
    barsToResolve: 5,
    windowSize: DETECTOR_WINDOW,
    inSampleRatio: 0.7,
  });

  const harmonicTrades = trades.filter((t) => t.signal.pattern === 'harmonic-pattern');

  const split = computeSplitMetrics(trades);
  generateReport(trades, split, {
    symbol: 'SYNTH-HARMONIC',
    timeframe: '1m',
    from: '2025-01-01(synthetic)',
    to: 'synthetic-generated',
    outputDir: 'backtest/output',
  });

  console.log('\n' + '═'.repeat(60));
  console.log('  HARMONIC-ONLY TRADES (signal.pattern === "harmonic-pattern")');
  console.log('═'.repeat(60));
  if (harmonicTrades.length === 0) {
    console.log('  Нет сделок, где harmonic-pattern стал top-паттерном сигнала.');
  } else {
    const m = computeMetrics(harmonicTrades);
    console.log(`  Trades:       ${m.totalTrades}`);
    console.log(`  Win rate:     ${(m.winRate * 100).toFixed(1)}%`);
    console.log(`  Average R:    ${m.averageR >= 0 ? '+' : ''}${m.averageR.toFixed(2)}R`);
    console.log(`  Profit factor: ${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)}`);
  }
  console.log('═'.repeat(60) + '\n');

  return { trades, harmonicTrades };
}

async function main(): Promise<void> {
  console.log('Generating synthetic harmonic dataset...');
  const { candles, patterns, meta } = generateSyntheticHarmonicDataset({ seed: 42 });
  console.log(
    `Generated ${candles.length} candles, ${patterns.length} embedded patterns, maxSpanBars=${meta.maxSpanBars}`,
  );

  const detectorRows = auditDetectorDirectly(candles, patterns);
  printDetectorReport(detectorRows);

  console.log('Running full simulate() → computeSplitMetrics() → generateReport() pipeline...');
  runFullBacktest(candles);
}

main().catch((err: unknown) => {
  console.error('Harmonic audit failed:', err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
