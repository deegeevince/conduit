# Places as pins on a sketch map

summary: A map, a route, a journey, cities in order, where things are in relation to each other, the Silk Road, a trip, stops along the way.
reason: only if you are drawing places and how they lie in relation to each other

Draws a rough outline for the land, then pins the places and lets the painter label them.

**Use it when** the answer is where things are relative to each other. Draw one or two big shapes for land or water first, east on the right and north at the top, then the pins in the order of travel with `route`.

**Not when** exact geography matters: this is a schematic and has no map data.

**Example**
```series
look paper
color sea=#bcd6e6 land=#e6dcc4
scene caption
rect full layer=far fill=sea
path coast fill=land stroke=dim | M0 90 L0 38 C30 30 52 46 80 40 C110 34 132 20 160 26 L160 90 Z
map trip route | The coast road, west to east
node 18,52 | Harbour
node 62,58 | Cliffs
node 104,50 | Old bridge
node 142,40 | Lighthouse
say | A day's drive, end to end.
```

**What failed** Dots with labels placed at offsets by hand: labels overlapped where places were close. A zigzag line with no land or water read as a chart, not a map.

**Score** No run has scored this technique yet.
