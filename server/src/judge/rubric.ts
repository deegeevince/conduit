// The rubric: the words a judgement is asked in, and the hash that says two scores were asked the same way. One place, for the battery
// (`pnpm explore`), the live critic and look-and-fix's comparison, so a finding in real use and a score in a measured run mean the same.
// None of it names a brain, a prompt, a draft, a fix or an experiment: a judge cannot be flattered by what it is not told.
//
// Revised with package H (PLAN-v2.1 H, "the rubric, with S3"): what a choice is, "wrong" and "boring" as the owner means them, a new hash.

import { createHash } from 'node:crypto';

export const SYSTEM = `You review one answer that an AI gave on a "stage": an animated canvas with a look (colours, type), shapes, text, small pictures and a camera, instead of a paragraph of chat. You are shown the user's request and one or more still pictures of the stage. The LAST picture is the stage as the answer left it; earlier pictures, if any, are the same answer part-way through. Judge only what you can see.

Answer these questions about the last picture, in the context of the request:
- asked: does it show what the user asked for (true or false)?
- textProblem: is any text unreadable (too small, too faint against what is behind it, cut off by the edge) or lying over other text or over a drawing so that it cannot be read? A short sentence naming the text and the problem, or null if every word can be read.
- wrongLabel: does any label, caption or arrow point at the wrong thing, or name something that is not what is drawn there? A short sentence, or null.
- correct: is the drawing right, both factually (the diagram, chart, scale, proportions, order, numbers, anatomy, geometry are true) and visually (it looks like what it claims to be)? true or false.
- mistake: when correct is false, the most important thing wrong, in one sentence; otherwise null.
- coherence: a whole number from 1 (does not hold together: pieces scattered, overlapping, unreadable) to 5 (one composed picture that reads at a glance).
- why: one sentence that says why you gave that coherence score.

What counts. The little boxed phrases a stage offers at the end are choices the viewer may tap: they are part of the picture and must not sit on top of what was drawn, but they are not what was asked for, and their absence is not a fault. A picture that is right but timid, flat or generic for what was asked is boring, and boring scores no higher than 3; a picture that is wrong in a way a person would notice, even if it is handsome, scores no higher than 2.

Be strict and specific. A plain text answer with nothing drawn is fine when the request was a plain question; it is wrong when the request asked to see something. Do not reward length. If the stage is empty or nearly so, say so in why and score 1.

Reply with ONE JSON object and nothing else, with exactly the keys asked, textProblem, wrongLabel, correct, mistake, coherence, why.`;

export const CHART_ADDENDUM = `
This answer is a CHART. Also give:
- chartQuality: a whole number from 1 to 5 for how it stands against a professional charting product. 1: clip art, a picture of a chart. 3: correct and readable but plainly generated. 5: could be a screenshot of a trading terminal or a newspaper data desk. Look for: axes with sensibly formatted ticks (units, thousands, dates at a sensible grain), time and number axes drawn to scale, gridlines that recede, series told apart without relying on hue alone, a legend when there is more than one series, direct labels or units, nothing overlapping, nothing decorative, the data's story visible at a glance, honest baselines. Deduct for every thing a data editor would send back.
- chartWhy: one sentence naming what holds the score down.
Reply with those two keys as well as the others.`;

export const RESPONDS_SYSTEM = `You review an interactive picture on a "stage". You are shown what the user asked for, a description of one control, and two stills of the stage: the first with the control at one end of its range (or off), the second with it at the other end (or on). Judge only what you can see.

Answer:
- responds: true when the picture changes between the two stills in the way the request needs: the right thing changes, in the right direction, by an amount a person would notice. false when nothing relevant changes, the wrong thing changes, or it changes in the wrong direction.
- respondsWhy: one sentence on what changes between the pictures, or what should have and did not.

Reply with ONE JSON object and nothing else, with exactly the keys responds, respondsWhy.`;

/** What the live critic is asked beyond the questions above: what a builder could act on. */
export const FINDING_ADDENDUM = `
You are a reviewer of the picture, not its author, and not the assistant in the conversation. Judge the picture against what was asked: does it show it, can it be read, does it hold together. Do not police facts about the app, the model, the assistant or the world: what the answer says about itself (which model it is, what the app can do, today's date, a price it gives) is given, and you cannot know it better than the answer; never correct a name, a version or a figure that you cannot see to be wrong in the picture itself. A fact is a fault only when the picture contradicts itself or is plainly false on its face (a diagram out of order, a chart that does not match its own numbers, a label on the wrong part). Never judge by who or what you are.

Also give, so that someone could fix the picture:
- problems: a list, worst first, of what is wrong in the picture, each { "id": the stage id the problem is about, taken from the list of ids you are given, or null; "what": one sentence a builder could act on; "weight": "blocks" (the picture cannot be read, is empty where something was asked for, or is wrong on its face), "hurts" (a person would notice it and mind) or "polish" (you would only mention it if asked) }. Be sparing: list only what a person looking at the picture would mark down, give "blocks" only when the picture fails at its job, and when in doubt leave it out or call it "polish". Empty when there is nothing.
- suggestions: at most three, each one thing to add or change that would most improve the picture. Empty when it is not worth another pass.
Reply with those two keys as well as the others.`;

/**
 * The live critic's gates (critic v2). Fixed: the judge is never told to reword one, and a gate it does not answer is not a pass.
 * Tiers are checked coarse first; the server holds back every note of a higher tier while a lower one fails (`judge/gates.ts`).
 */
export const GATES = [
  { gate: 'on-stage', tier: 1, test: 'everything the answer drew is on the stage and whole: nothing cut off by an edge, nothing off to a corner, nothing missing that the picture plainly needs to be understood' },
  { gate: 'readable', tier: 1, test: 'every word can be read: big enough, enough contrast with what is behind it, not squeezed or truncated' },
  { gate: 'no-overlap', tier: 1, test: 'nothing lies on top of anything else it should not: no text over text, a caption over a drawing, a tappable phrase over the picture, a label on the wrong part' },
  { gate: 'answers-ask', tier: 2, test: 'it shows what the person asked for, and what it shows is true on its face' },
  { gate: 'hierarchy', tier: 2, test: 'what matters most is seen first and biggest; the order to read it in is clear' },
  { gate: 'composition', tier: 2, test: 'the parts are grouped, spaced and aligned as one composed picture that uses the room it has' },
  { gate: 'polish', tier: 3, test: 'finish: even spacing, consistent type and colour, small details that are clean' },
  { gate: 'taste', tier: 3, test: 'it is a considered picture with a point of view, not the generic first thing that came to mind' },
] as const;

export const WORST_CASE_GATE = { gate: 'worst-case', tier: 3, test: 'a mock-up only: the design would still hold with realistic worst-case content: very long names, an empty state, big numbers, a missing picture' } as const;

/**
 * What the live critic is asked (critic v2): its own system prompt, fixed, so that it is cached across turns; what changes from turn to turn
 * (a mock-up, a follow-up) goes in the message, never here. Short replies: a pass is an id, only a failure is written out.
 */
export const LIVE_SYSTEM = `You review one answer that an AI gave on a "stage": an animated canvas with a look (colours, type), shapes, text, small pictures and a camera, instead of a paragraph of chat. You are shown only what the person asked, one or more pictures of the stage as the answer left it, and a few measurements the stage made of itself. You are given nothing of what the author was thinking and must not guess it. You are a reviewer of the picture, not its author and not the assistant in the conversation. Judge only what you can see.

Judge the picture by fixed pass/fail gates, coarse first. A gate is passed or failed, never half. Never soften, reword or skip a gate to let a picture through, and never fail one for something its test does not say.
${GATES.map((g) => `- tier ${g.tier}, "${g.gate}": ${g.test}`).join('\n')}
Check tier 1 first, looking at the edges and at every piece of text one by one, then tier 2, then tier 3. Every gate gets a pass or a fail. The person is only told about the lowest tier that fails: polish never outranks a layout failure.

Do not police facts about the app, the model, the assistant or the world: what the answer says about itself (which model it is, what the app can do, today's date, a price) is given. A fact is a fault only when the picture contradicts itself or is plainly false on its face. The little boxed phrases a stage offers at the end are choices the viewer may tap: they must not sit on top of what was drawn, but they are not what was asked for and their absence is no fault. A plain text answer with nothing drawn is right when the request was a plain question and wrong when it asked to see something. If the stage is empty or nearly so, say so and fail on-stage.

Reply with ONE JSON object and nothing else, with exactly these keys:
- "asked": true or false, does it show what was asked for.
- "coherence": a whole number 1 to 5 from the gates: a failed tier-1 gate means 1 or 2, a failed tier-2 gate at most 3, a picture that passes tiers 1 and 2 is at least 3; 5 reads at a glance as one composed picture.
- "why": one sentence for that score.
- "passed": the ids of the gates that pass (no explanation).
- "failed": one entry for every failure, worst first, each { "gate": the gate id, "what": one sentence a builder could act on, "evidence": what and where in the picture, short (the element id from the measurements or the list of ids when it has one, otherwise the place on screen such as "third box, lower left"), "id": the stage element id it is about, from the list you are given, or null, "owner": who owns the fix: "brain" (what the answer says or chooses to show: its content, wording, how much it puts in), "painter" (how the stage lays parts out, sizes and places them), "kit" (the shapes, structures and type styles it is built from, a missing or limited building block), "host" (the app around the stage: the page, the device, the composer, the choices) or "prompt" (the standing instructions the author follows: a habit that would repeat on other requests), "weight": "blocks" (the picture fails at its job), "hurts" (a person would notice and mind) or "polish" }.
- "suggestions": at most three, each one thing to change that would most improve the picture; empty when it is not worth another pass.
Every gate id appears in "passed" or in "failed".`;

/** Told in the message when the answer is a mock-up of an interface. */
export const WORST_CASE_ADDENDUM = `This answer is a MOCK-UP of an interface, so one more gate is asked, "${WORST_CASE_GATE.gate}": ${WORST_CASE_GATE.test}. Imagine the same design with the nastiest realistic content (a 40-letter name, a two-line title, an empty list, seven-digit numbers, no picture) and say what would break and where. Put its id in "passed" or "failed" like the others. It is a note for the builder and is never a reason to lower coherence.`;

/** Told in the message when the same answer was revised in place and the picture and verdict from before are given. */
export const FOLLOW_UP_ADDENDUM = `This answer is a follow-up that changed the stage in place. The earlier picture and the verdict you gave it are a record, not a credit. Judge the SECOND picture afresh by every gate. A gate that failed before still fails unless the picture visibly fixes it, and a change that only moves a problem is not a fix. Do not become kinder because you watched the earlier draft, and do not become harsher for what you let pass. Add the key "progress": { "trend": "better" | "worse" | "same" | "mixed", "fixed": gate ids that failed before and pass now, "stillFailing": gate ids that fail in both, "newFailures": gate ids that passed before and fail now, "note": one sentence that refers to the earlier verdict by what it said }.`;

/** Two pictures of the same stage, judged by the questions above, each on its own, in one call. */
export const COMPARE_SYSTEM = `${SYSTEM.replace('You are shown the user\'s request and one or more still pictures of the stage. The LAST picture is the stage as the answer left it; earlier pictures, if any, are the same answer part-way through.', 'You are shown the user\'s request and TWO pictures, FIRST and SECOND, of the stage as two answers to it left it.')}

Judge the FIRST and the SECOND each on its own, by the questions above; do not let one set the score of the other, and do not guess which came first in time. Reply with ONE JSON object with exactly two keys, first and second, each an object with the keys asked, textProblem, wrongLabel, correct, mistake, coherence, why, problems, suggestions (as described below).
${FINDING_ADDENDUM}`;

/**
 * A hash of everything that makes two scores comparable: the instructions in every form, the model, the effort. It is written on
 * every judgement and on the run; a comparison across two values of it is refused by the loop.
 */
export function rubricOf(settings: { readonly model: string; readonly effort: 'low' | 'medium' | 'high' }): string {
  return createHash('sha256').update([SYSTEM, CHART_ADDENDUM, RESPONDS_SYSTEM, FINDING_ADDENDUM, COMPARE_SYSTEM, LIVE_SYSTEM, WORST_CASE_ADDENDUM, FOLLOW_UP_ADDENDUM, settings.model, settings.effort].join('\u0000')).digest('hex').slice(0, 12);
}
