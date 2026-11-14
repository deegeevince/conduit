# A quantity the user can drag

summary: How one quantity depends on another: an angle, a rate, a speed, a dose, interest, what happens if, the more the, let me try it, let me change, see how, steepness, a slope, interactive, explore, drag.
reason: only if the answer is how one quantity changes another

Gives the user a slider bound to the drawing, so the answer is found by dragging.

**Use it when** the heart of the answer is "as this changes, that changes". Draw the scene, add one slider, bind the parts that move, and put the numbers in a sentence with braces.

**Not when** the user asked for a fact: say it. One or two controls; more is a form, not an answer.

**Example**
```series
scene caption
line ground 10,78 150,78 thick=1
rect post 30,48 3x30 fill=ink
line shadow 33,78 120,78 stroke=accent thick=2
circle sun 30,14 6 fill=accent soft=3
path sky stroke=none | M30 14 Q90 6 140 60
slider height 10 80 20 unit=deg | Height of the sun
bind height | move sun along=sky
bind height | line shadow 33,78 38,78
say | Sun at {height} degrees: a 3 m post casts {round(3/tan(rad(height)), 1)} m of shadow.
```

**What failed** A paragraph describing how the shadow shortens: nothing to try. A slider with nothing bound to it changes nothing on the stage and reads as broken.

**Score** No run has scored this technique yet.
