// Entry for index.html: the stage, the prompt bar, the transcript, and the HUD when asked for.

import { DEFAULT_LOOK, FIRST_LOAD_DEMO } from '@conduit/language';
import { readParams } from './app/params';
import { mountStage } from './app/stage-app';
import { sourcesOf } from './chrome/photos';
import type { StageApp, StageStatus } from './app/stage-app';
import { mountActions } from './chrome/actions';
import { mountHud } from './chrome/hud';
import { mountLangPane } from './chrome/lang-pane';
import { mountModelLabel } from './chrome/model-label';
import { startJourney } from './app/journey';
import { runCommand } from './chrome/command-runner';
import { mountTour } from './chrome/tour';
import { copyAnswer } from './chrome/files';
import { isCommand } from './chrome/commands';
import { mountActivity } from './chrome/activity';
import { mountReport } from './chrome/report';
import { installTrace } from './chrome/trace';
import { mountAbout } from './chrome/about';
import { DRAW_WORDS, mountStageInk } from './ink/stage';
import { mountPenAsk } from './app/pen-ask';
import { guardFor, mountPenWriting } from './app/pen-write';
import type { StageInk } from './ink/stage';
import { mountPermission } from './chrome/permission';
import { mountPicker } from './chrome/picker';
import type { Picker } from './chrome/picker';
import { mountPromptBar } from './chrome/prompt';
import { mountSound } from './chrome/sound';
import { mountTranscript } from './chrome/transcript';
import { pageSpeaker } from './chrome/speak';
import { mountReader } from './chrome/speak-reader';
import type { WallRoom } from './wall/wall-room';
import { FONTS, fontFor } from './fonts';
import { LOOKS } from './looks';
import { followVisualViewport } from './app/viewport';

installTrace();

// The default look's face is asked for before anything else so the first words do not wait for it.
function preloadFace(): void {
  const key = LOOKS[DEFAULT_LOOK].type.font;
  if (!(key in FONTS)) return;
  const link = document.createElement('link');
  link.rel = 'preload';
  link.as = 'font';
  link.crossOrigin = 'anonymous';
  link.href = fontFor(key).url;
  document.head.append(link);
}
preloadFace();

const params = readParams(window.location.search);
const root = document.getElementById('app');
if (root === null) throw new Error('index.html has no #app element.');

if (params.look !== null) {
  const roles = LOOKS[params.look].roles;
  const style = document.documentElement.style;
  style.setProperty('--stage-ground', roles.ground);
  style.setProperty('--stage-ink', roles.ink);
  style.setProperty('--stage-dim', roles.dim);
  style.setProperty('--stage-accent', roles.accent);
}

root.innerHTML = `
  <main class="stage" id="stage" aria-label="Stage" tabindex="0"></main>
  <footer class="bar" id="bar"></footer>`;
const appRoot: HTMLElement = root;
if (params.journey !== null) appRoot.dataset['journey'] = params.journey;
const stageHost = root.querySelector<HTMLElement>('#stage');
const bar = root.querySelector<HTMLElement>('#bar');
if (stageHost === null || bar === null) throw new Error('The page could not be built.');

let app: StageApp | null = null;
let picker: Picker | null = null;
let stageInk: StageInk | null = null;
const promptBar = mountPromptBar(bar, {
  onSubmit: (text, photos, held, voice, skills) => {
    // The field is cleared at once so Enter feels immediate; if the turn is not accepted the words (and photos) come back.
    if (app === null) {
      promptBar.restore(text, held, skills);
      return false;
    }
    if (isCommand(text)) {
      const mounted = app;
      // SK1. `/skill <name> words` holds the skill as a chip and sends the words with it, as the chip and Send would
      void runCommand(app, text, (choice) => picker?.show(choice), {
        hold: (skill) => (promptBar.skills === null ? 'Skills are not available here.' : promptBar.skills.hold(skill)),
        send: async (words) => {
          const going = [...(promptBar.skills?.held() ?? [])];
          promptBar.skills?.clear();
          try {
            await mounted.prompt(words, undefined, undefined, undefined, undefined, going.map((skill) => skill.id));
          } catch (cause) {
            promptBar.restore(words, undefined, going);
            throw cause;
          }
        },
      });
      return false;
    }
    const going = skills.map((skill) => skill.id);
    const drawn = stageInk;
    if (drawn !== null && drawn.pending()) {
      // what was drawn on the stage goes up with these words: its picture is kept first, then one turn carries words, photos and marks
      const mounted = app;
      void (async () => {
        const marks = await drawn.take();
        await mounted.prompt(text === '' ? DRAW_WORDS : text, photos, marks ?? undefined, voice, sourcesOf(held), going);
        drawn.sent();
      })().catch((cause: unknown) => {
        promptBar.restore(text, held, skills);
        mounted.announce(cause instanceof Error ? cause.message : 'The drawing could not be sent.');
      });
      return true;
    }
    void app.prompt(text, photos, undefined, voice, sourcesOf(held), going).catch(() => promptBar.restore(text, held, skills));
    return true;
  },
  onStop: () => app?.interrupt(),
  // ink waiting on the stage is something to send even with no words
  hasExtra: () => stageInk?.pending() === true,
  // A photo (picked, taken, pasted or dropped) goes to the server as soon as it is added, and is shown back as the server kept it.
  photos: {
    upload: async (photo) => {
      if (app === null) throw new Error('The stage is still starting. Try again in a moment.');
      return (await app.link.uploadPhoto(photo)).id;
    },
    urlOf: (id) => app?.link.photoUrl(id) ?? null,
  },
  // SK1. The owner's skills, listed read only by the server; the page holds names and ids, never a skill's text.
  skills: {
    list: async (refresh) => {
      if (app === null) throw new Error('The stage is still starting. Try again in a moment.');
      return (await app.link.skills(refresh)).skills;
    },
  },
  // A voice note is recorded in the page and read on the owner's own Mac (Apple's on-device recogniser); only its words come back.
  voice: {
    status: async () => {
      if (app === null) throw new Error('The stage is still starting.');
      return app.link.voiceStatus();
    },
    upload: async (recording) => {
      if (app === null) throw new Error('The stage is still starting. Try again in a moment.');
      return app.link.uploadVoice(recording);
    },
  },
});

promptBar.setStatus('connecting');
promptBar.setBusy(false);

followVisualViewport();

function unavailable(message: string): void {
  const note = document.createElement('p');
  note.className = 'stage__unavailable';
  note.setAttribute('role', 'alert');
  note.textContent = `Stage unavailable. ${message}`;
  stageHost?.append(note);
  promptBar.setStatus('stage unavailable', true);
}

async function start(): Promise<void> {
  if (stageHost === null) return;
  // a journey starts on an empty stage: its first step is the first thing the film shows
  const autoplay = params.demo === 'none' || params.journey !== null ? null : (params.demo ?? FIRST_LOAD_DEMO);
  try {
    app = await mountStage({ host: stageHost, params, lockLook: params.look, autoplay });
  } catch (cause) {
    unavailable(cause instanceof Error ? cause.message : String(cause));
    return;
  }
  const mounted = app;
  window.__stage = mounted.hook;
  // ?wall=1 (PLAN-wall WL3): a tap on a turn in the transcript flies the camera to its frame
  let wall: WallRoom | null = null;
  const transcript = mountTranscript(promptBar.extra, mounted.painter, {
    menu: promptBar.menu,
    onChoice: (key) => mounted.choose(key),
    onCopyAnswer: (turn) => void copyAnswer(mounted, turn),
    ...(params.wall ? { onTurnTap: (turn: string) => wall?.goTurn(turn), skipPages: true } : {}),
  });
  mountReader(mounted.painter, pageSpeaker(), stageHost);
  const penGuard = guardFor(mounted.lens);
  stageInk = mountStageInk(stageHost, promptBar.menu, {
    upload: async (png) => (await mounted.link.uploadPhoto(png)).id,
    lastTurn: () => mounted.lastTurn(),
    capture: (maxSide) => mounted.capture(maxSide),
    moment: () => mounted.moment(),
    prompt: (words, marks) => mounted.prompt(words, [], marks),
    announce: (text) => mounted.announce(text),
    answerBoxes: () =>
      mounted.hook
        .controls()
        .filter((view) => view.ask === true && view.enabled && view.askState?.locked !== true && view.askState?.verdict !== 'right' && view.askState?.verdict !== 'shown')
        .flatMap((view) => {
          const box = view.parts.find((part) => part.part === 'field')?.box;
          return box === undefined ? [] : [{ id: view.id, kind: 'answer' as const, label: view.label.slice(0, 60), box: { x: box.x, y: box.y, w: box.width, h: box.height } }];
        }),
  }, { guard: penGuard, penPasses: mounted.lens === null });
  // the lens (`?lens=1`) looks at the ink through its own view
  mounted.lens?.useInk(stageInk);
  // the Pencil writes on the stage with no mode: in a written method's cells (and anywhere with the lens)
  mountPenWriting(mounted, stageInk, stageHost, penGuard);
  // `/demo`: a tap on a card of the tour, and the bar after a demo, are handled here; the real controls are the bar's own
  mountTour(mounted, {
    showCanvas: () => undefined,
    showAnswer: () => undefined,
    prompt: (text) => void mounted.prompt(text).catch((cause: unknown) => mounted.announce(cause instanceof Error ? cause.message : 'That could not be sent.')),
    open: (control) => {
      const pick = (selector: string): HTMLElement | null => bar?.querySelector<HTMLElement>(selector) ?? null;
      if (control === 'mic') pick('.prompt__voice')?.click();
      else if (control === 'typing') pick('.prompt__input')?.focus();
      else if (control === 'photo') promptBar.menu.open();
      else if (control === 'draw') {
        promptBar.menu.open();
        pick('.composer__item[data-item="draw"]')?.click();
      }
    },
  });
  mountPenAsk({ stage: stageHost, bar: bar as HTMLElement, ink: stageInk, controls: () => mounted.hook.controls(),
    question: () =>
      mounted.hook
        .lines()
        .map((line) => /^say\s+[^|]*\|\s*(.+)$/.exec(line.text)?.[1] ?? '')
        .filter((words) => words !== '')
        .slice(0, 4)
        .join(' '),
    upload: async (png) => (await mounted.link.uploadPhoto(png)).id,
    read: (request) => mounted.link.readInk(request),
    penChanged: () => mounted.painter.penChanged(),
    askAt: (x, y) => mounted.askAt(x, y),
  });
  // for the browser checks (web/scripts/ink-check.mjs): the ink layer's own latency numbers
  (window as unknown as { __inkStats?: () => unknown }).__inkStats = () => stageInk?.ink.stats();
  (window as unknown as { __inkDoc?: () => unknown }).__inkDoc = () => stageInk?.ink.document();
  (window as unknown as { __inkClear?: () => void }).__inkClear = () => stageInk?.ink.reset();
  (window as unknown as { __inkStrokes?: () => number }).__inkStrokes = () => stageInk?.ink.model.strokes.length ?? 0;
  // the picture the brain would be sent for what is drawn (the ink over the stage's picture, or on white when the stage's could not be taken), as a data URL: for the browser check
  (window as unknown as { __inkPicture?: () => Promise<string | null> }).__inkPicture = async () => {
    const made = await stageInk?.ink.picture();
    if (made === null || made === undefined) return null;
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(made.blob);
    });
  };
  mountActions(promptBar.extra, mounted, transcript, stageHost, { top: promptBar.top, menu: promptBar.menu });
  mountSound(promptBar.top, mounted);
  picker = mountPicker(promptBar.menu, mounted);
  mountReport(promptBar.menu, mounted, stageHost);
  mountAbout(promptBar.menu, mounted, params.wall ? (body) => mountMotionSetting(body, () => wall) : undefined);
  if (params.wall) {
    const { mountWall } = await import('./wall/wall-room');
    wall = await mountWall({ host: stageHost, app: mounted, transcript, motionParam: params.motion });
  }
  mountActivity(promptBar.activity, mounted);
  mountLangPane(appRoot, stageHost, mounted, promptBar.menu, { locked: params.journey !== null });
  if (params.journey !== null) {
    mountModelLabel(appRoot, mounted);
    void playJourney(params.journey, mounted, stageHost);
  }
  mountPermission(mounted);
  const show = (status: StageStatus): void => {
    promptBar.setStatus(status.text, status.announce);
    promptBar.setCancel(status.cancel);
    promptBar.setBusy(status.busy);
  };
  // The picker learns what the brain is set to once the session exists.
  mounted.hook.ready.then(() => mounted.link.brain()).then((choice) => picker?.show(choice), () => undefined);
  mounted.onStatus(show);
  show(mounted.status());
  if (params.debug) mountHud(document.body, mounted);
  promptBar.focus();
}

/** The journey of this name, from language/demos/journeys: lazily read, so a page without `?journey=` carries none of it. */
async function playJourney(name: string, mounted: StageApp, stage: HTMLElement): Promise<void> {
  const files = import.meta.glob('../../language/demos/journeys/*.journey', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;
  const load = Object.entries(files).find(([path]) => path.endsWith(`/${name}.journey`))?.[1];
  if (load === undefined) {
    window.__journey = { name, status: 'stopped', message: `There is no journey called "${name}".`, started: null, finished: null, steps: [], model: null, follow: { samples: 0, misses: 0, longestMissMs: 0 }, focus: [] };
    return;
  }
  startJourney({ app: mounted, stage, name, source: await load() });
}

/** "Motion: glide or fade", beside the system's reduced-motion setting: how the camera travels the wall. */
function mountMotionSetting(body: HTMLElement, wall: () => WallRoom | null): void {
  const row = document.createElement('label');
  row.className = 'about__line wall-setting';
  const text = document.createElement('span');
  text.textContent = 'Motion';
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Motion: glide or fade');
  for (const [value, label] of [['glide', 'Glide'], ['fade', 'Fade']] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  try {
    select.value = window.localStorage.getItem('conduit.wallMotion') === 'fade' ? 'fade' : 'glide';
  } catch {
    select.value = 'glide';
  }
  select.addEventListener('change', () => wall()?.setMotionSetting(select.value === 'fade' ? 'fade' : 'glide'));
  const note = document.createElement('small');
  note.textContent = "Fade cross-fades between frames instead of travelling. The system's reduced-motion setting does the same.";
  row.append(text, select);
  body.append(row, note);
}

void start();
