# A dashboard tile: one number and its recent shape

summary: A dashboard tile, a KPI, a metric card, a status widget, one headline number with a small chart, a ticker tile, live-looking.
reason: only if you are making a tile that shows one number and its trend

Makes a tile: a label, one big number, how it changed, and a small chart with no axes.

**Use it when** one figure is the answer and its recent shape is the context. Keep it to a card with four things in it.

**Not when** the reader needs to read values off the chart: give it axes.

**Example**
```series
scene free
card tile 40,22 80x46 | Active users
say in=tile at=42,16 title | 48,210
say in=tile at=64,17 aside ink=accent | up 6.2% this week
chart area spark live in=tile 44,30 72x30
| Mon | 44100
| Tue | 44900
| Wed | 45600
| Thu | 46800
| Fri | 47300
| Sat | 47900
| Sun | 48210
```

**What failed** A full chart with axes inside a small card: the ticks crowded out the number.

**Score** No run has scored this technique yet.
