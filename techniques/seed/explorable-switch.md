# The same thing in two states, with a switch

summary: The same thing in two states: day and night, before and after, summer and winter, on and off, two modes, switch between, flip, a toggle, view it both ways.
reason: only if the user wants to switch one picture between two states

Draws one scene and gives a toggle that holds the changes for the second state.

**Use it when** the two states are the same thing seen two ways. Draw the first state, add a `toggle`, and bind a handful of changes to its `on` value; the switch undoes them by itself.

**Not when** there are three or more states (a `pick`), or the change is a number (a slider).

**Example**
```series
scene caption
rect sky 0,0 160x90 fill=#bfe0f5
circle sun 120,20 8 fill=#ffd95a
rect house 60,46 40x30 fill=dim
rect door 76,58 8x18 fill=ink
toggle night | Night
bind night=on | rect sky 0,0 160x90 fill=#1b2a49
bind night=on | set sun opacity=0
bind night=on | set house fill=#3a3f5c
bind night=on | rect door 76,58 8x18 fill=accent
say | The house is the same; only the light changed.
```

**What failed** Two separate drawings one after the other: the viewer could not flip between them. A toggle whose changes were not bound did nothing.

**Score** No run has scored this technique yet.
