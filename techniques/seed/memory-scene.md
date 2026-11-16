# A story, a memory or a mood staged as a scene

summary: A story, a memory, a mood, a place remembered, a bedtime tale, a poem to be staged, an evening, a feeling of a place.
reason: only if you are staging a story, a memory or a mood

Stages a few words inside a picture: layers far to near, weather, one camera move.

**Use it when** the answer is felt more than known. Lay the far ground first, then one lit thing, then one small thing that is alive, then few words, one at a time.

A person, an animal or a thing in the scene is a `draw` line (`draw child1 child at=40,64 | sitting, facing left`), never shapes; the room, the light and the weather are yours.

**Not when** the user wants information: a scene delays it.

**Example**
```series
look amber like=night ground=#2a1a10 ink=#f6e3c0 accent=#ffb454
color wall=#5a3720 glow=#ffd9a0
scene caption calm slow
rect full layer=far fill=wall>#2a1a10
rect win 98,12 44x32 r=2 layer=bg fill=glow
line 120,12 120,44 layer=bg stroke=wall thick=1.5
draw child1 child at=60,62 size=40 loop=sway | sitting, facing right, sleepy
ambient dust light layer=fg
cam push slow
say | It always smelled of toast and rain.
wait 2
say | The window was the brightest thing in the house.
```

**What failed** Many small shapes with no ground behind them: a scattering, not a place. Three camera moves in one scene made the words hard to read.

**Score** No run has scored this technique yet.
