// Entry for index.html: the stage, the prompt bar, the transcript, and the HUD when asked for.

import { DEFAULT_LOOK, FIRST_LOAD_DEMO } from '@conduit/language';
import { readParams } from './app/params';
import { mountStage } from './app/stage-app';
import type { StageApp, StageStatus } from './app/stage-app';
import { mountActions } from './chrome/actions';
import { mountHud } from './chrome/hud';
import { brainLabel, confirmation, isCommand, parseCommand } from './chrome/commands';
import { mountPromptBar } from './chrome/prompt';
import { mountTranscript } from './chrome/transcript';
import { FONTS, fontFor } from './fonts';
import { LOOKS } from './looks';

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
const stageHost = root.querySelector<HTMLElement>('#stage');
const bar = root.querySelector<HTMLElement>('#bar');
if (stageHost === null || bar === null) throw new Error('The page could not be built.');

let app: StageApp | null = null;
const promptBar = mountPromptBar(bar, {
  onSubmit: (text) => {
    // The field is cleared at once so Enter feels immediate; if the turn is not accepted the words come back.
    if (app === null) {
      promptBar.restore(text);
      return;
    }
    if (isCommand(text)) {
      void runCommand(app, text);
      return;
    }
    void app.prompt(text).catch(() => promptBar.restore(text));
  },
  onStop: () => app?.interrupt(),
});
/** A line starting with `/` is for the app, not the brain: it never becomes a turn and the stage is left alone. */
async function runCommand(stage: StageApp, text: string): Promise<void> {
  const command = parseCommand(text);
  if (command.kind === 'refused') {
    stage.announce(command.message);
    return;
  }
  if (command.kind === 'help') {
    stage.announce(confirmation(command, { configurable: false, model: null, effort: null }));
    return;
  }
  try {
    const choice = command.kind === 'set' ? await stage.link.setBrain(command.change) : await stage.link.brain();
    promptBar.setBrain(brainLabel(choice));
    stage.announce(confirmation(command, choice));
  } catch (cause) {
    stage.announce(cause instanceof Error ? cause.message : String(cause));
  }
}

promptBar.setStatus('connecting');
promptBar.setBusy(false);

const keepAboveKeyboard = (): void => {
  const viewport = window.visualViewport;
  if (viewport === null) return;
  document.documentElement.style.setProperty('--app-height', `${Math.round(viewport.height)}px`);
  window.scrollTo(0, 0);
};
window.visualViewport?.addEventListener('resize', keepAboveKeyboard);
keepAboveKeyboard();

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
  const autoplay = params.demo === 'none' ? null : (params.demo ?? FIRST_LOAD_DEMO);
  try {
    app = await mountStage({ host: stageHost, params, lockLook: params.look, autoplay });
  } catch (cause) {
    unavailable(cause instanceof Error ? cause.message : String(cause));
    return;
  }
  const mounted = app;
  window.__stage = mounted.hook;
  const transcript = mountTranscript(promptBar.extra, mounted.painter, { onChoice: (key) => mounted.choose(key) });
  mountActions(promptBar.extra, mounted, transcript, stageHost);
  const show = (status: StageStatus): void => {
    promptBar.setStatus(status.text, status.announce);
    promptBar.setCancel(status.cancel);
    promptBar.setBusy(status.busy);
  };
  mounted.link.brain().then((choice) => promptBar.setBrain(brainLabel(choice)), () => undefined);
  mounted.onStatus(show);
  show(mounted.status());
  if (params.debug) mountHud(document.body, mounted);
  promptBar.focus();
}

void start();
