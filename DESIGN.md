# Design: looks, drawing, motion

This document answers one question: **what must things on the stage look and move like, and what must they never be?** The values themselves (hex codes, amounts, recipes) live in `language/src/vocabulary.ts` (what a look is, in the brain's words) and `web/src/looks/*.ts` (what the painter adds); this file says why they are what they are and specifies the part that cannot be data.

## What a look is

A look is four things a brain can name and the things that follow from them:

| Part | In the language | What it decides |
| --- | --- | --- |
| **palette** | `ground`, `ink`, `dim`, `accent`, `alt` | every colour role |
| **face** | `face=` | the typeface text is set in, and so its measure and rhythm |
| **stroke** | `stroke=` | the character of a drawn line |
| **surface** | `fx=` | what the picture is laid on and seen through |

**There is no house look.** Eight presets ship; the brain may wear one, or define its own as a variation of one (`look dusk like=night ground=#2b1d3a face=hand fx=grain,vignette`). `paper` is only where an empty stage starts.

**Every preset is pinned to a real material**, the way v0 pinned each look to a real machine: pencil on cartridge paper, chalk on slate, a risograph print, an amber tube. That is the defence against the default rut of "near-black, one neon accent, glow": a material has constraints, and the constraints are the character. When a decision about a preset is unclear, the answer is whatever that material would have done.

**A look the brain invents has no material behind it**, and that is allowed: it is the brain's to answer for. What the painter guarantees for any look, invented or not, is in the rules below.

## Rules every look obeys

**Type**

- A face is fixed pitch or proportional. The painter measures both with one function over one table of advances per face (`web/src/fonts/measure.ts`); the renderer never measures. Shipped faces carry no kerning and no ligatures, so a width is a sum.
- The size ladder is `xs s m l xl xxl`. Two neighbouring steps told apart by size alone differ by at least 1.25x. A fixed-pitch preset may collapse steps its machine did not have, but then something else (colour, a bar, case) must tell them apart.
- Body size aims for the look's target line length and never drops below its minimum, so a phone gets shorter lines, not smaller type. Lines are never set longer than the look's measure: about 64 characters for a proportional face.
- A scene's block is placed for the tallest arrangement it is known to reach, pins its top once line one lands and grows downward, so line one does not move when later lines arrive. A column never shrinks once it is placed: when it is full, its oldest lines scroll out upward (eased, like `page`), a scene's headings (size `l` and up) outlive the body lines under them, and in a split scene a line keeps its column when the other column's oldest lines retire. In a caption the band grows upward over the picture's ground to hold the scene's choices, so each stays visible and tappable.
- The safe frame is the margin on every side. No text enters it. Drawn things may: a sky runs to the edge.

**Colour**

- Five roles: `ground`, `ink`, `dim`, `accent`, `alt`. In every look, shipped or invented, **text** in any role passes 4.5:1 against what is behind it (3:1 at 24 px and up). For a preset this holds by construction. For an invented look the painter takes the ground as written and moves each other role, keeping its hue, until it passes.
- **What is behind text may be a drawing.** Text that lands on something drawn (a full-screen fill that bleeds past the canvas, a sprite, a gradient sampled at the text's own height, a picture) gets a plate: the ground colour behind each of its line boxes, at the opacity that restores the ratio, with a soft edge. Contrast is always judged, and reported, against what is actually drawn behind the words.
- **Drawn things are shown in the colour asked for.** A picture may hold a dark thing on a dark ground. The contrast rule is for words.
- A colour given by hex is brought into what the look can show first (one phosphor has only luminance; teletext has eight colours) and, for text, then pushed until it passes.
- `accent` is one colour. It means "this is the thing that matters", so it is used rarely or it means nothing.
- A gradient belongs in a fill (a sky, water). Never in text.

**Depth**

- Four flat planes: `far`, `bg`, `mid`, `fg`. The camera moves; the planes do not. This is a multiplane camera, not a 3D scene.
- Depth must be legible without motion: far things are paler and softer, near things crisp. Each preset says in its own idiom what "behind" and "in front" are.
- Text on the reading plane keeps clear of other text, including text placed with `at=`, which slides along its anchor's axis and then shrinks within the look's minimum; sight reports any overlap that remains. Words on `bg` and `fg` keep clear of the reading plane's block, as in v0.
- No text leaves the safe frame, whatever the camera does. A close-up on a drawing, a pan or a focus goes as far as resting words (labels included) allow and stops short of the rest; to go close on a picture, clear the words first. The brain's prompt says so.
- A change of look between two looks that are not machines dips through the ground colour. Static between channels is what a tube does, so it is used only when a machine look (`phosphor`, `teletext`, `printout`) is on either side.

**Motion**

- Ease out. Things arrive fast and settle. Nothing bounces, overshoots or wobbles into place, with one exception: `enter=pop` under `mood=playful` may overshoot by 6% once.
- Exits are faster than entrances.
- Where a preset's machine stepped, it steps. Everything else is smooth.
- While the stage waits for the brain it holds and stays alive: ambient motion, weather and the waiting signal keep running. It never freezes and never shows a spinner.
- Reduced motion keeps every word, every drawing and every pause. It removes shake, flicker, blink, spin, bob and signal jitter, shortens camera travel to about a third, slows weather to a fifth, and replaces `flicker`, `slam` and `pop` with a short fade. A line still draws itself: that is the content arriving, not decoration.
- Nothing flashes more than three times a second, in any look, at any setting, weather included (`sparks` and `confetti` are many small things, never a field-wide flash).

**Never, in any preset**

- Neon glow, frosted glass, drop shadows on a dark ground, rounded "card" containers around text.
- Purple-to-blue synthwave palettes, grids receding to a horizon.
- RGB-split "glitch" effects.
- An effect that is on all the time at full strength. The surface is the room the answer is in; if it is noticed before the answer, it is too strong.
- Emoji. The faces do not have them.

A brain may invent a look that breaks the first three. The presets may not.

## The surface: effects

A look lists effects; the painter applies them in one fixed order whatever order they are listed in (`FX_ORDER` in `web/src/render/three/fx/index.ts`): first what decides the raster, then the surface the picture lies on, then treatments of the picture as ink, then treatments of it as light. Each has an amount from 0 to 1; what 1 means is here.

| Effect | Stage | At amount 1 |
| --- | --- | --- |
| `pixelate` | raster | the stage is drawn at one-twentieth of the body size per pixel and scaled up with hard edges |
| `bars` | surface | green-bar fanfold: bars three body lines tall, tractor holes, a perforation; a sheet in the scene |
| `paper` | surface | a visible fibre tooth and a desk lamp's falloff; ink multiplies onto it and can never be lighter than it |
| `grid` | surface | drafting squares every 10 canvas units, heavier every 50, in the ground's lighter neighbour |
| `dust` | surface | chalk haze: the ghost of wiped marks, strongest where things have left |
| `shadow` | surface | things on `fg` cast a soft contact shadow on the sheet, offset by their height above it |
| `ribbon` | print | ink density varies along the line and per dot, as from a worn fabric ribbon |
| `halftone` | print | every tone between ground and ink becomes dots at 45 degrees, 6 px pitch; solid ink stays solid |
| `misprint` | print | the accent ink is laid 1.5 px out of register, and its overlap with ink darkens |
| `dither` | print | the picture is cut to the look's palette; anything between is an ordered 4x4 dither |
| `persistence` | light | what moves or leaves lingers for about a third of a second |
| `glow` | light | bright things bleed into their surroundings; never enough to close up a letter |
| `scanlines` | light | one line pair per tenth of body size; switched off below 3 device pixels a line rather than left to moire |
| `signal` | light | jitter, snow and hum, scaled by the mood's agitation; nothing at rest |
| `grain` | light | fine film grain, static in reduced motion |
| `vignette` | light | the corners fall off by 35% |
| `curve` | light | a 5% barrel curve with rounded corners |
| `header` | furniture | teletext's top row: page number, name, date, a ticking clock |

Rules for all of them: periodic things use the frame's ambient or wall time, so a paused frame is still; every one has a `lite` form; an effect may darken the ground freely but takes text below 4.5:1 nowhere inside the safe frame; and two effects that cannot meet (`paper` and `persistence`: one is reflected light, one emitted) resolve to the one listed in the look's preset, or the first, never to a muddle.

## The presets

### Paper (the default)

**Pencil and ink on cartridge paper, in even daylight.** Warm off-white, a soft near-black, one red crayon, one blue. The quietest look and the one a drawing is most at home in.

Type is a serif text face. Text fades in word by word. Lines are pencil: slightly uneven in weight, with a grain that belongs to the paper, and they wander a fifth of a unit from true, decided once per line so nothing shimmers. A fill is a flat wash that lets the tooth show. Depth: far things are paler, as if under a sheet of tracing paper; near things cast nothing.

Never: a "vintage" stain or torn edge; a ruled notebook; a pencil texture so strong it reads as a filter.

### Night

**Gouache on dark blue board, lit from within.** For stories, stillness, anything after sunset. A deep blue that is never black, a warm off-white, an amber accent, a cold blue second.

Type is the same serif. Light things bleed a little (`glow`) and the corners fall away. Lines are clean and thin. Depth: `far` is the sky, flat and cold; near things are darker silhouettes, which is how a night scene reads.

Never: neon; a starfield wallpaper (stars are weather the brain asks for); pure black.

### Chalk

**Chalk on a slate board that has been wiped more than once.** For explaining and working things out. A grey-green board, chalk white, yellow and pale blue chalk.

Type is the hand face, written on with a wipe. Lines are chalk: broken along their length where the stick skips, heavier where it turns. Dust hangs where things have been erased. Depth: far things look half-wiped.

Never: a wooden frame; a chalk tray; a "school" motif. It is a surface, not a classroom.

### Blueprint

**A cyanotype of a ruling-pen drawing.** For mechanisms and plans. Drafting blue, white line, a yellow and a pink for the two things that matter.

Type is the mono face, typed in. Lines are exact and thin; nothing wobbles. A faint grid lies under everything. Depth: far things are thinner line, not dimmer.

Never: fake dimension arrows or title blocks the brain did not draw; a paper-crease texture.

### Riso

**A two-drum risograph print on uncoated stock.** Bold and playful. Cream paper, a navy and a coral, and their overlap.

Type is the display face and pops in. Shapes are flat; any tone between is halftone dots; the second colour sits a hair out of register. Lines are marker: thick, confident. Depth: far things are a lighter dot.

Never: more than the look's inks at once from the presets' own roles (a brain's `#hex` is its own business); a gradient that is not dots.

### Phosphor

**DEC VT320 with the amber tube, 1987.** A terminal in a dark room. One phosphor, three beam intensities. Intimate, nocturnal: someone thinking aloud to you, one character at a time.

**Colour.** Monochrome: only luminance exists. `ink` is normal intensity; `dim` is the terminal's half-intensity attribute; `accent` is bold, which on a real tube is more beam current, so it is brighter and slightly whiter as the phosphor saturates; `alt` sits between dim and normal. A hex colour keeps only its luminance, mapped onto the ramp from `dim` to `accent`. `mark=invert` is reverse video: a solid lit cell block with the text knocked out.

**Type.** VT323, modelled on the terminal's own glyphs. Cell width 0.4 em. The ladder is the nominal one. Bold has no second face: it is the brighter beam.

**The screen.** In this order, each a real pass:

1. **Persistence.** A feedback buffer holds the previous picture, decaying exponentially with a time constant of about 120 ms, frame-rate independent (`decay = exp(-dt / tau)`), combined with the new picture by maximum. This is why this look's exits are cuts: the phosphor does the fading, and moving text leaves a short trail.
2. **Halation.** Bright areas glow through the glass: a small blur of the picture added back at low strength, plus a wider, fainter one. Enough to soften the edge of a lit character, never enough to close up a counter.
3. **Scanlines.** The raster is visible: brightness is modulated down the screen at one line pair per tenth of the body font size. Below 3 device pixels per line the modulation is switched off rather than left to moire.
4. **The tube.** A slight barrel curve (about 5% at the corners), darkening toward the edges, corners rounded by the same curve. Scanlines, the curve's vignette and the mood's dim darken the ground fully but ink only as far as its surplus contrast allows: ink near the 4.5:1 floor keeps (or, without halation, is lifted to keep) its ratio, measured at 5.2:1 or better for `dim` text at the centre and at a safe-frame corner under `mood=grave`.
5. **The signal.** Driven by `agitation`: horizontal jitter of a pixel or two that changes per scanline band, a faint grain, and mains hum as a brightness ripple under 2%. At rest these are barely there; a tense scene makes the picture nervous.

**Motion.** Text is typed at a steady rate behind a solid block cursor. The cursor blinks once a second at the writing position whenever the stage is waiting or holding: that blinking block is this look's "I am thinking". Moves ease out smoothly.

**Depth.** `far` and `bg` are deeper in the glass: dimmer and soft, like a reflection inside the tube. `fg` is sharp; the compose pass changes nothing else about it.

**Never.** Green "Matrix" rain. A plastic monitor bezel drawn around the stage. Glow strong enough to blur a word. Scanlines as a fixed-pitch overlay that ignores the pixel ratio.


### Teletext

**Ceefax as the Mullard SAA5050 drew it (BBC Micro Mode 7), 1981.** Information broadcast to a whole country in the gaps of a television signal. Public, declarative, hard-edged, a little cheerful.

**Colour.** The eight Level 1 colours at full saturation on black. `ink` white, `accent` yellow, `alt` cyan. Level 1 has nothing that recedes, so `dim` borrows the half-intensity white of Level 2.5: one honest concession, recorded here. Green, magenta and red are reachable by hex. Blue fails contrast as text, and a blue bar is pushed by the contrast rule to the nearest palette colour that passes (magenta), so blue never appears. A hex colour snaps to the nearest member of the palette that passes contrast. `mark=invert` is teletext's "new background": a solid colour bar one cell taller and wider than the text, with the text in black. This, not weight, is how teletext makes a headline.

**Type.** Bedstead, an outline of the SAA5050's own character set. Cell width 0.6 em. The machine had one size and double height, so: `xs`, `s` and `m` are one cell (told apart by colour and case); `l` is double height; `xl` is double size; `xxl` is triple. There is no bold. Everything sits on the cell grid, 40 columns where the screen allows.

**The screen.**

1. **The pixel grid.** The scene is rendered into a target whose pixel is one-twentieth of the body cell height, and scaled up with nearest-neighbour filtering. Every edge on screen is a pixel edge.
2. **No blends.** Text coverage is thresholded: a pixel is lit or it is not. Anything partly transparent is drawn as an ordered dither (a 4x4 Bayer pattern) against what is behind it, never as an alpha blend. A fade in this look is a dissolve of pixels.
3. **The palette.** The final picture is snapped to the nine colours.
4. **The signal.** Driven by `agitation`: a pixel of colour smear to the right of saturated edges, and a little snow. At rest the picture is clean.
5. **The header row.** The only furniture inside any stage: the top row reads like a teletext header, with a page number, the name `CONDUIT`, the date, and a clock that ticks every second. While the stage is waiting or holding, the page number rolls the way a decoder does while it hunts for a page. That rolling number is this look's "I am thinking".

**Motion.** Stepped at 12.5 frames a second; the camera at 25. Words cut in whole, one at a time. `loop=blink` and `enter=flicker` are teletext's flash attribute. `rise` scrolls up one row at a time. Nothing glides.

**Depth.** All four planes are sampled into the same pixel grid, so far text is chunkier for its size and near text is finer. `bg` words are huge and half-intensity.

**Never.** Anti-aliasing, gradients, soft shadows, rounded corners, a tenth colour. Tube curvature or scanlines: this look is the signal, not the television.


### Printout

**An Epson MX-80 printing on green-bar fanfold paper, 1980.** Daylight, paper, ink. The only light-ground look, and the only one where what has been said stays said: it is on the record.

**Colour.** The paper is warm off-white with pale green bars; contrast is checked against the darker of the two. `ink` is a black fabric ribbon, slightly warm, never pure black. `dim` is a worn ribbon. `accent` is the red half of a two-colour ribbon (borrowed from teleprinters; the MX-80 was black only, and this is the one liberty taken). `alt` is blue carbon. A hex colour keeps its hue and is darkened until it reads as ink on this paper. `mark=invert` is a solid printed bar with the text left as bare paper.

**Type.** Doto, a dot-matrix face, at weight 700; weight 900 for bold, which is the printer's double-strike. Cell width 0.6 em. The printer's own modes are the ladder: body is normal pitch; `l` is expanded mode, double width at the same height; `xl` is double size; `xxl` triple; `s` is a small step; `xs` is condensed mode, the same height as `s` set about 40% narrower, so on this look `xs` and `s` are told apart by width, not height (the 1.25x rule applies to the steps that differ in size). Positions sit on the printer's character grid.

**The sheet.** A real plane in the scene at reading depth, not a backdrop: green bars three body lines tall alternating with bare paper, aligned to the line grid; tractor-feed holes down both edges where the screen is wide enough to show them; a perforation line once a page. Because it is in the scene, it moves correctly under the camera.

**The page.**

1. **Ink multiplies.** Ink is combined with the paper by multiplication, so the bars show through it and it can never be lighter than the paper.
2. **The ribbon.** Ink density varies slowly along the direction the head travels, and slightly per dot, so a line is never uniformly black. `agitation` raises the variation and drops the occasional pin.
3. **Impact.** Each line carries a fixed sub-pixel offset and a trace of baseline wobble, decided once from the element's key. It is imperfection, not animation: it never shimmers.
4. **Paper.** A fine static fibre grain in paper space, and light falling off gently toward the edges as from a desk lamp. The lamp's falloff and the mood's dim darken the paper, and dark ink on darker paper loses contrast, so ink takes the same darkening again in proportion to how much ink there is (none on bare paper): the contrast bar holds at a safe-frame corner under `mood=grave` (4.9:1 or better at the darkest pixels of `dim` text).
5. **Shadow.** Anything on `fg` casts a soft contact shadow on the sheet, offset by its height above it. This is what makes depth readable in daylight.

**Motion.** A print head travels along the line and characters appear behind it at a fixed rate; the head (a small solid marker under the line) is this look's cursor, and it rests, blinking slowly, at the start of the next line while the stage waits. Paper moves in detents: element motion is stepped at 24 frames a second. Ink does not fade off paper, so leaving gently means the paper feeds on: text moves up and away. `slam` is a rubber stamp: it lands a little rotated and unevenly inked. The camera is a rostrum camera over a desk and moves smoothly.

**Depth.** `bg` is beneath the surface: large, pale lettering in worn-ribbon grey that slides slightly under the bars when the camera moves, like the ghost of an earlier printing. `fg` floats above the sheet and casts a shadow.

**Never.** Glow, bloom, scanlines or any light-emitting effect: this is reflected light. Pure black or pure white. Ink that fades away in place: leaving means the paper feeds on. (The entrances `fade` and `flicker` do bring ink in from faint, and a corrected line rests in the worn-ribbon colour; nothing else changes ink density in place.) A torn or coffee-stained "vintage paper" texture: the sheet is fresh from the box.


## Drawing

**A drawing draws itself.** The stroke travels along the line in the order it was written, at a speed the pace sets, and a fill arrives over the last third. Strokes overlap in time like a quick, sure hand: the next begins when the last is half done. Nothing in a drawing pops in unless the brain asked for `cut` or `pop`.

- **Stroke.** Round caps, mitred joins that round off past 4x the thickness. Thickness is in canvas units, so a drawing keeps its proportions on every screen; the look's own is between 0.5 and 1.4. A stroke never renders thinner than 1.25 device pixels.
- **Character.** `clean` is even. `pencil` varies 15% in weight along its length and breaks up with a grain fixed to the paper. `marker` is solid with a darker overlap where it turns. `chalk` skips. `pixel` has no antialiasing. The wobble of a hand-drawn line is geometry the painter adds once from the element's key; it is imperfection, never animation.
- **Bleed.** A filled shape that touches the canvas's left, right or bottom edge runs on to the viewport's edge, so land, water and sky reach the screen edges; `bleed=none` opts a shape out.
- **Fill.** Flat, or a top-to-bottom gradient. A fill sits under its own stroke. Fills let the surface show (paper tooth, halftone, dust): a fill is ink, not a sticker.
- **Morph.** One shape becomes another by moving its outline, eased in and out, over most of a second. No cross-fade.
- **Labels.** A `near=` label sits one body line from the thing it names (never farther than its extent), on the side with most room, in the look's `dim`, and keeps clear of other labels, other text, drawn outlines and fills, and the canvas edge. A label never gets a leader line the brain did not draw.
- **Size.** Something drawn smaller than 12 px on screen is reported to the brain as `tiny`. The painter does not enlarge it: where things are is the brain's meaning.

## Pixels

A sprite is real pixels: hard-edged squares, never smoothed, never rotated off-axis by the painter's own motion (`bob` moves it by whole cells' worth; `spin` is the brain's choice and looks like what it is). Rows land one after another from the top, a row every 45 ms at steady pace, so a sprite is drawn in while the brain is still writing it. When a cell would be under two device pixels the sprite snaps to the device grid so cells stay square. The sixteen colours are the same in every look that can show them; phosphor shows their luminance and teletext the nearest of its eight. No look's ground can keep all sixteen at 1.5:1 (the best manages 1.25:1), so a sprite whose used colour falls under 1.5:1 against its ground, or under 3:1 as a near miss, is set on a backing tile in a contrasting surface (`spriteBacking`). The `pixel` look is the ground made for sprites: a flat mid-grey (`#8a8f98`), hard edges, a whole-number scale, so no default colour vanishes and the picture is as the cells say.

## Weather

A field is hundreds or thousands of small things and must read as air, not as an overlay. Density is the kind's own at `some`, halved at `light`, doubled at `heavy`, scaled to the screen's area and halved again in `lite` quality. Colour is the look's `dim` unless the brain gives one (`embers` and `fireflies` take `accent`; `stars` take `ink`). Fields on a far layer are smaller, slower and fainter than the same field near. Weather passes behind text; a field on `fg` thins to a third where it crosses the flow block.

## Paintings

- **The sketch is the picture until there is a better one.** Nothing marks it as unfinished except, while a painting is on its way, the faintest breathing of the picture's edge. No spinner, no skeleton, no "generating" text.
- **A painting develops.** It is revealed through a noise threshold over the sketch, with a soft wet edge, over about two and a half seconds, on ambient time. Never a cross-fade, never a pop. (Growing it outward from the sketch's lines is wanted and not built; see product.md.)
- **It belongs to the stage.** It is on a layer, moves under the camera, takes the look's surface effects (grain, halftone, paper), and takes a mask: `round`, `circle`, `soft` (edges fade), `torn`.
- **If none comes, nothing happens.** The sketch stays; the edge stops breathing. The stage never apologises.

## Waiting, and being heard

- **The waiting signal.** Looks with a fixed-pitch face keep their own cursor (a block, a print head). Every other look shows three soft dots in `dim` that swell in turn, at the place the next thing will appear, or low on the left of an empty stage. It is visible within 100 ms of a wait beginning.
- **A tap is answered in one frame.** The tapped choice takes a pressed look (its box fills); the other choices recede to `dim`; the waiting signal starts. All before the server has replied. A second tap does nothing and shows nothing.
- **"Show all"** settles the stage with a 150 ms fade to its final state, never a jump cut, and never plays entrances in fast forward.

## The chrome

The chrome is the prompt bar, the status line, the transcript panel, the two action buttons, and the debug HUD. It steps back; the stage leads.

- It takes its ground and text colours from the current look (`--stage-ground`, `--stage-ink`, `--stage-dim`, `--stage-accent`), so the bar belongs to the stage instead of framing it. All other values are the tokens in `web/src/styles/tokens.css`.
- Type is the system UI face at one size, with one smaller size for status and the HUD. The looks' faces are for the stage only.
- Flat surfaces, a single hairline in `--stage-dim`, square corners (2 px). No frosted glass, no gradient text, no shadows.
- One input, one primary button ("Send" at rest, "Stop" while a turn is open). Beside it, while a turn is open or playing: **Show all**. Once a turn has ended: **Take away** (copy or save the script, play a script, save a picture, save a film, save frames). Controls are at least 44 px tall.
- Enter always submits: with text, it interrupts the answer and opens the new turn; Escape stops; `.` is Show all only while the stage has focus (WCAG 2.1.4; the button is always there).
- A prompt that cannot be sent is not thrown away: the words go back in the input and the status line says so.
- Routine status is silent to a screen reader; a hidden status region announces only what matters. The transcript is the live record: words as words, a drawing as one line built from the names the brain gave its parts ("Drawn: ground, wall, roof, door and sun.", announced once the drawing pauses), weather as "Weather: fireflies", a painting as its prompt. On a phone, Show all does not cover the stage with the transcript: it reports in the status line, and the sheet is capped at 42% of the screen.
- Focus is always visible: a 2 px outline in `--stage-accent`.
- An export shows its progress in the status line with a Cancel, and never covers the stage. A second film or picture while one is running is refused in words ("Another export is still running") and the first goes on. A lost graphics context says so in the status line and, when it cannot be rebuilt, points at `?renderer=plain`.
- The first drawing appears within 1.5 s of opening the page: the first-load demo plays from the copy bundled in the page while the connection is made in parallel, and the server replays it unseen into its own memory so the brain knows what the viewer saw.
- The HUD is monospaced, dense, and visually separate from the product.

The **exploration page** is a working tool, not part of the product's face: system UI type, a neutral ground of its own, cards in a grid, numbers aligned. It should read like a contact sheet.

## Considered and not built

- **A vector monitor look (Asteroids, 1979).** Now cheap, since strokes exist: glowing lines on black with a beam's overshoot at the corners. A good first addition; not needed to prove anything.
- **Bitmap brushes and blur.** Would make painterly work possible without the image model, at the cost of clean vector export and a much larger renderer.
- **Keyframes.** Per-property animation curves would serve motion prototyping. Left out until the harness shows that is a use worth the tokens.
