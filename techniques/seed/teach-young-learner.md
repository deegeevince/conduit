# Maths help, one question on the canvas

summary: Help with homework or a maths question (typed or from a photo): a sum, adding or taking away, a fraction of a number, division, times tables, my 7 year old, a question number, which one first, pen on iPad, hints and layouts drawn on the question itself, on the canvas.
reason: only if the person wants help with a maths or homework question (typed, or photographed alone or with others), and did not ask for a document

Never a document, a map or work for a question nobody asked about.

**Use it when** a child needs help with a question; interactive, "an app" or a visual is this canvas, never a program. Write the example's exact shape, never `scene figure`: only its numbers, words and pieces change. Named ("number 3"): go straight to it. A photo of many, none named: no `ask`, only `say title | Which one first?` and a `say choice | <number>. <question>` each. ONE question: `scene free canvas=wide`; retype it exactly as printed, no labels or story, as big `say`s in one row at the top, one piece each, the blank a `rect` she writes in with the pen (never `__`); ALWAYS the `ask` too (it holds the answer in `is=`, its words only "Type it:"). Hints are two tabs that light the question: numbers, then the blank. Offer `pick way tabs` layouts that fit it (groups, bar, number line; column for + and -), pieces at `opacity=0`, a `pick s steps` that adds one piece per step, labels on their parts. A later bind wins, so each way hides the others. Never the answer, never the method. No other words.

**Not when** an adult wants it explained, or a document or worksheet is asked for.

**Example**
```series
scene free canvas=wide
say a at=36,12 size=xl | 1 000
say b at=68,12 size=xl | =
rect box 78,5 22x15
say c at=118,12 size=xl | ÷ 3
ask q is=3000 at=140,70 | Type it:
pick h tabs at=45,27 | What do we know? | What are we finding?
bind h=1 | set a ink=accent
bind h=1 | set c ink=accent
bind h=2 | set box stroke=accent
pick way tabs at=125,27 | Groups | Bar
circle g1 25,55 8 opacity=0
rect r1 20,48 40x14 opacity=0
pick s steps at=70,80 | The whole | Three equal parts
bind s=2 | set g1 opacity=1
bind s=2 | set r1 opacity=1
bind way=2 | set g1 opacity=0
bind way=1 | set r1 opacity=0
```

**What failed** An `ask` for every question on a photo. A story label. A paraphrase. Hints as sentences. A program to run elsewhere.

**Score** No run has scored this technique yet.
