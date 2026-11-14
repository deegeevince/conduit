# An algorithm traced on real data

summary: How an algorithm works on data: bubble sort, quicksort, merge sort, how a sort puts numbers in order, searching, binary search, swapping, a loop over a list of numbers, a stack or a queue, tracing code.
reason: only if you are tracing an algorithm on example values

Puts the values on stage, then moves them as the algorithm does, one comparison at a time, with a caption of the rule in use.

**Use it when** the user gives or implies example data. Each value is its own text with an id, a frame marks what is being compared, and each step is a move or a morph of the frame, never a redrawing.

**Not when** the user wants the algorithm's complexity or its code (say it).

**Example**
```series
scene caption
say v1 at=40,40 title | 5
say v2 at=60,40 title | 2
say v3 at=80,40 title | 4
rect pair 30,30 40x20 stroke=accent thick=1.5
say aside | 5 is bigger than 2, so they swap.
move v1 60,40
move v2 40,40
wait
rect pair 50,30 40x20 stroke=accent thick=1.5
say aside | Now 5 against 4.
```

**What failed** Each step redrawn as a new scene: the eye could not follow which value went where. The values not written out: a trace of nothing in particular teaches nothing.

**Score** No run has scored this technique yet.
