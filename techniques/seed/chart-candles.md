# A price over a period as candles

summary: A stock, a share price, a coin, an index, a market over a year or a month, price action, candlesticks, trading, how a ticker did.
reason: only if you are charting the price of something traded

Charts a price as weekly or monthly candles with volume, and says plainly where the numbers come from.

**Use it when** the user asks how something traded over a period. With DATA in the brief, draw it by reference. Without, write weekly or monthly candles from what you recall, mark the chart `approx`, and say in one line that these are recalled figures, not market data. Mark the one or two events that explain the shape.

**Not when** the user wants a single figure (say it), or wants live prices: there is no price feed here, and the answer says so.

**Example**
```series
scene caption
chart candles approx | Brent crude, monthly, dollars a barrel
| month | open | high | low | close
| 2014-06 | 109 115 108 112
| 2014-08 | 106 107 101 103
| 2014-10 | 95 96 82 86
| 2014-12 | 70 73 55 57
| 2015-01 | 57 59 45 53
node x=2014-10 | Supply outruns demand
node y=100 | Where it had sat for three years
say aside | Recalled monthly figures, not market data.
```

**What failed** A line drawn from guessed daily prices: it looked exact and was not. Rows whose high was below the close were dropped by the chart.

**Score** No run has scored this technique yet.
