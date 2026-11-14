# Events on a timeline, to scale

summary: A history, a timeline, events with years or dates, a chronology, "from 1961 to 1972", the main moments of a period.
reason: only if you are drawing events that have dates

Places events along an axis by their year, so the gaps between them are true.

**Use it when** the answer is events with dates. Give each node its year first; a period is two years.

**Not when** the order matters and the dates do not (use a flow), or there is one date (say it).

**Example**
```series
scene caption
timeline | Powered flight, first steps
node 1903 | Wright Flyer: twelve seconds in the air
node 1909 | Bleriot crosses the Channel
node 1914 1918 | War drives the engines
node 1919 fill=accent | Alcock and Brown cross the Atlantic
say | Sixteen years from a hop to an ocean.
```

**What failed** Dates spaced evenly by hand: six years looked like one. Captions floated above the line with nothing tying them to their markers. More than eight events crowd the axis; keep the ones the question needs.

**Score** No run has scored this technique yet.
