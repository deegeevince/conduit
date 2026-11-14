# An interface animation: a control through its states

summary: A button, a toggle, a switch, a loading spinner, a menu, a modal, idle and pressed and success states, a micro-interaction, a prototype of an interface animation.
reason: only if the user wants an interface element animated through its states

Draws the element once, then changes the same shapes through each state so the motion is the design.

**Use it when** an interface element goes through states over time. Draw it big, centred, with an id on each part. Press is a small shrink, loading is a spinning arc, success is a colour change and a new word. Hold each state long enough to be seen.

**Not when** the user wants to try the element themselves: that is a control, not a clip.

**Example**
```series
look paper
scene free brisk
rect btn 50,38 60x16 r=8 fill=accent
say lab at=80,46 ink=ground | Pay
wait
set btn scale=0.94 over=0.2s
wait 0.3s
set btn scale=1 over=0.2s
correct lab | Paying
path spin at=80,46 stroke=ground thick=1.5 loop=spin | M80 41 A5 5 0 0 1 85 46
wait 1.5s
drop spin
set btn fill=#2f8f5b
correct lab | Paid
```

**What failed** Every state drawn as a separate box side by side: nothing moved, so there was no animation. A spinner left running after the work was done.

**Score** No run has scored this technique yet.
