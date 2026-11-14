# The rule of a game or sport shown on its field

summary: The rules of a sport or a game explained with a picture: a pitch, a court, a board, where the players stand, how scoring works, a foul, a legal move.
reason: only if you are explaining a rule of a sport or game on its playing area

Draws the field from above in a few lines, puts the players or pieces on it, and shows the legal move against the rule.

**Use it when** the rule depends on where things are. Draw the playing area first, mark the one zone that matters in the accent colour, place two or three pieces, and show the move as a line.

**Not when** the rule is about time or numbers, not place (say it plainly).

**Example**
```series
scene figure lines=2
rect court 10,10 100x60 stroke=ink thick=1
line net 60,10 60,70 stroke=ink thick=2
line serviceline 90,10 90,70 stroke=ink thick=1
rect target 60,10 30x30 fill=accent opacity=0.25
circle server 14,60 3 fill=ink
line serve 14,60 75,25 stroke=accent thick=1
say callout near=server | server
say callout near=target | must land here
say | Serve across the court into the far box.
```

**What failed** A photo-real field with many players: the one that mattered was lost. The rule stated in words with no picture of where things stand.

**Score** No run has scored this technique yet.
