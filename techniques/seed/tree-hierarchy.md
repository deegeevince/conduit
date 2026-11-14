# A hierarchy as a tree

summary: A family tree, an org chart, a classification, a breakdown of a whole into parts, who reports to whom, kinds of a thing.
reason: only if you are drawing a family, a hierarchy or a breakdown into kinds

Draws parents and children as a tree; each node names its parent with from=.

**Use it when** every thing has one parent: a family, a taxonomy, an outline of parts.

**Not when** things have several parents or point at each other (use a flow).

**Example**
```series
scene caption
tree down | Kinds of triangle
node tri | Triangle
node sides from=tri | By sides
node angles from=tri | By angles
node equi from=sides | Equilateral
node isos from=sides | Isosceles
node right from=angles fill=accent | Right-angled
node acute from=angles | Acute
```

**What failed** Names placed in rows by coordinates with lines between them: lines crossed names, and a generation of five did not fit its row.

**Score** No run has scored this technique yet.
