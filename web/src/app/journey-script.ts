// A journey: a scripted walk through one live conversation, one step per line (language/demos/journeys/*.journey).
// This file only reads the lines; app/journey.ts plays them.

export type JourneyOp = 'type' | 'tap' | 'drag' | 'undo' | 'back' | 'hold' | 'rest';

export interface JourneyStep {
  /** 1-based, in the order played */
  readonly n: number;
  /** the line of the file it came from, 1-based */
  readonly line: number;
  readonly op: JourneyOp;
  /** `op?` (or `op? |`): the step is skipped, and said so in the timings, when what it needs never shows */
  readonly optional: boolean;
  /** `name: type | …`: what a film editor calls this step (`car`, `brakes`, `dragSpeed`); null when it has none */
  readonly name: string | null;
  /** type: the words; tap: the label (a choice, a control, or a label the brain drew on a part, found by its words); `Brakes / Brake / Wheels` lists alternatives: the first that is on stage is tapped */
  readonly text: string;
  /** drag: the control's id or label, the two values and the seconds */
  readonly target: string;
  readonly from: number | 'min' | 'max';
  readonly to: number | 'min' | 'max';
  /** drag: seconds; hold: seconds */
  readonly seconds: number;
}

/** What `window.__journey` says: where the journey is and, for each step, when things happened (the page's clock and `performance.now()`). */
export interface Stamp {
  /** `Date.now()`: the page's clock, the same one a screen recording's frame times are on */
  readonly at: number;
  /** `performance.now()` */
  readonly perf: number;
}

export interface StepTiming {
  readonly n: number;
  readonly line: number;
  readonly op: JourneyOp;
  readonly optional: boolean;
  /** `name: type | …`: what a film editor calls this step (`car`, `brakes`, `dragSpeed`); null when it has none */
  readonly name: string | null;
  /** type: the words; tap: the label that was asked for; drag: the control asked for */
  readonly text: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'stopped';
  note: string | null;
  begin: Stamp | null;
  end: Stamp | null;
  /** the turn this step opened, when it opened one */
  turn: string | null;
  typingStart: Stamp | null;
  typingEnd: Stamp | null;
  sent: Stamp | null;
  /** the first new line that PAINTS: the first panel row or the first stage element that was not there when the turn opened is on screen. What a film is cut by. */
  firstLine: Stamp | null;
  /** the first line arriving in the page's log (before it paints); what `firstLine` was before the paint was timed */
  firstLineEvent: Stamp | null;
  /** the turn's own end: the stage has played it out */
  turnEnded: Stamp | null;
  /** the `rest` step: the last change anyone could see (a stage element, a control, a chart, a panel row) before the stage came to rest. What a film is cut by. */
  rest: Stamp | null;
  /** the page judged the stage settled (still for a moment, any critic or repair done or skipped): the last visible change is `rest`, this comes after it */
  restSettled: Stamp | null;
  /** a tap or an undo: the finger going down, and what it landed on */
  tapAt: Stamp | null;
  tapped: string | null;
  /** a tap: which of the words it listed (`Brakes / Brake / Wheels`) was found and tapped; null for any other step, and for a tap that found nothing */
  used: string | null;
  dragStart: Stamp | null;
  dragEnd: Stamp | null;
  drag: { readonly control: string; readonly from: number; readonly to: number; readonly reached: number; readonly readout: { readonly before: readonly string[]; readonly after: readonly string[] } } | null;
}

/** The alternatives a tap's words list, in the order wanted: `Brakes / Brake / Wheels` is three; words with no ` / ` in them are one. */
export function alternativesOf(text: string): string[] {
  const parts = text.split(/\s+\/\s+/).map((part) => part.trim()).filter((part) => part !== '');
  return parts.length === 0 ? [text.trim()] : parts;
}

/** A box in CSS pixels of the page's viewport (so, pixels of a recording made at that size). */
export interface FocusBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** What is being performed at one moment: the line the panel has lit, the element it made, and where both are on screen. */
export interface FocusSample {
  readonly at: number;
  readonly perf: number;
  /** `draw`: a line being performed; `type`: the input box; `tap`: the tapped element; `drag`: the control and what it changes; `idle` */
  readonly kind: 'draw' | 'type' | 'tap' | 'drag' | 'idle';
  readonly id: string | null;
  readonly element: FocusBox | null;
  readonly row: FocusBox | null;
}

export interface JourneyState {
  /** the focus track, sampled every frame and kept when it changes (and at least every 50 ms): for a film that keeps its eye on what is being animated */
  readonly focus: FocusSample[];
  readonly name: string;
  status: 'loading' | 'running' | 'done' | 'stopped';
  /** why it stopped, in words */
  message: string | null;
  started: Stamp | null;
  finished: Stamp | null;
  readonly steps: StepTiming[];
  /** what the brain itself reported for the last turn, as the label shows it */
  model: { readonly model: string; readonly effort: string } | null;
  /** how well the language pane kept the line being drawn in view: samples taken, those where it was out of view, the longest such stretch */
  follow: { samples: number; misses: number; longestMissMs: number };
}

export type JourneyParse = { readonly steps: readonly JourneyStep[] } | { readonly error: string };

const NO_TEXT = { text: '', target: '', from: 0, to: 0, seconds: 0 } as const;
const VALUE = String.raw`(-?\d+(?:\.\d+)?|min|max)`;
const valueOf = (word: string): number | 'min' | 'max' => (word === 'min' || word === 'max' ? word : Number(word));

/** Reads a journey file. The first line that is not a step, or is a step with something wrong in it, is the whole answer: `line N: …`. */
export function parseJourney(source: string): JourneyParse {
  const steps: JourneyStep[] = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    let raw = (lines[index] ?? '').trim();
    if (raw === '' || raw.startsWith('#')) continue;
    const named = /^([A-Za-z][\w-]*):\s+(?=[a-z]+\??(\s|$))/.exec(raw);
    const name = named === null ? null : (named[1] as string);
    if (named !== null) raw = raw.slice(named[0].length);
    const fail = (why: string): JourneyParse => ({ error: `line ${index + 1}: ${why} (${raw})` });
    const head = /^([a-z]+)(\?)?(?:\s|$)/.exec(raw);
    if (head === null) return fail('not a step');
    const op = head[1] as string;
    const optional = head[2] === '?';
    const rest = raw.slice(head[0].length).trim();
    const base = { n: steps.length + 1, line: index + 1, optional, name };
    switch (op) {
      case 'type':
      case 'tap': {
        const words = /^\|\s*(.+)$/.exec(rest);
        if (words === null) return fail(`${op} needs "| words"`);
        steps.push({ ...base, ...NO_TEXT, op, text: (words[1] as string).trim() });
        break;
      }
      case 'drag': {
        const parts = new RegExp(String.raw`^(.+?)\s+${VALUE}\s*>\s*${VALUE}(?:\s+over=(\d+(?:\.\d+)?)s?)?$`).exec(rest);
        if (parts === null) return fail('drag needs "<control> <from> > <to> over=<seconds>" (a number, min or max)');
        steps.push({ ...base, ...NO_TEXT, op, target: (parts[1] as string).trim(), from: valueOf(parts[2] as string), to: valueOf(parts[3] as string), seconds: parts[4] === undefined ? 2 : Number(parts[4]) });
        break;
      }
      case 'hold': {
        const seconds = /^(\d+(?:\.\d+)?)s?$/.exec(rest);
        if (seconds === null) return fail('hold needs seconds');
        steps.push({ ...base, ...NO_TEXT, op, seconds: Number(seconds[1]) });
        break;
      }
      case 'undo':
      case 'back':
      case 'rest':
        if (rest !== '') return fail(`${op} takes nothing after it`);
        steps.push({ ...base, ...NO_TEXT, op });
        break;
      default:
        return fail(`"${op}" is not a step (type, tap, drag, undo, back, hold, rest)`);
    }
  }
  if (steps.length === 0) return { error: 'the journey has no steps' };
  return { steps };
}

/** The seeded generator behind the typing rhythm: the same journey types the same way every time. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A short name for a model id the CLI reported: `claude-opus-5-5` is `Opus 5.5`. An id with no family in it is shown as it came. */
export function modelName(id: string): string {
  const bare = id.trim().replace(/\[[^\]]*\]$/, '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const words = bare.split('-').filter((word) => word !== '');
  const family = words.find((word) => /^[a-z]+$/.test(word));
  if (family === undefined) return id.trim();
  const numbers = words.filter((word) => /^\d{1,2}$/.test(word));
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return numbers.length === 0 ? name : `${name} ${numbers.join('.')}`;
}

/** What the label says: the model as the brain reported it and the effort the turn used, e.g. `Opus 5.5 · medium`. */
export function modelLabel(model: string, effort: string): string {
  return `${modelName(model)} · ${effort}`;
}
