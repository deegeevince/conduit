# A brand sting or logo reveal

summary: A logo sting, a logo reveal, a brand animation, a wordmark appearing, an intro for a company or a product name, a bumper, an ident.
reason: only if the user wants a logo or brand name animated

Builds a simple mark from two or three shapes, lands the name on it with weight, and holds the last picture.

**Use it when** a brand name is given and the answer is an animation of it. A look that matches the brand, one shape that grows or spins in, then the name slamming or wiping in over it, then a held beat.

**Not when** the user wants a logo drawn as a static picture to look at (draw it), or gave a length in seconds without a brand (a stated length applies).

**Example**
```series
look riso
scene solo brisk align=center
circle ring 80,38 14 stroke=accent thick=3 enter=draw
circle dot 80,38 5 fill=accent enter=pop
say shout enter=wipe | NORTHWIND
wait 0.8s
```

**What failed** A mark of many shapes: it was still drawing when the name arrived. A name with a long tagline under it: nobody reads the tagline in a sting.

**Score** No run has scored this technique yet.
