# A living thing drawn as one smooth outline

summary: A silhouette of something alive: a heart, a leaf, a flower, a bird, an animal, a creature, a person standing, sitting or walking, a pose.
reason: only if the answer is a drawn shape of a living or curved thing

Draws the form as one smooth closed `path` of curves, so it reads as itself and not as circles and rectangles stuck together.

**Use it when** the thing has a curved outline. Make the silhouette read first: one closed `path` in a flat fill against a plain ground, curves through every corner (`C` and `Q`, never straight `L` runs), then one or two details on top (an eye, a vein, a highlight). A heart is two rounded lobes meeting in a dip at the top and one point at the bottom: `M50 88 C10 58 14 22 38 22 C46 22 50 28 50 34 C50 28 54 22 62 22 C86 22 90 58 50 88 Z`. An animal is a body, a head and a tail that run into each other in one outline, ears as part of the head's curve; a person is a head and a torso as one flowing path, limbs as thick rounded strokes (`thick=` with a round cap) in a pose with a clear line of action. Group the parts and place the group, so it can be moved or turned whole.

**Not when** the user asked for pixel art (a `pix` sprite), or for a diagram or a chart of the thing (name the structure).

**Example**
```series
scene caption
rect full fill=#f3d9a4>#e8a76a
circle sun 118,26 9 fill=#fff1c9 soft=3
path hill fill=#6b4a3a stroke=none | M0 90 V70 C40 56 80 74 120 62 C140 56 150 60 160 64 V90 Z
path bird fill=#2b2118 stroke=none loop=bob | M46 36 C54 22 68 24 72 36 C76 24 90 22 98 36 C88 31 78 35 72 48 C66 35 56 31 46 36 Z
say | Evening, and the gulls turn inland.
```

**What failed** A heart of four circles and a triangle: the joins showed and it never read as a heart. A cat built from a dozen overlapping ellipses: the outline was lumpy and nothing moved as one.

**Score** No run has scored this technique yet.
