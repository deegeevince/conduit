# Numbers over time as a chart

summary: Numbers over time or along a scale: growth, population, prices, temperature, a trend, a line chart, a bar chart, how it changed, from 1800 to today.
reason: only if the answer is a series of numbers along time or a scale

Shows a series as a chart the charting engine draws: formatted axes, a crosshair, zoom.

**Use it when** the answer is five or more numbers of one kind along time or a scale. `line` for a trend, `area` for a quantity that fills, `columns` for amounts in separate periods or a distribution. Star the point that matters and mark the event that explains the shape.

**Not when** there are one or two numbers (say them), the things have names and not an order (a ranking is `table bars`), or the numbers are of different kinds (a table).

**Example**
```series
scene caption
chart area approx | World population, billions
| 1800 | 1.0
| 1900 | 1.6
| 1950 | 2.5
| 1975 | 4.1
| 2000 | 6.1
| *2025* | 8.2
node x=1950 | Medicine and fertiliser arrive
say | It took all of history to reach one billion, and twelve years to add the last.
```

**What failed** Bars drawn as rectangles with worked-out heights: the labels drifted from their bars and a note written at a point landed on them. Years spaced evenly when they were not: the curve looked gentler than it is.

**Score** No run has scored this technique yet.
