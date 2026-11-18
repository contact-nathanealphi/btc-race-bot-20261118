// BTC race bot: EMA trend + momentum filter, trailing stop, take-profit.
//
// Long only, one position. Enters when the fast EMA crosses above the slow EMA
// with positive trailing momentum; exits on the cross back, a trailing stop off
// the peak close since entry, or a take-profit on position value. No new entries
// late in the window. Deterministic: float64 EMA math only, no clock, no
// randomness, no environment reads.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const FAST_SPAN = 12;
const SLOW_SPAN = 144;
const TRAIL_PCT = 0.02;
const TAKE_PROFIT_BPS: number | null = 150;
const SIZE_BPS = 3750;
const MOM_BARS = 30;
const ENTRY_CUTOFF_BARS = 1380;
const MAX_SLIPPAGE_BPS = 100;

/** EMA seeded by the mean of its first span of closes. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function stepEma(e: Ema, close: number): number | null {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
  } else {
    e.warm.push(close);
    if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
  }
  return e.value;
}

interface Trader {
  fast: Ema;
  slow: Ema;
  closes: number[];
  gapPrev: number | null;
  peak: number | null;
  down: boolean;
}

const traders = new Map<string, Trader>();

function traderFor(symbol: string): Trader {
  let t = traders.get(symbol);
  if (t === undefined) {
    t = {
      fast: { span: FAST_SPAN, warm: [], value: null },
      slow: { span: SLOW_SPAN, warm: [], value: null },
      closes: [],
      gapPrev: null,
      peak: null,
      down: false,
    };
    traders.set(symbol, t);
  }
  return t;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const symbol = state.hello.symbols[0]!.symbol;
    const t = traderFor(symbol);
    let fresh = false;
    let crossUp = false;
    let momentumOk = false;
    for (const bar of batch.bars) {
      if (bar.symbol !== symbol) continue;
      fresh = true;
      const close = Number(bar.c);
      t.closes.push(close);
      const fast = stepEma(t.fast, close);
      const slow = stepEma(t.slow, close);
      const gap = fast === null || slow === null ? null : fast - slow;
      const prev = t.gapPrev;
      t.gapPrev = gap;
      if (gap === null || gap >= 0) t.down = false;
      else if (prev !== null && prev >= 0) t.down = true;
      crossUp = prev !== null && gap !== null && gap > 0 && prev <= 0;
      momentumOk = true;
      if (MOM_BARS > 0) {
        momentumOk = t.closes.length > MOM_BARS && close > t.closes[t.closes.length - 1 - MOM_BARS]!;
      }
    }
    if (state.warmingUp) return [];
    const held = state.positions.get(symbol);
    const close = state.close(symbol);
    if (held !== undefined && close !== null) {
      const closeNum = Number(close);
      t.peak = t.peak === null ? closeNum : Math.max(t.peak, closeNum);
      let exitNow = t.down;
      if (closeNum < t.peak * (1 - TRAIL_PCT)) exitNow = true;
      if (TAKE_PROFIT_BPS !== null) {
        const value = state.value(symbol, held.qty);
        if (value * 10000n >= held.cost * BigInt(10000 + TAKE_PROFIT_BPS)) exitNow = true;
      }
      if (exitNow) {
        t.peak = null;
        return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }
    if (held === undefined && fresh && crossUp && momentumOk && t.closes.length <= ENTRY_CUTOFF_BARS) {
      const bySize = (state.equity * BigInt(SIZE_BPS)) / 10000n;
      let amount = bySize < state.cash ? bySize : state.cash;
      const room = state.weightRoom(symbol);
      if (room < amount) amount = room;
      if (amount >= BigInt(state.hello.fees.min_notional_quote_units)) {
        t.peak = close === null ? null : Number(close);
        return [{ side: 'buy', symbol, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
    return [];
  },
});
