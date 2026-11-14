# Plan a trip, an itinerary or a holiday

summary: Plan a trip, a weekend away, an itinerary or a holiday with me, one day at a time, let me choose what I most want and plan the next stage from my choice, bookings.
reason: only if the answer is a plan in parts that the person's choices shape

Writes the plan as a document of parts: a part for each day or stage, a choice that shapes what is written next, and the map or the times painted beside.

**Use it when** the person is planning something in stages and the choices are theirs. One `part` for the plan and one for each day or stage, titled by what it is ("Day 1: the old town"). Each part opens with an `ask <id> check=any pick=<a>,<b>,<c> | <what do you most want?>`: a choice with no right answer; once it is held, the next part is written to suit it. Its steps are the things to do, with the time written in the words; help for a choice is its own part `for=<ask>` with a `tag=`. A map of the route, a table of times or a timeline is painted as a scene, never part of the document. Write the first day now and the rest after the choices. Finish with a `reply`.

**Not when** the person wants one answer (the best time to go, one comparison): say it, or a table.

**Example**
```series
part t1 | A weekend in Lisbon
part t1a in=t1 | Day 1: the old town
ask p1 in=t1a check=any pick=Viewpoints,Markets,Museums | What do you most want today?
step in=t1a | Morning: tram 28 from the cathedral, about 40 minutes.
step in=t1a | Lunch at the market hall, then the viewpoint at sunset.
part t1b in=t1 tag=rainy-day for=p1 | If it rains
step in=t1b | The tile museum, then a long lunch indoors.
part t1c in=t1 | Day 2: the coast
reply | Day 1 planned around the choice; day 2 is next.
```

**What failed** Every day written at once before a single choice: the plan fitted nobody. Times and places buried in sentences that a table would have shown.

**Score** No run has scored this technique yet.
