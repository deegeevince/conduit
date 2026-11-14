# A storyboard: a piece told in shots

summary: A storyboard, shots, the frames of an advert or a video in order, a shot list, a commercial split into shots, a short film outline.
reason: only if the user asked for a storyboard or a piece told in numbered shots

Stages each shot as its own small scene with the shot's number and its framing as a caption.

**Use it when** the user names a number of shots or asks for a storyboard. One scene a shot, one simple picture each, a caption that says the shot's number and what the camera does, brisk pace so the whole fits in a few seconds a shot.

**Not when** the user wants the finished piece, not a plan of it.

**Example**
```series
scene caption brisk
rect road 0,60 160x30 fill=dim
circle wheel 40,56 12 stroke=ink thick=2
say aside | Shot 1. Wide: the rider arrives.
wait 1s
scene caption brisk
circle wheel 80,50 24 stroke=ink thick=3
say aside | Shot 2. Close on the wheel.
wait 1s
scene caption brisk
say title | Ride more.
say aside | Shot 3. Title over the road.
```

**What failed** All the shots drawn on one stage: they could not be told apart as a sequence. A shot with five things in it, when the board is for one idea each.

**Score** No run has scored this technique yet.
