# A decision as a flowchart

summary: A yes or no decision, should I, deciding whether, how to decide, a flowchart of questions that end in outcomes, troubleshooting.
reason: only if you are drawing a decision, a flowchart or a troubleshooting path

Turns a decision into a flow whose questions are `ask` nodes and whose outcomes are `end` nodes.

**Use it when** the answer is a path through questions: should I, which one, what to do if, a flowchart, troubleshooting.

**Not when** the steps have no branches (a recipe, a routine): that is a plain flow of steps, or a list.

**Example**
```series
scene caption
flow down | Is the bread done?
node look ask | Is the crust deep brown?
node tap ask from=look:yes | Does it sound hollow when tapped?
node more end from=look:no | Ten more minutes
node done end from=tap:yes fill=accent | Take it out
link tap more | no
say | Colour first, then sound.
```

**What failed** Boxes and arrows placed by coordinates: labels crossed the arrows, a branch ended nowhere, and the yes and no words sat beside the wrong line. Outcomes written as loose text beside the chart read as stray captions.

**Score** No run has scored this technique yet.
