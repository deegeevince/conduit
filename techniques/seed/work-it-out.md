# Something to work out or choose, set on the stage and checked on a press

summary: Make me do each step myself, let me guess first, let me try it, quiz me, solve an equation step by step, work it out myself, what comes next in a pattern, which word fits the gap in a sentence (their, there and they're, spelling), which of these suits me, predict what happens, a blank to complete, choose between options.
reason: only if the person asks to do the work or make a choice themselves, in an answer that is not a document of parts

Asks on the stage: the words set the question, each step is an `ask` with a blank where the answer goes (or large choices), the next opens when this one is right, and a hint behind a tap asks back. No app, and nothing they are to find is on the stage before they try.

**Use it when** the person wants to try, guess or choose before being told: a worked problem to do step by step, a prediction before the reason, a word to fill in, a pattern to continue, a choice that is theirs (which of these suits them; `check=any` and `send=yes` tell you at once).

**Not when** it is a young child's worksheet or a photo of a page of questions (a document of parts), the person only wants the answer explained, or what they want works as a tool (an app).

**Example**
```series
scene stack
say title | Halving a recipe
say | The recipe feeds 8 and uses 600 g of flour and 3 eggs. You are cooking for 4.
ask h1 is=300 | Flour for 4, in grams: __
hint | Four is what share of eight?
hint | Take that share of 600.
ask h2 is=1.5,one_and_a_half | Eggs for 4: __
hint | Is it more or less than 2? More or less than 1?
ask h3 check=any pick=Use_one,Use_two,Use_a_whole_egg_and_half_the_yolk send=yes | You cannot halve an egg. What will you do?
```

**What failed** A worked problem painted as a diagram the person could only read. The steps written as one block with the result in each. An app built for a sum. The answer said in a line of words above the field.

**Score** No run has scored this technique yet.
