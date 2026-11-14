# A quantity the user can drag

summary: How one quantity depends on another: an angle, a rate, a speed, a dose, what happens if, the more the, let me try it, let me change, see how, steepness, a slope, interactive, explore, drag.
reason: only if the answer is how one quantity changes another

Gives the user a slider bound to the picture, and a chart that redraws as it moves, so the answer is found by dragging.

**Use it when** the heart of the answer is "as this changes, that changes". Lay it out as a `figure`: the drawn thing beside, one `chart` whose cells hold braces on the slider, one slider, a `bind` for what moves in the drawing, and the numbers in a sentence.

**Not when** the user asked for a fact: say it. One or two controls; more is a form, not an answer. Never draw axes and a curve by hand: a chart does it, and it follows the slider.

**Example**
```series
scene figure
rect tank 8,22 24x50 stroke=ink thick=1.5
rect water 9.5,56 21x15 fill=accent stroke=none
slider rate 1 10 4 unit=L/h | Tap flow
chart fill line | Litres in the tank
| 0 | 0
| 2 | {rate*2}
| 4 | {rate*4}
| 6 | {rate*6}
| 8 | {rate*8}
bind rate 1..10 | rect water 9.5,28 21x43 fill=accent stroke=none
say | At {rate} litres an hour it holds {rate*8} after eight hours.
```

**What failed** A curve and axes drawn by hand: flat for most of the range, and the slider sat on top of it. A slider with nothing bound to it changes nothing on the stage and reads as broken.

**Score** No run has scored this technique yet.
