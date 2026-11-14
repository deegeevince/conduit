# A long document's key figures as charts

summary: A long document, a report, a filing, quarterly results, a paper, a pasted statement: summarise it, the key figures of a document.
reason: only if the answer is drawn from a document the user gave

Turns the few figures that carry a document into a chart or a table, with the claim above them and nothing the document did not say.

**Use it when** there is a document in the brief. Say its claim in one line, chart the one series that matters (one chart, not four), put what changed in a small table with units and periods, and say which figure to look at. Report only what it says; say when it does not say.

**Not when** the document is prose with no figures: give its few ideas in order, as plain lines or a flow.

**Example**
```series
scene stack
say strong | Revenue grew for the fourth quarter running.
chart columns | Revenue, million dollars
| Q1 | 118
| Q2 | 124
| Q3 | 131
| Q4 | 139
table | What changed
| | This year | Last year
| Revenue | 139 | 121
| Costs | 98 | 90
say aside | Costs grew more slowly than revenue.
```

**What failed** A page of numbers retyped as text. Every figure charted: nothing stood out. A figure the document did not contain, added to round the story off.

**Score** No run has scored this technique yet.
