# Help a young learner work a question out

summary: Teach a child, help my kid with homework, a worksheet of sums, a lesson on adding, times tables or number bonds, show the working and not the answer, a young learner who is to try each question herself.
reason: only if the person is a young child in the first years of school who is to try each question herself, with help she pulls

Writes the work as a document of parts: her own try first, then help she asks for as a thinking ladder, then ways to go at it that she does together with you.

**Use it when** a young child is to do the work herself. Short words, small steps, warm and plain; give approaches, never answers; never write a name. ASK ALONE FIRST: open with the question as printed (title, crop) and her answer space, nothing else; help only when she taps Help. HER TRY: an `ask` straight on the question (`is=` with every spelling she may type, no `pick=`, she writes it) and a thinking ladder as its hints, facts first, each a question back to her and never a step toward the answer: hint 1 marks what we know, with the question's own facts in [brackets] ("We know [3 bags] and [4 apples in each bag]. What do we know?"); hint 2 asks what it is asking ("What are we asked to find?"); hint 3 offers ways ("Could we draw it, count on, or break it apart?"); then she has a go. WAYS: three to five help parts, each `for=<her ask>` with a `tag=` of the way (draw-it, share-it-out, count-on-a-line, make-ten, break-it-apart, find-the-pattern, read-the-question, work-backwards), each a different approach of three to six small steps; start with the one she most likely knows. DO IT TOGETHER: every step sets up one piece and is followed by an `ask` she answers: the gap first (a jump's size), then where she lands. Never a reveal. Give `pick=` with three large choices, one right. A step is about twelve words she can read alone: say what to do ("Tap each flower"), never the result. A picture is told only what the question says (`parts=6,2,4`, never `each=12`; a line gets its span and hop size, never where it lands). Show partial work, never the total. Finish with a `reply` of one warm sentence on how she did it.

**Not when** the person is an adult or an older learner who wants the answer explained (a plain answer or a drawn one), or the question is a thing to watch and not to try.

**Example**
```series
part w1 | Sheet 1
part q1 in=w1 crop=6,20,88,9 | Ben has 3 bags with 4 apples in each. How many apples in all?
ask a0 in=q1 is=12 | How many apples in all?
hint in=a0 | What do we know? We know there are [3 bags] and [4 apples in each bag].
hint in=a0 | What are we asked to find?
hint in=a0 | Could we draw it, or hop along a line? Pick a way, then have a go.
part q1a in=q1 tag=draw-it for=a0 | Draw the bags
step in=q1a show=groups count=3 each=4 label=apples | Here are the 3 bags. Tap the apples in one bag to count them.
ask b1 in=q1a is=4 pick=3,4,5 | How many apples are in one bag?
step in=q1a | Every bag is the same. Count on by fours as you tap each bag.
ask b2 in=q1a is=12 pick=10,12,14 | How many apples in all 3 bags?
hint in=b2 | Tap the bags one at a time and say the fours as you go.
part q1b in=q1 tag=count-on-a-line for=a0 | Hop along a number line
step in=q1b show=numberline 0..16 step=4 | Each hop is one bag. We start at 0.
ask c1 in=q1b is=8 pick=6,8,10 | Hop twice. Where do you land?
hint in=c1 | The first hop lands on 4. Where does the next hop land?
ask c2 in=q1b is=12 | Hop a third time. Where do you land?
part q2 in=w1 crop=6,34,88,9 | Ben has 12 apples and eats 5. How many are left?
reply | Three bags of four, counted by fours and then hopped along a line.
```

**What failed** A step that said the result ("5 x 12 = 60") beside the choices 50, 60, 70: the answer was on the page before she tried. Hints that were steps toward the answer, not questions back to her. Painting the question as a scene and a bar model, so she could not write her answer.

**Score** No run has scored this technique yet.
