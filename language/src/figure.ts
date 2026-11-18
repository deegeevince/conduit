// FG2. The `figure` kit's words: what the brain writes, and the typed input the painter's figure engine takes.
//
//   figure heart cutaway | How the heart pumps blood
//   poly ra smooth 24,30 38,26 42,40 30,46 in=body fill=blue label="right atrium"
//   route tired ink=blue via=vena,ra,rv,pulm
//   step show=vena,ra | Used blood from the body fills the right atrium.
//   end
//
// A figure is a structure whose rows are its own lines, taken as written (as a mock-up's are), so each line stands alone on the wire and in the log.
// `readFigure` is the one reader of those rows. It is pure and total: a line it cannot read is a note, never a throw. The painter's engine
// (`web/src/painter/blocks/figure`) takes what it returns; the types here are the same shapes, written once more so that the language needs no painter.

export interface FigurePoint {
  readonly x: number;
  readonly y: number;
}

export type FigureShapeSpec =
  | { readonly kind: 'path'; readonly d: string }
  | { readonly kind: 'poly'; readonly points: readonly FigurePoint[] }
  | { readonly kind: 'line'; readonly points: readonly FigurePoint[] }
  | { readonly kind: 'ellipse'; readonly cx: number; readonly cy: number; readonly rx: number; readonly ry: number }
  | { readonly kind: 'rect'; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly r?: number };

export interface FigurePartSpec {
  readonly id: string;
  readonly shape: FigureShapeSpec;
  readonly smooth?: boolean;
  readonly in?: string;
  readonly fill?: string;
  readonly stroke?: string;
  readonly thick?: number;
  readonly label?: string;
  readonly optional?: boolean;
  readonly cut?: boolean;
}

export interface FigureRouteSpec {
  readonly id: string;
  readonly via: readonly string[];
  readonly ink?: string;
}

export interface FigureStepSpec {
  readonly show: readonly string[];
  readonly words: string;
}

export type FigureModeSpec = 'plain' | 'cutaway' | 'exploded';

export interface FigureSpec {
  readonly id: string;
  readonly title: string;
  readonly mode: FigureModeSpec;
  readonly axis?: 'x' | 'y';
  readonly parts: readonly FigurePartSpec[];
  readonly routes: readonly FigureRouteSpec[];
  readonly steps: readonly FigureStepSpec[];
}

/** The words a figure's own lines begin with; inside a figure these are its rows and nothing else's. `drop` takes parts away from a figure that is already on stage. */
export const FIGURE_WORDS: readonly string[] = ['path', 'poly', 'line', 'ellipse', 'rect', 'circle', 'route', 'step', 'drop'];
const PART_WORDS: readonly string[] = ['path', 'poly', 'line', 'ellipse', 'rect', 'circle'];

const NAME = /^[a-z][a-z0-9_-]*$/;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/;
const POINT = /^(-?(?:\d+\.?\d*|\.\d+)),(-?(?:\d+\.?\d*|\.\d+))$/;
const SIZE = /^(-?(?:\d+\.?\d*|\.\d+))x(-?(?:\d+\.?\d*|\.\d+))$/;
const LIMIT = { parts: 40, steps: 8, label: 40, words: 140 };

/** `key="two words"` or `key=word` pairs and the bare words of a head, with a quoted value kept whole. */
function tokens(head: string): string[] {
  const out: string[] = [];
  const pattern = /(?:[^\s"“=]+=)?(?:"[^"]*"|“[^”]*”|\S+)/g;
  for (const match of head.matchAll(pattern)) out.push(match[0]);
  return out;
}

const unquote = (value: string): string => value.replace(/^["“]/, '').replace(/["”]$/, '').trim();

/** One line of a figure, as the normaliser leaves it: the verb, the id (made when the brain left it out), the rest as written. */
export function figureRowLine(raw: string, ordinal: number): string {
  const text = raw.trim();
  const bar = barOf(text);
  const head = (bar < 0 ? text : text.slice(0, bar)).trim();
  const tail = bar < 0 ? '' : text.slice(bar);
  const [verbWord = '', ...rest] = tokens(head);
  const verb = verbWord.toLowerCase();
  if (!PART_WORDS.includes(verb)) return text;
  const first = rest[0] ?? '';
  const named = NAME.test(first.toLowerCase()) && !/^(smooth|optional|cut)$/i.test(first);
  return named ? text : [verb, `p${ordinal}`, ...rest].join(' ') + (tail === '' ? '' : ` ${tail}`);
}

/** What one row of a figure is: a part or a route (named, so that a figure written again can find it), a step (counted, not named), or a `drop` of named parts. */
export type FigureRowKind =
  | { readonly kind: 'part'; readonly id: string }
  | { readonly kind: 'route'; readonly id: string }
  | { readonly kind: 'step' }
  | { readonly kind: 'drop'; readonly ids: readonly string[] }
  | { readonly kind: 'other' };

/** The reading of a figure's row that a figure written again goes by: parts and routes by their ids, as `readFigure` names them. */
export function figureRowOf(raw: string): FigureRowKind {
  const text = raw.trim();
  const bar = barOf(text);
  const head = (bar < 0 ? text : text.slice(0, bar)).trim();
  const [verbWord = '', ...rest] = tokens(head);
  const verb = verbWord.toLowerCase();
  if (verb === 'step') return { kind: 'step' };
  if (verb === 'drop') return { kind: 'drop', ids: rest.flatMap((word) => word.split(',')).map((word) => word.trim().toLowerCase()).filter((word) => NAME.test(word)) };
  if (verb === 'route') {
    const name = rest.find((word) => !word.includes('=') && NAME.test(word.toLowerCase()));
    return name === undefined ? { kind: 'other' } : { kind: 'route', id: name.toLowerCase() };
  }
  if (!PART_WORDS.includes(verb)) return { kind: 'other' };
  const idWord = rest.find((word) => !word.includes('=') && NAME.test(word.toLowerCase()) && !/^(smooth|optional|cut)$/i.test(word));
  return idWord === undefined ? { kind: 'other' } : { kind: 'part', id: idWord.toLowerCase() };
}

function barOf(text: string): number {
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' || char === '”') quoted = false;
    } else if ((char === '"' || char === '“') && text[index - 1] === '=') quoted = true;
    else if (char === '|') return index;
  }
  return -1;
}

/** The input the engine draws, from the figure's title, its mode and its rows. Notes say what could not be read. */
export function readFigure(id: string, title: string, mode: FigureModeSpec, rows: readonly string[]): { readonly input: FigureSpec; readonly notes: readonly string[] } {
  const parts: FigurePartSpec[] = [];
  const routes: FigureRouteSpec[] = [];
  const steps: FigureStepSpec[] = [];
  const notes: string[] = [];
  let ordinal = 0;
  for (const row of rows) {
    const text = row.trim();
    if (text === '') continue;
    const bar = barOf(text);
    const head = (bar < 0 ? text : text.slice(0, bar)).trim();
    const tail = bar < 0 ? null : text.slice(bar + 1).trim();
    const [verbWord = '', ...rest] = tokens(head);
    const verb = verbWord.toLowerCase();
    if (verb === 'route') {
      const pairs = pairsOf(rest);
      const via = (pairs.get('via') ?? '').split(',').map((part) => part.trim().toLowerCase()).filter((part) => part !== '');
      const name = rest.find((word) => !word.includes('=') && NAME.test(word.toLowerCase()));
      if (via.length < 2) notes.push(`route ${name ?? ''} needs via=a,b,… with two parts or more`);
      else routes.push({ id: (name ?? `r${routes.length + 1}`).toLowerCase(), via, ...(pairs.has('ink') ? { ink: pairs.get('ink') ?? '' } : {}) });
      continue;
    }
    if (verb === 'step') {
      const pairs = pairsOf(rest);
      const show = (pairs.get('show') ?? '').split(',').map((part) => part.trim().toLowerCase()).filter((part) => part !== '');
      // `long || short`: the longer form is the words; the band fits it or shrinks it (the engine's own floor)
      const words = (tail ?? '').split(/\s+\|\|\s+/)[0]?.trim() ?? '';
      if (show.length === 0 || words === '') notes.push('a step needs show=<parts> and its words after the bar');
      else if (steps.length < LIMIT.steps) steps.push({ show, words: words.slice(0, LIMIT.words) });
      continue;
    }
    if (verb === 'drop') continue;
    if (!PART_WORDS.includes(verb)) {
      notes.push(`"${verbWord}" is not a line of a figure; ignored`);
      continue;
    }
    ordinal += 1;
    const pairs = pairsOf(rest);
    const flags = new Set(rest.filter((word) => !word.includes('=')).map((word) => word.toLowerCase()));
    const idWord = rest.find((word) => !word.includes('=') && NAME.test(word.toLowerCase()) && !/^(smooth|optional|cut)$/i.test(word));
    const partId = (idWord ?? `p${ordinal}`).toLowerCase();
    const bare = rest.filter((word) => !word.includes('=') && word !== idWord);
    const shape = shapeOf(verb, bare, tail, pairs.get('r'));
    if (shape === null) {
      notes.push(`${verb} ${partId}: no shape could be read; left out`);
      continue;
    }
    if (parts.length >= LIMIT.parts) {
      notes.push(`a figure has at most ${LIMIT.parts} parts; ${partId} was left out`);
      continue;
    }
    const label = pairs.get('label');
    const thick = Number(pairs.get('thick'));
    const stroke = pairs.get('stroke') ?? (shape.kind === 'line' || shape.kind === 'path' ? pairs.get('ink') : undefined);
    const fill = pairs.get('fill') ?? (shape.kind === 'poly' || shape.kind === 'ellipse' || shape.kind === 'rect' ? pairs.get('ink') : undefined);
    parts.push({
      id: partId,
      shape,
      ...(flags.has('smooth') || pairs.get('smooth') === 'yes' ? { smooth: true } : {}),
      ...(pairs.has('in') ? { in: (pairs.get('in') ?? '').toLowerCase() } : {}),
      ...(fill !== undefined && fill !== '' ? { fill } : {}),
      ...(stroke !== undefined && stroke !== '' ? { stroke } : {}),
      ...(NUMBER.test(pairs.get('thick') ?? '') && thick > 0 ? { thick } : {}),
      ...(label !== undefined && label !== '' ? { label: label.slice(0, LIMIT.label) } : {}),
      ...(flags.has('optional') ? { optional: true } : {}),
      ...(flags.has('cut') ? { cut: true } : {}),
    });
  }
  return { input: { id, title, mode, parts, routes, steps }, notes };
}

function pairsOf(words: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const word of words) {
    const at = word.indexOf('=');
    if (at <= 0) continue;
    out.set(word.slice(0, at).toLowerCase(), unquote(word.slice(at + 1)));
  }
  return out;
}

function shapeOf(verb: string, bare: readonly string[], tail: string | null, radius?: string): FigureShapeSpec | null {
  const points = bare.flatMap((word) => {
    const match = POINT.exec(word);
    return match === null ? [] : [{ x: Number(match[1]), y: Number(match[2]) }];
  });
  if (verb === 'path') {
    const d = (tail ?? '').trim();
    return /^[Mm]/.test(d) ? { kind: 'path', d } : null;
  }
  if (verb === 'poly') return points.length >= 3 ? { kind: 'poly', points } : null;
  if (verb === 'line') return points.length >= 2 ? { kind: 'line', points } : null;
  const [centre] = points;
  const size = bare.map((word) => SIZE.exec(word)).find((match) => match !== null);
  if (verb === 'ellipse' && centre !== undefined && size !== undefined && size !== null) return { kind: 'ellipse', cx: centre.x, cy: centre.y, rx: Number(size[1]), ry: Number(size[2]) };
  if (verb === 'circle' && centre !== undefined) {
    const r = bare.find((word) => NUMBER.test(word));
    return r === undefined ? null : { kind: 'ellipse', cx: centre.x, cy: centre.y, rx: Number(r), ry: Number(r) };
  }
  if (verb === 'rect' && centre !== undefined && size !== undefined && size !== null) {
    const r = Number(radius);
    return { kind: 'rect', x: centre.x, y: centre.y, w: Number(size[1]), h: Number(size[2]), ...(NUMBER.test(radius ?? '') ? { r } : {}) };
  }
  return null;
}

const FIGURE_ASK = /\b(anatom\w*|parts? of|cross[- ]section|labell?ed|label (?:the|a|an|each|its)|(?:heart|lungs?|kidneys?|brain|stomach|digestive|eye|ear|tooth|teeth|skeleton|cell|flower|bicycle|bike)\b)/i;

/** The cue of the figure chapter: whether the user's words ask for a labelled drawing of a thing with parts. */
export const asksForFigure = (text: string): boolean => FIGURE_ASK.test(text);

/**
 * FG2. The figure kit, taught only on a turn that asks for one (never in the system prompt, which is full). The worked example is the plan's heart:
 * the brain writes parts, what they are called, the routes through them and the steps, and never a coordinate for a label, a route or a step.
 */
export const FIGURE_CHAPTER = `A LABELLED DRAWING (a thing with parts: anatomy, a machine, a mechanism): \`figure <id> [cutaway|exploded] | title\`, then its lines, then \`end\`. Never place a label, an arrow or a step by coordinates: the kit fits the subject, sets each label on its part's own side, keeps the labels clear and draws the steps' stepper.
- a part: \`path|poly|line|ellipse|rect <id> [smooth] [in=<part>] [fill=<hue>|stroke=<hue> thick=N] [optional] label="its name"\`. Points are x,y in a space of your own choosing (about 0 to 100); \`smooth\` curves a poly or a line through its points; \`in=<part>\` keeps it inside another closed part (the chambers of a heart in its body); \`optional\` goes first when labels crowd (seven at most are shown). A hue is a plain word (red, blue, muscle, bone, steel, leaf); the kit shades it. Back to front: the outline first, then what is inside it, then the vessels and pipes.
- \`route <id> via=a,b,c [ink=<hue>]\`: the path something takes, along open parts and through closed ones, in order. Arrows show the direction.
- \`step show=a,b | what happens\`: a stop that lights those parts and says it in a band; two to six steps, one sentence each (\`long || short\` is allowed). The user steps through them.
Seven or eight labelled parts at most. Then one \`say\` for what the picture cannot show.
scene caption
figure heart cutaway | How the heart pumps blood
path body fill=muscle | M52 14 C74 10 90 30 84 54 C78 76 60 90 46 94 C28 84 12 62 16 38 C20 20 36 12 52 14 Z
poly ra smooth 24,30 38,26 42,40 30,46 in=body fill=blue label="right atrium"
poly rv smooth 26,52 44,48 46,84 34,78 in=body fill=blue label="right ventricle"
poly la smooth 56,26 74,28 76,42 58,42 in=body fill=red label="left atrium"
poly lv smooth 54,48 76,50 70,74 48,90 in=body fill=red label="left ventricle"
path vena stroke=blue thick=4 label="from the body" | M30 2 V28
path pulm stroke=blue thick=4 label="to the lungs" | M36 50 C34 20 20 12 8 14
path veins stroke=red thick=4 label="from the lungs" optional | M96 30 H72
path aorta stroke=red thick=5 label="aorta" | M62 50 C60 8 82 4 88 18
route tired ink=blue via=vena,ra,rv,pulm
route fresh ink=red via=veins,la,lv,aorta
step show=vena,ra | Used blood from the body fills the right atrium.
step show=rv,pulm | The right ventricle squeezes it out to the lungs.
step show=veins,la | Fresh blood comes back into the left atrium.
step show=lv,aorta | The left ventricle, the thickest wall, sends it to the whole body. || The left ventricle pumps it to the body.
end
say aside approx from=recalled | About 70 beats a minute at rest. Valves stop it flowing back.`;

/**
 * A figure already on stage is changed in place: said again under its id, then only what changes. Carried while one stands (never in the system prompt, which is full), because
 * the figure's parts are not shapes the brain can `drop` or `set` one by one, and the only other way to change one was to draw the whole thing again in a new scene.
 */
export const FIGURE_EDIT = `A LABELLED DRAWING ON STAGE IS CHANGED IN PLACE, NOT DRAWN AGAIN: write \`figure <its id>\` again (a new title only if it changes), then only the lines that change, then \`end\`. A part or \`route\` line under an id the figure has replaces that one where it stands; a new id adds a part (give every new part an id of its own); \`drop <id> <id>\` takes parts or a route away. \`step\` lines, if you write any, are the whole list of steps (none leaves them as they are). Whatever you do not name stays exactly as it is, so the picture does not move; but whatever the change makes untrue goes with the part named, so drop that too. A route or a step you keep must not name a part you dropped. A new \`scene\` clears the whole drawing: it is for a new subject.`;

/**
 * How the painter plays a change to a figure that is on stage, on its own clock and whenever the lines came: each part that goes (or is put right) fades out in turn, then each part that
 * comes (or is put right) is drawn in, then the routes, then the labels. What the change leaves alone is never faded or redrawn. A part is played no earlier than the line that made it
 * arrived, and each waits its turn behind the one before, so a change that streams in over seconds plays as it comes and a burst plays one after another.
 * The pacing is here so that the turn lasts as long as the change plays (`figureReviseEnd`); `lead`: a change is never earlier than this into a turn, so that the figure as it was is on
 * screen for the change to play from (a layout epoch is a quarter of a second at the least); `most`: a change that would take longer is played faster; `move`: a part that stays but
 * is set again (the figure was fitted to its room afresh) eases to its new place over this long.
 */
export const FIGURE_REVISE = { lead: 0.3, leave: 0.5, leaveStagger: 0.12, enter: 0.7, enterStagger: 0.25, route: 0.6, label: 0.5, labelStagger: 0.12, move: 0.8, most: 6 } as const;

/** One thing the change plays: something that leaves, a part that is drawn in, a route, or a label; `at` is when the line that made it arrived (the turn's clock). */
export interface ReviseItem {
  readonly at: number;
  readonly kind: 'leave' | 'part' | 'route' | 'label';
}

/**
 * When, from the first of them, each item is played, and when it is all over: what leaves goes first, in turn; then the parts that come, each after the one before and no earlier
 * than its line arrived; then the routes; then the labels. A change longer than `FIGURE_REVISE.most` is played at the pace that fits it (`pace`: the share of each time and stagger kept).
 */
export function reviseTimes(items: readonly ReviseItem[]): { readonly starts: readonly number[]; readonly end: number; readonly pace: number } {
  if (items.length === 0) return { starts: [], end: 0, pace: 1 };
  const first = Math.min(...items.map((item) => item.at));
  const run = (k: number): { readonly starts: number[]; readonly end: number; readonly pace: number } => {
    const starts: number[] = new Array<number>(items.length).fill(0);
    const queue = (kind: ReviseItem['kind'], from: number, stagger: number, seconds: number): number => {
      const order = items.flatMap((item, i) => (item.kind === kind ? [i] : [])).sort((a, b) => (items[a] as ReviseItem).at - (items[b] as ReviseItem).at || a - b);
      let cursor = from;
      let end = from;
      for (const i of order) {
        const start = Math.max((items[i] as ReviseItem).at - first, cursor);
        starts[i] = start;
        cursor = start + stagger * k;
        end = Math.max(end, start + seconds * k);
      }
      return end;
    };
    const left = queue('leave', 0, FIGURE_REVISE.leaveStagger, FIGURE_REVISE.leave);
    const drawn = queue('part', left, FIGURE_REVISE.enterStagger, FIGURE_REVISE.enter);
    const routed = queue('route', drawn, 0, FIGURE_REVISE.route);
    const end = queue('label', routed, FIGURE_REVISE.labelStagger, FIGURE_REVISE.label);
    return { starts, end, pace: k };
  };
  const whole = run(1);
  const k = whole.end > FIGURE_REVISE.most ? FIGURE_REVISE.most / whole.end : 1;
  return k === 1 ? whole : run(k);
}

/** On the turn's clock, when a figure's change has finished playing: from its history (the steps are only words and are not played), the same queue the painter plays. 0 when nothing was played. */
export function figureReviseEnd(history: readonly { readonly kind: 'drop' | 'replace' | 'add'; readonly at: number; readonly row?: 'part' | 'route'; readonly words?: true }[]): number {
  const played = history.filter((change) => change.words !== true);
  if (played.length === 0) return 0;
  const items: ReviseItem[] = played.flatMap((change): ReviseItem[] => {
    const comes: ReviseItem[] = change.row === 'route' ? [{ at: change.at, kind: 'route' }] : [{ at: change.at, kind: 'part' }, { at: change.at, kind: 'label' }];
    return change.kind === 'drop' ? [{ at: change.at, kind: 'leave' }] : change.kind === 'add' ? comes : [{ at: change.at, kind: 'leave' }, ...comes];
  });
  return Math.min(...items.map((item) => item.at)) + reviseTimes(items).end;
}
