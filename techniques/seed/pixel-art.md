# Pixel art and animated sprites

summary: Pixel art, a sprite, a pixel character, 8-bit, retro game graphics, an animated pixel scene, a pixelated animal or object.
reason: only if the user asked for pixel art or a sprite

Writes a real sprite one row per line, every row the same width, with two frames when it should move.

**Use it when** pixel art is asked for. Choose the pixel look so every sprite colour stays visible. Eight to sixteen cells a side. For a moving thing, two or three frames with an `fps`, and a loop for the bob or the flicker.

**Not when** the user wants a smooth picture or a painting: draw it with shapes.

**Example**
```series
look pixel
scene caption playful
pix slime scale=6 fps=3
| ........
| ..3333..
| .333333.
| 33033033
| 33333333
| .333333.
frame
| ........
| ........
| ..3333..
| .333333.
| 30333033
| 33333333
say aside | It never stops bouncing.
```

**What failed** Letters arranged as a picture. Rows of different lengths: the sprite shears. Thirty-two cells a side: nobody could write it, and it read as noise.

**Score** No run has scored this technique yet.
