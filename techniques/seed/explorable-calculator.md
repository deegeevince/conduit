# A calculator the user works

summary: A calculator, a converter, a tool that works out a number from what you enter, split a bill, a tip, a unit converter, a loan, a form.
reason: only if the user wants a small tool that computes a number from their inputs

Gives the user sliders or a pick for the inputs and one big sentence that recomputes the result as they move.

**Use it when** the answer is a number that depends on two or three inputs. A card, a slider for each input with a sensible range and start, and the result as a strong line in braces.

**Not when** the user asked for the answer to one case (say it), or the formula is long enough to need a page.

**Example**
```series
scene stack
card calc | Split the bill
slider bill in=calc 10 200 60 step=5 unit=$ | Bill
slider people in=calc 1 10 3 | People
say strong | Each pays {round(bill/people, 2)}
say aside | Add a tip: {round(bill*1.15/people, 2)} with fifteen per cent.
```

**What failed** A typed box for every number: slow, and a wrong letter broke it. A result shown only once, not recomputed as the input moved.

**Score** No run has scored this technique yet.
