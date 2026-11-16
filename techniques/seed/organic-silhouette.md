# A living thing or a character, drawn by the painter

summary: A character, an animal, a creature, a person standing, sitting or walking, a bird, a cat, a fox, a monster, a pose; or a heart, a leaf, a flower as one smooth shape.
reason: only if the answer is a drawn animal, character or person, or a single curved shape

Names the subject and lets the painter draw it, so it reads as itself and comes with parts you can label and move.

**Use it when** the picture has a character, an animal, a person or an everyday thing in it. One `draw` line a subject: `draw <id> <subject> at=x,y size=N | pose, facing`, with the ground and the sky drawn around it by you. It is a group, so `move`, `loop=`, `set` and `hit` work on it as on any group; two of one kind take `as=<name>`, and `new` asks for a different one. Never plot an animal or a person from circles, ellipses or paths. A heart, a leaf or a flower, which is one curved shape and no character, stays a single closed `path` with curves through every corner (`C` and `Q`): a heart is `M50 88 C10 58 14 22 38 22 C46 22 50 28 50 34 C50 28 54 22 62 22 C86 22 90 58 50 88 Z`.

**Not when** the user asked for pixel art (a `pix` sprite), or for a diagram or a chart of the thing (name the structure); or the answer is anatomy, a machine, or anything with labelled parts (use the mechanism card: parts as shapes, each with an id, inside the outline with `in=`).

**Example**
```series
scene caption
rect full fill=#f3d9a4>#e8a76a
circle sun 118,26 9 fill=#fff1c9 soft=3
path hill fill=#6b4a3a stroke=none | M0 90 V70 C40 56 80 74 120 62 C140 56 150 60 160 64 V90 Z
draw fox1 fox at=60,64 size=44 | sitting, facing right, curious
say | Evening, and the fox turns toward the last light.
```

**What failed** A heart of four circles and a triangle: the joins showed and it never read as a heart. A cat built from a dozen overlapping ellipses or one long path: the outline was lumpy and nothing moved as one; naming it with `draw` gave a finished cat.

**Score** No run has scored this technique yet.
