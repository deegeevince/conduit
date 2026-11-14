# How a thing works: a mechanism drawn and its parts named

summary: How does a thing work: a machine, a mechanism, an engine, a pump, a lever, a device, the parts of something, a cross-section, anatomy.
reason: only if you are drawing a thing and naming its parts

Draws the thing big from a few simple shapes and names each part with a callout, then changes one part to show it working.

**Use it when** the question is how a thing works or what its parts are. Give every part an id. Show the working by changing a part: declare a shape again and it moves into its new form.

**Not when** the answer is a sequence with no object to look at (use a flow).

**Example**
```series
scene figure lines=2
line beam 14,50 86,50 thick=2
poly pivot 38,62 44,50 50,62 fill=accent
rect load 72,40 12x10 fill=dim
path push stroke=accent thick=1.5 | M20 26 V46 m-4 -5 l4 5 l4 -5
say callout near=pivot | pivot
say callout near=load | load
say callout near=push | effort
say | Push down far from the pivot and the short end lifts the load.
wait
poly pivot 60,62 66,50 72,62 fill=accent
say strong | Move the pivot closer: *less effort, less lift*.
```

**What failed** Labels placed at coordinates beside small parts: thin drawn lines crossed the words, and two labels asked for the same side ended up beside the wrong part. A figure drawn small beside a column of text carried less than the text alone.

**Score** No run has scored this technique yet.
