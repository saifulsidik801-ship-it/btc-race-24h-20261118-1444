# Dip Guard breakout bot — btc-race-24h-20261118-1444

A bot that trades cbBTC (CBBTC) minute by minute on Solana Orca Whirlpool
prices, long only, starting from $1,000 of paper money. Entry for the
make.fun competition "Race a BTC trading bot live for 24 hours".

## Strategy

1-minute BTC noise is ~7 bps per bar while a full round trip costs ~26 bps
in fees, slippage and price impact, so fast signals churn themselves to
death. This bot waits for slow regime moves instead:

- **Entry:** the close breaks above the highest close of the prior 120 bars
  by at least 0.20%, while the 60-bar EMA is above the 240-bar EMA.
  Full size (100% of cash), at most one open position.
- **Exit:** a trailing stop 0.8% below the highest close since entry, or
  120 bars after entry, or the 60-bar EMA crossing back below the 240-bar
  EMA — whichever comes first. After a sell the bot waits 30 bars before
  a fresh entry, so one whipsaw exit cannot instantly re-enter on the
  same chop.

## Dev-window backtest (frozen 24h window in the kit)

- Net PnL **+$8.48** on 1 round trip (buy bar 397 at $64,279, sell bar 517
  at $64,956), max drawdown -0.64%. Passes the dev gate (PnL > $0).
- On the second 12h half of the window it trades nothing and loses nothing.
- Buy-and-hold on the same window loses ~$31.60; a plain EMA 8/21 cross
  loses ~$148 on 80 whipsaw trades.

## Run

Standard library only, Node 22 (erasable TypeScript, no imports). Speaks
`agent-fun/bars-replay/v1` (newline-delimited JSON on stdin/stdout). Fully
deterministic: no clock, no environment, no randomness, no files — the same
bars always produce the same orders.

```
node main.ts
```
