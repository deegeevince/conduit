# The same thing in two states, with a switch

summary: The same thing in two states: day and night, before and after, summer and winter, on and off, two modes, switch between, flip, a toggle, view it both ways.
reason: only if the user wants to switch one picture between two states

Draws one picture and gives a toggle that holds the changes for the second state.

**Use it when** the two states are the same thing seen two ways. Lay it out as a `figure`: draw the first state, add a `toggle` named for both states, and bind a handful of changes to its `on` value; the switch undoes them by itself. If a number differs between the states, show it in a sentence with braces, or a `chart` of the two.

**Not when** there are three or more states (a `pick`), or the change is a number the user should sweep (a slider).

**Example**
```series
scene figure
rect sky 0,0 160x90 fill=#bfe0f5
circle sun 120,20 8 fill=#ffd95a
rect house 60,46 40x30 fill=dim
rect door 76,58 8x18 fill=ink
toggle night | Day / Night
bind night=on | rect sky 0,0 160x90 fill=#1b2a49
bind night=on | set sun opacity=0
bind night=on | set house fill=#3a3f5c
bind night=on | rect door 76,58 8x18 fill=accent
say | The house is the same; only the light changed.
```

**What failed** Two separate drawings one after the other: the viewer could not flip between them. A toggle whose changes were not bound did nothing. A toggle named for one state only: nobody could tell what off meant.

**Score** No run has scored this technique yet.
