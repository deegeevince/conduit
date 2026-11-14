# A price over a period as candles

summary: A traded price over weeks or months as candlesticks with open, high, low and close: a stock, a share price, a coin, an index, a market over a year, price action, trading, how a ticker did.
reason: only if you are charting the price of something traded

Charts a traded price as monthly or weekly candles, about twenty of them, and says plainly where the numbers come from.

**Use it when** the user asks how something traded over a period and candles fit: about twenty periods or more, each with open, high, low and close. With DATA in the brief, draw it by reference. Without, write the candles from what you recall, mark the chart `approx`, and say in one line that these are recalled figures, not market data. Mark the one or two events that explain the shape.

**Not when** there are fewer than about twenty periods or only closing prices (a `line`, see the numbers technique), the user wants a single figure (say it), or wants live prices: with no DATA and no web search there is no price feed, and the answer says so.

**Example**
```series
scene caption
chart candles approx | Copper, monthly, dollars a kilo
| 2024-09 | 6.2 6.5 6.0 6.4
| 2024-10 | 6.4 6.9 6.3 6.8
| 2024-11 | 6.8 7.1 6.6 6.7
| 2024-12 | 6.7 6.8 6.2 6.3
| 2025-01 | 6.3 6.4 5.9 6.0
| 2025-02 | 6.0 6.3 5.8 6.2
| 2025-03 | 6.2 6.9 6.1 6.8
| 2025-04 | 6.8 7.4 6.7 7.3
| 2025-05 | 7.3 7.8 7.2 7.6
| 2025-06 | 7.6 8.2 7.5 8.0
| 2025-07 | 8.0 8.1 7.4 7.5
| 2025-08 | 7.5 7.7 7.0 7.1
| 2025-09 | 7.1 7.3 6.8 7.2
| 2025-10 | 7.2 7.9 7.1 7.8
| 2025-11 | 7.8 8.4 7.7 8.3
| 2025-12 | 8.3 8.6 8.0 8.1
| 2026-01 | 8.1 8.2 7.5 7.6
| 2026-02 | 7.6 7.8 7.2 7.7
| 2026-03 | 7.7 8.3 7.6 8.2
| 2026-04 | 8.2 8.8 8.1 8.7
node x=2025-06 | Supply scare
say aside | Recalled monthly figures, not market data.
```

**What failed** A line drawn from guessed daily prices: it looked exact and was not. Five candles on a time axis: they stood alone at the edge of a wide empty chart. Rows whose high was below the close were dropped.

**Score** No run has scored this technique yet.
