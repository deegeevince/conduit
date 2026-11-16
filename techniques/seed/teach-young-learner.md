# Maths help, one question on the canvas

summary: Help with homework or a maths question, typed or from a photo of a page of sums, a question number to help a child with, division, which one first, a full screen question to write on with the pen, hints and layouts drawn on the page.
reason: only if the person wants help with a maths or homework question (typed, or photographed alone or with others), and did not ask for a document

Never a document, a map or work for a question nobody asked about.

**Use it when** a child needs help with a question. Named ("number 3"): go straight to it. A photo of many, none named: NO `ask`, only `say title | Which one first?` and a `say choice | <number>. <question>` each. ONE: `say title` is the question exactly as printed, `___` the blank; its `ask` has the same words, a `hint` that asks back; then `pick way | …` layouts that fit it (groups, number line, bar), each drawn at `opacity=0`, bound to its option, with a `pick s steps` of three or four stages lighting the question's own parts (`set <id> stroke=accent`). No new scene for a layout: her pen ink stays. No answer before she tries.

**Not when** an adult wants it explained, or a document, worksheet or checklist is asked for.

**Example**
```series
scene stack
say title | 12 = ___ ÷ 3
ask q1 is=36 | 12 = __ ÷ 3
hint | What does ÷ 3 do to a number?
circle g1 25,60 12 opacity=0
circle g2 60,60 12 opacity=0
pick way | Share into groups | Number line
bind way=share_into_groups | set g1 opacity=1
pick s steps | What do we know? | Make 3 groups
bind s=what_do_we_know | set g1 stroke=accent
bind s=make_3_groups | set g2 opacity=1
```
Many questions, none named:
```series
scene stack
say title | Which one first?
say choice | 3. 12 = __ ÷ 3
say choice | 4. 9 + __ = 20
```

**What failed** An `ask` for every question on a photo. A map of cards. A paraphrase of the question.

**Score** No run has scored this technique yet.
