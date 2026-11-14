# A process as a flow of steps

summary: A process, a pipeline, how something goes from one stage to the next, steps in order, cause and effect, how a bill becomes law, how a request is handled.
reason: only if you are drawing a process whose steps follow one another

Lays a process out as a flow, one node a step, told a step at a time.

**Use it when** something passes through stages in order: a pipeline, a procedure, a chain of causes.

**Not when** the last step leads back to the first (use a cycle), or the steps are instructions the reader will follow with their hands (say them plainly, in a list).

**Example**
```series
scene caption
flow right | From bean to cup
node pick | Picked
node dry from=pick | Dried
node roast from=dry fill=accent | Roasted
node grind from=roast | Ground
node brew end from=grind | Brewed
say | Roasting is where the flavour is made.
hit roast
```

**What failed** A snaking grid of boxes with hand-placed text: the words overflowed the boxes and hid each other. More than eight steps in one flow came out small; two flows of four read better.

**Score** No run has scored this technique yet.
