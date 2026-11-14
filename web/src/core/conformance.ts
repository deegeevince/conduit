// `pnpm kinds`: what the compiler cannot see (PLAN-v3-core 2.3). Every kind's fixtures are drawn under `tsx`, no browser, and held to:
//
//   pure        the same arguments twice give the same model, layout, drawing and census
//   inside      no ink outside the leaf's box
//   ink         at rest the leaf has ink, and every part of it is whole (opacity 1)
//   floor       every word in the census at or above the legibility floor for the screen (`LEGIBLE`)
//   targets     every region at least 44 points a side, for a finger
//   describe    `describe()` names every word the leaf shows (a kind that says it summarises by design is not held to this)
//   input       a hand's event and its inverse return the held value; a button's press tells the mind
//
// and, of the registry as a whole:
//
//   parity      what it advertises equals what today's painter advertises by hand (`STRUCTURES_READY`, `CONTROLS_READY`, the host tests)
//   taught      what the lexicon teaches, walked over what it advertises, is something the registry or the old core draws
//   cues        a chapter's cue says what `asksForMusic` and `asksForInterface` say
//
// A known failure is written down in `WAIVED` with its reason and the package that ends it, and is reported, not hidden; a failure that is
// not in the table fails the run. Text is sized by a stand-in measurer (as `painter/blocks/bench.ts` does), the looks are the real eleven, the
// rooms are the real safe frames at 1280x720 and 375x667.
//
//   pnpm kinds [--verbose]

import { CONTROLS_READY } from '../painter/controls';
import { STRUCTURES_READY } from '../painter/blocks';
import { EMPTY_STAGE, FULL_CAPABILITIES, LineNormalizer, LineReader, TurnScore, asksForInterface, asksForMusic, buildSystemPrompt } from '@conduit/language';
import type { Capabilities, ElementSpan, InkRole, Size } from '@conduit/language';
import { KIND_IDS, LEXICON, chaptersFor, isControlKind, isStructureKind, taughtNotAdvertised, teachingFor } from '../../../language/src/kinds';
import type { KindId } from '../../../language/src/kinds';
import type { BlockLook, MeasuredText, TextMeasure, TextSpec } from '../contracts/blocks';
import type { LookSpec } from '../contracts/look';
import type { Box } from '../contracts/space';
import { LOOKS } from '../looks';
import { bodySize, cellOf, safeFrame } from '../painter/layout/metrics';
import { AT_REST } from './contracts';
import type { Drawn, Env, LeafCensus, LeafEvent, Phase, Sealed } from './contracts';
import { LEGIBLE, TARGET } from './invariants';
import { KINDS, advertisedControls, advertisedStructures, isReady, kindOf, notYetKinds, readyKinds } from './registry';
import type { Hosts } from './registry';
import { fixtureElement } from './kinds/figure';

// The web package's types carry no Node; the run takes what it needs from the runtime.
declare const process: { argv: string[]; stdout: { write(s: string): void }; exitCode?: number };
const say = (line: string): void => void process.stdout.write(`${line}\n`);
const VERBOSE = process.argv.includes('--verbose');

// ---------------------------------------------------------------- the table of known failures

type Check = 'pure' | 'inside' | 'ink' | 'floor' | 'targets' | 'describe' | 'input' | 'fixture';
const WAIVED: readonly { readonly kind: KindId; readonly check: Check; readonly why: string }[] = [
  { kind: 'timeline', check: 'floor', why: 'teletext at 375 sets its body type at 10.5px, under the phone floor of 11: the look\'s size ladder; the stage solver (PC5, PC6) raises it' },
  { kind: 'table', check: 'floor', why: 'the same: teletext at 375 sets its body type at 10.5px (PC5, PC6)' },
  { kind: 'screen', check: 'floor', why: 'the kit sets its smallest type at 11.9px on paper at 1280, against a floor of 12 (its own MIN_TEXT_PX is 12; a rounding): PC9 takes the floor from Env.tokens' },
  { kind: 'tune', check: 'inside', why: 'under the fixed-pitch grid at 1280 (printout) the roll\'s last notes run 6 units past the room\'s right edge: the engine\'s grid snapping; PC14' },
  { kind: 'button', check: 'inside', why: 'under the fixed-pitch grid at 375 (teletext) the box outline spans 58 units in a control the engine reports as 48 high: the control engine\'s grid snapping; PC8' },
];

// ---------------------------------------------------------------- the pipeline: lines to elements

function elementsOf(lines: readonly string[]): readonly ElementSpan[] {
  const score = new TurnScore(EMPTY_STAGE);
  const reader = new LineReader();
  let seq = 0;
  let auto = 0;
  const normalizer = new LineNormalizer(() => `x${(auto += 1)}`);
  for (const raw of lines) {
    const result = reader.read(raw);
    if (result.kind !== 'line') continue;
    const normalized = normalizer.normalize(result.line);
    if (normalized.line === null) continue;
    seq += 1;
    score.push(normalized.line, seq, 0);
  }
  return score.schedule.elements;
}

/** The element a fixture is for, and its parts, in the order written. Null when the lines did not make a leaf of that kind. */
function leafOf(id: KindId, elements: readonly ElementSpan[], lines: readonly string[] = []): { readonly element: ElementSpan; readonly parts: readonly ElementSpan[] } | null {
  // `figure` has no line the language reads yet: its fixtures are one-line stand-ins (`figure:<name>`) for the typed input (kinds/figure.ts)
  if (id === 'figure') return fixtureElement(lines);
  const element = elements.find((candidate) => {
    const figure = candidate.figure;
    if (isStructureKind(id)) return figure?.kind === 'structure' && figure.structure === id;
    if (isControlKind(id)) return figure?.kind === 'control' && figure.control === id;
    if (id === 'canvas') return figure?.kind === 'shape';
    if (id === 'choice') return candidate.kind === 'text' && /tap=yes/.test('') === false && candidate.text !== '' && candidate.style.tap === true;
    return candidate.kind === 'text';
  });
  if (element === undefined) return null;
  return { element, parts: elements.filter((candidate) => candidate.parent === element.key) };
}

// ---------------------------------------------------------------- the environment: the real looks, a stand-in measurer

interface Screen {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}
const SCREENS: readonly Screen[] = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '375x667', width: 375, height: 667 },
];

function measurerFor(look: LookSpec, viewport: { width: number; height: number; dpr: number }): TextMeasure {
  const fixed = look.type.pitch === 'fixed';
  return (text: string, spec: TextSpec, maxWidth: number): MeasuredText => {
    const cell = cellOf(spec.size, viewport, look);
    const size = spec.shrink;
    const advance = fixed ? cell.width * size : look.type.advance * cell.fontSize * size;
    const widthOf = (s: string): number => {
      if (fixed) return s.length * advance;
      let w = 0;
      for (const ch of s) w += advance * (/[il.,'|:;!]/.test(ch) ? 0.55 : /[mwMW@]/.test(ch) ? 1.4 : /[A-Z0-9]/.test(ch) ? 1.15 : ch === ' ' ? 0.7 : 1);
      return w;
    };
    const lineHeight = cell.height * size;
    const lines: { text: string; width: number }[] = [];
    for (const para of text.split('\n')) {
      let cur = '';
      for (const word of para.split(/\s+/).filter((x) => x !== '')) {
        const next = cur === '' ? word : `${cur} ${word}`;
        if (cur !== '' && widthOf(next) > maxWidth) {
          lines.push({ text: cur, width: widthOf(cur) });
          cur = word;
        } else cur = next;
      }
      lines.push({ text: cur, width: widthOf(cur) });
    }
    return { width: Math.max(...lines.map((l) => l.width)), height: lines.length * lineHeight, lineHeight, lines };
  };
}

interface Setup {
  readonly look: LookSpec;
  readonly screen: Screen;
  readonly env: Env;
  readonly room: Box;
  readonly phone: boolean;
}

function setupFor(look: LookSpec, screen: Screen): Setup {
  const viewport = { width: screen.width, height: screen.height, dpr: 1 };
  const m = cellOf('m' as Size, viewport, look);
  const unit = Math.min(screen.width / 160, screen.height / 90);
  const fixed = look.type.snapToCells;
  const phone = screen.width <= 600;
  void bodySize;
  const tokens: BlockLook & { minTarget: number; floor: number } = {
    body: m.height,
    minShrink: 0.7,
    stroke: Math.max(1.5, Math.min(4, look.stroke.thick * unit * 0.4)),
    radius: fixed || look.stroke.character === 'pixel' ? 0 : 4,
    grid: fixed ? { cell: { width: m.width, height: m.height } } : null,
    minTarget: TARGET,
    floor: phone ? LEGIBLE.floor.phone : LEGIBLE.floor.desk,
  };
  const env: Env = {
    dpr: 1,
    pointer: phone ? 'coarse' : 'fine',
    tokens,
    measure: measurerFor(look, viewport),
    px: (spec: TextSpec) => cellOf(spec.size, viewport, look).fontSize * spec.shrink,
    ink: (role: InkRole) => look.roles[role],
    ground: look.roles.ground,
    canvasUnit: unit,
    legacy: { look },
  };
  const frame = safeFrame(viewport, look);
  return { look, screen, env, room: { x: 0, y: 0, width: frame.width, height: frame.height }, phone };
}

// ---------------------------------------------------------------- drawing a fixture, twice, and what that gives

/** A stable string of anything the kinds return, Maps included, so two runs can be compared. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v instanceof Map ? { map: [...v.entries()] } : v));
}

interface Drew {
  readonly drawn: Drawn;
  readonly census: LeafCensus;
  readonly digest: string;
  readonly describe: string;
  readonly leaf: ReturnType<Sealed<KindId>['layout']>;
  readonly element: ElementSpan;
}

function draw(kind: Sealed<KindId>, id: KindId, lines: readonly string[], setup: Setup, phase: Phase): Drew | null {
  const found = leafOf(id, elementsOf(lines), lines);
  if (found === null) return null;
  const { env, room } = setup;
  const model = kind.model(found.element, found.parts, null as never, env);
  const measured = kind.measure(model, { maxWidth: room.width, maxHeight: room.height }, env);
  // the box a leaf is given is what it asked for, at least its least, and no more than the room
  const size = { width: Math.max(1, Math.min(room.width, Math.max(measured.width, measured.least.width))), height: Math.max(1, Math.min(room.height, Math.max(measured.height, measured.least.height))) };
  const leaf = kind.layout(model, size, env);
  const drawn = kind.draw(leaf, phase, env);
  const census = kind.census(leaf);
  const describe = (LEXICON[id].describe as (e: ElementSpan, p: readonly ElementSpan[], h: never) => string)(found.element, found.parts, null as never);
  return { drawn, census, digest: stable([measured, size, drawn, census]), describe, leaf, element: found.element };
}

// ---------------------------------------------------------------- the checks

interface Finding {
  readonly kind: KindId;
  readonly check: Check;
  readonly where: string;
  readonly detail: string;
}

const findings: Finding[] = [];
const counts = new Map<string, { pass: number; fail: number }>();
function count(kind: KindId, check: Check, ok: boolean, where: string, detail: string): void {
  const key = `${kind}/${check}`;
  const entry = counts.get(key) ?? { pass: 0, fail: 0 };
  if (ok) entry.pass += 1;
  else {
    entry.fail += 1;
    findings.push({ kind, check, where, detail });
  }
  counts.set(key, entry);
}

function geometry(drawn: Drawn): readonly Box[] {
  const boxes: Box[] = [];
  const point = (x: number, y: number): Box => ({ x, y, width: 0, height: 0 });
  for (const { part } of drawn.parts) {
    if (part.kind === 'text') boxes.push(part.box);
    else for (const line of part.outline) for (const p of line.points) boxes.push(point(p.x, p.y));
  }
  for (const element of drawn.frames?.elements ?? []) boxes.push({ x: element.x - element.width / 2, y: element.y - element.height / 2, width: element.width, height: element.height });
  for (const figure of drawn.frames?.figures ?? []) {
    if (figure.kind !== 'shape') continue;
    const t = figure.transform;
    for (const line of figure.outline) for (const p of line.points) boxes.push(point(t.a * p.x + t.c * p.y + t.e, t.b * p.x + t.d * p.y + t.f));
  }
  return boxes;
}

const plain = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

function checkDrew(id: KindId, kind: Sealed<KindId>, lines: readonly string[], setup: Setup, tag: string): void {
  const a = draw(kind, id, lines, setup, AT_REST);
  const b = draw(kind, id, lines, setup, AT_REST);
  if (a === null || b === null) {
    count(id, 'fixture', false, tag, `${JSON.stringify(lines[0])} did not make a leaf of kind ${id}`);
    return;
  }
  count(id, 'fixture', true, tag, '');
  count(id, 'pure', a.digest === b.digest, tag, 'the same arguments gave two different drawings');

  // inside: the leaf's box is the size it was given, which `draw` chose; ink is held to it with the stroke's width to spare
  const size = (a.leaf as unknown as { size?: { width: number; height: number } }).size;
  if (size !== undefined) {
    const slack = setup.env.tokens.stroke + 0.5;
    const out = geometry(a.drawn).filter((b2) => b2.x < -slack || b2.y < -slack || b2.x + b2.width > size.width + slack || b2.y + b2.height > size.height + slack);
    count(id, 'inside', out.length === 0, tag, `${out.length} of ${geometry(a.drawn).length} marks outside ${Math.round(size.width)}x${Math.round(size.height)} (first at ${out[0] === undefined ? '' : `${Math.round(out[0].x)},${Math.round(out[0].y)} ${Math.round(out[0].width)}x${Math.round(out[0].height)}`})`);
  }

  const parts = a.drawn.parts;
  const whole = parts.every((p) => p.opacity === 1);
  const inked = parts.length > 0 || (a.drawn.frames !== null && (a.drawn.frames.figures.length > 0 || a.drawn.frames.elements.length > 0)) || a.drawn.surface !== null;
  count(id, 'ink', inked && whole, tag, !inked ? 'nothing drawn at rest' : 'a part is not whole at rest');

  const floor = setup.env.tokens.floor;
  const small = a.census.words.filter((w) => w.px < floor);
  count(id, 'floor', small.length === 0, tag, `${small.length} of ${a.census.words.length} words under ${floor}px: "${small[0]?.text ?? ''}" at ${small[0]?.px.toFixed(1) ?? ''}`);

  const thin = a.census.regions.filter((r) => r.box.width < TARGET - 0.5 || r.box.height < TARGET - 0.5);
  count(id, 'targets', thin.length === 0, tag, `${thin.length} of ${a.census.regions.length} regions under ${TARGET}: ${thin[0]?.part ?? ''} ${Math.round(thin[0]?.box.width ?? 0)}x${Math.round(thin[0]?.box.height ?? 0)}`);

  if (LEXICON[id].describes === 'words') {
    // what the painter draws that the mind did not write is not a word to name: a scale's ticks, a fixed-pitch look's `[x]`
    const said = plain(a.describe).replace(/\s/g, '');
    const missing = a.census.words.filter((w) => !/^(tick|mark)/.test(w.part)).map((w) => plain(w.text)).filter((w) => w !== '' && !said.includes(w.replace(/\s/g, '')));
    count(id, 'describe', missing.length === 0, tag, `describe() omits "${missing[0] ?? ''}" (${missing.length} of ${a.census.words.length} words): ${a.describe.slice(0, 90)}`);
  }
}

// ---- input: an event and its inverse

function checkInput(id: KindId, kind: Sealed<KindId>, setup: Setup, tag: string): void {
  if (!isControlKind(id)) return;
  const input = kind.input;
  const lines = kind.fixtures[0];
  if (input === null || lines === undefined) {
    count(id, 'input', false, tag, 'a control with no input');
    return;
  }
  const found = leafOf(id, elementsOf(lines), lines);
  if (found === null) return;
  const { env, room } = setup;
  const model = kind.model(found.element, found.parts, null as never, env);
  const measured = kind.measure(model, { maxWidth: room.width, maxHeight: room.height }, env);
  const leaf = kind.layout(model, { width: Math.max(measured.width, measured.least.width), height: Math.max(measured.height, measured.least.height) }, env);
  const regions = kind.census(leaf).regions;
  const at = (part: string): Box | undefined => regions.find((r) => r.part === part)?.box;
  const centre = (box: Box): { x: number; y: number } => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const press = (part: string, box: Box): LeafEvent => ({ type: 'press', part, ...centre(box) });

  if (id === 'button') {
    const box = at('press');
    const out = box === undefined ? null : input(leaf, null as never, press('press', box));
    count(id, 'input', out !== null && out.emit?.send === true && out.held === null, tag, 'a press did not send');
    return;
  }
  if (id === 'toggle') {
    const box = at('switch') ?? regions[0]?.box;
    if (box === undefined) return count(id, 'input', false, tag, 'no region to press');
    const initial = true; // the fixture is `on`
    const one = input(leaf, initial as never, press(regions.find((r) => r.box === box)?.part ?? 'switch', box));
    const two = one === null ? null : input(leaf, one.held as never, press(regions.find((r) => r.box === box)?.part ?? 'switch', box));
    count(id, 'input', one !== null && (one.held as unknown) === false && two !== null && (two.held as unknown) === initial, tag, `press gave ${String(one?.held)}, then ${String(two?.held)}; wanted false, then true`);
    // keys: more then less
    const more = input(leaf, false as never, { type: 'key', part: '', key: 'more' });
    const less = more === null ? null : input(leaf, more.held as never, { type: 'key', part: '', key: 'less' });
    count(id, 'input', more !== null && (more.held as unknown) === true && less !== null && (less.held as unknown) === false, tag, 'key more then less did not return the toggle');
    return;
  }
  if (id === 'slider') {
    const knob = at('knob');
    if (knob === undefined) return count(id, 'input', false, tag, 'no knob region');
    const home = centre(knob);
    const far = input(leaf, 4 as never, { type: 'drag', part: 'knob', x: home.x + 80, y: home.y, end: true });
    const back = far === null ? null : input(leaf, far.held as never, { type: 'drag', part: 'knob', x: home.x, y: home.y, end: true });
    const ok = far !== null && (far.held as unknown as number) > 4 && back !== null && Math.abs((back.held as unknown as number) - 4) < 0.5 && far.emit !== null;
    count(id, 'input', ok, tag, `drag right gave ${String(far?.held)}, back gave ${String(back?.held)}; wanted more than 4, then 4`);
    const more = input(leaf, 4 as never, { type: 'key', part: '', key: 'more' });
    const less = more === null ? null : input(leaf, more.held as never, { type: 'key', part: '', key: 'less' });
    count(id, 'input', more !== null && less !== null && (less.held as unknown as number) === 4, tag, `key more then less gave ${String(more?.held)} then ${String(less?.held)}`);
    return;
  }
  if (id === 'pick') {
    const second = at('option:2');
    const first = at('option:1');
    if (second === undefined || first === undefined) return count(id, 'input', false, tag, `no option regions (have ${regions.map((r) => r.part).join(', ')})`);
    const two = input(leaf, 1 as never, press('option:2', second));
    const one = two === null ? null : input(leaf, two.held as never, press('option:1', first));
    count(id, 'input', two !== null && (two.held as unknown) === 2 && one !== null && (one.held as unknown) === 1, tag, `option 2 gave ${String(two?.held)}, option 1 gave ${String(one?.held)}`);
    return;
  }
  if (id === 'input') {
    const typed = input(leaf, '' as never, { type: 'text', part: 'field', value: 'abc', commit: true });
    const erased = typed === null ? null : input(leaf, typed.held as never, { type: 'text', part: 'field', value: '', commit: true });
    count(id, 'input', typed !== null && (typed.held as unknown) === 'abc' && typed.emit !== null && erased !== null && (erased.held as unknown) === '', tag, `typing gave ${String(typed?.held)}, erasing gave ${String(erased?.held)}`);
  }
}

// ---------------------------------------------------------------- the run

const HOSTS_BOTH: Hosts = { chart: true, app: true };

function drawKinds(): void {
  say('Drawn under tsx: 11 looks x 2 screens (1280x720, 375x667), every fixture, at rest.\n');
  for (const id of KIND_IDS) {
    const kind = kindOf(id) as Sealed<KindId>;
    // the fixtures of any kind must make a leaf of that kind, ready or not
    kind.fixtures.forEach((lines, index) => {
      const made = leafOf(id, elementsOf(lines), lines);
      if (!isReady(kind.status, HOSTS_BOTH)) count(id, 'fixture', made !== null, `fixture ${index}`, `${JSON.stringify(lines[0])} did not make a leaf of kind ${id}`);
    });
    if (!isReady(kind.status, HOSTS_BOTH)) continue;
    for (const look of Object.values(LOOKS)) {
      for (const screen of SCREENS) {
        const setup = setupFor(look, screen);
        kind.fixtures.forEach((lines, index) => {
          const tag = `${look.id} ${screen.name} #${index}`;
          checkDrew(id, kind, lines, setup, tag);
        });
        checkInput(id, kind, setup, `${look.id} ${screen.name}`);
      }
    }
  }
}

// ---- the registry as a whole

function capabilitiesOfRegistry(hosts: Hosts): Capabilities {
  return { ...FULL_CAPABILITIES, structures: advertisedStructures(hosts), controls: advertisedControls() };
}

/** Kinds the old core still draws that the registry says "not yet" to: words, choices and the canvas. Not a gap in teaching. */
const LEGACY_DRAWN: readonly KindId[] = ['words', 'choice', 'canvas'];

function wholeRegistry(): { readonly lines: string[]; readonly failed: number } {
  const lines: string[] = [];
  let failed = 0;
  const check = (name: string, ok: boolean, detail: string): void => {
    lines.push(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : `: ${detail}`}`);
    if (!ok) failed += 1;
  };

  // parity with today's lists, by hand in `painter/blocks/index.ts`, `painter/controls/index.ts` and `painter/index.ts:419`
  const todayStructures = FULL_CAPABILITIES.structures.filter((kind) => (kind === 'chart' || kind === 'app' ? true : STRUCTURES_READY.includes(kind)));
  const derived = advertisedStructures(HOSTS_BOTH);
  check('structures advertised = today\'s (STRUCTURES_READY and both hosts)', derived.join() === todayStructures.join(), `derived [${derived.join(' ')}], today [${todayStructures.join(' ')}]`);
  const bare = advertisedStructures({ chart: false, app: false });
  const todayBare = FULL_CAPABILITIES.structures.filter((kind) => kind !== 'chart' && kind !== 'app' && STRUCTURES_READY.includes(kind) );
  check('structures with no host = STRUCTURES_READY less app', bare.join() === todayBare.join(), `derived [${bare.join(' ')}], today [${todayBare.join(' ')}]`);
  const todayControls = FULL_CAPABILITIES.controls.filter((kind) => CONTROLS_READY.includes(kind));
  check('controls advertised = CONTROLS_READY', advertisedControls().join() === todayControls.join(), `derived [${advertisedControls().join(' ')}], today [${todayControls.join(' ')}]`);

  // taught is drawn
  for (const hosts of [HOSTS_BOTH, { chart: false, app: false }]) {
    const caps = capabilitiesOfRegistry(hosts);
    const teaching = teachingFor(caps);
    const taught = [...teaching.kernel, ...teaching.chapter].map((entry) => entry.id);
    const drawable = [...readyKinds(hosts), ...LEGACY_DRAWN];
    const undrawn = taughtNotAdvertised(taught, drawable);
    check(`taught is drawn (chart host ${hosts.chart}, app host ${hosts.app}): ${taught.length} taught, ${teaching.kernel.length} in the prompt, ${teaching.chapter.length} in the brief`, undrawn.length === 0, `taught but not drawn: ${undrawn.join(', ')}`);
  }
  // and code, which the vocabulary teaches and no painter draws, is left out
  const codeTaught = [...teachingFor(capabilitiesOfRegistry(HOSTS_BOTH)).kernel].some((entry) => entry.id === 'code');
  check('code is not taught (it has no engine)', !codeTaught, 'code is advertised');
  const brokenCaps: Capabilities = { ...capabilitiesOfRegistry(HOSTS_BOTH), structures: [...advertisedStructures(HOSTS_BOTH), 'code'] };
  const leaked = taughtNotAdvertised([...teachingFor(brokenCaps).kernel].map((e) => e.id), [...readyKinds(HOSTS_BOTH), ...LEGACY_DRAWN]);
  check('the check catches it: advertising code is "taught but not drawn"', leaked.join() === 'code', `got [${leaked.join(' ')}]`);

  // the prompt built today from the derived capabilities: every structure it lists as a shape is in the lexicon's kernel
  const prompt = buildSystemPrompt({ capabilities: capabilitiesOfRegistry(HOSTS_BOTH), services: { paint: false, sight: 'report', review: false } });
  const kernelStructures = teachingFor(capabilitiesOfRegistry(HOSTS_BOTH)).kernel.map((e) => e.id).filter(isStructureKind).filter((id) => id !== 'code' && id !== 'chart');
  const absent = kernelStructures.filter((id) => !new RegExp(`\\b${id}\\b`).test(prompt));
  check(`today's prompt, built from the derived capabilities (${prompt.length} chars), names each kernel structure`, absent.length === 0, `not in the prompt: ${absent.join(', ')}`);

  // cues
  const sentences = ['play me a lullaby', 'a song about spring', 'compose a fugue', 'mock up a sign-in screen', 'a landing page for a cafe', 'how do planes fly', 'explain the water cycle', 'build a working calculator', 'a wireframe of the app', 'what is a chord'];
  let cueOk = true;
  let cueDetail = '';
  for (const text of sentences) {
    const input = { kind: 'prompt' as const, text };
    const wantMusic = asksForMusic(input);
    const wantUi = asksForInterface(input);
    if (LEXICON.tune.teach.cue?.(text) !== wantMusic) (cueOk = false), (cueDetail += `tune cue differs on "${text}"; `);
    if (LEXICON.screen.teach.cue?.(text) !== wantUi) (cueOk = false), (cueDetail += `screen cue differs on "${text}"; `);
  }
  check(`chapter cues agree with asksForMusic and asksForInterface on ${sentences.length} sentences`, cueOk, cueDetail);
  check('chaptersFor names the tune chapter on a music prompt', chaptersFor(capabilitiesOfRegistry(HOSTS_BOTH), 'play me a lullaby').some((e) => e.id === 'tune'), '');
  check('chaptersFor is empty on a plain question', chaptersFor(capabilitiesOfRegistry(HOSTS_BOTH), 'why is the sky blue').length === 0, '');

  // every kind is in both halves, by the compiler; and by name at run time
  check(`registry and lexicon list the same ${KIND_IDS.length} kinds`, Object.keys(KINDS).sort().join() === [...KIND_IDS].sort().join(), '');
  check('every entry\'s id is its key', KIND_IDS.every((id) => KINDS[id].id === id && LEXICON[id].id === id), '');
  return { lines, failed };
}

// ---------------------------------------------------------------- the report

function report(): void {
  say('Coverage of today\'s kinds (the registry, `web/src/core/registry.ts`)\n');
  const pad = (s: string, n: number): string => s.padEnd(n);
  say(`  ${pad('kind', 10)}${pad('status', 14)}${pad('wraps', 40)}${pad('teaches', 10)}describes`);
  const wraps: Readonly<Partial<Record<KindId, string>>> = {
    words: 'old timeline (PC6)',
    choice: 'old timeline (PC6)',
    canvas: 'old timeline, figures, camera (PC13)',
    figure: 'painter/blocks/figure (FG2): pure engine',
    flow: 'blocks/flow.ts layoutFlow',
    tree: 'blocks/tree.ts layoutTree',
    cycle: 'blocks/cycle.ts layoutCycle',
    timeline: 'blocks/timeline.ts layoutTimeline',
    map: 'blocks/map.ts layoutMap',
    table: 'blocks/table.ts layoutTable',
    chart: 'a surface (charts.ts, chart-host)',
    code: 'nothing: no engine yet (PC10)',
    tune: 'blocks/tune.ts layoutTune',
    app: 'blocks/app.ts layoutApp + a surface',
    screen: 'ui-stage.ts layoutUi',
    button: 'controls/engine.ts',
    toggle: 'controls/engine.ts',
    slider: 'controls/engine.ts',
    pick: 'controls/engine.ts',
    input: 'controls/engine.ts',
  };
  for (const id of KIND_IDS) {
    const status = KINDS[id].status;
    const label = status.state === 'ready' ? 'ready' : status.state === 'host' ? `ready+${status.host} host` : 'not yet';
    say(`  ${pad(id, 10)}${pad(label, 14)}${pad(wraps[id] ?? '?', 40)}${pad(LEXICON[id].teach.where, 10)}${LEXICON[id].describes}`);
  }
  const ready = KIND_IDS.filter((id) => KINDS[id].status.state !== 'not-yet');
  say(`\n  ${KIND_IDS.length} kinds: ${ready.length} drawn by an adapter, ${notYetKinds().length} typed "not yet" (${notYetKinds().map((k) => k.id).join(', ')})\n`);
}

function waivedFor(finding: Finding): string | null {
  return WAIVED.find((w) => w.kind === finding.kind && w.check === finding.check)?.why ?? null;
}

function main(): void {
  report();
  drawKinds();

  say('Per kind, per check (passes over drawings)\n');
  const checks: Check[] = ['fixture', 'pure', 'inside', 'ink', 'floor', 'targets', 'describe', 'input'];
  say(`  ${'kind'.padEnd(10)}${checks.map((c) => c.padEnd(10)).join('')}`);
  for (const id of KIND_IDS) {
    const cells = checks.map((check) => {
      const entry = counts.get(`${id}/${check}`);
      return (entry === undefined ? '-' : `${entry.pass}/${entry.pass + entry.fail}`).padEnd(10);
    });
    say(`  ${id.padEnd(10)}${cells.join('')}`);
  }

  // failures, grouped by kind and check, one example each
  const groups = new Map<string, Finding[]>();
  for (const f of findings) groups.set(`${f.kind}/${f.check}`, [...(groups.get(`${f.kind}/${f.check}`) ?? []), f]);
  say(`\nFailures: ${findings.length} drawings in ${groups.size} groups\n`);
  let unwaived = 0;
  for (const [key, list] of groups) {
    const first = list[0] as Finding;
    const why = waivedFor(first);
    if (why === null) unwaived += 1;
    say(`  ${why === null ? 'FAIL  ' : 'waived'} ${key} x${list.length}: ${first.detail} [${first.where}]${why === null ? '' : ` (${why})`}`);
    if (VERBOSE) for (const f of list.slice(1, 6)) say(`            ${f.detail} [${f.where}]`);
  }

  say('\nThe registry as a whole\n');
  const whole = wholeRegistry();
  for (const line of whole.lines) say(line);

  say(`\n${unwaived === 0 && whole.failed === 0 ? 'kinds: clean' : `kinds: ${unwaived} failing group(s), ${whole.failed} failing registry check(s)`}`);
  if (unwaived > 0 || whole.failed > 0) process.exitCode = 1;
}

main();
