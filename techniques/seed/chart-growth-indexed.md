# Growth compared: several series from the same start

summary: Compare growth, growth rates, which grew faster, performance of several things over the same years, relative change, since a year, side by side over time.
reason: only if you are comparing how several things grew over the same period

Puts several series on one chart, each starting from 100, so that their growth can be compared whatever their sizes.

**Use it when** two to five things of different sizes are compared over the same period. Name the series in a first row of words; `indexed` starts each from 100.

**Not when** the absolute sizes are the point (leave `indexed` off), or there are more than five series (the legend stops being readable).

**Example**
```series
scene caption
chart line indexed approx | Output per person, 1990 = 100
| year | Korea | Poland | Italy
| 1990 | 9400 | 6200 | 27000
| 2000 | 16500 | 9300 | 31000
| 2010 | 25400 | 14800 | 31500
| 2020 | 31700 | 21400 | 30100
say | Two caught up; one stood still.
```

**What failed** Raw values on one axis: the small series lay flat along the bottom and nothing could be compared.

**Score** No run has scored this technique yet.
