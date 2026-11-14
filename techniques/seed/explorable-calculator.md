# A calculator the user works

summary: A calculator, a converter, a tool that works out a number from what you enter, split a bill, a tip, a unit converter, a savings goal, a form.
reason: only if the user wants a small tool that computes a number from their inputs

Gives the user sliders or a pick for the inputs, one big sentence that recomputes the result as they move, and a chart when the result has a shape.

**Use it when** the answer is a number that depends on two or three inputs. A card, a slider for each input with a sensible range and start, the result as a strong line in braces; when the result grows or falls over a range, a `chart` whose cells hold the same braces.

**Not when** the user asked for the answer to one case (say it), or the formula is long enough to need a page.

**Example**
```series
scene figure
card calc | Saving for a goal
slider monthly in=calc 20 400 120 step=10 unit=$ | Each month
slider months in=calc 6 60 24 | Months
chart fill area | Saved so far, dollars
| 0 | 0
| 12 | {monthly*min(12, months)}
| 24 | {monthly*min(24, months)}
| 36 | {monthly*min(36, months)}
| 48 | {monthly*min(48, months)}
say strong | {monthly*months} saved in {months} months
```

**What failed** A typed box for every number: slow, and a wrong letter broke it. A result shown once, not recomputed as the input moved. A chart left out: the user saw one number and never the shape.

**Score** No run has scored this technique yet.
