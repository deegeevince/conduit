# Sizes or distances compared to scale

summary: Things compared by size or distance: how big, how far, how many times bigger, a scale comparison, the planets in order, their sizes, smallest to largest.
reason: only if the answer is how big or how far things are, compared to one another

Draws each thing as a circle or bar whose size is proportional, in a row, each named.

**Use it when** the lesson is relative size. Choose one unit (radius divided by a fixed number), compute each size before writing, set the things in a row from smallest to largest or in their real order, and name each with a callout.

**Not when** the user wants the exact figures to compare (a table), or the sizes differ by more than fifty times (say so; one cannot be seen).

**Example**
```series
scene figure lines=2
line axis 10,45 150,45 stroke=dim thick=0.5
circle io 30,45 6.1 fill=accent
circle eu 60,45 5.2 fill=accent
circle ga 95,45 8.8 fill=accent
circle ca 135,45 8 fill=accent
say callout near=io | Io
say callout near=eu | Europa
say callout near=ga | Ganymede
say callout near=ca | Callisto
say | Radius in kilometres divided by 300: Ganymede is the largest moon in the solar system.
```

**What failed** Sizes eyeballed: the larger was drawn smaller. Diameters scaled when the viewer compares areas.

**Score** No run has scored this technique yet.
