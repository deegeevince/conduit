# Series: the language between brain and painter

This document is the specification. The code in `language/` implements it, and where prose and code disagree, that is a bug in one of them: fix it and say which. The reference tables at the end are generated from the code (`pnpm docs:language`), so they cannot disagree.

Series is version 4. Version 2 could only set type; version 3 can draw; version 4 can name a structure and have the painter lay it out, chart data on an instrument, put controls on stage that drive the drawing with no round trip, and be shown its own draft and fix it. Everything version 3 said still means what it meant, with the exceptions listed in section 12.

> **State of the build.** Version 4 is specified here, parsed, scheduled and carried by `language/`, and performed: the painter lays out every structure, draws charts through its charting engine, works every control and renders its own paint, and advertises exactly that, so a brain is taught all of it (`web/src/painter/blocks/index.ts`, `controls/index.ts`, `web/src/render/chart/index.ts`). What v2.1 adds to the language (`standing`, `code`, `deck`, `pic … from=`, `refine`, `href=`, and composition by relation, repetition and dive) is not here yet: each is written into this document by the package that builds it, before it is parsed (`PLAN-v2.1.md`).

## 1. What Series is for

A brain (a language model, or an agent standing in for one) answers a person by writing Series. A painter in the browser performs each line the moment it arrives, on a stage with depth: it sets type, draws shapes, sets pixels, moves a camera, fills the air with weather. Nobody reads Series; they see what it does.

Three properties are fixed and everything else follows from them:

1. **It streams.** One command per line. A line is complete, and can be acted on, when its newline arrives. No line depends on a later line to be valid.
2. **It is a defined language.** Every word is in `language/src/vocabulary.ts`. A word that is not there does not exist.
3. **It is all the painter is told.** The painter holds real skill (layout, measurement, contrast, choreography, the motion of every particle), but it is driven by lines.

The design rule is the one behind MIDI: **the brain sends intent, the painter holds the skill.** Each side is blind to something. The painter cannot see the future; the brain cannot see the canvas. So each decides what only it can know, and the language carries just enough between them.

| The brain decides | The painter decides |
| --- | --- |
| what is said and drawn, in what order, in what groups | exact positions of text, line breaks, collision avoidance |
| what matters and how much | real sizes in pixels, and fitting the canvas to this screen |
| pace, pauses, silence | exact seconds, from the words, the lengths of lines and the pace |
| what stays and what leaves | where a label goes beside the thing it names |
| the look: ground, inks, face, surface | contrast, and keeping it legible |
| which weather | where every raindrop is |
| which structure, its parts and what leads to what | where every part goes, how every connector runs, where every label sits |
| the numbers of a chart and what to mark on it | the axes, the ticks, the scale, the crosshair |
| which control, and what it changes | what the control looks like, and every frame while it is dragged |

Most of the language is at **mind level**: it says what something means. A small part is **hand level**: an exact time or length, for the rare moment the brain wants one specific effect. A drawing's coordinates are not hand level: where the roof goes is the brain's meaning, and it is written in the canvas's own units, never in pixels.

**Coordinates are for things that have a place, not for layout.** Measured over a hundred answers, a brain places a roof on a house well and places boxes, arrows and their labels badly: it cannot see what it has covered. So version 4 moves layout to the side that can see. Where a thing IS (the piston, the city on the coast) stays the brain's, in coordinates. Where a box in a flowchart goes, how an arrow gets round it and where a label finds room is the painter's: the brain names the structure (section 4.13) or asks for a callout (section 4.3).

**The form of an answer is the brain's choice.** Plain prose at reading speed (`layout=page`) is a first-class answer, and for a question of fact it is the right one. Drawing, staging and timing are for what they say better than words. The language makes the plain answer the cheapest thing to write.

## 2. Lines

```
verb  word…  key=value…  @time  | text
```

- One command per line, ended by `\n`. A trailing `\r` is ignored. Leading and trailing spaces are ignored.
- The **verb** is the first token. Verbs and all words are case-insensitive and are lower-cased; text is kept exactly.
- **Words** and **`key=value` pairs** follow, separated by spaces, in any order. A value never contains a space.
- **Geometry** is written as bare numbers among the words: a point `x,y`, a size `WxH`, a single number. `80,45 12`, `80 45 12` and `cx=80 cy=45 r=12` all read the same.
- **`@time`** is at most one token starting with `@` (section 5.4).
- **Text** is everything after the first `|` to the end of the line, trimmed. It needs no quotes and no escaping; a `|` inside the text is just a character. If the text is wrapped in one pair of double quotes they are removed. For `path` the text is SVG path data; for `paint` it is what to paint.
- Inside text, `*asterisks*` mark a span for emphasis. `\*` is a literal asterisk. An unclosed `*` is a literal asterisk.
- **A line that starts with `|` is a row**: one row of cells of the sprite being written (section 4.6).
- A blank line is ignored. A line starting with `#` is a comment and is ignored.
- A line starting with `#!` is a comment to every reader except the replay brain, for which it is a directive (section 10).
- A line starting with `|` is also a row of the table or chart being written (section 4.13): its cells are separated by bars. In a `code` block it is one line of the source, taken exactly (section 4.13): the one space after the bar is the bar's, every other space is the code's, and a bare `|` is an empty line.
- Inside text, `{…}` is a value when it reads as arithmetic on the controls on stage (section 4.14), and is ordinary text otherwise.

### Ids are optional

Everything on stage has an id. The brain gives one only to what it will refer to again; anything else is given `x1`, `x2`, … An id, when given, is the first word after the verb. On a `say` line a first word that names a style (built in, or defined by the brain) is that style and not an id, so `say strong | …` and `say fear | …` mean what they look like. On a drawn thing the first word is always the id (`pix ghost`, `circle stamp`).

### Forgiveness

A brain is a model writing fast. The parser is forgiving about everything except meaning: **a line is rejected only when there is nothing left to act on.** Losing a sentence over a typo is worse than losing a flourish.

| Problem | Result |
| --- | --- |
| unknown property, unknown value, unknown extra word | that token is ignored, the line is kept, a warning is recorded |
| a colour name nobody defined | `ink` is used, a warning is recorded |
| text longer than the limit | cut at a word boundary with `…`, a warning is recorded |
| a leading list marker (`- `, `* `, `1. `) | removed |
| a Markdown code fence | skipped with a warning |
| a row of cells written without its leading `\|` while a sprite is being written | read as a row |
| a `\| text` line when no sprite is being written | said as plain text |
| a path command that cannot be read | skipped; what was understood is drawn |
| a row of a table or chart written without its leading `\|` | read as a row |
| a Markdown table's rule row (`\|---\|---\|`), a closing bar | skipped; ignored |
| a link (`href=`) that is not an `http:` or `https:` address | the words are kept, the link is not; a warning is recorded |
| a `node` with no structure open; a `bind` that names no control, or a change a control cannot drive | the line is rejected, and the brain is told why |
| unknown verb; `say`, `correct`, `node` or `path` without text; a shape without its geometry; a missing required id or argument; a line with nothing to do | the line is rejected |

Aliases are accepted and never emitted: the verbs `camera`, `text`, `sprite`, `pixel`, `pixels`, `colour`, `polygon`, `polyline`, `image`, `picture`, `weather`, `particles`, `flowchart`, `graph`, `diagram` (a `flow`), `edge`, `connect` (a `link`), `pin`, `event` (a `node`), `plot`, `bars`, `barchart`, `candles`, `candlestick` (a `chart`, of that kind), `tabs`, `menu`, `stepper`, `select`, `dropdown`, `radio` (a `pick`, in that form), `switch`, `checkbox` (a `toggle`), `textbox` (an `input`); the camera moves `push-in`, `pull-back`, `pull-out`, `zoom`, `reset`; the properties `color`, `font`, `rotate`, `stroke-width`. In a `scene` header a bare layout, mood, pace or canvas word is accepted in place of `layout=`, `mood=`, `pace=`, `canvas=`.

### Explicit lines

Things a brain may leave implicit are settled before a line is scheduled or forwarded: the id of anything it did not name, which sprite, table or chart a row belongs to, which structure a node belongs to (`in=<its id>`), and whether a first word is an id or a style. A sprite is closed by the next line that is not one of its rows; a table, a chart and a structure of nodes stay open across speech, waits and changes, so they can be told a part at a time, until another structure or a new scene opens. `LineReader` and `LineNormalizer` in `language/src/normalize.ts` do this, in arrival order, once, on the server. After that every line stands alone: the wire carries `row cat | ..0..0..` and `say x7 strong | …`, never the short forms. `serializeLine` writes the one canonical form of a line; `parseLine(serializeLine(x))` equals `x`.

### Names

Element ids, scene ids, style names, colour names and look names match `[a-z][a-z0-9_-]*`, at most 24 characters. `all`, `scene`, `none`, `full` and `-` are reserved.

## 3. The stage

- The stage holds **elements**. Every element has an id, a kind, a layer, a lifetime and a style, whatever it is. The kinds are in the reference: text, shape, sprite, group, copy, picture, field, structure, node, link, control. A node, a link and a control are things like any other: `set`, `hit`, `drop`, `cam focus` and a tap reach them by id.
- The stage has four **layers** in depth: `far`, `bg`, `mid` (the subject and the reading plane, the default) and `fg`. The brain never writes a depth. Things on `far` and `bg` are backdrop: they never hold the pen.
- Content is grouped into **scenes**. A scene has a **layout**, a **canvas**, a **mood**, a **pace**, and optionally the number of text lines to expect. Opening a scene clears the previous one (section 4.1).
- **The canvas** is the scene's drawing space: a rectangle of square units with 0,0 at its top-left and y running down. There are three: `wide` (160 x 90), `square` (100 x 100) and `tall` (90 x 160). The painter fits the whole canvas, never cropped or stretched, into the room the layout leaves for pictures. The same coordinates therefore draw the same picture on every screen, and a script written once plays anywhere. Points outside the canvas are allowed (something can start off stage); `rect full` covers the whole screen whatever the canvas.
- A text element is **in the flow** of its scene when it is on `mid` and has no `at=`, `near=` or `in=` (in `layout=split`, `at=left` and `at=right` choose a column and stay in the flow). The layout places in-flow text; everything else is placed by its own coordinates, its `at=`, or its `near=`.
- **Where the picture and the flow go** depends on the layout. In `caption` the picture has the stage and the flow is a band under it; the band holds two lines and grows upward over the picture's ground (to at most the lower 65% of the safe frame) when the scene has or expects more, so every choice stays on screen and tappable, and in `caption` and `solo` the choices of a scene (`tap=yes` lines) gather under the content instead of replacing one another. In `figure` the picture has one side and the flow the other (side by side on a landscape screen, picture above on a portrait one). In every other layout both have the whole stage, and text that lands on something drawn is given a plate of the ground colour behind it so that it stays readable.
- **Drawing order** within a layer is the order of creation: later things are on top, text and drawn things alike.
- The stage has one **look** at a time: ground, inks, typeface, stroke and surface. Each look defines the colour roles `ground`, `ink`, `dim`, `accent`, `alt`. There is no house look; the default, `paper`, is only where an empty stage starts.
- The stage **persists**. Elements stay, and stay addressable by id, across turns, until a scene clears them or they are dropped.

## 4. Verbs

The generated reference (section 13) lists every form. This section is the meaning.

### 4.1 `scene` and `plan`: the plan comes first

```
scene [id] [layout] [canvas=…] [lines=N] [mood] [pace] [align=…] [clear=…]
plan  [lines=N] [mood=…] [pace=…]
```

`scene` opens a new scene and states its plan before any content arrives. This is the painter's lookahead: with `layout=stack lines=3` it can reserve the block and put line one where it will still be when line three lands; with `layout=figure` it knows before the first stroke that half the stage is for a picture.

- `lines=N` counts in-flow text lines only.
- `mood`, `pace` and `canvas` carry over from the previous scene when omitted, with one exception: a `figure` scene that names no canvas (and inherits `wide`) gets `square`, which gives the picture about 41% of a landscape screen instead of 23%; the next scene returns to the inherited canvas. `layout` does not: it defaults to `stack`.
- When the scene starts, elements leave according to `clear`: `scene` (default) removes everything not pinned; `all` removes pins too; `none` removes nothing. Each leaves with its own exit.
- A scene without an id is named `s<n>`, counting over the conversation.

A turn may begin without `scene`; its lines then join the scene already on stage.

`plan` amends the open scene. `lines=N` is about layout, so it applies as early as it can be seen: from the start of the scene if the scene has not begun playing, otherwise from now, and the painter re-flows smoothly. `mood=` and `pace=` apply to the lines that follow.

### 4.2 `style`, `color`, `look`: the brain defines its own words

```
style <name> [like=<style>] <prop>=<value>…
color <name>=#hex …
look  <name> [like=<look>] [ground= ink= dim= accent= alt=#hex] [face=…] [fx=a,b] [stroke=…]
```

All three define words that last for the whole conversation.

- `style` defines or redefines a named style. `like=` starts from another style. A definition may use the name of a built-in style, which shadows it. A definition affects elements created after it; elements already on stage keep the style they were resolved with.
- `color` names colours. A name can be used wherever a colour goes (`ink=`, `fill=`, `stroke=`). A name is looked up when the line that uses it is scheduled, so a colour is defined before it is used.
- `look` chooses a look, and with any property also defines it. `look night` wears a preset. `look dusk like=night ground=#2b1d3a face=hand fx=grain,vignette` defines `dusk` as a variation of `night` and wears it; later `look dusk` wears it again. A look with no `like=` stands on `paper`. The presets are written in exactly these words (see the reference), so a brain can read what `night` is and make its own. The painter takes the ground as written and moves every other colour, if it must, until it reads against that ground: a brain can ask for any palette and the stage never shows an unreadable one.

`look` is the only one of the three that takes time: the stage changes over the look-change length and the pen waits for it. Mid-answer, write it straight after a `scene` line so the change happens on a cleared stage.

### 4.3 `say` and `correct`: text

```
say [id] [style…] [<prop>=<value>…] [@time] | <text>
correct <id> [@time] | <new text>
```

`say` creates a text element. Its style is resolved in this order, later winning: language defaults, then each named style left to right, then the line's own properties, and finally, for `enter`, `by` and `exit` only, what the layout and the look decide for whatever is still open (section 6).

If an element with the same id is live, it leaves and the new one takes its place in the layout and in the drawing order.

**Callouts.** `say callout near=<id> | name` is a label with a line to the part it names; `say callout at=x,y | name` points at a spot. (`callout` is a built-in style: `label` and `leader=yes`.) The painter places all the callouts of a drawing together: in clear room round the drawing, ordered so that no two leaders cross, with no stroke through any word. A plain `label near=` still sits beside its target with no line; a label never gets a leader the brain did not ask for.

In a `layout=free` scene, words told no place (a `title`, a plain line) are the stage's to place: after every word told a point, clear of those and of what is drawn. A heading with no `at=` goes to the top of the stage, a little smaller before it gives up the top, never over the worked answer set at its own coordinates (fb-059). The painter and the server's measure are one engine, so they agree.

Text goes where the layout puts it, or `at=` an anchor or a canvas point, or `near=` another element. `near=moon` places it beside that element on whichever side has room; `near=moon:below` names the side. A `near` line is a label: it is read with the thing it names, so it holds the pen only for its own entrance. Labels keep to their target's extent and avoid other text and drawn outlines and fills (they slide along their side, then shrink within the look's minimum, and a label that still cannot find a clear place is the one sight reports). Text with `at=x,y` avoids other text the same way: it slides along its anchor's axis, then shrinks, and sight says `collides` for any overlap that remains; it says "landed as written" only when it did.

`correct` is in section 7.

### 4.4 Shapes

```
circle  [id] x,y r
ellipse [id] x,y RXxRY
rect    [id] x,y WxH [r=N]      or   rect [id] full
line    [id] x,y x,y [x,y…]
poly    [id] x,y x,y x,y [x,y…]
path    [id] | <SVG path data>
```

Each creates one shape, in canvas units. `rect` is a top-left corner and a size; `rect full` covers the whole screen on its layer and is the way to lay a sky or a ground. `line` is open, `poly` is closed. `path` takes SVG path data with every command, absolute or relative (M L H V C S Q T A Z); it is reduced to moves, lines, cubic curves and closes when the line is parsed.

A shape with neither `fill=` nor `stroke=` is an outline in `ink`. With only `fill=` it is a flat shape with no outline. `fill=sky>sea` is a gradient from the top of the shape to its bottom. `thick=` is the outline's thickness in canvas units; the look has its own when none is given.

**A shape draws itself.** Its default entrance is `draw`: the stroke travels along the outline in the order it was written, and a fill arrives over the last third. How long that takes depends on how long the line is (section 5.3). A shape with no stroke fades in.

**A shape declared again under a live id changes into the new one.** `circle sun 120,20 9` and later `circle sun 120,20 14 fill=accent` grows the sun and colours it; `poly sun …` turns the circle into a polygon. The painter reduces both outlines to the same number of points and moves one into the other. Only what the second line names is restyled.

### 4.5 `group` and `use`: things made of parts

```
group <id> [at=x,y] [prop=value…]
use [id] <source> [at=x,y] [scale=N] [rot=N] [prop=value…]
```

`group` creates a thing with no picture of its own. An element that says `in=<group>` is a part of it: its coordinates are measured from the group's `at=` (0,0 when it has none), it lives on the group's layer, and it moves, turns, scales, fades and leaves with the group. Colour set on a group is colour set on its parts. Text may be a part too: `say in=<group>` joins the group and moves with it.

`use` creates another copy of a group, a shape or a sprite, with its own place, size and turn. A copy is a live reference: it shows its source as the source is now, and leaves when its source leaves.

### 4.6 `pix`, rows and `frame`: pixels

```
pix [id] [scale=N] [fps=N] [key=c:colour,…] [prop=value…]
| ..7777..
| .777777.
frame [id]
| …
```

`pix` creates a sprite with no rows. Each row line that follows adds one row of cells, top to bottom; the sprite is as wide as its longest row and shorter rows are padded with empty cells. A row whose width differs from the first raises a `ragged-sprite` warning, which the brain is told in its next brief. A cell is one character:

- `.` or a space is empty (a space is transparent, like `.`).
- `#` is the `ink` role.
- `0`-`9` and `a`-`f` are the sixteen sprite colours (the reference lists them; the order is the one fantasy consoles use, so 7 is white, 8 red, c blue).
- any character named in `key=` is that colour: `key=o:accent,x:#224466`.
- any other character is `ink`.

Cells are drawn as hard-edged squares, never smoothed. `scale=` is canvas units per cell; without it the painter sizes the sprite to about two fifths of the canvas's height. `at=` places its centre; without it, it sits at the centre of the canvas.

A sprite's default entrance is `draw`: its rows land one after another, and because each row is its own line, a sprite is drawn on stage while the brain is still writing it. `frame` starts the next animation frame of the sprite; its rows follow. A sprite with more than one frame cycles them at `fps=`.

### 4.7 `paint`, `tex`, `soft`, `brush`: paint without an image model

```
paint [id] [x,y WxH] [over=<group>] [as=<medium>] [sketch=fade|keep] [mask=…] [| what it is]
```

**A painting is the painter's own rendering of the brain's sketch.** No image model is used: none is configured, and the owner has ruled out paid services. The brain draws the picture with ordinary shapes; `paint` puts a picture element over them (the given box, or the box of the group named by `over=`, or the whole canvas) and the renderer re-renders those shapes in a medium, as shader passes: washes that pool and granulate, edges that bleed, brush ridges, hatching, a posterised cut. It is revealed over the sketch like a wash; with `sketch=fade` (the default) the sketch's lines fade as it grows, with `sketch=keep` they stay on top. The text after the bar is optional: it is what the transcript calls the painting.

It paints what was drawn and invents nothing. A horse drawn badly is a badly drawn horse in watercolour. That is the limit of this round and it is stated in product.md.

Three properties make a drawing less flat without any painting: `tex=` gives a fill a texture (the reference lists them), `soft=N` fades a shape's edge over N canvas units (light, cloud, shadow), and `brush=` gives one line a stroke character of its own, whatever the look's is (`ink` swells and tapers, `dry` breaks up).

**A painting is not on the turn clock.** `paint` takes no time and holds nothing; the painting develops on the ambient clock.

The door to an image model is left as it was: when one is configured (`services.paint`), `paint as=photo | <what to paint>` asks it, the sketch is what is seen until it answers, and the report says `painted` or `unpainted`. Nothing in this round uses it.

### 4.8 `ambient`: atmosphere

```
ambient [id] <kind> [light|some|heavy] [ink=…] [layer=…]
ambient none
```

Fills the scene with a field of small moving things: rain, snow, stars and the rest (the reference lists them). The brain names the weather; the painter moves every particle. A field fades in, lives with its scene, and never holds the pen. It sits behind the subject (`bg`; stars and rays on `far`) unless a `layer=` says otherwise. `ambient none` clears the scene's fields.

### 4.9 `set`, `move`, `drop`, `hit`: what is already there

```
set  <id|scene|all> [style…] [<prop>=<value>…] [speed] [over=Ns] [@time]
move <id> <x,y|anchor> [speed] [over=Ns] [along=<path id> [period=N]] [@time]
drop <id|scene|all> [exit=…] [@time]
hit  <id> [gesture] [@time]
```

- `set` changes live elements of any kind: named styles and properties are applied on top of what they have, and the painter moves smoothly from old to new (colour, size, place, turn, scale, opacity, layer). It takes the short set length unless a speed word or `over=` says otherwise. `stay=pin` pins; `stay=beat` or `stay=Ns` schedules a departure.
- `move` sends an element's centre to a place. With `along=` it travels along a drawn shape's outline, by length, from the place it was drawn at (the nearest point of the outline), and stops where the outline ends unless a destination is given. On a closed outline (a circle, an ellipse) one whole move, or one whole range of a bound control, is one lap, clockwise, from where it was drawn back to it: a thing drawn at 3 o'clock is at 9 o'clock half way, the way a ride with `period=` goes round from its drawing.
- `drop` makes elements leave now, with `exit=` or their own exit. It takes several ids (`drop a1 a2 a3`); `set` moves an element and refuses to resize it.
- `hit` performs one gesture on one element and then is over.
- The target `scene` means every live element of the open scene; `all` means every live element.

### 4.9a Motion that keeps time

Five properties and one option on a control. They add no verb.

```
circle moon 85,50 1 loop=spin around=earth period=27.3
group pend at=50,10 loop=sway amp=20 period=2
move train along=track period=8
slider day 0 730 0 unit=d clock=time | Day
toggle run on clock=rate | Running
```

- `period=N` is one cycle of the element's loop (or one lap of its ride), in clock units: a second until a slider is the clock. Any size, negative runs backwards, and it is kept at full precision in the parser and on the wire (`period=0.0748` stays `0.0748`). A loop with no `period=` is decoration, as it always was. `period=` with nothing to time (no loop, no `around=`, no `along=`) is a `bad-value` warning.
- `around=<id|x,y>` is the point the element turns about, for `spin`, `sway` and a plain `rot=`. With an id the pivot is that element's centre and the element is carried by it as it moves: that is a moon. With a period and no loop it is a spin. The mover and its pivot must both be top-level or in the same group, or the line is a `bad-around` warning. An id that names nothing drawn is `unknown-id`, reported when the scene is over (the moon may be written before the planet).
- `along=<shape id>` with `period=` rides that outline for ever, upright: round and round on a closed one, there and back on an open one. It may be written on the shape's own line, in a `set`, or as `move x along=p period=N`; all three mean the same. `along=none` stops it. A `move … along=` without `period=` is still one pass on the turn clock.
- `phase=0..1` is how far into its cycle it is when the clock reads zero. `amp=N` is how far a loop goes: degrees for `sway`, canvas units for `bob`, a share for `pulse` and `breathe`.
- `clock=time` on a slider makes its value the stage clock, so periods are in its units; `clock=rate` on a slider or a toggle makes it how fast the clock runs (a toggle is 1 or 0). A second `clock=time` slider replaces the first, with a warning. The option is `clock=`, never a bare word, so a slider may still be called `clock`.
- **Motion takes no time on the turn clock.** It holds no pen and adds nothing to the schedule's end; the same lines give the same schedule as without it. An `over=` longer than 20 s is cut, and now says so and names `period=`.
- Painters say whether they perform it with `Capabilities.clockwork`; none does yet, and the brain is not taught these words until one does.

### 4.10 `cam`: the camera

```
cam <move> [id|direction] [speed] [over=Ns] [amount=0..1] [@time]
```

Starts a camera move at the pen that runs underneath the following lines. Each move eases from wherever the camera is, so moves chain; `rest` returns home. `focus` needs the id of a live element; `pan` needs `left`, `right`, `up` or `down`. Because the layers are at different depths, a pan or an orbit slides near things past far ones. `over=` and `amount=` are hand level.

### 4.11 `wait`

```
wait [N | Ns]
```

Moves the pen forward without doing anything. `N` is in beats (default 1), and a beat follows the pace; `Ns` is exact seconds (hand level).

### 4.12 `correct`, `revise`, `cancel`: changing your mind

See section 7.

### 4.13 Structures: `flow`, `tree`, `cycle`, `timeline`, `map`, `table`, `chart`

```
flow     [id] [right|down] [x,y WxH] [| title]
tree     [id] [down|right] [x,y WxH] [| title]
cycle    [id] [x,y WxH] [| title]
timeline [id] [x,y WxH] [| title]
map      [id] [route] [x,y WxH] [| title]
table    [id] [bars] [x,y WxH] [| title]
chart    [id] [line|area|columns|candles|ohlc] [indexed] [log] [spark] [live] [approx] [x,y WxH] [data=<id>] [| title]
code     [id] [lang] [file=<name>] [x,y WxH] [| title]
tune     [id] [tempo=<bpm>] [voice=piano|strings|chip|bell] [x,y WxH] [| title]

node [id] [number | x,y] [ask|end|note] [from=<id>[:label]] [x=<when>] [y=<value>] [prop=value…] | <words>
link <a> <b> [c…] [both|plain] [dashed] [| label]
| <cell> | <cell> …
```

A structure is a diagram the brain names and the painter lays out. The line that opens it says what it is and, optionally, the room it has (`x,y WxH` in canvas units; otherwise the whole canvas) and a title. Its parts follow, one a line, and the painter places every one of them: no part of a structure is ever given a coordinate, except the pins of a map, whose places are what the brain knows.

**Parts are elements.** A node and a link have ids and can be restyled (`set q1 fill=accent`), pointed at (`hit q1`), dropped, framed (`cam focus q1`), tapped, and travelled (`move dot along=<link id>`). Words, waits and changes may come between the parts, so a diagram can be told a step at a time.

**It is laid out from every line that has arrived**, not from what the playhead has reached. The brain writes seconds ahead of the audience, so most of a diagram is known before its first node is seen. When a part arrives after the layout has been shown, what is on stage moves as little as it can, eased; in an export, where every line is known from the start, nothing moves.

- **`flow`**: nodes joined by arrows, in ranks, `right` or `down` (the painter chooses when neither is said). A node's `from=<id>` draws the arrow from that node; `from=q1:yes` writes one word on it. `link a b c` adds arrows in a chain, with a label after the bar. Node words: `ask` (a decision), `end` (a start or a stop), `note` (no frame); a plain node is a step. Arrows are routed round nodes and never through one; a label on an arrow sits on a plate and never on another label.
- **`tree`**: as a flow, laid out as a tidy tree: each node under (or beside) the node its `from=` names.
- **`cycle`**: nodes round a ring in the order written, each leading to the next and the last to the first. The ring closes by construction. `link a b | label` labels an arc or adds a chord.
- **`timeline`**: each node gives its number first (`node 1969 | Apollo 11`); the painter draws the axis and places the nodes **to scale**, staggering their words above and below with a tick to each. Two numbers are a span (`node 1961 1972 | Apollo programme`). Nodes with no numbers are spaced evenly in order.
- **`map`**: each node is a pin at the brain's own `x,y` on the canvas; the painter draws the pin and finds its label a place clear of every other pin, label and stroke, with a short leader when it has to move away. `route` joins the pins in the order written. A map has no map data: the brain draws the land and water with ordinary shapes first.
- **`table`**: rows of cells between bars, as Markdown writes a table; the first row is the header, and a first column of names is set as row headers. Columns are sized by their content, numbers are aligned on the right, and rules are the look's hairlines. `*Stars*` mark a cell. `table bars` also draws its numbers as bars beside the figures: a ranking.
- **`chart`**: see below.
- **`code`**: source taken exactly. Each `| line` after it is one line of the source, **never split into cells and never trimmed at the front**: indentation is kept, a `|` inside the line is only a character, and a bare `|` is an empty line (it is a row of a code block and nowhere else; in a table or a sprite it says nothing). A line is cut at 1,160 characters and a block holds 400 lines. `lang` is a word of the reference (`python`, `ts`, `bash`, `c++`, `json`, …) or `lang=<anything>`; the painter highlights what it knows and sets the rest plain. `file=<name>` is the file the code is from, shown as its header, and `| title` is a heading above it. The painter sets it in the look's monospaced face inside its frame, each reserved word, string, number and comment in its own colour (`painter/blocks/code-lex.ts`), every line at its own columns so indentation is exact; the lines land one after another, quickly (a listing is read, not watched). It does not scroll or offer a copy action yet: a line wider than the room is cut with an ellipsis and rows past the room's height are left for a last line that says how many more (both are `crowded`), and a selection or Copy answer gives the lines as written. The brain is taught to use `code` for any code, and never a `say` or a list line.
- **`tune`**: music, as ABC notation (the plain-text score every model has read). Each `| row` after it is one line of the score, **taken exactly like a line of code** (the one space after the bar is the bar's; a row that begins `|:` or `||` has no such space and is all music; a line with no bar at all, when it is no verb, is read as a row of the tune just opened). The painter draws the tune as a piano roll in the look's inks (one colour a voice, a bar line each bar, the keys' names down the side), a playhead that moves with the sound, and each note lighting as it sounds; it plays it on its own synthesiser, with nothing to load. `tempo=<bpm>` (30 to 240, quarter notes a minute) wins over the score's `Q:`; `voice=` is the instrument, one of `piano`, `strings`, `chip` (a square-wave lead), `bell`, and a piano when it is not said. `| title` is the heading, and wins over `T:`. A tune holds 160 rows, 3,000 notes and 300 seconds.
  - **The ABC read.** Fields `K:` (any tonic with `#` or `b`, major, minor and the church modes), `M:` (`4/4`, `6/8`, `C`, `C|`), `L:` (unit length; `1/8` by default, `1/16` under three quarters), `Q:` (`1/4=120`, `120`), `V:` (a voice), `T:` (title); a field may stand inside a line of music, in brackets (`[K:G]`, `[V:2]`). Notes `C`-`B` (the octave of middle C) and `c`-`b` (the one above), `,` and `'` for other octaves, `^` `^^` `_` `__` `=` for accidentals (they hold to the bar line, and the key signature is applied), lengths (`2`, `/2`, `3/2`, `/`), rests `z` and `x`, a bar's rest `Z`, `>` and `<` for dotted pairs, `-` for ties, `(3abc` and the other tuplets, chords `[CEG]` with a length inside or after. Bar lines `|`, `||`, `|]`, `[|`, repeats `|:`, `:|`, `:|:`, `::`, and first and second endings (`|1`, `:|2`, `[1`, `[2`). **Two voices**, `V:1` and `V:2`, each written from the start: a melody and a bass; any voice after the second is skipped. Skipped with a warning and never a failure: grace notes `{}`, overlays `&`, a field or a sign it does not know. Skipped quietly because they are about the page, not the sound: chord symbols `"Am"`, decorations (`!trill!`, `.`, `~`), slurs, lyrics (`w:`), `%` comments, and the fields `X: C: N: Z: O: S: R: B: D: F: G: H: I: P: A:`.
  - **When it sounds.** The notes of a tune are not played as its rows arrive, because a bass written after the melody would begin late: the music **begins when the block is closed**, that is the moment the brain writes any line after it (a `say` will do), or the turn ends. From then the painter's clock and the music's agree: the playhead is at the sound. A tune stays on stage as a picture when the next turn begins, and the sound stops then (a new turn, `Stop` and `/stop` all stop it; the sound control mutes it). The first sound of a page needs a click or a key, and the Send that asked for the music is one. Nothing is loud: the master volume is low, notes are shaped, and a limiter keeps a thick chord from jumping.
  - **Taught only when asked.** The system prompt does not teach `tune`; the turn's brief does, when the user's words are about music (play, song, melody, tune, sonata, music, chord, compose, MIDI, beat) or a tune is on stage, with an eight-bar example in two voices and the rule that a piece asked for is 16 to 32 bars unless the user asks for more.
  - **Export.** The Save menu holds `Save MIDI`, a standard MIDI file of the tune on stage (a tempo track and a track a voice).
- **`app`**: a live app. Each `| row` after it is one line of ONE HTML document (inline `<style>` and `<script>`, no `<html>`, `<head>` or `<body>` tags), **taken exactly like a line of code** and always with its bar. `height=<n>` is the room it asks for (120 to 1200); the stage plan gives it the rest like any block. The app runs in a locked sandbox over its room (`web/src/surfaces/host.ts`): `sandbox="allow-scripts"` and nothing else, a Content-Security-Policy in the document that allows no network at all, and a page policy that lets a frame hold nothing but an inline document. A document is at most 700 lines and 60,000 characters. Until it is whole the room shows a skeleton of the lines arriving; the app **starts when the block is closed** (any line after it, or the turn ending), and a picture of it, taken by the app itself or by copying its document, stands in the stage's snapshots, exports and the critic's look.
  - **The bridge.** The app has a global `conduit`: `conduit.send(name, value)` (what the user did; the brain reads it as `THE USER DID IN THE APP` on its next turn), `conduit.ask(name, value)` (the same, and asks for a new answer now), `conduit.state(obj)` (saves the state; `conduit.state()` returns it, so a rebuilt frame restores it) and `conduit.snapshot(fn)` (the app draws its own picture). The look arrives as CSS variables `--ink --ground --accent --on-accent --alt --dim --line --good --bad --font --font-px --radius --gap`.
  - **Taught only when asked.** The system prompt does not teach `app`; the turn's brief does, when the user's words ask for something that works (an app, a game, a calculator, a tool, a tracker, a quiz, a practice sheet that checks answers, "actually works", "fully interactive") or an app is on stage. A mock-up asked for as a picture is still a `screen`. `/stop-all` ends every running app; a `scene` that clears the stage removes its frame.

**Rows.** A line that starts with `|` is a row of the table or chart being written. A row may be written before or after other lines (a table can be revealed with words between its rows). Each row lands a step after the last.

**Charts are an instrument, not a drawing.** The painter does not draw a chart from shapes. It reads the rows into a model (`chartModelOf`, `language/src/chart.ts`) and hands it to a charting engine that gives it what a trading terminal has: formatted axes, gridlines, a crosshair with the value under it, pan and zoom, a legend, marks, a volume pane, and tens of thousands of points at sixty frames a second. It takes its colours and face from the look.

- A chart row is `| when | value…`. Values are separated by bars or by spaces. `when` is a date (`2026-03-09`, `2026-03`, `Mar 2026`, `Q1 2026`), a year, a number, or a name. One value is one series; a first row of words names the series (`| year | Japan | Korea`). For `candles` and `ohlc` the values are open, high, low, close, and volume if there is one, by name in a header or by place.
- Numbers are written as people write them (`1,204.5`, `$3.50`, `-4.1%`, `8.2B`, `72 kg`); the axis and the crosshair write them the same way.
- **Time and numbers are drawn to scale**: equal steps are equal distances however unevenly the points are spaced. Names take one slot each. Candles and OHLC bars sit side by side with the gaps between sessions closed, as on every trading chart.
- Chart words: `indexed` (every series starts from 100, so growth can be compared), `log`, `spark` (no axes or grid: a small chart for a tile), `live` (the last point pulses), `approx` (the numbers are recalled, not data: the chart says so by its title).
- **Marks.** A `node` after a chart is a mark on it: `node x=<when> | label` is an event (a labelled line at that time), `node y=<value> | label` a level (a labelled line at that value), both together a point.
- A cell may be `{…}` (section 4.14): the chart then follows the controls. **So may a chart's title and the words of its marks**: `{rate}` in either is the control's value, set again whenever it changes. A cell may name a control that is written *after* the chart; until the control arrives the cell stands for a number and nothing is said about it.
- **Data by reference.** A chart of a few dozen points is written as rows (at most 400). Anything larger, or anything that must be true to the last digit, is never retyped by a model: when the brief names DATA (`DATA d1: …`, section 8), `chart … data=d1` draws it. The server sends the rows to the painter itself. Like a painting, data is not on the turn clock: the chart shows its axes at once and reveals itself when the rows arrive.
- **There is no market data.** A brain asked for a stock's year either has DATA (the user pasted it) or draws what it recalls, coarsely, and marks the chart `approx`. A guess is never dressed as data.

### 4.14 Controls and `bind`: things the user can work

```
button [id] | <label>
toggle [id] [on|off] [clock=rate] [send] | <label>
slider [id] <min> <max> [value] [step=N] [unit=…] [clock=time|rate] [send] | <label>
pick   [id] [tabs|menu|steps] [N] [send] | <a> | <b> | <c>
input  [id] [send] | <placeholder>
card   [id] [x,y WxH] [| title]

bind <control> | <a set, move, correct or shape line>
bind <control> <from>..<to> | <change>
bind <control>=<value> | <change>
```

A control is declared in one line, drawn by the painter in the look, and worked by the user. It is on the stage like anything else: in every picture the brain is shown, in every exported film, under the camera. It sits in the flow like a line of text (in `caption` and `solo` it gathers under the content, as a choice does), or takes `at=`, `near=` or `in=`. A `card` is a group with a frame and a title: its parts say `in=<id>`.

**What a control holds.** A slider: a number between its ends. A toggle: on or off. A pick: one of its options, by number from 1 (`tabs`, `menu` and `steps` are three ways of showing the same choice; `steps` has back and next). An input: its text. A button holds nothing.

**Local first.** A control changes the stage in the painter, at once, with no word to the brain. That is what `bind` is for:

- `bind angle | move sun along=arc`: the change is as far along as the control is across its range. Dragging the slider scrubs the change. For a toggle, off is the start and on the end; for a pick, the first option and the last.
- `bind spin | move namer 34,26`: the same for a move to a point. The thing goes in a straight line from where it is drawn to that point as the control goes from its minimum to its maximum, and is exactly half way at half way: a change the hand makes is never eased, so the picture is under the finger. Several moves on one thing are taken in the order written, each from where the one before ends.
- `bind angle 0..45 | …`: the change runs from start to end as the control goes from 0 to 45, in the control's own units. Several binds over parts of a range make a change that is not a straight line.
- `bind view=night | …`: the change has landed while the control holds that value (an option's words or its number, `on`, `off`), and is undone otherwise, eased.

The change is any line that changes something on the clock: `set`, `move` (with `along=`), `correct` (the words are swapped, never struck through), or a shape declared again (it morphs).

**What a control may drive.** A bound `set` works on anything on stage by id: text, a drawn thing, a group, a card, a diagram, a chart, a block of code, a picture. That is how a chart or a diagram is **shown and hidden** by a control, the same bound changes as any element: `bind view=chart | set sales opacity=1` and `bind view=table | set sales opacity=0`. Colour set on a diagram reaches its parts. A bound `move` carries what the painter places by a point: a drawn shape, pixel art, a picture, a group or a card. The layout places words, and the painter lays out a diagram, a chart or a block of code, and a control stands where the flow puts it: a control cannot carry those (hide, show or recolour them with a `set`, swap words with `correct`). What cannot be bound is rejected by name, as a `bad-bind` issue that says which control, which thing, and what to write instead: `correct` and a shape's morph only fit text and shapes, a `move` only fits what is placed by a point (above), a node or a link cannot be `move`d (the painter places them), and a control that is not there, or a target that is not there, is named. **A control that does nothing is told.** When the turn ends and every bind on a control leaves what it names exactly as it is (`bind spin | move globe 80,45` with the globe already there, a `set` of what is already set, a `correct` to the words already shown), the control is a `dead-bind` warning on its last bind, and the brain's next brief says so twice: as the line that did nothing, and as an urgent thing seen (`a bind did nothing: …`). It is judged on what the whole turn adds up to, not line by line: the first of `bind view=chart | set sales opacity=1` and `bind view=table | set sales opacity=0` changes nothing alone and the pair works. A control with no bind at all is left alone (a form's field, a choice: the brain is told what it holds), and a bind that names nothing drawn is `bad-bind` or `unknown-id` and is told the same way (`TurnScore.settledIssues`). What changes *inside* a chart or a diagram (the numbers, the words) follows a control through `{…}` in a cell, a title or a mark, never through `bind`. A bound change is not on the turn clock: it takes no time, holds nothing, and the schedule is the same whatever the user does. Several on one element apply in the order written, each from where the one before leaves it. What `bind` means is defined once, in `language/src/bind.ts`.

**Values in text.** `{angle}` in any text shows that control's value as words (an option's text, `on`, a slider's number with its unit). `{round(10/tan(rad(angle)), 1)}` is arithmetic on values: numbers, control ids, `+ - * / % ^`, comparisons, brackets and the functions in the reference; `{expr:2}` asks for two decimals. Braces that do not read as arithmetic on a live control are left exactly as written, so code and set notation are safe. Computed numbers group their thousands (`12,345.68`; a whole number from 1900 to 2100 is left alone, being far more often a year than an amount), and **a unit written twice prints once**: a slider with `unit=%` shows `5%`, and `{rate}%` after it still reads `5%` (`unitOnce`, `language/src/expr.ts`). A name in arithmetic is one word: a control that is computed with is called `rate`, not `interest-rate`. It is parsed by hand (`language/src/expr.ts`) and never evaluated as code.

**What goes up to the brain.** Pressing a `button` opens a turn, as a choice's tap does: the input is `act`, with the button's label and the value of every control on stage, so a few controls and a button are a form. A control marked `send` does the same when the user commits a change to it. Every other change is heard, not sent: the brain is told at its next turn what the user set and where every control stands. Nothing is sent while a slider is being dragged.

**Later, not now:** a sandboxed component the brain writes itself (a custom control with its own drawing and logic). The catalogue above is closed; the door is the `control` family in the vocabulary, which a new kind joins without touching the grammar.

### 4.15 `pic`: a picture the user gave

```
pic [id] from=<picture id> [x,y WxH] [prop=value…]
```

The user can paste, drop or pick a picture into the prompt bar. The server stores it with the session and gives it an id (`u1`, `u2`, …), tells the brain which ids this turn holds, and passes the pictures themselves to the brain. `pic photo from=u1` puts it on stage as an element called `photo`: whole inside the canvas when no box is given, or in the box `x,y WxH`. It is then like any picture: the brain can label parts of it (`say near=photo`), draw over it, trace it with shapes and point at it. It is never sent anywhere but the brain. Whether `from` names a picture the session holds is for the server and the painter to say, not the language. Said again exactly as it is, it is nothing (section 7.3).

### 4.16 `deck`: a turn of slides

```
deck | <title>
```

`deck | title` makes the turn a deck: **each scene after it is a slide**. The line itself opens the first slide (a scene written straight after it, before anything is on the slide, is that slide's own header). `Schedule.deck` says where each slide begins and where its own content is done (`SlideSpan.start`, `end`): the painter stops the clock at each `end` and the viewer steps on with the arrow keys, a swipe or the counter. The title is the deck's name for the counter, the transcript and the saved film. The brain writes it when slides are asked for ("a PowerPoint", "a deck", "slides"): several scenes, each with a headline and one idea, never one scene of loose text.

### 4.17 `standing` and `refine`: for the server

```
standing | <what the user asked to hold, in their words>
standing drop <n> | standing drop all
refine [passes]
```

Neither is ever scheduled and neither reaches the painter; `TurnScore.push` answers `ignored` and the conductor reads them from the lines. **`standing | …`** records what the user said is to hold from now on ("add a visual to every reply"): the conductor keeps up to six for the conversation, 140 characters each (`STANDING_LIMITS`), gives them back in every later brief, and the look holds the draft to them. `standing drop 2` lets go of the second one in the list the brief gave; `drop all` of every one. **`refine [passes]`** is the brain's way of saying the user asked for iteration: the server then runs the refinement passes (`REFINE_LIMITS`; `passes` is clamped to 1..8, and absent means as many as are worth it).

### 4.18 Links: `href=`

`say … href=https://… | words` makes the words a link: it opens in a new tab, and is set apart from other words by the look. Only an `http:` or `https:` address is a link; anything else (`javascript:`, `data:`, a bare path) is dropped with a warning, and the words stay. The address is as written, at most 400 characters. A link is a property of the element, carried with it, and the transcript and the copied answer keep the words and the address. Sources the brain cites are links.

### 4.19 Interfaces: `screen`, `row`, `col`, `end` and the parts

```
screen <id> phone|tablet|desktop|browser [from=<screen>[:label]] [| name]
row | col  [gap=none|xs|s|m|l|xl|N] [pad=…] [align=start|center|end] [spread] [grow] [wrap] [card] [lift] [max=N] [center]
end
nav [back|close|menu] [action=<icon>] [links="a,b,c"] | Title        tabbar icons=a,b,c | One | Two
heading | words    text | words    note | words    button [primary|ghost|danger] [wide|small] [to=<screen>] [send] | Label
field [error|password] | Label | value | message    item [icon=<name>] [chevron|toggle] [value=…] | Title | subtitle
badge | words    price | 34 | /mo    progress 2 of 4    image [wide|square|tall|round] | what it shows
icon <name>    divider    space [s|m|l|grow]    pick | Label | A | B    toggle | Label    slider | Label | N    chart ref=<id> | Title
look wireframe | studio
```

A mock-up is described, not drawn. The brain says what is on each screen, in order; the painter sizes, spaces and aligns every part (an auto-layout subset of flexbox, solved in `web/src/painter/blocks/ui`), sets it in the look's tokens, and stands the screens side by side at true proportions, scaled together to their room. A phone is 390 points across, a tablet 820, a desktop 1280 and a `browser` is a desktop with its chrome. The brain never gives a part a coordinate and never builds a control out of `rect`s.

- **Read only inside a screen.** `screen` opens a mock-up. The words `row`, `col`, `end` and the parts are the interface's only from then until a `scene`, a `deck`, a `pix`, another structure or a lesson word (`part`, `step`, `ask`, `hint`, `reply`; section 4.20); before it, `row` is a sprite's row and `text`, `image`, `menu` keep their aliases (`say`, `paint`, `pick`). A word inside a screen that is no part is set as `text` and named in the brief's list of repairs. `interface.ts` (`language/src/interface.ts`) is the reader.
- **One block.** The first `screen` line opens a structure (verb `screen`, kind `screen`); every later line of the interface, later `screen` lines included, is a row of it, taken as written like a line of code. A journey of six screens is one block.
- **Every line stands alone.** The normaliser keeps the stack of open `row`s and `col`s and writes `id=` and `in=` on every part, so a line on the wire says what it sits in and `end` means nothing to the painter: `heading id=s1.heading1 in=s1.col1 | Welcome back`. The wire form of the block is `screen x1 | screen s1 phone | Sign in`, then `row x1 | <that line>` for each part, and each lands a step after the one before (0.06 s).
- **Looks.** `wireframe` (boxes and lines on white) and `studio` (a finished design) are looks like the rest and are taught by the interface chapter, not by the fixed prompt. The same lines serve both; `look studio` after a wireframe is the wireframe becoming the design.
- **Pictures.** `image … | what it shows` is a placeholder at once. Where the owner has switched a source on (`PICTURES=openverse`), the server looks for a photograph by those words, never on the turn clock; when one is found it arrives as a `picture` event and the painter draws it in the placeholder's place with its credit at its foot. Failing, the placeholder stays.
- **Taught only when asked.** The system prompt holds one clause ("A mock-up, a page, an app screen: INTERFACE lines, never rects"); the brief carries the chapter (`INTERFACE_CHAPTER`) when the user's words are about an interface (mock-up, wireframe, screen, page, app, site, figma, landing, UI, journey) or a mock-up is on stage.
- **Live parts.** Tabs, picks, toggles, sliders, fields and buttons answer fingers on the stage. A tab, a pick and a field answer at once; a field takes the keyboard and shows what is typed (`password` shows dots). A toggle and a slider are held: the knob follows the finger (pointer capture, so the gesture survives leaving the part), a toggle lets go to the side its knob is on, and a slider to a whole percent, each by a short ease (a tap flips a toggle by the same ease). A button looks pressed while the finger is down and acts when it lets go on it.
- **A button that reaches the brain.** A `button` with no `to=` opens a turn when it is pressed: the input is `act` with `text` the button's label, `screen` the screen it is on and `values` what every live part of that screen holds, by its label (`Email="ada@x"`, `Remember me=on`, a slider as a whole percent, a pick as the option's words). A password is never sent: only `filled` or `empty`. A button with `to=<screen>` is a prototype's own step: it brings that screen forward and tells nobody, unless it also says `send` (a Sign in that opens the next screen and must be heard). A disabled button does nothing; `item` rows and `nav` icons never send. The brief says "The user pressed "Sign in" on screen s1 of your mock-up" and the values.
- **To change a mock-up, write its screens again.** A `screen` written with the id of a screen already on stage (this turn or an earlier one) replaces that screen where it stands: its lines are put in the old block in its place, in the same position on the board, and the screens that were not written again stay. A new id is a new screen after the others. Nothing is drawn twice. The interface chapter teaches it ("to change a mock-up, reuse its screen ids").
- **Not yet.** A part is not an element: `set`, `hit` and `drop` reach the block, not one part by its id. `set <screen> device=desktop` is not wired in the product (it works on `bench-ui.html`).

### 4.20 The document and its lessons: `part`, `step`, `ask`, `hint`, `reply`, `end`

```
part <id> [in=<part>] [tag=<word>] [for=<ask>] [crop=x,y,w,h [from=<photo>]] | <title>
step [id] [in=<part>] [show=<visual> [a..b] [key=value…]] | <words>
ask <id> [in=<part>] is=<a>[,<b>…] [pick=<x>,<y>,<z>] [unit=<unit>] [check=working|order|any|done] | <question>
hint [in=<ask>] | <words>
reply | <words>
end
```

These words build a **document**: a tree of parts, a mind and a person's shared place to come back to (PLAN-v3-core 2.1). They are a table of their own, `LESSON_VERB`, and not rows of `VERB`: the fixed prompt is built from `VERB`, and a lesson is taught by its own chapter on its own cues. They put nothing on a painted stage and take no time (`QUIET_VERBS`); `L/document.ts` keeps them.

- **`part`** is a place in the document: a sheet, a section, a question, a way of doing it. Its title is its words. **Written with only a title it is an outline**: named now, written later. `in=` says what it sits in; the first part written is the document's root, and one with no `in=` sits in the part last opened (an open `part … end` block) or, with none open, in the root. `tag=` is the technique a way uses, one of the table below; the catalogue lists by it, and a word that is not in it is dropped with a warning. `crop=` is where a question sits on the photo it was read from, in whole percents of the photo's width and height from its top left (`crop=6,31,88,7`), so that the lesson page can show the worksheet's own words; `from=` names the photo when a conversation has several (absent, the first). A `crop` that is not four numbers inside the photo is dropped with a warning. It is written again by writing the part again.
- **`step`** is one reveal of a lesson: its words and the picture shown with them. Steps stack into a worked page, and nothing shown is taken away. It sits in the part it names, else the part last written. The normaliser gives an unnamed step an id; **writing the same id again replaces the step**, which is how a step that gave an answer away is mended.
- **`ask`** is a try. The learner types the answer, or taps one of the large choices in `pick=`; it is checked on the page, at once, with no round trip. **`is=` holds every answer the ask accepts and no other word does**: a comma between answers, a `_` for a space inside one (`is=ten_pence`), so an answer cannot hold a comma. It lists the ways of writing the **one** answer (`is=6281,six_thousand_two_hundred_and_eighty_one`), never a step of the working. A number's thousands are part of it, never a second answer: `6,281` in `is=` reads as `6281` (a list of three-digit numbers, `100,200`, stays a list unless it ends in `000`; the items of `check=order` are never merged), quotes round a value are dropped, and what a person types is matched as a number whether it is `6281`, `6,281` or `6 281`. When the question is a plain sum (`3486 + 2795 = __`, `What is 12 x 7?`) and the ask accepts its answer and also another number (`is=6281,6`: the ones digit of the working), the line plays with the other dropped and the brain is told why; a step of the working is its own `ask`, or a `math` block (`blank=all`). A hint is refused only when it shows a number the ask really accepts (what the question itself is made of is no secret). `unit=` is the unit a typed unit is read against. `pick=` needs two or more choices, one of which is an accepted answer. `check=working` is for a question she works out on paper: what she tries is her working, read from her ink into lines (a step to a line, "61 - 50 = 11"), and it is right when every step checks out with exact arithmetic (`language/src/maths`, which also recomputes every ask when a lesson is verified) and the working ends on an answer in `is=`. A wrong step is named ("12 + 12 is 24, not 22"), and a line that cannot be read is never counted wrong. `check=order` is for putting things in order: `is=` lists the items IN THE RIGHT ORDER (the question's own numbers or words), the page shuffles them into tiles she drags into place (or taps two to swap), and a try is her sequence, compared item by item with the same matcher (numbers as numbers). Nothing is sealed for it (the items are on the page already; the order is the secret), and when the words say which way ("smallest to largest") the checker holds `is=` to it. An `ask` is a gate: nothing written after it is drawn until it holds an accepted answer (or its hints are used up). On the stage, an ask that waits for the one before it (`stage=2:q1`) draws nothing at all, no number and no blank, and stands nowhere (so nothing is crowded by it); it appears when the ask before it is right or given up.
- **`hint`** is what is said after a wrong try, one hint a wrong try, in the order written. `in=` is the ask it is for; absent, the last ask of the open part. An id the brain reuses in another way (`a1` in every way) is made its own by the normaliser (`a1-2`), and the hints that follow find their ask by the part they are in.
- **`reply`** is the answer as one sentence for the conversation's thread. It is never drawn on a stage.
- **`end`** closes the part last opened without an `in=`.

Every line stands alone on the wire: the normaliser writes `in=` and an id on every line that needs one. A part's id in the document is its parents' ids joined by `/` (`w1/s2/q7/a2`); a painted scene is `#1`, `#2`, and a conversation with no part at all has the root `root`.

**The pictures a step may show** (`VISUAL`): the lesson view's own widgets, each worked by hand. After `show=<visual>` come its span (`0..70`, when it takes one) and `key=value` pairs; a value of kind `numbers` is a comma list in which `?` is a gap the learner fills. A word or value the picture does not know is dropped with a warning and the step stays.

| Picture | Takes | Shows |
| --- | --- | --- |
| `numberline` | a span `a..b`; `mark` (number), `hops` (numbers, signed), `step` (number) | a number line: a place marked, hops along it |
| `groups` | `count`, `each` (numbers); `parts` (numbers); `label` (word) | groups of counters to tap and count |
| `blocks` | `tens`, `ones`, `take` (numbers) | ten-rods and unit cubes: a number built, or taken away from |
| `bar` | `total` (number, absent when it is the gap); `parts` (numbers) | a bar model: a whole and its parts |
| `coins` | `coins` (numbers), `target` (number) | coins to count and add up |
| `clock` | `time` (like `3:30`), `mode` (word) | a clock face to read or to set |
| `ruler` | `mm` (numbers: each straight road in millimetres, in order; drawn, never written) | a ruler she drags along a road, its zero clicking onto a place, to read the length off herself |

**Tags and help.** `tag=` is any one word naming what kind of part it is; it means nothing to the reader. What is help is what says `for=<ask>` (a part with a `tag=` and no `for=` helps the last ask of the part it sits in, so documents written before `for=` read as they did). The ways of a primary-maths question (`TECHNIQUE`: `draw-it`, `share-it-out`, `count-on-a-line`, `make-ten`, `break-it-apart`, `find-the-pattern`, `read-the-question`, `work-backwards`) are content: the lesson page has names for them, and a technique card teaches them. **Two asks with no right answer:** `check=any` (a choice: `pick=` the options, no `is=`) and `check=done` (a tick); the gate opens when a value is held, and nothing is sealed or checked.

**An open ask seals its answer, by structure** (2.6). A rule the brain must remember is not a rule, so in three layers:

1. *The reader refuses.* When an `ask` or a `hint` arrives and what is already on the page holds an answer it accepts, the line is refused (`spoiler`), with the step to write again named. What is on the page: the way's title, every step before the ask (its words, and the numbers its picture was told, but not the ends of a span), the asks and hints before it, the ask's own words. A number the question itself is made of (the titles of the parts above the first way) is no secret and may be used. Numbers are matched as numbers (`60`, `sixty`, `60 flowers`), a constant `{5*12}` as its value, words as phrases.
2. *Whatever draws masks.* A drawer asks `sealed(value, openAsks)` of every word, readout, computed `{expression}` and widget label it is about to show, and draws a gap in its place; a readout may show partial work ("2 vases: 12 + 12") and never the total. `maskSealed(text, openAsks)` does it for a string.
3. *The invariant reads the whole* (`lintLesson`), in the page and for the verifier.

**Answers** are matched as what they are (`matchAnswer`): numbers as numbers (`34`, `thirty four`, `60 flowers`), money and units as what they measure (`£1.50`, `1.5`, `150p`; `30 cm`, `0.3 m`; a unit of another kind is wrong; a bare number is right for an answer with a unit), a time of day as a time (`3:30`, `half past three`), and anything else as the same words once case, punctuation, a leading `a` or `the` and a plural `s` are let go. A sum (`5 x 12`) is not an answer.

**The document's types** (`language/src/document.ts`): `Document`, `DocNode`, `Cursor`, `Play`, `DocState`, and `advance(doc, state, event)`, the only writer of what the person did; `foldDocument(records)` makes a document from a conversation's log, and a flat conversation is one (the root is one part, every `scene` opens a scene node, and a turn with no `scene` line adds a segment to the open scene). A node is `outlined`, `filling` while a turn writes to it, `filled` when the turn finished, `verified` or `refused` when the verifier has said (a refused way is never checked wrong).

**How the brain is taught it** (`language/src/teach.ts`, WS7, split by GEN1a). Not in the fixed prompt. A short neutral DOCUMENT chapter (the lines, outline then fill, what an ask seals, the two asks with no right answer, "the person") rides in the turn's brief whenever a document of parts exists, or when a technique card the library chose writes one. What a kind of document teaches is a technique card in `techniques/seed/`, chosen by `selectTechniques`: `teach-young-learner`, `recipe-steps`, `review-a-document`, `plan-a-trip`.

Limits are `LESSON_LIMITS`: 400 parts, 6 deep, 40 steps and asks to a part, 8 answers, 6 choices and 6 hints to an ask.

### 4.21 `math`: a written method, laid out as on paper

`math <id> <method> [worked] [blank=answer|all] [carry=write|shown|none] [steps | step=<n|control>] | <sum>` puts a sum on the canvas the way it is written on paper: stacked in place-value columns, carries above, a rule under, the answer below. **The painter computes every digit and the brain writes none**, so the working cannot be wrong and cannot leak the answer. The brain is taught it by the maths chapter of the brief (carried when the words are a maths question), in place of the hand-placed columns it used to be taught (`say at=x,y align=right face=mono` digits, whose carries never lined up): `math m1 column | 3486 + 2795` in a `scene stack`, a worked example first (`worked`, on other numbers) and then the person's own sum with its boxes blank. `problem` and the old workspace are not taught; a `problem` line in an old log still plays, as an `ask`.

```
math m1 column | 12 + 12 + 12 + 12 + 12 + 12
math m2 column | 503 - 278
math m3 times | 47 × 6
```

- **Methods.** `column`: addition of any number of rows (up to 8), subtraction by exchange (the first number is not the smaller), decimals aligned on the point. `times`: short multiplication, a whole number by a single digit. `split`: expanded form, `347` is `300 + 40 + 7`. `bond`: part and whole, `10 = 4 + ?` (one part is `?`). `bar`, `groups`, `array`, `line`: the pictures, written with the question's own numbers (`12 ÷ 3`, `3/4`); parsed now.
- **`formula`: typeset TeX, as in a textbook.** `math f1 formula | c = \frac{d}{\Delta t}` sets one formula, centred, at the look's headline size; the line after the bar is TeX as written (one line, at most 300 characters; `$…$` and `\[…\]` round it are dropped). It is for a calculation shown whole (the maths chapter says so for a person who asks to *see* working, and a second line puts the numbers in: `math f2 formula | c = \frac{3.0\times10^{8}\,\text{km}}{1320\,\text{s}} \approx 2.3\times10^{5}\,\text{km/s}`). Nothing in it is sealed, there are no cells and no `worked`, `blank=`, `carry=` or `steps`; The block is addressed whole (`near=f1`, `hit f1`, `drop f1`); its inner parts (a numerator, a term) have no names yet. KaTeX 0.16.22 sets it in the page, as a chunk of its own that is fetched the first time a formula is on stage (it is not in the main chunk). The WebGL renderer draws what KaTeX set the way it draws CJK: the glyph boxes and rules are read off a hidden node and replayed on a 2D canvas, shown as a texture; the plain renderer puts KaTeX's HTML in the page; the SVG export embeds the canvas as an image; the text layer holds KaTeX's MathML (and a copy gives the TeX). The page measures it, so a turn that holds a formula is the page's to measure (`measurable`), as one with a script the faces lack is. A formula KaTeX cannot read shows its source as text. Inline `$…$` inside other text is not set: it stays the characters written.
- **The sum** is read exactly (decimals are exact, never floats; commas as thousands are dropped, `×`, `x` and `*` are one sign) and written back in one canonical form, so a line reads back as itself. A sum that cannot be read, or that a method cannot hold (`5 - 8`, `12.5 × 3` in `times`), refuses the line with `bad-sum` and says why.
- **The default shows the method without the answer:** the givens, the signs, the rule and empty cells. `worked` writes everything, for teaching on a different sum. `blank=answer` (the default) leaves the answer cells empty; `blank=all` asks for every step to be written. `carry=write` leaves the carries for the learner (a carry held in the head is not marked down, a wrong one is), `carry=shown` draws them, `carry=none` has none. `steps` adds a stepper and captions (a tap advances); `step=<n>` shows step n, and `step=<id>` follows a `pick <id> steps`.
- **The answer is sealed** like an ask's `is=`. The server computes it from the sum (`answerOf`, `language/src/maths/sum.ts`) and the normaliser refuses a `say` that states it (`spoiler`), unless the block is `worked`. A number the sum itself shows is no secret and is not sealed. For `split` each place's value is sealed (`300`, `40`, `7`); for a `bond`, the missing part.
- **Parts** are written `<id>.<part>` (an id cannot hold a dot, so it is unambiguous): `m1.r3` (a row), `m1.r3-tens` (one digit of it), `m1.tens` (a place), `m1.carry-tens` (the carry above a place), `m1.ans-ones` (an answer cell), `m1.ans` (the whole answer row), `m1.ex-tens` (the exchanged digits of a subtraction), `m1.top-tens`, `m1.rule`, `m1.sign`, `m1.s2` (what step 2 adds). Places are `ones tens hundreds thousands tenthousands tenths hundredths thousandths`. A part works in `near=` (`say near=m1.r3:below | …`), `hit` (`hit m1.tens`), `set` (`set m1.carry-tens mark=box`, as `set t1.row2 mark=box` marks a table's row) and `fill`. Whether the block has that part is for the painter to say.
- **`fill m1 | 72`** spreads a given answer across the answer cells, right to left, one digit to each; `fill m1.ans-ones | 2` writes one.
- **Composition.** A block in the flow like a table, or in a room on a free scene.
- **A finished sum is told to the brain, and answered.** The Check that finds every box right (or the Show me that fills the last box) is the act that finishes the block: it goes up as a control event and is also the next turn's input, as an ask's last answer is (`send=last`), worded with how she got there: `m1: all right, after 1 wrong check (tens 7) and 1 hint`. Every other act (a wrong Check, a hint, a box ringed) is only heard with the next turn. A finger or a Pencil on a box or a button works the block and is not also a tap on it. The maths chapter teaches the brain to answer a finished block with one line of what she did well and ONE next small question (fb-091).
- **A photographed question** is shown first (`scene layout=figure canvas=wide`, `pic p1 from=u1`), a `callout at=x,y in=p1` on each number it gives, in the question's own words, then the working in its own `scene stack` (fb-090).

## 5. Time

### 5.1 The two clocks, the pen and the playhead

Every turn has one **turn clock**, in seconds. Zero is the moment the painter starts playing the turn's first line.

- The **pen** is the time at which the next line would start. Writing moves it.
- The **playhead** is where the painter's clock is. Playing moves it.
- **Lead** is pen minus playhead: how far the brain is ahead of the audience.

Anything behind the playhead has happened and is fixed. Anything between the playhead and the pen is written but not yet seen, and can be revised or cancelled.

**The playhead never passes the pen while the turn is open.** If the painter catches up with the brain, the playhead **holds** at the pen and resumes the instant a new line moves the pen. The stage does not freeze while it holds: breathing, weather, the waiting signal and camera sway run on a separate **ambient clock** that keeps going. Once the brain has finished the turn, the playhead runs on to the end of everything scheduled.

This rule is what makes a schedule reproducible: with no revisions, **the same lines always produce the same times**, however slowly or unevenly they arrived. It is why an answer can be exported as a film, frame by frame, long after it was performed.

**The viewer can ask to see all of it at once.** That does not change the schedule: the playhead jumps to the end of everything scheduled and, while the brain is still writing, keeps up with the pen. The report then says where they skipped.

### 5.2 What holds the pen

| Verb | Starts | Then the pen |
| --- | --- | --- |
| `say`, `correct` | at the pen | moves to the end of the entrance plus reading time |
| a shape, `use` | at the pen | moves half way through the entrance, so strokes overlap like a quick hand |
| `pix` and its rows | at the pen | moves to the landing of the last row written so far |
| `hit`, `look` | at the pen | moves to the end of the gesture or the change |
| `wait` | at the pen | moves on by the wait |
| `scene` | at the pen | moves past most of the outgoing exits (section 5.3) |
| `cam`, `set`, `move`, `drop`, `paint`, `ambient` | at the pen | stays where it is |
| `style`, `color`, `plan`, `group`, `frame`, `card`, `bind` | no time | stays where it is |
| a structure (`flow` … `chart`) | at the pen | stays where it is; its title fades in |
| `math` | at the pen | moves to the end of its entrance: the working has arrived before the next line, a `scene` too, begins (fb-023) |
| `node`, a control | at the pen | moves half way through its entrance, like anything drawn |
| `link` | at the pen | moves half way through each link, so a chain is drawn link after link |
| a row of a table or chart | a step after the row before it | moves to its landing |
| `revise`, `cancel` | not scheduled: they edit the score (section 7) | recomputed |

Nothing on `far` or `bg` ever moves the pen: backdrop arrives alongside whatever comes next.

### 5.3 Durations

Durations depend only on the text, the geometry and words of the language, never on pixels or fonts. That is why the server and the painter can both compute the schedule and get the same answer. The numbers are in the generated reference; the rules are:

- **Entrance of text.** `dur=Ns` if given. Otherwise, with `base` the effect's base length, `ease` the pace's ease multiplier and the element's plain text:
  - `enter=cut by=all`: 0.
  - typed (`enter=type`, or any effect with `by=char`): `0.5 x base x ease + max(0.2, characters x per-character)`.
  - `by=word`: `base x ease + (words - 1) x between-words`.
  - `by=all`: `base x ease`.
  - Never more than 4 seconds; a long line simply arrives faster.
- **Entrance of a shape.** `dur=Ns` if given. With `enter=draw`: the length of its outline in canvas units divided by the pace's drawing speed, at least a quarter of a second, at most 4. With any other effect: `base x ease`. The length of an outline is computed by `lengthOf` in `language/src/geometry.ts`, which is the one definition of what a shape's geometry is.
- **Entrance of a sprite.** With `enter=draw`: one row length per row. Row `i` lands at `start + i x row length`, and never before the playhead was when its line arrived.
- **Reading time.** `words / reading-speed`, at least one beat, at most 6 seconds.
- **Tail**: the quiet after a text entrance before the pen moves on. For `by=all` it is the reading time. For a progressive entrance it is `max(half a beat, reading time - 0.6 x entrance)`, because the line was partly read as it arrived. For a `near=` label it is at most half a beat.
- **Prose.** In `layout=page` the reader is reading, not listening: a paragraph's tail is `words / (reading-speed x page factor)`, at least 0.3 s, and its default entrance is a short fade of the whole paragraph.
- **Plain content arrives quickly** ("dont need to fade slowly"). A paragraph of a `page`, and the frame (title) of a table, a chart or a block of code, come in with a fade, a rise or a wipe no longer than `QUICK_ENTER_SECONDS` (0.18 s, times the pace's ease). A row of a table lands in a tenth of a second (steady), a line of code in 0.04 s. An entrance the brain chose to perform (`slam`, `draw`, `type`) or gave a length (`dur=`) is as asked.
- **`stay=beat`**: the element starts leaving one reading time after its entrance ends. **`stay=Ns`**: N seconds after its entrance ends.
- **Exit**: the effect's length times `ease`. Exits are shorter than the entrance of the same name, always.
- **Scene change**: outgoing elements start leaving at the scene's start; the pen moves to `start + 0.8 x the longest of those exits`.
- **`layout=solo` and `layout=caption`**: when an in-flow line starts, the in-flow lines before it in the same scene (unless pinned) start leaving, and the new entrance begins `0.6 x` their longest exit later. Re-using a live id behaves the same way.
- **A morph** takes the morph length times `ease`, or `dur=`; the pen moves half way through it.
- **`set`** takes the set length times `ease`; with a speed word, that speed's `move` length; with `over=`, that.
- **`correct`**: the strike-through takes 0.3 s; the replacement's entrance begins half a beat after it ends; the pen moves to the end of the replacement's entrance plus its tail.
- **A link** draws itself in a fixed time (the reference has it), not one worked out from its length: where a link runs is the painter's decision, made with real type measurements, and the schedule may not depend on it. This is the one place a drawn thing's duration does not come from its geometry, and it is why the server and the painter still agree on every time.
- **Limits**: text and drawn things are counted apart. Past either limit, `buildSchedule` retires the oldest unpinned ones first, then the oldest pinned, and warns (`element-limit`) on the line that crossed it.
- **`wait`**: beats times the pace's beat, or the exact seconds; never more than 10 seconds.

### 5.4 Saying when (`@time`)

By default a line starts at the pen. One token can override that:

| Form | Start | Level |
| --- | --- | --- |
| `@with` | the start of the previous line | mind |
| `@+N` | N seconds after the pen | hand |
| `@-N` | N seconds before the pen, but not before the previous line's start | hand |
| `@N` | exactly N seconds on the turn clock, but never more than 10 seconds past the pen: a larger time is clamped with a `bad-time` warning | hand |

After any of these the pen is the later of where it was and where this line would have left it. No line can start before the playhead was when it arrived: a time in the past means "now".

## 6. Styles

A style is a set of properties. The built-in styles and every property are in the generated reference. A property says which kinds of element it means something on; on any other kind it is ignored.

Resolution for a new element: defaults, then each named style in order (a style's `like=` chain first), then the line's own properties. Unknown style names are ignored with a warning.

`enter`, `by` and `exit` have no universal default. What they are when the brain leaves them open is decided in the language, not in the painter, because they change durations and both sides must agree on the schedule:

- Text takes the look's: a terminal types, paper fades in word by word. In `layout=page` text fades in a paragraph at a time, whatever the look.
- `enter=type` always implies `by=char`. If the brain names an `enter` but no `by`, `by` is `all`.
- A shape with a stroke draws itself; one without fades in. A sprite draws itself. Everything else drawn fades in.
- Drawn things leave with a fade unless the look's exit is `cut`.

Colour is a **role** (`ink`, `dim`, `accent`, `alt`, `ground`), a **name** the brain defined, or an exact `#hex`. The painter brings an exact colour into what the look can show (one phosphor has no hue; teletext has eight colours) and then enforces contrast on text, so the brain can ask for a clash but the stage never shows unreadable words. Drawn shapes are shown in the colour asked for: a picture may have a dark thing on a dark ground.

`*emphasis*` inside text is drawn in the look's emphasis colour for the surrounding role.

## 7. Changing your mind

The brain writes ahead of the audience, so there are two different situations, and a verb for each.

### 7.1 Before it has been seen: `revise`, `cancel`

```
revise <id> [style…] [<prop>=<value>…] [| <new text>]
cancel [id]
```

These are not scheduled. They **edit the score**: the list of lines of the turn. The schedule is then recomputed from the edited score, so everything after the edit moves as if the brain had written it that way in the first place.

- `revise id …` rewrites the line that created `id`: new text replaces the text, named styles replace the styles, properties are merged. It works on drawn things too (their style; to change geometry, declare the shape again).
- `cancel id` removes the line that created `id`.
- `cancel` removes every line that has not started playing (definitions made by `style`, `color` and `look` are kept), and pulls the pen back to the playhead, or to the end of any entrance already in flight.

Both are defined against the playhead **at the moment the line arrives**, which only the painter knows exactly. The painter is the authority; the server's copy of the schedule is an estimate wherever these verbs are involved.

**Too late.** If `revise` arrives after its target has started playing, the change cannot be quiet: what has been seen cannot be unseen. The painter performs it instead: new text becomes a `correct`, new styles or properties become a `set`, both at the pen. `cancel id` for a line that has played does nothing; use `drop` or `correct`.

**A choice can be revised, and stays a choice.** `revise x391 | new words` on a choice (`say x391 choice | …`) changes its words and keeps it a thing to tap, before it has played (the line is rewritten) and after (a `correct` that carries its tap with it). A choice that has already left, because the turn that offered it was answered (the first line of the answer retires every choice still standing) or because it was dropped, comes back as a choice with the new words, and the line carries an `unknown-id` warning that says so; it is never said again as plain words that cannot be tapped.

### 7.2 After it has been seen: `correct`

A performance, scheduled at the pen like any other line and always visible: the old text is struck through and stays, dimmed, as a ghost; the new text arrives beside it and takes over the id, the place in the layout and the style. The ghost leaves when its replacement leaves, or at the next scene.

This is not an error path. Saying a thing and visibly taking it back is something this medium can do and plain text cannot. `correct` is for text; a drawn thing is changed by declaring it again.

### 7.3 Saying it again: nothing

**What stays is not redrawn.** A line that declares, under an id that is live, exactly what is there is nothing: no new element, no entrance, no change on the clock, no issue, and the pen does not move. It is what lets a follow-up that carries the scene on say its diagram again without drawing it again, and what makes a fix that repeats half the answer cost only the other half. "Exactly what is there" means:

| Line | It is nothing when |
| --- | --- |
| `say`, `correct`'s replacement excepted | the same plain words and emphasis, the same link, the same resolved style (every property alike) |
| a shape (`circle`, `rect`, `path`, …) | the same geometry as it has now (after any morph) and every property it names already holds |
| `group`, `card` | every property it names already holds; a card's title and box are as it has them |
| a structure of nodes (`flow`, `tree`, `cycle`, `timeline`, `map`) | the same title, direction, room and route, and every property it names already holds |
| `node` | the same words, shape, numbers and mark, the same style, and the arrow into it it already has (`from=`, with its label) |
| `link` | every connector it names is already there, between the same nodes, the same way, with the same words (whatever id it was given) |
| a control | the same kind, range, options, label and style; it keeps what the user set and what it drives |
| `table`, `chart`, `code` | the same kind, title, words, room, data and style: the rows that follow are then **read against the rows it has**. A row that is the same is nothing; one that differs is put right where it stands, with no new entrance; one past the end is the block growing, and lands as a row does |
| `ambient`, `pic` | the same kind, amount, picture and box |

A line that differs in anything is the change it always was: a shape morphs, a node is said anew in place, a table is drawn afresh. An id that was not written (the normaliser gave it one) is never the same id as before, so a structure the brain wants to say again must be named. `pix` is not covered: a sprite said again is a new sprite.

**Choices belong to the turn that offered them.** When a turn opens for a prompt, a tap or a control, every choice (`tap=yes`) still on stage from an earlier turn leaves as the answer's first line arrives, **the tapped one too**: they were that turn's, and the user has answered them. The first line that begins an answer is any line that is not a definition or an edit (`style`, `color`, `look`, `plan`, `wait`, `revise`, `cancel`, `bind`, `row`, `frame`, `standing`, `refine`). They leave with the exit effect they carry; the element's `exit.cause` says `answered`. A demo, a script and a refinement do not retire anything. `TurnScore` takes how the turn was opened as its second argument (`new TurnScore(base, input.kind)`, `retiresChoices`), and the server and the painter must both pass it, or their schedules disagree about when the choices went.

**A follow-up continues the scene.** A question about what is on stage is answered with `set`, `hit`, `revise` and new lines, not a new `scene`: `scene` is for a new subject, because it takes everything on stage away.

## 8. Turns, interruption, memory and sight

A **turn** is one answer: the lines a brain writes for one thing the user said. Each turn has its own clock starting at zero. The stage is carried from turn to turn: when a turn starts, whatever was resting on stage is already there, addressable by the same ids.

A turn ends in one of two ways:

- **Finished.** The brain stopped writing and the playhead reached the end, by playing or because the viewer asked to see it all.
- **Interrupted.** The user spoke, tapped a choice, or pressed Stop while the turn was still being written or played. The painter discards everything that has not started, completes entrances already in flight (it does not leave half a word or half a sprite on screen), and comes to rest.

Either way the painter sends a **report**: where the playhead stopped, what was shown, the stage as it now rests, what every control holds, and **sight**.

### Look and fix

A turn may have more than one **pass**. The first is the draft. When the brain has finished writing it, and it drew something, the server asks the painter how the draft **will** land: the painter settles a copy of the schedule to its end, computes sight for it and takes a picture, without waiting for the playhead, so this happens while the viewer is still watching the draft arrive. If it is worth a look, the brain is shown the picture and the report in the same conversation and writes a second pass: the lines that repair the draft. They are lines of the same turn, on the same clock, with the same ids.

The language already says what a fix looks like. What the viewer has not reached yet is fixed quietly (`revise`, `cancel`); what they have seen is fixed in front of them (`set`, `move`, `correct`, a shape declared again); a draft beyond repair is replaced by a new `scene`. So the first draft shows at once, and it visibly improves.

- **One look.** At most one fix pass after the draft (`REVIEW_PASSES`, 0 to 2). Measured before this round, one look raised the judge's score in three of four tries; each costs a model call.
- **Plain words are never held up.** A turn that drew nothing ends as it does today. A structure the painter laid out, with nothing to report, is not looked at either: its geometry is the painter's. A free drawing is always looked at when there is a picture. The rule is `worthALook` and `worthAFix` in `language/src/review.ts`, shared by the server and the battery.
- **Budgets.** The painter's draft report is waited for at most 1.5 s. The first line of a fix must come within 12 s of the draft ending or the draft is kept; a pass may take 30 s in all. The viewer interrupting ends it like any turn.
- **`ok`.** A brain that looks and would change nothing writes the one line `ok`. Nothing is forwarded.
- The message the brain is given is `buildReviewBrief`: the same words for every turn, so that a measured gain belongs to the mechanism.

While a pass is being looked at or fixed the turn is still open, so the playhead holds at the pen as it does for any slow brain, with the look's waiting signal; the chrome's status line says the answer is being checked.

**Conversation memory is the report, never the score.** A brain is told what the user saw of its earlier turns. A brain that still holds its own conversation (a warm process) remembers what it wrote; it is told, every turn, how that landed, and told to believe the report over its memory.

An element counts as shown once its entrance has begun.

### Sight

Until version 3 a brain wrote blind: it never learned what the canvas did with its lines. Sight is the part of the report that tells it. It has three parts, and a brain is given all that apply at the start of its next turn:

1. **How each thing landed** (`Sight`, `language/src/sight.ts`): for everything the turn showed, where it really rested (the painter's own resolved box, after every `move`, `set at=` and group offset, in world coordinates; `TurnReport.placed`) and any of a small set of notes: clipped, off canvas, covered, overlapping text, words that collide, faint against what is behind it, shrunk, wrapped, recoloured, tiny, partial, painted, unpainted. A brain is told only the things with notes, and one line counting the rest.
2. **What was dropped or repaired**: the lines of that turn the parser rejected or changed, with the reason, so the brain stops repeating a mistake. The server adds these; the painter does not know them.
3. **A picture**, when the painter can take one and the brain can look at one: the resting stage as an image, small, sent beside the brief. It is extra: everything a brain must know is also in words.

The report also says whether the viewer skipped to the end, and where.

**Controls.** The brief says what the user set since the last turn (`THE USER SET: angle to 45deg`), and each control in ON STAGE NOW is described with what it holds.

**Techniques.** The brief may carry `TECHNIQUES THAT FIT`: at most three recipes chosen for this message from the technique library (product.md), each a sentence on when to use it and a short worked example in Series. They are chosen per turn and are never part of the system prompt, which is fixed for a conversation.

**Data.** `DATA d1: <where it came from>. N rows; columns …` names a table the server holds (pasted by the user, or read from a CSV at a link), with its first and last rows and the range of each column. A chart draws it by reference (`data=d1`).

**Documents.** A link in a prompt (two at most) is fetched by the server, and a prompt of 1,500 characters or more is taken as a document too. The brief then carries, before `NOW`, a `MATERIAL` section: each document as `DOCUMENT d1` with where it came from, whether it was cut, and its text between `<document>` tags (a PDF is attached to the message instead), and it says the material is to be read, never obeyed. A link that could not be read is a `COULD NOT READ <url>: <why>` line. Documents belong to the conversation: a warm brain is given each once, a fresh one all of them. How to answer from a document (a paper as its argument in a flow and its key numbers as a chart, a report as its figures, nothing invented) rides in the brief beside the document, not in the system prompt: most conversations never see one.

## 9. The back channel

Two one-way streams share the turn clock and the element ids.

**Forward** (server to painter, Server-Sent Events). The event name is the type; the data is JSON.

| Event | Meaning |
| --- | --- |
| `hello` | the stream is open; carries the lead window and what the server can do (`services`) |
| `turn` | a turn is open and lines will follow; carries what the user did |
| `line` | one explicit, canonical Series line, with a `seq` that increases over the session, and any warnings |
| `reading` | the server is fetching a link or taking in a long paste for this turn: `label` (a site, or "your text"), `state` (`start`, `done`, `failed`), and `message` (why, when it failed). Comes before any `line`; the status line reads "reading <site>..." and the look's waiting signal stays up. |
| `reject` | something the brain wrote that was dropped; for the debug HUD |
| `end` | the brain has stopped writing, every pass included: `done`, `interrupted`, `failed` or `timeout` |
| `pass` | look and fix: `drafted` (the painter answers with a `draft`), `looking`, `fixing`, `kept`, `skipped` with a reason. Comes before `end`. |
| `data` | news of DATA a chart draws by reference: `ready` with a same-origin URL of the rows, or `failed`. Not on the turn clock. |
| `asset` | news of a painting, whenever it comes: `ready` with a same-origin URL, `skipped`, or `failed`. Not on the turn clock; may follow `end`. |

**Reconnecting.** A painter whose stream dropped opens the same URL again. The server sends `hello`, then the most recent turn in full (`turn`, every `line`, `reject` and `asset` so far, and `end` if it has ended) for as long as the painter has not sent that turn's `report`. The painter ignores a `seq` it has already scheduled. Once the `report` is in, nothing is replayed.

**Back** (painter to server, small POSTs, in order). The link keeps every back event queued while a turn is being started and sends them inside that turn's POST (`{ input, events }`), so the report of an interrupted turn always reaches the server before the turn that interrupted it.

| Event | Meaning |
| --- | --- |
| `ready` | what the painter can see and do: screen facts, capabilities, the look. Sent on connect and when the screen changes. |
| `started` | the turn clock left zero |
| `progress` | playhead, pen, clock state, the highest `seq` scheduled, ids newly shown, ids newly gone. Sent on any change and at least every 500 ms while playing. |
| `tap` | the user tapped an element; says whether it was a choice |
| `report` | the turn finished or was interrupted (section 8) |
| `control` | the user committed a change to a control: its id, value and words, and whether it also opens a turn. Never sent while dragging. |
| `draft` | how a pass of the open turn will land: sight, and whether a picture was uploaded beside it. Sent in answer to `pass … drafted`. |

Pictures travel beside the back channel as plain uploads: the **snapshot** of a resting stage (painter to the next brief), the **draft** of an open turn (painter to the brain's look), and, only when an image model is configured, the **sketch** a picture element stands on.

The **user's photos** (v2.1) come in by `POST /api/sessions/:id/uploads`, the body being the photo itself (JPEG, PNG, WebP or HEIC, at most 12 MB, read by its bytes, not by its name or Content-Type): the server converts it, shrinks it to 2048 pixels on its longest side, re-encodes it as a JPEG with every piece of metadata dropped (EXIF, so the place it was taken is gone), keeps it under `DATA_DIR/uploads/` and answers 201 `{ id, mime, width, height, bytes }` with the id `u1`, `u2`, … of that session (415 for anything else, 413 too large, 409 past 24 a session). `GET /api/sessions/:id/uploads/:uid` gives the kept JPEG back. The photo is made upright from its EXIF orientation before the metadata is dropped. To frame one question from a page, send `?crop=x,y,w,h` (fractions of the upright photo, from its top left): the part is the answer's photo and the whole page is kept beside it (`whole`); or later `POST /api/sessions/:id/uploads/:uid/crop` with `{ x, y, w, h }`, which makes a new photo and leaves the page as it was. A prompt carries up to four ids in `input.images`; the brain is shown those photos with the turn and may put one on stage with `pic u1`. Each upload is an `upload` entry in the audit trail (`pnpm audit-log --kind upload`) and an `upload` record in the session log, by id and size, never the bytes.

The **clock state** in `progress` is one of `idle`, `waiting` (a turn is open or expected, no line yet), `playing`, `holding` (caught up with the pen), `paused` and `hidden`. `hidden` is reported, never papered over.

A brain cannot listen while it is generating, so it hears the back channel only at breaks: an LLM brain at the start of its next turn, a relay agent between any two of its calls.

**Capabilities.** The painter advertises what it can perform: looks, layers, layouts, camera moves, entrances, exits, loops, marks, the kinds of element it can draw, faces, effects, weather, what sight it can give, and, for version 4, the structures it can lay out, the kinds of chart its engine draws, the controls it can work, the media, textures and brushes it can paint, and whether it can report on a draft. Each of those lists holds only what is built; a painter that speaks version 3 leaves them out and is taught none of it. The server adds what it can do (`services`: whether paintings are possible). The brain's prompt is generated from the vocabulary filtered by both, so the brain is never taught a word that cannot be performed, and the vocabulary is written down in one place only. A painter that can only set type gets a prompt with no drawing in it.

**Screen facts.** `cols` and `rows` say roughly how many characters fit on a line of body text and how many lines on the stage; `canvas` is the canvas that suits the screen's shape.

The exact shapes are the types in `language/src/wire.ts`, `context.ts` and `sight.ts`.

## 10. HTTP

All paths are under the same origin's `/api`. Errors are always `{ "code": string, "message": string, "statusCode": number }`.

### For the browser

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/health` | | `{ ok, language, brain }` |
| `GET /api/demos` | | the fixture scripts: `[{ name, title, summary }]` |
| `POST /api/sessions` | `{ screen, capabilities, look }` | 201 `{ session, lead }` |
| `GET /api/sessions/:session/stream` | | the forward stream |
| `POST /api/sessions/:session/turns` | `{ input, events? }` where input is `{kind:"prompt",text}`, `{kind:"tap",id,text}`, `{kind:"act",id,text,values}`, `{kind:"demo",script}` or `{kind:"script",text}` | 202 `{ turn }`. Applies `events` in order, then interrupts an open turn and opens the new one. Atomic: if any event is invalid the answer is 400 and no turn opens. |
| `POST /api/sessions/:session/events` | `{ events: [...] }` | 204. The back channel. |
| `GET /api/sessions/:session/assets/:asset` | | a painting's bytes |
| `POST /api/sessions/:session/sketches/:key` | `image/png` | 204. The sketch for the picture element with that key. |
| `POST /api/sessions/:session/turns/:turn/snapshot` | `image/jpeg` | 204. `GET` returns it. |
| `POST /api/sessions/:session/turns/:turn/drafts/:pass` | `image/jpeg` | 204. The stage as that pass of an open turn will leave it. |
| `GET /api/sessions/:session/data/:id` | | the rows of DATA a chart draws by reference |
| `GET`, `POST /api/taste` | a score | the answers set out for the owner to score; one score |
| `GET /api/explore/runs`, `…/runs/:run`, `…/runs/:run/:prompt` | | the exploration harness's runs on disk (read only) |

`demo` and `script` input are always answered by the replay brain, whatever brain is configured: `demo` plays a named fixture, `script` plays the lines in the request, which is how a script copied from an earlier answer is played again, edited or not. The browser cannot tell which brain answers a `prompt` or a `tap`.

### For an outside agent acting as the brain (the relay)

| Method and path | Meaning |
| --- | --- |
| `POST /api/relay/next?wait=25` | claim: long-poll for the next unclaimed turn. 200 with the turn, what the user did, the full context, a text brief, and links (one of them the snapshot of the previous turn, when there is one); 204 if none arrived. |
| `POST /api/relay/turns/:turn/lines[?end=1]` | body `text/plain`, one line per line. Good lines are accepted even if others in the same body are rejected. Answers with accepted count, rejects and warnings by line number, the clocks, and back-channel events since the last call. |
| `GET /api/relay/turns/:turn/events?since=N&wait=5` | the back channel since a cursor. `open: false` means the user interrupted: stop writing. |
| `POST /api/relay/turns/:turn/end` | the turn is finished |
| `GET /api/relay/guide[?session=…]` | the brain's system prompt as plain text, with the relay appendix |
| `GET /api/relay/status` | what is waiting and what is claimed |

**Content-Type.** Every route that reads a body requires its type: `application/json`, `text/plain` for `lines`, `image/png` and `image/jpeg` for the painter's uploads. Anything else is 415. The one exception is the user's own photos (`POST /api/sessions/:id/uploads`): what a photo is is read from its bytes, so its Content-Type is not trusted or required.

**Server limits.** A request body is at most 64 KB (1 MiB for the painter's `events` and `turns` bodies and for uploads), a photo at most 12 MB, a prompt at most 20,000 characters and a script at most 48,000. A brain may write at most 1000 lines in one turn. The server answers questions about the last 30 turns of a session.

In relay answers, `pen` is exact (the server computes it from the accepted lines); `playhead` is the painter's last report with its age.

### Fixture directives

In a `.series` fixture file, `#! stall N` tells the replay brain to stop streaming for N seconds, the way a real brain stalls. Every other reader treats it as a comment.

## 11. Changing the language

One home per fact:

1. Add or change the word in `language/src/vocabulary.ts` (and `style.ts` for a built-in style, `timing.ts` for a duration, `geometry.ts` for what a shape is). Types, the parser's accepted values and the prompt's tables follow from it.
2. If it is a new verb or property, teach `parse.ts`, `serialize.ts` and, when it takes time or touches elements, `schedule.ts`.
3. Run `pnpm docs:language` to regenerate section 13, `pnpm prompt` to read what the brain will now be told, and `pnpm prompt count`: the prompt has a budget and the command fails above it.
4. The painter advertises it through capabilities once it can perform it. Until then the brain is not taught it.

Reserved for later, deliberately not in version 4: `sound` (cues on the turn clock; opt-in only), per-word timestamps on `say` (for voice), `fx` as a verb (a surface effect animated within a scene), `{…}` as the value of a property (a formula driving a shape directly), and a sandboxed component the brain writes itself.

A new structure, chart kind or control is one entry in its table in `vocabulary.ts` and one engine behind the painter's contract (`web/src/contracts/blocks.ts`, `chart.ts`, `controls.ts`); the grammar does not change.

## 12. What changed

**v3 (still version 4; additive, and every line written before it is valid unchanged).**

- New: the document words `part`, `step`, `ask`, `hint`, `reply`, `end` (section 4.20) with the tables `LESSON_VERB`, `TECHNIQUE`, `VISUAL` and `LESSON_LIMITS`; the issue codes `spoiler`, `no-part` and `bad-ask`; `language/src/lesson.ts` (the answer matcher, `sealed`, the spoiler lint) and `language/src/document.ts` (the types of the document, `foldDocument`, `advance`).
- A lesson line ends a sprite, a table or a mock-up being written, as a `scene` does.

**v2.2 (still version 4; additive).**

- New: the structure `screen` with its rows, the interface words (`row`, `col`, `end`, the parts; section 4.19), the looks `wireframe` and `studio`, the `picture` event, `UI_ROW_SECONDS`.

**v2.1 (still version 4; everything below is additive and every painter and server advertises what it can do).**

- New lines: `code` (a structure of verbatim rows; `lang`, `file=`), `deck`, `pic … from=`, `standing`, `refine`. New properties: `href=` on `say`.
- A line that declares again, under a live id, exactly what is there is nothing (section 7.3); a table, chart or code block said again is read against its rows. An unnamed line has no live id to repeat.
- `TurnScore` takes how the turn was opened; choices an earlier turn offered leave as the answer begins (`exit.cause` `answered`).
- Plain content arrives quickly (a page's paragraphs, the frame of a table, a chart or a code block); table rows land in 0.1 s steady, not 0.18.
- `bind` to a chart or a structure is documented and its failures are named (`bad-bind` says the control, the thing and what to write); a `{…}` in a chart's title and marks follows a control; a chart cell may name a control written after it; computed numbers group their thousands and a unit written twice prints once.
- `Schedule.deck`; `ElementSpan.href`; the `structure` figure's `lang`, `file`; the `picture` figure's `from`.
- A bare `|` is an empty row inside an open `code` block; `row <id> |` is an empty row.

**From version 3 to version 4.** Everything version 3 said is still accepted, with these differences:

- `paint` no longer needs text and no longer means an image model: it is the painter's own rendering of the sketch in a medium. With an image model configured it still asks one.
- A line that starts with `|` is a row of the table or chart being written when one is open; otherwise, as before, a sprite's row or plain speech.
- `{…}` in text is a value when it reads as arithmetic on a live control. With no controls on stage, braces are text, as before.
- The prompt variant `hero` is gone: measured, it scored level with `column` and cost more.
- New: the structure verbs, `node`, `link`, the control verbs, `card`, `bind`; the properties `leader`, `tex`, `soft`, `brush`; the style `callout`; the strokes `ink` and `dry`; the element kinds `structure`, `node`, `link`, `control`; the sight notes `crossed` and `crowded`; the input `act`; the events `pass`, `data`, `control`, `draft`.

**From version 2 to version 3.**

- `at=x,y` is in canvas units of the scene's canvas, not percent of the safe frame.
- An id is optional, and a `say` whose first word is a style name is styled, not named. Version 2 took that word as the id and warned.
- The default look is `paper`. The three version 2 looks are presets like any other.

## 13. Reference

<!-- reference:start (generated by `pnpm docs:language`; edit language/src, not this section) -->

### Verbs

| Form | Time | Meaning |
| --- | --- | --- |
| `scene [id] [layout] [canvas=…] [lines=N] [mood] [pace] [align=…] [clear=…]` | starts at the pen and moves the pen past most of the outgoing exits | Open a new scene and state its plan first. What was on stage leaves. |
| `plan [lines=N] [mood=…] [pace=…]` | takes no time | Amend the open scene mid-stream. |
| `look <name> [like=<look>] [ground= ink= dim= accent= alt=#hex] [face=…] [fx=a,b] [stroke=…]` | starts at the pen and moves the pen past itself | Choose a preset, or define and wear a look of your own. |
| `style <name> [like=<style>] <prop>=<value>…` | takes no time | Define a named style. It lasts for the conversation. |
| `color <name>=#hex …` | takes no time | Name colours of your own; use the names wherever a colour goes. |
| `say [id] [style…] [prop=value…] \| <text>` | starts at the pen and moves the pen past itself | Text. The pen moves on once it has arrived and been read. |
| `correct <id> \| <new text>` | starts at the pen and moves the pen past itself | Visibly take it back: the old text is struck through, the new arrives beside it. |
| `circle [id] x,y r [prop=value…]` | starts at the pen and moves the pen part of the way through its own drawing | A circle: centre and radius. |
| `ellipse [id] x,y RXxRY [prop=value…]` | starts at the pen and moves the pen part of the way through its own drawing | An ellipse: centre and radii. |
| `rect [id] x,y WxH [r=N] [prop=value…]` | starts at the pen and moves the pen part of the way through its own drawing | A rectangle: top-left corner and size. `rect full` covers the whole screen. |
| `line [id] x,y x,y [x,y…] [prop=value…]` | starts at the pen and moves the pen part of the way through its own drawing | A line through points. |
| `poly [id] x,y x,y x,y [x,y…] [prop=value…]` | starts at the pen and moves the pen part of the way through its own drawing | A closed shape through points. |
| `path [id] [prop=value…] \| <SVG path data>` | starts at the pen and moves the pen part of the way through its own drawing | Any curve, in SVG path data (M L H V C S Q T A Z). |
| `pix [id] [scale=N] [fps=N] [key=c:colour,…] [prop=value…]` | starts at the pen and moves the pen past itself | Pixel art. Follow it with one `| row` line per row of cells. |
| `\| <cells>` | starts at the pen and moves the pen past itself | One row of the sprite above. `.` is empty, `#` is ink, 0-9 a-f are the sixteen sprite colours. |
| `frame [id]` | takes no time | Start the next animation frame of the sprite; its rows follow. |
| `group <id> [at=x,y] [prop=value…]` | takes no time | A thing made of parts. Parts say in=<id> and use coordinates measured from its at=. |
| `use [id] <source> [at=x,y] [scale=N] [rot=N] [prop=value…]` | starts at the pen and moves the pen part of the way through its own drawing | Another copy of a group, shape or sprite. |
| `flow [id] [right\|down] [x,y WxH] [\| title]` | starts at the pen and leaves the pen where it is | A flowchart. Follow it with `node` lines; the painter places them and routes the arrows. |
| `tree [id] [down\|right] [x,y WxH] [\| title]` | starts at the pen and leaves the pen where it is | A tree. Each `node` after the first says from=<its parent>. |
| `cycle [id] [x,y WxH] [\| title]` | starts at the pen and leaves the pen where it is | A loop. Its `node` lines go round a ring, each leading to the next and the last to the first. |
| `timeline [id] [x,y WxH] [\| title]` | starts at the pen and leaves the pen where it is | An axis of time. Each `node` gives its number (a year); the painter spaces them to scale. |
| `map [id] [route] [x,y WxH] [\| title]` | starts at the pen and leaves the pen where it is | Pins on a drawing. Each `node x,y` is a labelled pin; `route` joins them in order. |
| `table [id] [bars] [x,y WxH] [\| title]` | starts at the pen and leaves the pen where it is | A table. Follow it with one `| cell | cell` line per row; the first is the header. |
| `chart [id] [line\|area\|columns\|candles\|ohlc] [indexed] [log] [spark] [live] [approx] [x,y WxH] [data=<id>] [\| title]` | starts at the pen and leaves the pen where it is | A chart: an instrument with axes, a crosshair and zoom. Follow it with one `| when | value…` line per point, or name DATA from the brief. |
| `code [id] [lang] [file=<name>] [x,y WxH] [\| title]` | starts at the pen and leaves the pen where it is | Code, taken exactly: follow it with one `| line` per line of the source, indentation kept, a bare `|` for an empty line. |
| `tune [id] [tempo=<bpm>] [voice=piano\|strings\|chip\|bell] [x,y WxH] [\| title]` | starts at the pen and leaves the pen where it is | Music, in ABC notation: follow it with one `| line` per line of the score (K: M: L: Q: V:1 V:2, then the notes). It is drawn as a piano roll and played when it is whole. |
| `app [id] [height=<n>] [x,y WxH] [\| title]` | starts at the pen and leaves the pen where it is | A live app: follow it with one `| line` per line of one HTML document (inline <style> and <script>). It runs in a locked sandbox on the stage, with no network. Taught only when the user asks for something that works. |
| `figure <id> [cutaway\|exploded] [\| title]` | starts at the pen and leaves the pen where it is | A labelled drawing: follow it with its parts (path, poly, line, ellipse, rect, each with label="…"), route and step lines, then `end`. Taught by the FIGURE chapter in the brief. |
| `problem <id> answer=<a>[,<b>…] [ways=<way>[,<way>…]] [for=<who>] \| <the question exactly as given, ___ for the blank>` | starts at the pen and leaves the pen where it is | An old maths question, kept so earlier answers still play: it is an `ask` for its answer, with the question as its words. Write an `ask` instead. |
| `fill <ask, math id or math part> \| <the answer>` | takes no time | Puts an answer the person gave you (by voice, by pen or in the chat) into the blank of an ask or a written method (`math`). The page shows it there and checks it itself, like a typed answer. It is the only way anything gets filled in: never say you filled a blank any other way. |
| `screen <id> phone\|tablet\|desktop\|browser [from=<screen>[:label]] [\| name]` | starts at the pen and leaves the pen where it is | A mock-up: a device at its true size. The parts of the screen follow, one a line (nav, heading, button, field, item, image, row, col, end…); the painter lays them out. Taught by the INTERFACE chapter in the brief; on the wire its first line is the title and each later line a row, taken as written. |
| `node [id] [number \| x,y] [ask\|end\|note] [from=<id>[:label]] [x=<when>] [y=<value>] [prop=value…] \| <text>` | starts at the pen and moves the pen part of the way through its own drawing | One part of the structure above. from= also draws the link from that node. On a chart it is a mark: x= an event, y= a level, both a point. |
| `link <a> <b> [c…] [both\|plain] [dashed] [\| label]` | starts at the pen and moves the pen part of the way through its own drawing | Join nodes with a routed connector, in a chain when more than two are named. |
| `button [id] [prop=value…] \| <label>` | starts at the pen and moves the pen part of the way through its own drawing | A button. Pressing it is sent to you, with the value of every control on stage. |
| `toggle [id] [on\|off] [send] \| <label>` | starts at the pen and moves the pen part of the way through its own drawing | A switch. |
| `slider [id] <min> <max> [value] [step=N] [unit=…] [send] \| <label>` | starts at the pen and moves the pen part of the way through its own drawing | A number the user drags. |
| `pick [id] [tabs\|menu\|steps] [N] [send] \| <a> \| <b> \| <c>` | starts at the pen and moves the pen part of the way through its own drawing | One of several options. N is the one chosen to begin with. |
| `input [id] [send] \| <placeholder>` | starts at the pen and moves the pen part of the way through its own drawing | A line the user types. |
| `card <id> [x,y WxH] [\| title]` | takes no time | A framed group, for controls and what they change. Its parts say in=<id>. |
| `bind <control>[=<value>] [<from>..<to>] \| <set, move, correct or shape line>` | takes no time | Let a control drive a change on stage, at once, with no round trip: the change is as far along as the control is. |
| `pic [id] from=<picture id> [x,y WxH] [prop=value…]` | starts at the pen and moves the pen part of the way through its own drawing | Put a picture the user gave on stage, to draw over, point at or trace. Its id is in the brief. |
| `paint [id] [x,y WxH] [over=<group>] [as=<medium>] [sketch=fade\|keep] [mask=…] [\| what it is]` | starts at the pen and leaves the pen where it is | Paint over what you drew: the painter re-renders your sketch in a medium. |
| `ambient [id] <kind> [amount] [ink=…] [layer=…]` | starts at the pen and leaves the pen where it is | Atmosphere for the scene: weather, light, particles. `ambient none` clears it. |
| `set <id\|scene\|all> [style…] [prop=value…] [speed] [over=Ns] [\| <new text>]` | starts at the pen and leaves the pen where it is | Change something on stage: colour, size, place, turn, opacity, layer, pin, its words; a structure or chart with its own line again and a new room. |
| `move <id> <x,y\|anchor> [speed] [over=Ns] [along=<path id>]` | starts at the pen and leaves the pen where it is | Travel to a place, straight or along a drawn path. |
| `drop <id\|scene\|all> [exit=…]` | starts at the pen and leaves the pen where it is | Make something leave now. |
| `hit <id> [gesture]` | starts at the pen and moves the pen past itself | Point back at something with one gesture. |
| `cam <move> [id\|direction] [speed] [over=Ns] [amount=0..1]` | starts at the pen and leaves the pen where it is | Move the camera. It runs underneath the lines that follow. |
| `wait [N \| Ns]` | starts at the pen and moves the pen past itself | Silence. N beats (default 1), or exact seconds with an s. |
| `revise <id> [style…] [prop=value…] [\| <new text>]` | edits lines that have not played yet | Quietly change a line that has not played yet. Read, never taught: `set` does it now. |
| `deck \| <title>` | starts at the pen and moves the pen past most of the outgoing exits | Make this answer a deck: each scene after it is a slide, and the viewer steps through them. |
| `standing \| <their words>  or  standing drop <n>` | takes no time | Hold what the user asked for from now on ("add a visual to every reply"), in their words; every later brief gives it back. |
| `refine [passes]` | takes no time | Keep making the picture better, pass by pass, because the user asked for iteration. |
| `cancel [id]` | edits lines that have not played yet | Throw away what has not played yet: one line, or everything ahead of the playhead. |

### Properties

| Property | Values | Applies to | Level | Meaning |
| --- | --- | --- | --- | --- |
| `size` | `xs` `s` `m` `l` `xl` `xxl` | text | mind | how loud |
| `ink` | `ink` `dim` `accent` `alt` `ground`; a colour name \| #hex | text | mind | text colour |
| `weight` | `normal` `bold` | text | mind | heaviness |
| `face` | `serif` `sans` `hand` `display` `mono` `terminal` `teletext` `dot` | text | mind | typeface, when the look's own is not what you mean |
| `case` | `asis` `upper` `lower` | text | mind | letter case |
| `mark` | `none` `underline` `box` `invert` `strike` | text | mind | a drawn mark on the text |
| `by` | `all` `word` `char` | text | mind | the unit of text that arrives |
| `fill` | `none` `ink` `dim` `accent` `alt` `ground`; a colour name \| #hex \| top>bottom for a gradient | drawn | mind | what a shape is filled with |
| `stroke` | `none` `ink` `dim` `accent` `alt` `ground`; a colour name \| #hex | drawn | mind | outline colour |
| `thick` | N | drawn | mind | outline thickness in canvas units |
| `brush` | `clean` `pencil` `marker` `chalk` `pixel` `ink` `dry` | drawn | mind | the character of this one line, when the look's own is not what you mean |
| `tex` | `flat` `wash` `hatch` `dots` `grain` `weave` | drawn | mind | what the fill is made of |
| `soft` | N | drawn | mind | how far its edge fades out, in canvas units: light, cloud, shadow |
| `enter` | `type` `fade` `rise` `slam` `wipe` `cut` `flicker` `draw` `pop` | any | mind | how it arrives |
| `exit` | `fade` `cut` `fall` `wipe` | any | mind | how it leaves |
| `loop` | `none` `breathe` `pulse` `blink` `shake` `drift` `spin` `bob` `sway` | any | mind | what it keeps doing |
| `stay` | `beat` `scene` `pin`; Ns | any | mind | how long it lives |
| `layer` | `far` `bg` `mid` `fg` | any | mind | which plane in depth |
| `at` | `center` `top` `bottom` `left` `right` `top-left` `top-right` `bottom-left` `bottom-right`; x,y in canvas units | any | mind | where its centre goes |
| `near` | <id> or <id>:above\|below\|left\|right | any | mind | beside another element: a label on a drawing |
| `leader` | `yes` `no` | text | mind | yes draws a line from the label to what it names; the painter finds clear room for the label |
| `in` | <group id> | any | mind | make it a part of a group |
| `bleed` | `auto` `none` | drawn | mind | whether a filled shape touching the canvas edge runs on to the screen edge |
| `scale` | N | drawn | mind | size multiplier (a sprite: canvas units per pixel) |
| `rot` | N degrees | any | mind | turned clockwise |
| `opacity` | 0..1 | any | mind | how solid |
| `align` | `left` `center` `right` | text | mind | with at=x,y: which edge of the words that point is (right for digits lined up in a column) |
| `tap` | `yes` `no` | any | mind | yes makes it a choice the user can tap |
| `dur` | Ns | any | hand | exact entrance length |
| `period` | N | any | hand | with loop=, around= or along=: one cycle in clock units (seconds until a slider is the clock); negative runs backwards, any size, kept exactly |
| `around` | <id> or x,y | any | hand | the point it turns about (spin, sway or rot=): another element's centre, which carries it, or a fixed point; both top-level or in the same group |
| `phase` | 0..1 | any | hand | how far into its cycle it is when the clock reads zero |
| `amp` | N | any | hand | how far a loop goes: degrees for sway, canvas units for bob, a share for pulse and breathe |
| `along` | <shape id> \| none | any | hand | with period=: rides that outline for ever, upright (round a closed one, there and back on an open one); none stops it |

### Painter's tools

Settings on a line the brain draws, taught in the drawing brief. None of them places anything.

| Word | Takes | Meaning |
| --- | --- | --- |
| `dash` | on,off | breaks the stroke into dashes along its own length, in canvas units |
| `thick` | a>b>c | width along the stroke, like pressure: thin, full, thin |
| `stroke` | c1>c2 | colour along the stroke |
| `clip` | <shape id> | paints only inside that shape |
| `blend` | normal \| multiply \| screen | multiply glazes, screen lights |
| `fill` | a>b>c, radial, angle=N | a gradient of any number of stops; radial from the middle; angle turns it (0 top to bottom, 90 left to right) |

### Built-in styles

| Style | Defined as | Meaning |
| --- | --- | --- |
| `body` | (the defaults) | plain speech; every line starts from this |
| `strong` | `size=l weight=bold` | the point of the sentence |
| `title` | `size=xl weight=bold` | names the scene |
| `shout` | `size=xxl ink=accent weight=bold enter=slam by=all` | one or two words at full volume |
| `aside` | `size=s ink=dim` | said under the breath |
| `label` | `size=xs ink=dim case=upper enter=fade by=all` | a small caption on something drawn |
| `callout` | `leader=yes size=xs ink=dim case=upper enter=fade by=all` | a label with a line to the part it names |
| `ghost` | `layer=bg size=xxl ink=dim enter=fade by=all loop=drift` | a huge dim word far behind, setting the subject |
| `stamp` | `layer=fg size=l ink=accent case=upper mark=box enter=slam by=all` | a verdict stamped in front |
| `choice` | `ink=alt mark=box tap=yes` | an option the user can tap; the tap becomes their next message |

### Element kinds

| Kind | Meaning |
| --- | --- |
| `text` | words |
| `shape` | one drawn shape |
| `sprite` | pixel art |
| `group` | a thing made of parts |
| `copy` | another copy of something |
| `picture` | a painting, or the sketch waiting for one |
| `field` | atmosphere |
| `structure` | a diagram the painter lays out: a flow, a tree, a cycle, a timeline, a map, a table or a chart |
| `node` | one part of a structure |
| `link` | a connector between two nodes |
| `control` | an interactive part: a button, a toggle, a slider, a pick or an input |

### `layout`

| Layout | Meaning |
| --- | --- |
| `stack` | lines build downward into one block: a thought growing. Default. |
| `solo` | one line at a time, centre stage; each new line replaces the last. |
| `split` | two columns for contrast; send lines to at=left and at=right. |
| `list` | compact left-aligned items. |
| `page` | plain prose in a reading column, arriving at reading speed. For answers that are information. |
| `caption` | the picture has the stage; lines appear one at a time in a band under it, like subtitles. |
| `figure` | the picture on one side, the lines beside it. For explaining something drawn. |
| `free` | no flow; each line goes where its at= or near= says. |

### `canvas`

| Canvas | Units | Meaning |
| --- | --- | --- |
| `wide` | 160 x 90 | 160 x 90, landscape. Default. |
| `square` | 100 x 100 | 100 x 100. |
| `tall` | 90 x 160 | 90 x 160, portrait: for phones. |

### `mood`

| Mood | Meaning |
| --- | --- |
| `calm` | slow ambient motion, long eases |
| `neutral` | at rest. Default. |
| `tense` | tighter framing, nervous, short eases |
| `playful` | lighter and quicker |
| `grave` | very slow, heavy, dimmer |

### `pace`

| Pace | Meaning |
| --- | --- |
| `slow` | unhurried: weight, tenderness, difficulty |
| `steady` | conversational. Default. |
| `brisk` | quick: lists, excitement, urgency |

### `clear`

| Clear | Meaning |
| --- | --- |
| `scene` | everything that is not pinned leaves. Default. |
| `all` | everything leaves, pins included |
| `none` | nothing leaves; the new scene is added on top |

### `align`

| Align | Meaning |
| --- | --- |
| `auto` | the painter chooses from the layout. Default. |
| `left` | ragged right, like prose |
| `center` | centred, like a title card |
| `right` | ragged left |

### `size`

| Size | Meaning |
| --- | --- |
| `xs` | fine print |
| `s` | an aside |
| `m` | body. Default. |
| `l` | emphasis |
| `xl` | a headline |
| `xxl` | one or two words that fill the stage |

Nominal scale against body: `xs` 0.64, `s` 0.8, `m` 1, `l` 1.5, `xl` 2.25, `xxl` 3.4. A look may snap these to what its face can do (see DESIGN.md).

### Colour roles (`ink`, `fill`, `stroke`)

| Role | Meaning |
| --- | --- |
| `ink` | the look's normal colour. Default. |
| `dim` | receded: asides, things already said, construction lines |
| `accent` | the look's one strong colour: the thing that matters |
| `alt` | a second, cooler signal |
| `ground` | the background colour: for knocking a shape out of another |

### `weight`

| Weight | Meaning |
| --- | --- |
| `normal` | Default. |
| `bold` | heavier, in the look's own way |

### `face`

| Face | Meaning |
| --- | --- |
| `serif` | a bookish text face: warmth, story, authority |
| `sans` | a clean neutral face: explanation, labels |
| `hand` | handwriting: notes, sketches, intimacy |
| `display` | a heavy poster face: titles and shouts |
| `mono` | a typewriter face: code, data, exactness |
| `terminal` | a 1980s terminal face (fixed pitch) |
| `teletext` | the broadcast teletext face (fixed pitch) |
| `dot` | a dot-matrix printer face (fixed pitch) |

### `enter`

| Effect | Meaning |
| --- | --- |
| `type` | character by character, as if being thought right now |
| `fade` | eases into being |
| `rise` | lifts into place |
| `slam` | lands hard, all at once: a verdict |
| `wipe` | unrolls left to right |
| `cut` | is simply there |
| `flicker` | struggles on: doubt, a bad signal |
| `draw` | draws itself: a stroke along its length, a sprite row by row. Default for anything drawn. |
| `pop` | springs up from nothing |

### `by`

| Unit | Meaning |
| --- | --- |
| `all` | the whole text at once |
| `word` | word by word, at speaking rhythm |
| `char` | character by character |

### `exit`

| Effect | Meaning |
| --- | --- |
| `fade` | lets go gently |
| `cut` | is gone |
| `fall` | drops away |
| `wipe` | is erased as you watch |

### `loop`

| Loop | Meaning |
| --- | --- |
| `none` | still. Default. |
| `breathe` | a slow swell |
| `pulse` | a steady beat |
| `blink` | on, off |
| `shake` | a tremor |
| `drift` | a slow wander |
| `spin` | turns steadily about its centre |
| `bob` | rides up and down: floating, idling |
| `sway` | rocks a little from side to side |

### `mark`

| Mark | Meaning |
| --- | --- |
| `none` | Default. |
| `underline` | this matters |
| `box` | a label, a key term, something to press |
| `invert` | knocked out of a solid bar |
| `strike` | withdrawn, but left visible |

### `case`

| Case | Meaning |
| --- | --- |
| `asis` | as written. Default. |
| `upper` | ALL CAPITALS |
| `lower` | all lower case |

### `stay`

| Stay | Meaning |
| --- | --- |
| `beat` | leaves by itself once it has been read |
| `scene` | leaves when the next scene opens. Default. |
| `pin` | stays across scenes until you drop it |

### `at`

| Anchor | Meaning |
| --- | --- |
| `center` | centre |
| `top` | top centre |
| `bottom` | bottom centre |
| `left` | left centre (in layout=split: the left column) |
| `right` | right centre (in layout=split: the right column) |
| `top-left` | top left corner |
| `top-right` | top right corner |
| `bottom-left` | bottom left corner |
| `bottom-right` | bottom right corner |

### `near` sides

| Side | Meaning |
| --- | --- |
| `auto` | wherever there is room. Default. |
| `above` | above it |
| `below` | below it |
| `left` | to its left |
| `right` | to its right |

### `layer`

| Layer | Meaning |
| --- | --- |
| `far` | the deep background: sky, horizon, weather. Never holds the pen. |
| `bg` | behind the subject: scenery, or one huge dim word. Never holds the pen. |
| `mid` | the subject and the reading plane. Default. |
| `fg` | in front, close to the camera: stamps, labels, things passing by. |

### `cam` moves

| Move | Meaning |
| --- | --- |
| `push` | move closer: intensity, intimacy |
| `pull` | move back: release, the bigger picture |
| `pan` | travel across the scene: give left, right, up or down |
| `drift` | a slow sideways float: time passing |
| `orbit` | swing a little around the stage so the layers separate |
| `focus` | travel to one element and frame it (give its id) |
| `shake` | one jolt: impact |
| `rest` | return to neutral |

### `cam pan` directions

| Direction | Meaning |
| --- | --- |
| `left` | left |
| `right` | right |
| `up` | up |
| `down` | down |

### Speeds (`cam`, `move`, `set`)

| Speed | Meaning |
| --- | --- |
| `slow` | felt more than seen |
| `steady` | a deliberate move. Default. |
| `fast` | a snap |

### `hit` gestures

| Gesture | Meaning |
| --- | --- |
| `pulse` | one swell: "this, again". Default. |
| `flash` | one bright blink: "look here, now" |
| `shake` | one jolt: "no", or an impact |

### `ambient` kinds

| Kind | Meaning |
| --- | --- |
| `rain` | falling streaks |
| `snow` | slow drifting flakes |
| `dust` | motes hanging in light |
| `stars` | a still field of points that twinkle |
| `fireflies` | a few warm lights wandering |
| `embers` | sparks rising and dying |
| `sparks` | a burst flying outward |
| `bubbles` | rising, wobbling |
| `leaves` | tumbling across |
| `confetti` | celebration |
| `fog` | slow soft banks |
| `rays` | shafts of light from above |

### `ambient` amounts

| Amount | Meaning |
| --- | --- |
| `light` | a little |
| `some` | Default. |
| `heavy` | a lot |

### `stroke` (of a look)

| Stroke | Meaning |
| --- | --- |
| `clean` | even, exact: diagrams |
| `pencil` | slightly uneven and grainy: a sketch |
| `marker` | thick, confident, a little wobbly |
| `chalk` | dusty, broken |
| `pixel` | hard stair-stepped edges |
| `ink` | a brush pen: swells and tapers along the stroke |
| `dry` | a dry brush: streaky, breaking up where it runs out |

### `fx` (of a look)

| Effect | Meaning | Taught to the brain |
| --- | --- | --- |
| `paper` | paper fibre; ink soaks in | yes |
| `grain` | film grain | yes |
| `glow` | bright things bleed light | yes |
| `vignette` | darker toward the edges | yes |
| `halftone` | printed dots for tone | yes |
| `misprint` | two inks out of register | yes |
| `pixelate` | chunky square pixels | yes |
| `dither` | few colours, dot shading | yes |
| `scanlines` | the raster of an old tube | yes |
| `grid` | faint drafting squares | yes |
| `dust` | chalk dust and smears | yes |
| `persistence` | afterglow: what moves or leaves lingers | no: it comes with a preset |
| `curve` | curved tube glass | no: it comes with a preset |
| `signal` | jitter and noise that rise with a tense mood | no: it comes with a preset |
| `header` | a teletext page header row | no: it comes with a preset |
| `bars` | green-bar fanfold paper with tractor holes | no: it comes with a preset |
| `ribbon` | uneven ink from a fabric ribbon | no: it comes with a preset |
| `shadow` | foreground things cast a soft shadow on the sheet | no: it comes with a preset |

### Structures

| Structure | Its parts | Who places them | Meaning |
| --- | --- | --- | --- |
| `flow` | nodes and links | the painter | steps joined by arrows: a process, a decision |
| `tree` | nodes and links | the painter | each node under its from=: a family, a hierarchy |
| `cycle` | nodes and links | the painter | nodes round a ring, the last leading back to the first |
| `timeline` | nodes and links | the painter, along an axis, by each node's number | nodes on an axis, to scale by their number (a year; two numbers are a span) |
| `map` | nodes and links | the brain (x,y); the painter labels and routes | pins at your x,y, labelled clear of each other |
| `table` | rows | the painter | rows `\| a \| b \| c`, the first the header; `bars` draws its numbers as bars too |
| `chart` | rows, and nodes as marks | the painter's charting engine | rows `\| when \| value`: an instrument with axes, a crosshair and zoom |
| `code` | rows | the painter's charting engine | rows `\| line` taken exactly as written, indentation kept: monospaced and highlighted, with a copy action |
| `tune` | rows | the painter's charting engine | rows `\| line` of ABC notation, taken exactly: a piano roll that plays, with a playhead and the notes lighting as they sound |
| `app` | rows | the painter's charting engine | rows `\| line` of one HTML document (inline style and script), taken exactly: a live app that runs in a locked sandbox on the stage and answers back (taught only when the user asks for something that works) |
| `figure` | rows | the painter's charting engine | a labelled drawing: each part one line (taught by the FIGURE chapter in the brief); rows are the lines of the figure, taken as written |
| `math` | rows | the painter's charting engine | a written method laid out as on paper (taught by the maths chapter): the line is `math <id> <method> \| <sum>`, the painter works every digit |
| `problem` | rows | the painter's charting engine | an old maths question: it plays as an `ask` for its answer (the question as its words); write an `ask` instead |
| `screen` | rows | the painter's charting engine | a mock-up: devices at true size, each part one line (taught by the INTERFACE chapter in the brief); rows are the lines of the interface, taken as written |

### `math` (written methods)

| Form | Time | Meaning |
| --- | --- | --- |
| `math <id> column\|times\|split\|bond\|bar\|groups\|array\|line\|formula [worked] [blank=answer\|all] [carry=write\|shown\|none] [steps \| step=<n\|control>] \| <sum>` | starts at the pen and moves the pen past itself | A written method laid out as on paper, in place-value columns. The painter computes every digit; you write none. The answer is sealed like an ask's `is=`: the default shows the method (the givens, the signs, the rule and empty cells) and never the answer. `worked` writes everything, for teaching on a different sum. `steps` adds a stepper, `step=<id>` follows a `pick`. Its parts are named `<id>.<part>`: `m1.r3` (a row), `m1.tens`, `m1.carry-tens`, `m1.ans-ones`, `m1.rule`, `m1.s2` (a step). `formula` sets TeX as a textbook does: `math f1 formula | c = \frac{d}{\Delta t}`. |

Methods: `column`, `times`, `split`, `bond`, `bar`, `groups`, `array`, `line`, `formula`. `blank=`: `answer`, `all` (the first is the default). `carry=`: `write`, `shown`, `none`. Places in a part: `ones`, `tens`, `hundreds`, `thousands`, `tenthousands`, `tenths`, `hundredths`, `thousandths`.

### `node` shapes (flow, tree, cycle)

| Shape | Meaning |
| --- | --- |
| `step` | a box. Default. |
| `ask` | a decision: its links carry the answers |
| `end` | where it starts or stops |
| `note` | an aside with no frame |

### `link` ends

| End | Meaning |
| --- | --- |
| `arrow` | points at the second node. Default. |
| `both` | points both ways |
| `plain` | no arrowhead: a relation, not a direction |

### `chart` kinds

| Kind | Meaning |
| --- | --- |
| `line` | a line through the points: a trend. Default. |
| `area` | a line with the ground under it filled |
| `columns` | upright bars: amounts, a distribution |
| `candles` | candlesticks: rows give open, high, low, close, and volume if there is any |
| `ohlc` | open-high-low-close bars |

### `chart` words

| Word | Meaning |
| --- | --- |
| `indexed` | every series starts from 100, so growth can be compared |
| `log` | a logarithmic scale |
| `spark` | no axes or grid: a small chart for a tile |
| `live` | the last point pulses, as on a feed |
| `approx` | the numbers are recalled, not data: the chart says so |

### `code` languages

Words that name a language and are never taken for an id: `text`, `plain`, `txt`, `ts`, `typescript`, `js`, `javascript`, `jsx`, `tsx`, `json`, `python`, `py`, `bash`, `sh`, `shell`, `zsh`, `css`, `scss`, `html`, `xml`, `svg`, `sql`, `c`, `cpp`, `c++`, `csharp`, `c#`, `cs`, `java`, `kotlin`, `swift`, `go`, `golang`, `rust`, `rs`, `ruby`, `rb`, `php`, `yaml`, `yml`, `toml`, `ini`, `md`, `markdown`, `diff`, `lua`, `r`, `haskell`, `scala`, `perl`, `dart`, `elixir`, `ocaml`, `regex`, `dockerfile`, `makefile`, `graphql`. Any other name is kept as written (`lang=…`) and shown plain.

### `tune` voices

The instruments a tune is played on, by `voice=` (or as a bare word on the line): `piano`, `strings`, `chip`, `bell`. The painter's own synthesiser makes them; none is loaded.

### Controls

| Control | Meaning |
| --- | --- |
| `button` | press it: the press is sent to you with every control's value |
| `toggle` | on or off |
| `slider` | a number between two ends, dragged |
| `pick` | one of several options, written `| a | b | c` |
| `input` | a line of text the user types |

### `pick` forms

| Form | Meaning |
| --- | --- |
| `row` | side by side. Default. |
| `tabs` | as tabs over what they switch |
| `menu` | folded into a menu: for many options |
| `steps` | one at a time with back and next: a walk-through |

### Functions in `{…}`

| Function | Meaning |
| --- | --- |
| `sin` | sine of an angle in radians |
| `cos` | cosine |
| `tan` | tangent |
| `asin` | inverse sine, in radians |
| `acos` | inverse cosine |
| `atan` | inverse tangent |
| `rad` | degrees to radians |
| `deg` | radians to degrees |
| `sqrt` | square root |
| `abs` | size without sign |
| `sign` | -1, 0 or 1 |
| `round` | to the nearest whole number; round(x, n) to n decimals |
| `floor` | down to a whole number |
| `ceil` | up to a whole number |
| `min` | the smallest of its arguments |
| `max` | the largest of its arguments |
| `clamp` | clamp(x, low, high) |
| `pow` | pow(x, y) is x to the power y |
| `exp` | e to the power x |
| `log` | natural logarithm; log(x, base) in another base |
| `if` | if(test, then, otherwise) |

Also in `{…}`: numbers, the ids of controls, `pi`, `e`, `+ - * / % ^`, comparisons (`< > <= >= == !=`, giving 1 or 0), brackets, and `{expr:N}` for N decimals.

### `tex` (of a fill)

| Texture | Meaning |
| --- | --- |
| `flat` | even colour. Default. |
| `wash` | a watercolour wash: pooled, darker at the edges |
| `hatch` | pen hatching |
| `dots` | stippled dots |
| `grain` | a dry, chalky grain |
| `weave` | canvas weave under thick paint |

### `paint as=`

| Medium | Meaning |
| --- | --- |
| `watercolor` | loose wet washes |
| `oil` | thick visible brushwork |
| `gouache` | flat opaque shapes |
| `ink` | brush and ink, few tones |
| `pastel` | soft chalky colour |
| `woodcut` | carved black and white |
| `photo` | a photograph |
| `pixel` | pixel art |

The painter renders these media by itself: `watercolor`, `oil`, `gouache`, `ink`, `pastel`, `woodcut`, `pixel`. `photo` needs an image model, and none is configured.

### `paint mask=`

| Mask | Meaning |
| --- | --- |
| `none` | the whole rectangle. Default. |
| `round` | rounded corners |
| `circle` | a circle |
| `soft` | edges fade out |
| `torn` | a rough torn edge |

### Time forms

| Form | Meaning |
| --- | --- |
| `@with` | start together with the previous line |
| `@+N` | start N seconds after the pen (a delay) |
| `@-N` | start N seconds before the pen (overlap the previous line) |
| `@N` | start at exactly N seconds on the turn clock (at most 10 s past the pen; use @+N for a delay) |

### Sight notes

| Note | Meaning |
| --- | --- |
| `clipped` | part of it fell outside the screen |
| `outside` | part of it stands outside the canvas, the frame the picture is read in: put it back inside (the point in `at=` or `move` is where the middle of the words goes, or their right edge with `align=right`, not their corner) |
| `off-canvas` | none of it was on screen |
| `covered` | something drawn later hides most of it |
| `overlaps` | it sits on top of text |
| `shrunk` | it was made smaller to fit |
| `wrapped` | it broke over more lines than is comfortable |
| `recoloured` | its colour was changed to stay readable |
| `collides` | its words run into other words |
| `crossed` | a drawn line runs through its words |
| `spills` | it spills out past the edge of a bigger filled shape that mostly holds it: pull it inside, or make it smaller |
| `refit` | it was written inside a shape but did not fit, so it was shrunk toward its centre until it did |
| `wrong-part` | its leader line ends on, or nearer to, a different part than the one it names |
| `tangled` | its leader line crosses another label's leader line |
| `crowded` | there were too many parts for the room, so they came out small: give the structure the whole scene, or split it in two |
| `faint` | it is hard to read against what is behind it |
| `tiny` | it came out too small to make out |
| `sparse` | the drawing ended in a corner: most of the picture is empty. Centre it, make it larger, or end the move inside the frame |
| `retired` | the layout let it go to make room: it is not on the stage at rest |
| `lost` | the line the answer rests on is not on the stage at rest: say less above it, or say it last |
| `partial` | the answer stopped while it was still arriving |
| `painted` | the painting arrived and replaced the sketch |
| `unpainted` | no painting arrived; the sketch is what was seen |
| `undrawn` | the shelf has no drawing of this subject yet: a soft placeholder stands in its place, so draw it with shapes if the picture needs it |
| `pending` | a drawing of this subject is being made and will replace the soft placeholder in a minute or two: leave it, and do not draw it again with shapes. Labels written for its parts wait for the drawing and appear beside the parts: do not rewrite them |
| `drawn` | a drawing from the shelf, made of named parts (listed with it): label one with near=<figure>-<part>, and never redraw it with shapes |
| `refused` | this subject is not drawn here (a real person, a brand, a named character, or something not for a young child): a soft placeholder stands in its place |

### Look presets

| Look | What it is | Defined as | Unspecified text motion |
| --- | --- | --- | --- |
| `paper` | Ink on warm paper. Quiet and bright. | `ground=#f4efe4 ink=#23201b dim=#6f685c accent=#c13e1e alt=#2a5d8f face=serif fx=paper,grain stroke=pencil` | `enter=fade by=word exit=fade` |
| `night` | Deep blue dark, soft light. Stories, stillness, anything after sunset. | `ground=#0f1424 ink=#e9e4d6 dim=#8e93a8 accent=#ffb454 alt=#7fb8d8 face=serif fx=glow,grain,vignette stroke=clean` | `enter=fade by=word exit=fade` |
| `chalk` | A blackboard: only when asked for, or for working something out by hand. | `ground=#22302b ink=#eef0e6 dim=#9aa79c accent=#ffd866 alt=#8fd3e8 face=hand fx=dust,vignette stroke=chalk` | `enter=wipe by=all exit=fade` |
| `blueprint` | White line on drafting blue: only when asked for, or for a real plan or schematic. Never the default for a mechanism. | `ground=#18407a ink=#f2f6ff dim=#a9c0e6 accent=#ffd23f alt=#ff8fa3 face=mono fx=grid,grain stroke=clean` | `enter=type by=char exit=cut` |
| `riso` | A two-colour print: flat shapes, halftone dots. Bold, playful. | `ground=#f6f0e2 ink=#1f2a5c dim=#636b98 accent=#db0013 alt=#007980 face=display fx=paper,halftone,misprint stroke=marker` | `enter=pop by=all exit=cut` |
| `phosphor` | An amber terminal, 1987: one colour, typed in. | `ground=#140d04 ink=#f0a000 dim=#a87400 accent=#ffd070 alt=#cf8a00 face=terminal fx=persistence,glow,scanlines,curve,signal stroke=clean` | `enter=type by=char exit=cut` |
| `teletext` | Broadcast teletext, 1981: eight hard colours, chunky pixels. | `ground=#000000 ink=#ffffff dim=#7f7f7f accent=#ffff00 alt=#00ffff face=teletext fx=pixelate,dither,signal,header stroke=pixel` | `enter=cut by=word exit=cut` |
| `pixel` | Flat mid-grey, hard edges. For pixel art: no sprite colour vanishes. | `ground=#8a8f98 ink=#141414 dim=#262a33 accent=#7a0f22 alt=#123a6b face=mono fx= stroke=pixel` | `enter=cut by=all exit=cut` |
| `printout` | A dot-matrix printout on green-bar paper, 1980. | `ground=#f1ede0 ink=#1d1a18 dim=#625d57 accent=#b3261e alt=#1f3f8f face=dot fx=bars,ribbon,shadow,paper stroke=pencil` | `enter=type by=char exit=fade` |
| `wireframe` | Boxes and lines on white: an interface before anyone has chosen a colour. For mock-ups (INTERFACE). | `ground=#171a21 ink=#1d2129 dim=#5d6573 accent=#1d2129 alt=#8a93a3 face=sans fx= stroke=clean` | `enter=fade by=all exit=fade` |
| `studio` | A finished interface design: surfaces, soft shadows, one accent. For mock-ups (INTERFACE). | `ground=#14161d ink=#12151c dim=#5b6479 accent=#1f5eff alt=#97a0b3 face=sans fx= stroke=clean` | `enter=fade by=all exit=fade` |

### Sprite palette

| Cell | `0` | `1` | `2` | `3` | `4` | `5` | `6` | `7` | `8` | `9` | `a` | `b` | `c` | `d` | `e` | `f` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Colour | #141414 | #22305c | #7b2a55 | #1f7a4d | #a5562f | #5c5a55 | #bfc3c7 | #fbf3e4 | #e83b46 | #f59f1c | #ffe74a | #3fd45c | #3aa8f2 | #8576a6 | #f582a8 | #f7c9a3 |

Also: `.` is an empty cell, `#` is the ink role, and any other character is ink unless the sprite's `key=` names it.

### Durations

Everything below is in seconds.

| Pace | Beat | Per typed character | Between words | Reading speed (words/s) | Ease multiplier |
| --- | --- | --- | --- | --- | --- |
| `slow` | 0.8 | 0.05 | 0.3 | 2.5 | 1.25 |
| `steady` | 0.55 | 0.032 | 0.2 | 3.5 | 1 |
| `brisk` | 0.38 | 0.02 | 0.13 | 4.5 | 0.8 |

| Entrance | `type` | `fade` | `rise` | `slam` | `wipe` | `cut` | `flicker` | `draw` | `pop` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| base, at steady pace | 0 | 0.6 | 0.6 | 0.3 | 0.5 | 0 | 0.6 | 0.25 | 0.3 |

| Exit | `fade` | `cut` | `fall` | `wipe` |
| --- | --- | --- | --- | --- |
| at steady pace | 0.35 | 0 | 0.35 | 0.3 |

| Other | Seconds |
| --- | --- |
| `hit pulse` | 0.6 x ease |
| `hit flash` | 0.35 x ease |
| `hit shake` | 0.45 x ease |
| `cam` at `slow` | 6 |
| `cam` at `steady` | 3 |
| `cam` at `fast` | 1.2 |
| `cam shake` | 0.45 |
| `set` transition | 0.5 x ease, or the speed word's `move` length, or `over=` |
| `move` at `slow` | 4 |
| `move` at `steady` | 1.6 |
| `move` at `fast` | 0.6 |
| a shape drawing itself | length in canvas units / 70 (slow), 120 (steady), 200 (brisk) per second |
| a sprite row landing | 0.07 (slow), 0.045 (steady), 0.03 (brisk) |
| share of a drawn entrance the pen waits for | 0.5 |
| a shape morphing | 0.8 x ease |
| atmosphere fading in | 1.2 |
| atmosphere fading out (a new scene, or `drop`) | 0.35 x the pace's ease |
| reading speed in `layout=page` | 1.6 x the pace's words per second |
| a link drawing itself | 0.35 x ease (a fixed length: where a link runs is the painter's decision) |
| a table row landing | 0.16 (slow), 0.1 (steady), 0.07 (brisk) |
| a line of code landing | 0.06 (slow), 0.04 (steady), 0.025 (brisk) |
| plain content fading in (a page's paragraph, the frame of a table, chart or code block) | at most 0.18 x ease |
| a chart point landing | 0.09 (slow), 0.06 (steady), 0.04 (brisk) |
| a chart of DATA revealing itself, once the data is there | 1.2, on the ambient clock |
| a bound change that is on or off (a toggle, `bind mode=night`) | 0.25, on the ambient clock |
| look and fix: waiting for the painter's draft report | at most 8 |
| look and fix: the first line of a fix | at most 12, then the draft is kept |
| look and fix: a whole pass | at most 30 |
| strike-through of a `correct` | 0.3 |
| `look` change | 0.6 |

### Limits

| Limit | Value |
| --- | --- |
| characters in one line | 1200 |
| characters of text in one element | 320 |
| characters in an id or style name | 24 |
| longest wait or delay, seconds | 10 |
| longest entrance, seconds | 4 |
| lines of text on stage before the oldest are retired | 48 |
| drawn things on stage before the oldest are retired | 240 |
| points in one line, poly or path | 400 |
| cells along either side of a sprite | 64 |
| frames in one sprite | 8 |
| characters in a painting's description | 400 |
| nodes in one structure | 40 |
| links in one structure | 80 |
| rows in one table | 24 |
| cells in one row | 8 |
| points in one chart written as rows (more comes by reference, `data=`) | 400 |
| marks on one chart | 24 |
| options in one pick | 12 |
| controls on stage at once | 16 |
| bound changes on stage at once | 48 |
| fix passes after the draft (look and fix) | 1 |
| lead window, seconds | 2 to 12 |

<!-- reference:end -->


## Language round A (L1, SA5, L3, FG2)

- **Quoted values.** `label="right atrium"`, `bind chord="C major" | …`: a value of several words goes in quotes after `=` or `:`.
- **`when <control>=<value>` … `end`.** Each inner line is read as `bind <control>=<value> | <line>`.
- **Prose fallback.** A line rejected as an unknown verb that reads as a sentence (three words or more, no `=` or `|`) is said, with a repair note.
- **Re-opening.** A table or chart opened again under its id as the same kind (same reading of its rows) is a `set`: it keeps its rows.
- **`set <id> | new words`** is what `revise` was (quiet if the line has not played, visible if it has). `revise` still parses; it is no longer taught.
- **Flow by default** (`LineNormalizer` `placement: 'flow'`, a live brain only): a numeric `at=x,y` on words or a control that is not `in=`, `near=`, a leader or in a `layout=free` scene, and a room on a structure's opening line, are dropped and told as "placed by the stage". The canvas is taught only by the cued DRAWING chapter.
- **Doubt and alternatives.** `approx [from=recalled|computed|given|guessed]` on `say` and `node` (drawn as a note after the words); `say | long || short` (the flow takes the first form that fits at the legible floor; timed on the longest); `optional` on a `say` or a figure part (let go first).
- **`figure <id> [cutaway|exploded] | title` … `end`** with part lines (`path|poly|line|ellipse|rect|circle`, `label="…"`, `smooth`, `in=<part>`, `optional`, `fill=`/`stroke=`), `route <id> via=a,b,c [ink=]` and `step show=a,b | words`. Its rows are the figure's own lines (`language/src/figure.ts` reads them into the engine's input). Taught by the FIGURE chapter, cued by anatomy, machines, "parts of", "how … works", labelled.
