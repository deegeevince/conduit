# A task done with your hands, ticked off as you go

summary: A checklist to tick off, a document to work through, tick each step off when it is done, keep my place with a tick for each step, a timer for each step.
reason: only if the person asks for a checklist or a document to tick off

Writes the recipe as a document of parts: one part a step, a tick to mark it done, a choice where there is one, and help for a step they pull.

**Use it when** the person does the steps with their hands (cooking, assembling, setting something up) and goes at their own pace. One `part` for the recipe, one part a step, in order. A step part has a `step` that says what to do in one short line (quantities and the time written in the words: "about 2 minutes, until bubbles show") and an `ask <id> check=done | <the step, short>` that they tick when it is done; the next step opens when it is ticked. A decision the person owns is an `ask check=any pick=<a>,<b>,<c>` with no right answer. Help for a step is a `hint` on its tick (what it should look like, what to do if it goes wrong), and a variation is a part with `for=<the tick>` and a `tag=`. A drawing of the finished dish or a timeline of the times is painted, not part of the document. Write the first steps now and the rest as they near. Finish with a `reply` of one sentence.

**Not when** the person asks for a recipe, a build, instructions or a how-to step by step without asking for a checklist or a document (draw it on the canvas with a stepper); or wants to read about a method, or to see how something works; or the steps are for a young child to learn from.

**Example**
```series
part r1 | Pancakes for two
part r1a in=r1 | Mix the batter
step in=r1a | Whisk 1 cup of flour, 1 egg and 1 cup of milk until smooth.
ask d1 in=r1a check=done | Batter is smooth
hint in=d1 | It should fall off the whisk in a ribbon, not in lumps.
part r1b in=r1 | Heat the pan
step in=r1b | Medium heat, a little butter. About 2 minutes.
ask c1 in=r1b check=any pick=Thick,Thin | How thick do you like them?
part r1c in=r1 | Cook the first side
step in=r1c | A small ladle of batter. About 2 minutes, until bubbles show and the edge looks dry.
ask d2 in=r1c check=done | Ready to flip
hint in=d2 | Slide the spatula under; if it sticks, give it another 30 seconds.
part r1d in=r1 | Flip and finish
reply | Four steps, ticked off as you went.
```

**What failed** The whole recipe as one painted list: no place kept, and nothing to tick off. Quantities left out of the steps, so the person had to scroll back to the top.

**Score** No run has scored this technique yet.
