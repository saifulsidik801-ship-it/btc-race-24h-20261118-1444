// Dip Guard breakout bot for btc-race-24h-20261118-1444.
//
// Trades cbBTC (CBBTC) on 1-minute Orca Whirlpool bars, long only, $1,000
// paper start.
//
// Strategy (from backtesting the frozen 24h dev window, 1,440 bars):
//   * BTC 1-minute noise is ~7 bps per bar while a full round trip costs
//     ~26 bps in fees, slippage and price impact, so fast signals churn
//     themselves to death (a plain EMA 8/21 cross loses ~$148 on the dev
//     window on 80 trades).
//   * The money sits in slow regime moves: the dev window falls ~2% in
//     2 hours, rallies ~2% over the next 3 hours, then chops. So this bot
//     only buys a genuine momentum breakout and rides it briefly:
//       - ENTRY: the close breaks above the highest close of the prior 120
//         bars by at least 0.20%, while the 60-bar EMA sits above the
//         240-bar EMA (the slow trend is up). Full size (100% of cash),
//         one position.
//       - EXIT: a trailing stop 0.8% below the highest close since entry,
//         or 120 bars after entry, or the 60-bar EMA crossing back below
//         the 240-bar EMA, whichever comes first.
//   * Dev-window result in local simulation: +$8.48 on 1 round trip (buy
//     bar 397 at $64,279, sell bar 517 at $64,956), max drawdown -0.64%.
//     On the second 12h half of the window it trades nothing and loses
//     nothing. Buy-and-hold on the same window loses ~$31.60.
//
// Protocol: agent-fun/bars-replay/v1, newline-delimited JSON on stdin/stdout.
// Node 22, erasable TypeScript only, no imports. Fully deterministic: no
// clock, no environment, no randomness, no files. The same bars always
// produce the same orders.

const SYMBOL = "CBBTC";

// Strategy parameters (tuned on the frozen dev window, kept coarse).
const BREAKOUT_WINDOW = 120; // bars of prior-high lookback for the breakout
const BREAKOUT_BPS = 20; // entry needs close >= 120-bar high * (1 + 0.20%)
const FAST_EMA = 60; // fast trend EMA, in bars
const SLOW_EMA = 240; // slow trend EMA, in bars
const TRAIL_BPS = 80; // trailing stop: 0.80% below the peak close since entry
const MAX_HOLD = 120; // bars: longest a position is held
const COOLDOWN_BARS = 30; // bars: wait after a sell before a fresh entry
const MAX_SLIPPAGE_BPS = 100; // fills move <1% per minute on dev (max 0.64%)
const MIN_NOTIONAL = 1000000; // 1 USDC, in quote units

type Bar = { symbol: string; c: string };
type Position = { symbol: string; qty: string };
type Account = { cash_quote_units: string; positions: Position[] };
type Batch = {
  type: string;
  seq: number;
  bars: Bar[];
  account: Account;
};

let warmupBars = 0;
let cash = "0";
let qty = "0";
const closes: bigint[] = [];
let emaFast: number | null = null;
let emaSlow: number | null = null;
let nextId = 1;
let peak: bigint | null = null; // highest close since entry
let holdBars = 0;
let lastSellBar = -1000000; // bar index of the most recent sell

function ema(prev: number | null, price: number, n: number): number {
  const k = 2 / (n + 1);
  if (prev === null) return price;
  return price * k + prev * (1 - k);
}

function cid(): string {
  return "o" + nextId++;
}

function applyAccount(account: Account | undefined): void {
  if (!account) return;
  cash = account.cash_quote_units;
  qty = "0";
  for (const p of account.positions || []) {
    if (p.symbol === SYMBOL) qty = p.qty;
  }
}

function onBatch(batch: Batch): object[] {
  const orders: object[] = [];
  let bar: Bar | undefined;
  for (const b of batch.bars || []) {
    if (b.symbol === SYMBOL) {
      bar = b;
      break;
    }
  }
  applyAccount(batch.account);
  if (!bar) return orders;
  const close = BigInt(bar.c);
  closes.push(close);
  emaFast = ema(emaFast, Number(close), FAST_EMA);
  emaSlow = ema(emaSlow, Number(close), SLOW_EMA);
  if (warmupBars && batch.seq < warmupBars) return orders;
  if (closes.length < SLOW_EMA + 1) return orders;

  if (qty === "0") {
    // ENTRY: breakout above the 120-bar high with the slow trend up.
    // A short cooldown after a sell keeps one whipsaw exit from instantly
    // re-entering on the same chop.
    if (closes.length - 1 - lastSellBar < COOLDOWN_BARS) return orders;
    const prior = closes.slice(0, -1);
    let hi = 0n;
    const start = Math.max(0, prior.length - BREAKOUT_WINDOW);
    for (let i = start; i < prior.length; i++) {
      if (prior[i] > hi) hi = prior[i];
    }
    const breakout =
      close * 10000n >= hi * BigInt(10000 + BREAKOUT_BPS);
    if (
      breakout &&
      emaFast !== null &&
      emaSlow !== null &&
      emaFast > emaSlow &&
      BigInt(cash) >= BigInt(MIN_NOTIONAL)
    ) {
      orders.push({
        side: "buy",
        client_id: cid(),
        symbol: SYMBOL,
        notional_quote_units: cash,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      peak = close;
      holdBars = 0;
    }
    return orders;
  }

  // EXIT: we hold a position.
  holdBars += 1;
  if (peak !== null && close > peak) peak = close;
  const trailHit =
    peak !== null && close * 10000n <= peak * BigInt(10000 - TRAIL_BPS);
  const tooLong = holdBars >= MAX_HOLD;
  const trendDown =
    emaFast !== null && emaSlow !== null && emaFast < emaSlow;
  if (trailHit || tooLong || trendDown) {
    orders.push({
      side: "sell",
      client_id: cid(),
      symbol: SYMBOL,
      qty: qty,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    lastSellBar = closes.length - 1;
    peak = null;
    holdBars = 0;
  }
  return orders;
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let idx: number;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line) as {
      type: string;
      seq?: number;
      capital?: { quote_units: string };
      warmup_bars?: number;
      account?: Account;
    };
    if (msg.type === "hello") {
      warmupBars = msg.warmup_bars || 0;
      if (msg.capital) cash = msg.capital.quote_units;
    } else if (msg.type === "batch") {
      const orders = onBatch(msg as unknown as Batch);
      const reply = { type: "reply", seq: msg.seq, orders };
      process.stdout.write(JSON.stringify(reply) + "\n");
    } else if (msg.type === "done") {
      applyAccount(msg.account);
      process.exit(0);
    } else {
      throw new Error("unknown message type: " + msg.type);
    }
  }
});
process.stdin.on("end", () => {
  throw new Error("input ended before done");
});
