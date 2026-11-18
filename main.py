"""Dip Guard breakout bot for btc-race-24h-20261118-1444.

Trades cbBTC (CBBTC) on 1-minute Orca Whirlpool bars, long only, $1,000 paper start.

Strategy (from backtesting the frozen 24h dev window, 1,440 bars):
  * BTC 1-minute noise is ~7 bps per bar while a full round trip costs ~26 bps
    in fees, slippage and price impact, so fast signals churn themselves to
    death (a plain EMA 8/21 cross loses ~$148 on the dev window on 80 trades).
  * The money sits in slow regime moves: the dev window falls ~2% in 2 hours,
    rallies ~2% over the next 3 hours, then chops. So this bot only buys a
    genuine momentum breakout and rides it briefly:
      - ENTRY: the close breaks above the highest close of the prior 120 bars
        by at least 0.20%, while the 60-bar EMA sits above the 240-bar EMA
        (the slow trend is up). Full size (100% of cash), one position.
      - EXIT: a trailing stop 0.8% below the highest close since entry, or
        120 bars after entry, or the 60-bar EMA crossing back below the
        240-bar EMA, whichever comes first.
  * Dev-window result in local simulation: +$8.48 on 1 round trip (buy bar 397
    at $64,279, sell bar 517 at $64,956), max drawdown -0.64%. On the second
    12h half of the window it trades nothing and loses nothing. Buy-and-hold
    on the same window loses ~$31.60.

Protocol: agent-fun/bars-replay/v1, newline-delimited JSON on stdin/stdout.
Standard library only. Fully deterministic: no clock, no environment, no
randomness, no files. The same bars always produce the same orders.
"""

import json
import sys

SYMBOL = "CBBTC"

# --- strategy parameters (tuned on the frozen dev window, kept coarse) ---
BREAKOUT_WINDOW = 120      # bars of prior-high lookback for the breakout
BREAKOUT_BPS = 20          # entry needs close >= 120-bar high * (1 + 0.20%)
FAST_EMA = 60              # fast trend EMA, in bars
SLOW_EMA = 240             # slow trend EMA, in bars
TRAIL_BPS = 80             # trailing stop: 0.80% below the peak close since entry
MAX_HOLD = 120             # bars: longest a position is held
MAX_SLIPPAGE_BPS = 100     # fills move <1% per minute on the dev window (max 0.64%)


class Bot:
    def __init__(self, hello):
        self.hello = hello
        self.warmup_bars = int(hello.get("warmup_bars") or 0)
        self.cash = int(hello["capital"]["quote_units"])
        self.qty = 0
        self.closes = []          # close prices, raw integer units (price_scale 5)
        self.ema_fast = None
        self.ema_slow = None
        self.next_id = 1
        # position tracking, set on entry, cleared on exit
        self.peak = None          # highest close since entry
        self.hold_bars = 0

    # -- EMA helpers (incremental, deterministic float math) --
    def _ema(self, prev, price, n):
        k = 2.0 / (n + 1)
        if prev is None:
            return float(price)
        return price * k + prev * (1.0 - k)

    def on_batch(self, batch):
        seq = int(batch["seq"])
        orders = []
        bar = None
        for b in batch.get("bars") or []:
            if b.get("symbol") == SYMBOL:
                bar = b
                break
        self._apply_account(batch.get("account") or {})
        if bar is None:
            return orders
        close = int(bar["c"])
        self.closes.append(close)
        self.ema_fast = self._ema(self.ema_fast, close, FAST_EMA)
        self.ema_slow = self._ema(self.ema_slow, close, SLOW_EMA)
        if self.warmup_bars and seq < self.warmup_bars:
            return orders
        if len(self.closes) < SLOW_EMA + 1:
            return orders

        if self.qty == 0:
            # ENTRY: breakout above the 120-bar high with the slow trend up.
            prior = self.closes[:-1]
            hi = max(prior[-BREAKOUT_WINDOW:])
            if close * 10000 >= hi * (10000 + BREAKOUT_BPS) and self.ema_fast > self.ema_slow:
                if self.cash >= 1_000_000:  # at least 1 USDC
                    orders.append({
                        "side": "buy",
                        "client_id": self._cid(),
                        "symbol": SYMBOL,
                        "notional_quote_units": str(self.cash),
                        "max_slippage_bps": MAX_SLIPPAGE_BPS,
                    })
                    self.peak = close
                    self.hold_bars = 0
            return orders

        # EXIT: we hold a position.
        self.hold_bars += 1
        if close > self.peak:
            self.peak = close
        trail_hit = close * 10000 <= self.peak * (10000 - TRAIL_BPS)
        too_long = self.hold_bars >= MAX_HOLD
        trend_down = self.ema_fast < self.ema_slow
        if trail_hit or too_long or trend_down:
            orders.append({
                "side": "sell",
                "client_id": self._cid(),
                "symbol": SYMBOL,
                "qty": str(self.qty),
                "max_slippage_bps": MAX_SLIPPAGE_BPS,
            })
            self.peak = None
            self.hold_bars = 0
        return orders

    def _apply_account(self, account):
        if not account:
            return
        self.cash = int(account["cash_quote_units"])
        self.qty = 0
        for p in account.get("positions") or []:
            if p.get("symbol") == SYMBOL:
                self.qty = int(p["qty"])

    def _cid(self):
        cid = "o%d" % self.next_id
        self.next_id += 1
        return cid


def main():
    bot = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        kind = msg.get("type")
        if kind == "hello":
            bot = Bot(msg)
        elif kind == "batch":
            if bot is None:
                raise SystemExit("batch before hello")
            orders = bot.on_batch(msg)
            reply = {"type": "reply", "seq": msg["seq"], "orders": orders}
            sys.stdout.write(json.dumps(reply, separators=(",", ":")) + "\n")
            sys.stdout.flush()
        elif kind == "done":
            if bot is not None:
                bot._apply_account(msg.get("account") or {})
            return 0
        else:
            raise SystemExit("unknown message type: %r" % (kind,))
    raise SystemExit("input ended before done")


if __name__ == "__main__":
    sys.exit(main())
