# A dashboard: headline numbers, then panels

summary: A dashboard, a report of numbers, a summary of figures, KPIs, metrics, a scorecard, results, an overview, a status page, more detail on a set of figures.
reason: only if the answer is several measures at once, not one series

Makes a page of figures through the mock-up kit, which fills, wraps and never overlaps: a row of headline `stat`s (at most two to a row on a phone), then panels of rows, each panel titled with its unit and period.

**Use it when** the person wants a dashboard, a report or "more detail" on numbers. Show more, not smaller: three to five `stat`s, then two to four panels, six to nine tiles in all. Read the primary source first; a figure you recall is `approx`, and an invented one is never filled in to make a tile.

**Not when** one series is the answer: that is a `chart`.

**Example**
```series
scene caption
look studio
screen d1 browser theme=light accent=teal | Branch overview, March
nav links="Overview,Loans,Members" | Library
col pad=l gap=m
row gap=m wrap
stat up spark=3,4,4,6,7 | Loans | 4,210 | +8% on February
stat down | Late returns | 96 | -12% on February
stat up | New members | 138 | +21% on February
stat | Open hours | 62 a week | unchanged
end
row gap=m wrap
col card grow pad=m
heading small | Loans by shelf, March
item value=1,420 | Fiction
item value=980 | Children
item value=760 | Non-fiction
end
col card grow pad=m
heading small | Busiest days, visits
item value=610 | Saturday
item value=540 | Tuesday
item value=410 | Thursday
end
end
end
say aside | Example figures.
```

**What failed** Two charts and a caption for a whole dashboard: too little to read, and "more detail" only shrank the type. Panels placed by coordinates overlapped.

**Score** No run has scored this technique yet.
