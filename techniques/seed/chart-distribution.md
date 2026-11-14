# How values are spread: a distribution

summary: How values are spread: a distribution, a histogram, how common, a bell curve, ages, heights, scores, how many fall in each range, bins.
reason: only if the answer is how many fall in each range of values

Draws a histogram as columns, one per range, and marks where the middle falls.

**Use it when** the question is how a quantity is spread across people or things. Columns with the ranges as names, the same width each, one or two series when two groups are compared, and a note on the middle or the peak.

**Not when** the numbers are a series over time (use a line) or there are only a few named things (a table with bars).

**Example**
```series
scene caption
chart columns approx | Commute time, thousands of workers
| 0-10 | 12
| 10-20 | 31
| 20-30 | 44
| 30-40 | 28
| 40-60 | 15
| 60+ | 6
node x=20-30 | Most common
say aside | Recalled figures, not a survey.
```

**What failed** Bins of unequal width drawn as equal bars: the tail looked taller than it is. A line chart over the ranges: it implied a time order.

**Score** No run has scored this technique yet.
