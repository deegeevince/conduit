# What's new

Newest first. Each item is something the brain can show live when asked "showcase what's new": draw it, don't describe it. The server reads this file.

## Everything where it belongs, nothing lost (live)
- Sliders and other controls stand in a column of their own beside a chart or a table, measured at the room they really have: all six sliders of a budget show at once on a computer, a tablet or a phone, and none sits on the drawing. On a very short screen they scroll inside their own window.
- Nothing an answer says is silently lost. When the words do not fit, they are set a little smaller together; whatever still does not fit waits behind a small "earlier" button at the top of the words, which shows those lines in order and closes again.
- "How does it work, step by step" keeps the picture and gives a "1 of 4" stepper beside it: one sentence a tap, the part it names lit up. A thing with a form you can see (a chord, a layout) is drawn, not put in a table.
- A row of boxes too narrow for its words (twelve months on a phone) wraps into rows, every word in its box. A hand-drawn table's rows open up instead of landing on each other, and narration keeps the order it was told in.
- On a phone, labels stay on the screen and their lines end on their own part. An app or a page keeps the answer's words beside it instead of covering them, and a mock-up's buttons and tab bar stay inside its screen.
- In homework, the pencil stays for the next try after a wrong answer, after Help and after "Show me how", on an iPad, a phone or a computer. A pen stroke that starts on a button draws; it never presses it.

## Step-by-step documents that are not homework (live)
- Ask to be walked through a recipe, a lease or a trip and Conduit writes a document of parts you work through: each step with a "Done" tick to mark it off, a choice where the call is yours (how thick, fine or question it, which day first), and help on a step when you ask. Homework help is the same pieces with a young learner's rules.
- Help for a young learner is a ladder of questions back to her, facts first (what do we know, with the facts marked in the question), then what is being asked, then ways to go at it, and then she has a go. Doing a way together is always an ask she answers, never an answer shown.

## Working through a page, a question at a time (live)
- Photograph a worksheet and Conduit shows it as a map: each section and its questions as cards, in order, each with a small crop from the photo. Everything is prepared and checked in the background before you reach it.
- Tap a question and it fills the screen, in the page's own words, with room underneath to write. You try first, with the pen, as on paper; nothing is shown before you do. Tap Check and Conduit reads your writing and drawing: a right answer gets a short celebration and goes on the card, a wrong one gets a kind word about what it saw and one hint.
- Help comes in small steps, only when you ask. "How could I think about this?" is a ladder of questions back to you, one tap each (what do we know, what is it asking, which way could we think about it), with the facts marked in the question, which stays pinned in the corner. "Show me how" plays one way through as steps you tap, and stops before the answer.
- A shape on a grid can be counted by tapping its squares. If Conduit cannot read a question or a figure well enough, it says "needs a person to check" instead of guessing.
- Stop any time. Reload within five minutes and it reopens where you were, your working still there; later, it offers to carry on or dismiss. Close takes you back to the canvas, and + then New conversation starts fresh.
- Units are set properly (cm², not cm2).

## The brain can see what it draws (live)
- After drawing, Conduit looks at its own picture and fixes what is wrong: a label on the wrong part, a label that spills out of its shape, lines that cross, words sitting on a diagram. It also has stage tools to draw and check on the canvas as it works.

## Labels on the right side (live)
- In a labelled picture (a heart, a machine, a cutaway) each label now stands outside the drawing, on the side nearest its part, in order, with a short line to exactly the part it names. Small screens get smaller type and stacked labels rather than overlap. The exploded view is complete when it comes to rest.

## Answers that do not overlap (live)
- A step-by-step answer reserves room for its longest version, so a changing number or a new step no longer lands on top of the text beside it. Tables and text that change as you move a slider or tap a button stay tidy.

## Live table numbers (live)
- Numbers in a table's cells can be worked out from the controls: move a slider and the table follows. A control may be named after the table that uses it.

## PDF in (live)
- Add a PDF the way you add a photo (+, paste, or drag and drop). Its first ten pages are drawn page by page, and its own text goes along with them, so a quote from it matches the page exactly.
- Up to ten photos or PDF pages in one message.

## Tidying up a broken answer (live)
- When the critic looks at an answer and says it cannot be read (words on words, things off the stage, text too small) and the brain can mend it, Conduit now does. The brain is shown what the critic found and writes a few fix lines; they are tried out of sight and kept only if the stage then measures better. A kept repair is shown as a change in place, with "Tidying up the last answer…" and then "Tidied" in the status line. If the repair is not better, nothing changes.
- One try per answer. Never while you are typing, never while a new answer is being made (a new question cancels it), never on a lesson, an app or a mock-up. `/review repair off` switches it off for you; it is on by default. The critic then looks at the repaired answer once more, so the log has the score before and after.

## Agent auto mode (live)
- `/tools auto` lets the brain's browser work without a prompt for each step: reading, scrolling, clicking, typing ordinary text, opening and closing its own tabs. `/tools ask` brings every prompt back. The server's default is `AGENT_PERMITS=auto|ask` (ask unless said).
- Still asked on stage, every time, even in auto: sending, buying, deleting, posting, signing in, and anything on a sign-in, payment or checkout page. Never allowed in any mode: typing a password or card number, touching a tab the brain did not open, downloads.
- The bar says "agent · auto" beside the model; each call allowed this way shows on the activity strip as "auto" and is logged with `permit: auto`. The kill switch stops it at once.

## The bar is one line (live)
- The bottom of the page is one pill, like a chat app's: a + button, the message box, the microphone, Send (Stop while Conduit answers). The box grows upwards when you type several lines (Shift+Enter makes a new line) and rests at one.
- The + menu holds the rest: Add a photo, Take a photo (on a phone), Draw, Save, Transcript, Model and effort, Copy answer, and About (keys, commands, the charting credit). It opens with Enter or Space and answers the arrow keys and Escape.
- Status is not a row any more: "thinking" and "playing" are the box's own hint; only an error or an export in progress shows as a small line above the bar.
- Sliders with whole-number ends and no step now move by whole numbers: 25%, not 25.06%.
- A mock-up on a narrow phone screen could hang the page when a photo's credit was only a little too long for it; fixed.

## Voice notes in
- Tap the microphone (or hold it) beside Send and speak, up to two minutes, with a level meter and a timer. The words appear in the message box to check before you send; a setting sends them at once. Works from a phone, an iPad or the desktop.
- It is read on the Mac that runs Conduit, on the device, and never sent to a third party. The audio is deleted once read, and the audit log records that a note was read, never the words. If the Mac cannot read it (permission not given, a language it cannot do on the device) it says so and offers typing.

## Saving films (live)
- Save film now saves the latest answer as you saw it: the prompt it began with and the taps and controls that carried it on, not only the last tap.
- Save whole conversation: one WebM of every turn in order, each after a card with what you asked, with the sound of any tunes. At most ten minutes; a longer conversation keeps its latest turns.
- Save frames (the zip of pictures) is gone; Save picture and Save MIDI stay.

## Mock-ups you can use (live)
- Mock-up buttons tell Conduit what you pressed (and what you typed, never a password); toggles and sliders follow your finger; follow-ups change the mock-up you have; bigger text; page mock-ups fit a phone.

## Working apps and films (live)
- Ask for something that works (a calculator, a playlist, a practice sheet that checks answers) and Conduit builds a real little app on the canvas, locked down with no internet or access to anything else; what you do in it reaches Conduit. Mock-ups stay mock-ups.
- Save film now saves your latest answer with its taps; Save whole conversation makes one video of everything, with sound; Save frames is gone.

## Photos in (live)
- Add photos to a message: the + menu (Add a photo, or Take a photo on a phone), paste, or drag and drop; up to 4, shown before sending. Conduit reads them (a worksheet becomes a table of its questions) and can show them on the canvas. Stored privately, upright, with location and other hidden details stripped.

## v2.2 first slice (live)
- Mock-ups stay on screen, can be clicked through (type into fields, passwords as dots, buttons go to the next screen), get relevant photos, and the bottom bar stays readable in every look.
- Mock-ups described, not drawn: ask for a page, an app screen or a user journey and get a laid-out browser page or phones (nav, buttons, cards, forms) in a clean studio look or a wireframe, with a real credited Creative Commons photo where a picture belongs.

## v2.1 (live, being polished)
- Only you can use it (your Tailscale login), every action is in an audit log, `/stop-all` stops everything, and `/usage` shows what it costs.
- Lessons read properly: the table you are learning from gets the big room with the steps beside it; the answer stays on screen at rest; decision boxes are diamonds; text keeps readable contrast.
- Music: ask for a tune or a sonata and it plays, drawn as a piano roll with a moving playhead; mute and stop in the bar; Save MIDI.
- Follow-ups change the picture you have instead of redrawing it; a correction never removes or rewords a choice; "what's new" (or /new) gives a short live tour.
- Words, pictures, diagrams, charts and choices each get their own room from one stage plan (still being polished on phones and wide screens).
- Text stays up long enough to read; tables and charts no longer collapse on wide, short screens.
- Asked "what's new" or `/new`, the brain showcases this list live.
- Fixes change only what's wrong: a correction is tried out of sight and thrown away if it removes something or looks worse.
- Standing asks: say "from now on…" once ("reply only in visuals") and it holds every turn.
- Charts read properly: real type sizes, labels that stay on the chart, the right chart for the data, a framed panel in the machine looks.
- Diagrams fit their room: labels beside lines, words inside boxes, cycles keep every arrow, wide tables become cards on a phone.
- Controls: a slider's value sits by its label, toggles name both states, every target is thumb-sized.
- Coming next (v2.1 part two, not live): code blocks, slide decks with PDF export, pasted pictures, selectable text.
- Agent is the only mode: reading and searching the web just happen; anything else waits for your Allow (or Deny) on stage, with the full details shown. Browser control is on: your Chrome, in Conduit's own tab group, every action asked first.
- Commands: /brain, /tools, /status, /asks, /look, /review, /export, /capture; "Take away" is now "Save".
- A critic (Fable) looks at every answer after it lands and notes what to improve.

## v2 hotfixes (live)
- Text no longer overlaps diagrams or charts.
- Web search and page reading, with sources cited on stage.
- /model, /effort, /help; the brain knows its own model and effort. Default: Opus at low effort.

## v2
- Structures: flow, tree, cycle, timeline, map, table, laid out by the painter.
- Charts on TradingView's engine: candles, lines, bars, with crosshair, pan and zoom.
- Controls: buttons, toggles, sliders, picks and inputs, bound to the drawing.
- Painting media (watercolour, oil, and more) from a sketch.
- Look and fix: the brain checks its own drawing and mends it.
- A technique library in Remote that grows from reviews.

## v1
- The Series language streamed line by line; a persistent stage; nine looks; a back channel that tells the brain what you saw.
