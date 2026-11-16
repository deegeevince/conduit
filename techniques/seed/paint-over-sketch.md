# A painting made from your own sketch

summary: A painting, paint me, watercolour, oil, gouache, an illustration, a picture in a medium, brush, painted scene, landscape painting.
reason: only if the user asked for a painting or a picture in a named medium

Draws the picture in a few big shapes, then has the painter re-render it in a medium.

**Use it when** a painting is asked for. Three to six big shapes back to front, a wash on the large ones, soft edges on light and cloud, then `paint` over the group. A character or animal is not sketched from shapes: draw it with `draw <id> <subject> | pose` after the `paint`, on top of the painted ground.

**Not when** the picture needs things you have not drawn: the painter adds nothing, it paints what is there.

**Example**
```series
look paper
color sky=#cfe3f5 sea=#3b7ea1 sand=#e8d9b0
scene caption calm
group view
rect in=view 0,0 160x54 fill=sky>#f4efe4 tex=wash
rect in=view 0,54 160x22 fill=sea tex=wash
path in=view fill=sand stroke=none | M0 76 C40 68 110 72 160 66 L160 90 L0 90 Z
circle in=view 120,22 9 fill=#fff3c4 soft=6
line in=view 62,54 62,34 brush=ink thick=1.2
poly in=view 62,36 76,52 62,52 fill=#fbf3e4
paint over=view as=watercolor mask=soft | a small boat off a beach at noon
draw gull1 bird at=118,30 size=12 | flying, facing left
say | Noon, and nowhere to be.
```

**What failed** Thirty small shapes: in a medium they turned to mud. Asking for a painting with no sketch gave nothing to paint.

**Score** No run has scored this technique yet.
