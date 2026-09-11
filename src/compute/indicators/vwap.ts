import type { Candle } from '@/types/domain';
import { lastNonNull } from './helpers';

export interface VwapResult {
  values: (number | null)[];
  isProxyVolume: boolean;
}

export function vwap(
  candles: Candle[],
  period?: number,
  useProxyVolume: boolean = false,
): VwapResult {
  if (candles.length === 0) return { values: [], isProxyVolume: false };

  const slice = period ? candles.slice(-period) : candles;
  const offset = period ? candles.length - slice.length : 0;
  const result: (number | null)[] = Array.from({ length: candles.length }, () => null);

  const allZeroVolume = slice.every((c) => c.volume === 0);
  const useProxy = useProxyVolume || allZeroVolume;

  let cumPV = 0;
  let cumV = 0;
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    const weight = useProxy ? c.high - c.low : c.volume;
    if (weight > 0) {
      const typical = (c.high + c.low + c.close) / 3;
      cumPV += typical * weight;
      cumV += weight;
      result[offset + i] = cumV > 0 ? cumPV / cumV : null;
    }
  }
  return { values: result, isProxyVolume: useProxy };
}

export interface VwapLastResult {
  value: number | null;
  isProxyVolume: boolean;
}

export function vwapLast(
  candles: Candle[],
  period?: number,
  useProxyVolume: boolean = false,
): VwapLastResult {
  const { values, isProxyVolume } = vwap(candles, period, useProxyVolume);
  return { value: lastNonNull(values), isProxyVolume };
}
