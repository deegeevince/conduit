# A walk-through the user steps through, one stage at a time

summary: Step by step, one stage at a time, take me through it, walk me through it, instructions, a recipe, a build or a how-to shown as a picture, stages of a process the user wants to move through at their own pace, strokes of an engine, phases.
reason: only if the user wants to go through stages one at a time

Lets the user step through stages with back and next, each stage changing the same drawing.

**Use it when** the same drawing has a few distinct states: strokes, phases, before and after. Draw it once, add `pick steps`, and bind each stage's changes to its option. A build or a recipe: the finished picture with each part at `opacity=0`, and each stage sets its part to `opacity=1`.

**Not when** there is no single drawing that changes (use a flow), or there are more than ten stages.

**Example**
```series
scene caption
rect tank 50,20 60x56 stroke=ink thick=1.5
rect water 51,60 58x15 fill=alt stroke=none
say cap | Empty: the float hangs low and the valve is open.
pick stage steps | Empty | Filling | Full
bind stage=filling | rect water 51,44 58x31 fill=alt stroke=none
bind stage=filling | correct cap | Filling: water lifts the float.
bind stage=full | rect water 51,28 58x47 fill=alt stroke=none
bind stage=full | correct cap | Full: the float shuts the valve.
```

**What failed** One scene a stage, each replacing the last: the viewer could not go back, and the drawing was redrawn from nothing each time.

**Score** No run has scored this technique yet.
