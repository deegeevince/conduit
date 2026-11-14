# A dashboard tile: one number and its recent trend

summary: A dashboard tile, a KPI, a metric card, a status widget, one headline number with a small trend line, a ticker tile, live-looking.
reason: only if you are making a tile that shows one number and its trend

Makes a tile: a drawn frame, a label, one big number, how it changed, and a small chart with no axes inside it.

**Use it when** one figure is the answer and its recent shape is the context. Draw the frame first (a rounded `rect` with an edge), then the card on it with four things inside.

**Not when** the reader needs to read values off the chart: give it axes.

**Example**
```series
scene free
rect plate 40,18 80x54 r=3 fill=alt stroke=dim thick=0.8
card tile 40,18 80x54 | Active users
say in=tile at=44,29 title | 48,210
say in=tile at=44,36 aside ink=accent | up 9.3% this week
chart area spark live in=tile 44,42 72x26
| Mon | 44100
| Tue | 44900
| Wed | 45600
| Thu | 46800
| Fri | 47300
| Sat | 47900
| Sun | 48210
```

**What failed** A tile with no frame: the number and the line floated on the page and read as loose text. A full chart with axes inside a small card: the ticks crowded out the number.

**Score** No run has scored this technique yet.
