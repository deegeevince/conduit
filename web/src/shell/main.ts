// Entry for chat.html (served at /chat): the chat shell. A list of conversations, a thread, a composer, and a canvas that opens from any reply.
// The stage, the link and the chrome's pieces (photos, voice, ink, the brain picker, the words, save, the permission dialog) are the ones index.html uses;
// this file only decides where they go and what the thread shows. Nothing here reads a colour from the stage.

import { CONVERSATION_ID } from './ids';
import { DEFAULT_LOOK } from '@conduit/language';
import type { BrainChoice, ConversationSummary, ConversationView } from '@conduit/language';
import { readParams } from '../app/params';
import { mountStage } from '../app/stage-app';
import { sourcesOf } from '../chrome/photos';
import type { StageApp, StageStatus } from '../app/stage-app';
import { copyAnswer } from '../chrome/files';
import { mountReport } from '../chrome/report';
import { installTrace } from '../chrome/trace';
import { mountAbout } from '../chrome/about';
import { mountActions } from '../chrome/actions';
import { runCommand } from '../chrome/command-runner';
import { isCommand } from '../chrome/commands';
import { mountActivity } from '../chrome/activity';
import { mountHud } from '../chrome/hud';
import { mountPermission } from '../chrome/permission';
import { mountPicker } from '../chrome/picker';
import type { Picker } from '../chrome/picker';
import { mountSound } from '../chrome/sound';
import { mountTranscript } from '../chrome/transcript';
import type { Transcript } from '../chrome/transcript';
import { FONTS, fontFor } from '../fonts';
import { DRAW_WORDS, mountStageInk } from '../ink/stage';
import type { StageInk } from '../ink/stage';
import { LOOKS } from '../looks';
import { continueConversation, listConversations, readConversation } from './api';
import { mountCanvas } from './canvas';
import { mountComposer } from './composer';
import { mountList } from './list';
import { mountOverflow, mountUsage } from './ops';
import type { ListItem } from './list';
import { mountLive } from './live';
import type { Live } from './live';
import { answerScript, messagesOfTurn, shorten } from './model';
import type { AnswerTurn, Message, ReplyChoice, ReplyMessage } from './model';
import { stageScheme, systemScheme, watchStage, watchSystem, wear } from './theme';
import { mountThread } from './thread';
import { followVisualViewport } from '../app/viewport';

installTrace();

const UNTITLED = 'New conversation';
const PAST_NOTE = 'An earlier conversation. Send a message to pick it up where it left off.';
const DRAFT_KEY = 'conduit-continue';
/** From this width the canvas is a panel beside the thread; below it, the whole screen */
const SIDE_PANEL = '(min-width: 1100px)';
const DRAWER = '(max-width: 719px)';

// The default look's face is asked for before anything else so the first words do not wait for it.
const face = LOOKS[DEFAULT_LOOK].type.font;
if (face in FONTS) {
  const link = document.createElement('link');
  link.rel = 'preload';
  link.as = 'font';
  link.crossOrigin = 'anonymous';
  link.href = fontFor(face).url;
  document.head.append(link);
}

const params = readParams(window.location.search);
const root = document.getElementById('app');
if (root === null) throw new Error('chat.html has no #app element.');

wear(systemScheme());
root.innerHTML = `
  <div class="shell" id="shell" data-canvas="closed" data-drawer="closed">
    <nav class="shell-list" id="shell-list" aria-label="Conversations"></nav>
    <div class="shell-scrim" hidden></div>
    <main class="shell-thread" id="shell-main">
      <header class="shell-bar">
        <button type="button" class="sh-btn shell-bar__menu" aria-label="Conversations" aria-expanded="false" aria-controls="shell-list">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
        </button>
        <h1 class="shell-bar__title">${UNTITLED}</h1>
      </header>
      <div class="shell-scroll" tabindex="0" role="region" aria-label="Conversation"></div>
      <div class="shell-activity"></div>
      <div class="shell-composer"></div>
    </main>
    <aside id="shell-canvas"></aside>
  </div>`;
const part = <T extends HTMLElement>(selector: string): T => {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error('The page could not be built.');
  return found;
};
const shell = part('#shell');
const main = part('#shell-main');
const menuButton = part<HTMLButtonElement>('.shell-bar__menu');
const barTitle = part('.shell-bar__title');
const scrim = part('.shell-scrim');

let app: StageApp | null = null;
let picker: Picker | null = null;

// These [+] entries work on the stage, which sits in the canvas: the canvas is opened first and then the press goes on.
const NEEDS_CANVAS = new Set(['draw', 'png', 'svg', 'film', 'conversation', 'play']);
let replaying = false;
part('.shell-composer').addEventListener(
  'click',
  (event) => {
    if (replaying || !(event.target instanceof Element)) return;
    const item = event.target.closest<HTMLButtonElement>('.composer__item');
    if (item === null || !NEEDS_CANVAS.has(item.dataset['item'] ?? '') || item.getAttribute('aria-disabled') === 'true' || canvasOpen()) return;
    event.stopPropagation();
    void openCanvas(canvasTurn, null).then(() => {
      replaying = true;
      item.click();
      replaying = false;
    });
  },
  true,
);
let stageInk: StageInk | null = null;
let transcript: Transcript | null = null;
let live: Live | null = null;

// ---- the canvas, its theme, and the one box it is given

type Active = { readonly kind: 'live' } | { readonly kind: 'past'; readonly id: string };
let active: Active = { kind: 'live' };
let pastView: ConversationView | null = null;
let summaries: readonly ConversationSummary[] = [];
/** what the brain is set to, for the head of a reply's timeline (the log has its own for past ones) */
let brainNow: BrainChoice | null = null;
/** the turn of the active conversation whose canvas is open */
let canvasTurn: string | null = null;
/** the id of an older conversation this page took up: it is this page's conversation now */
let continuedId: string | null = null;
/** what the stage holds now: `<conversation>:<turn>` */
let stageKey: string | null = null;
let opener: HTMLElement | null = null;
let notice: ReturnType<typeof setTimeout> | undefined;

const canvas = mountCanvas(part('#shell-canvas'), {
  onClose: () => closeCanvas(),
  onPrev: () => step(-1),
  onNext: () => step(1),
  onReplay: () => void replay(),
});
const overlay = (): boolean => !window.matchMedia(SIDE_PANEL).matches;
const canvasOpen = (): boolean => shell.dataset['canvas'] === 'open';

function applyTheme(): void {
  wear(canvasOpen() ? stageScheme(canvas.room) : systemScheme());
}
watchStage(canvas.room, applyTheme);
watchSystem(applyTheme);

// ---- the thread and the list

const thread = mountThread(part('.shell-scroll'), {
  onOpenCanvas: (reply, from) => void openCanvas(reply.turn, from),
  onChoice: (choice, reply) => chooseReply(choice, reply),
  onCopied: (text) => {
    void navigator.clipboard.writeText(text).then(
      () => say('Copied.'),
      () => say('The browser would not copy. Select the words and copy them.'),
    );
  },
});
const list = mountList(part('#shell-list'), { onPick: (id) => void pick(id), onNew: () => startNew() });

/** a line above the composer that goes by itself */
function say(text: string, ms = 4000): void {
  composer.setStatus(text, { announce: true });
  clearTimeout(notice);
  notice = setTimeout(() => composer.setStatus(null), ms);
}

// ---- the composer

const composer = mountComposer(part('.shell-composer'), {
  onSubmit: (text, photos, held, voice) => {
    if (app === null) {
      composer.restore(text, held);
      say('The stage is still starting. Try again in a moment.');
      return false;
    }
    const mounted = app;
    if (isCommand(text)) {
      void runCommand(mounted, text, (choice) => picker?.show(choice)).then(() => {
        if (/^\/(help|status|asks|usage|look|tools)\b/i.test(text)) showPageCanvas();
      });
      return false;
    }
    const drawn = stageInk;
    const inked = drawn !== null && drawn.pending();
    const failed = (cause: unknown): void => {
      live?.dropPending();
      composer.restore(text, held);
      say(cause instanceof Error ? cause.message : 'That could not be sent.');
    };
    const send = (): void => {
      live?.addPending(text === '' ? DRAW_WORDS : text, photos, voice.length > 0, inked);
      if (drawn !== null && inked) {
        // what was drawn on the canvas goes up with these words: its picture is kept first, then one turn carries words, photos and marks
        void (async () => {
          const marks = await drawn.take();
          await mounted.prompt(text === '' ? DRAW_WORDS : text, photos, marks ?? undefined, voice, sourcesOf(held));
          drawn.sent();
        })().catch(failed);
        return;
      }
      void mounted.prompt(text, photos, undefined, voice, sourcesOf(held)).catch(failed);
    };
    if (active.kind === 'past') {
      // a message in an earlier conversation picks that conversation up
      const id = active.id;
      if (!canTakeUp(id)) {
        composer.restore(text, held);
        continueOnFreshPage(id, text);
        return false;
      }
      void takeUp(id).then(() => {
        showLive();
        send();
      }, failed);
      return true;
    }
    showLive();
    send();
    return true;
  },
  onStop: () => app?.interrupt(),
  hasExtra: () => stageInk?.pending() === true,
  photos: {
    upload: async (photo) => {
      if (app === null) throw new Error('The stage is still starting. Try again in a moment.');
      // a photo given while an earlier conversation is on view belongs to it: the conversation is taken up first, so the photo is named above that log's own
      if (active.kind === 'past' && canTakeUp(active.id)) await takeUp(active.id);
      return (await app.link.uploadPhoto(photo)).id;
    },
    urlOf: (id) => app?.link.photoUrl(id) ?? null,
  },
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

// ---- showing a conversation

function titleOf(): string {
  if (active.kind === 'past') return pastView?.summary.title ?? UNTITLED;
  const first = live?.firstWords() ?? '';
  return first === '' ? UNTITLED : shorten(first, 80);
}

function setTitle(): void {
  barTitle.textContent = titleOf();
  document.title = titleOf() === UNTITLED ? 'Conduit' : `${titleOf()} · Conduit`;
}

function setUrl(id: string | null): void {
  try {
    const url = new URL(window.location.href);
    if (id === null) url.searchParams.delete('c');
    else url.searchParams.set('c', id);
    window.history.replaceState(null, '', url);
  } catch {
    // an address that cannot be changed is not a problem
  }
}

function showLive(): void {
  if (active.kind === 'live') return;
  active = { kind: 'live' };
  pastView = null;
  thread.setMessages(live?.messages() ?? []);
  thread.setOpenTurn(canvasOpen() && stageKey?.startsWith('live:') === true ? stageKey.slice(5) : null);
  setTitle();
  setUrl(liveId());
  renderList();
  syncNav();
}

async function showPast(id: string): Promise<void> {
  let view: ConversationView;
  try {
    view = await readConversation(id);
  } catch (cause) {
    say(cause instanceof Error ? cause.message : 'That conversation could not be opened.');
    return;
  }
  active = { kind: 'past', id };
  pastView = view;
  thread.setMessages(view.turns.flatMap((turn) => messagesOfTurn(turn)), PAST_NOTE);
  thread.setOpenTurn(canvasOpen() && stageKey?.startsWith(`${id}:`) === true ? stageKey.slice(id.length + 1) : null);
  setTitle();
  setUrl(id);
  renderList();
  syncNav();
}

async function pick(id: string): Promise<void> {
  closeDrawer();
  if (id === 'live' || id === continuedId) showLive();
  else await showPast(id);
  // a conversation chosen on a phone is read from its end
  thread.scrollToEnd();
}

function startNew(): void {
  closeDrawer();
  // This page's conversation is the one that is new until something is said: a second "new" has nothing to start.
  if ((live?.messages().length ?? 0) > 0) {
    say('A new conversation starts with your next message after you reload this page.', 6000);
  }
  showLive();
  composer.focus();
}

/** the server's id for this page's conversation, once it has a turn in its log */
function liveId(): string | null {
  const session = app?.link.session ?? null;
  if (session === null || (live?.messages().length ?? 0) === 0) return null;
  if (continuedId !== null) return continuedId;
  return summaries.find((entry) => entry.session === session)?.id ?? null;
}

function renderList(): void {
  const mine = liveId();
  const hasTurns = (live?.messages().length ?? 0) > 0;
  const own = summaries.find((entry) => entry.id === mine);
  const items: ListItem[] = [{ id: 'live', title: hasTurns ? titleOf2() : UNTITLED, when: own?.updated ?? (hasTurns ? new Date().toISOString() : '') }];
  for (const entry of summaries) if (entry.id !== mine) items.push({ id: entry.id, title: entry.title, when: entry.updated });
  list.setItems(items, active.kind === 'live' ? 'live' : active.id);
}

function titleOf2(): string {
  const first = live?.firstWords() ?? '';
  return first === '' ? UNTITLED : first;
}

let listTimer: ReturnType<typeof setTimeout> | undefined;
function refreshList(delay = 300): void {
  clearTimeout(listTimer);
  listTimer = setTimeout(() => {
    void listConversations().then(
      (found) => {
        summaries = found;
        list.setProblem(null);
        renderList();
        if (active.kind === 'live') setUrl(liveId());
      },
      (cause: unknown) => list.setProblem(cause instanceof Error ? cause.message : 'The list could not be read.'),
    );
  }, delay);
}

function chooseReply(choice: ReplyChoice, reply: ReplyMessage): void {
  if (app === null) return;
  if (choice.key !== null && active.kind === 'live' && reply.turn === live?.lastTurn()) {
    app.choose(choice.key);
    return;
  }
  // a choice from an earlier reply, or from an earlier conversation (which it picks up), is a new message with those words
  const mounted = app;
  const send = (): void => {
    showLive();
    live?.addPending(choice.text, [], false, false);
    void mounted.prompt(choice.text).catch((cause: unknown) => {
      live?.dropPending();
      say(cause instanceof Error ? cause.message : 'That could not be sent.');
    });
  };
  if (active.kind !== 'past') {
    send();
    return;
  }
  const id = active.id;
  if (!canTakeUp(id)) {
    continueOnFreshPage(id, choice.text);
    return;
  }
  void takeUp(id).then(send, (cause: unknown) => say(cause instanceof Error ? cause.message : 'That could not be sent.'));
}

/** The server lets this page's session take up the conversation on view, and the page shows it as its own: earlier turns, then what comes next. */
function canTakeUp(id: string): boolean {
  return continuedId === id || (live?.messages().length ?? 0) === 0;
}

async function takeUp(id: string): Promise<void> {
  if (continuedId === id) return;
  const session = app?.link.session ?? null;
  const view = pastView;
  if (session === null || view === null || live === null) throw new Error('The stage is still starting. Try again in a moment.');
  await continueConversation(id, session);
  live.seed(
    view.turns.flatMap((turn) => messagesOfTurn(turn)),
    view.turns.map((turn) => ({ turn: turn.turn, kind: turn.kind, lines: turn.lines })),
  );
  continuedId = id;
  if (stageKey?.startsWith(`${id}:`) === true) stageKey = `live:${stageKey.slice(id.length + 1)}`;
}

/** This page's session has a conversation of its own already, and one conversation holds one session: the older one is opened on a fresh page, with the words kept. */
function continueOnFreshPage(id: string, text: string): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ id, text }));
  } catch {
    // the words are not kept; the page still opens on the conversation
  }
  say('Opening that conversation on a fresh page. Send your message again there.', 6000);
  const url = new URL(window.location.href);
  url.searchParams.set('c', id);
  window.location.assign(url);
}

// ---- opening the canvas

function repliesOf(): { readonly turn: string; readonly said: string }[] {
  if (active.kind === 'past') return pastView?.turns.map((turn) => ({ turn: turn.turn, said: turn.said })) ?? [];
  return (live?.messages() ?? []).flatMap((message, index, all) => {
    if (message.role !== 'reply' || message.turn === null) return [];
    const before = all[index - 1];
    return [{ turn: message.turn, said: before?.role === 'user' ? before.said : '' }];
  });
}

function turnsOf(): AnswerTurn[] {
  if (active.kind === 'past') return pastView?.turns.map((turn) => ({ turn: turn.turn, kind: turn.kind, lines: turn.lines })) ?? [];
  return live?.answerTurns() ?? [];
}

function syncNav(): void {
  const all = repliesOf();
  const at = all.findIndex((entry) => entry.turn === canvasTurn);
  canvas.setNav({ position: at < 0 ? '' : `Reply ${at + 1} of ${all.length}`, prev: at > 0, next: at >= 0 && at < all.length - 1, replay: at >= 0 });
  const entry = all[at];
  canvas.setTitle(entry === undefined ? (canvasTurn === null && canvasOpen() ? 'Canvas' : 'Canvas') : shorten(entry.said === '' ? 'Canvas' : entry.said, 90));
}

function setOpen(open: boolean): void {
  shell.dataset['canvas'] = open ? 'open' : 'closed';
  // On a screen with no room for a panel the canvas covers everything: nothing behind it is reachable, by keyboard or by a screen reader.
  // The composer is the one thing left reachable: its pill floats over the canvas's foot, so the owner can type while looking at the answer.
  const covered = open && overlay();
  const behind = [part('#shell-list'), ...[...main.children].filter((element) => !element.classList.contains('shell-composer'))];
  for (const element of behind) {
    if (covered) element.setAttribute('inert', '');
    else element.removeAttribute('inert');
  }
  if (covered) main.removeAttribute('inert');
  applyTheme();
}

async function openCanvas(turn: string | null, from: HTMLElement | null): Promise<void> {
  if (app === null) return;
  const conv = active.kind === 'live' ? 'live' : active.id;
  if (from !== null) opener = from;
  canvasTurn = turn;
  if (turn !== null && stageKey !== `${conv}:${turn}`) {
    const onStage = conv === 'live' && live?.lastTurn() === turn && app.lastTurn() === turn;
    if (onStage) stageKey = `${conv}:${turn}`;
    else if (app.status().busy) app.announce('The canvas is busy with the answer being made. Open this reply when it has finished.');
    else {
      const script = answerScript(turnsOf(), turn);
      if (script === null || script.trim() === '') app.announce('This reply drew nothing to show again.');
      else {
        app.showPage(script);
        // the reply is shown as it rests; Replay performs it again
        app.painter.showAll();
        stageKey = `${conv}:${turn}`;
      }
    }
  }
  setOpen(true);
  thread.setOpenTurn(turn);
  syncNav();
  if (from !== null || overlay()) canvas.focusTitle();
}

function showPageCanvas(): void {
  canvasTurn = null;
  stageKey = 'page';
  setOpen(true);
  thread.setOpenTurn(null);
  syncNav();
  canvas.setTitle('Page');
  canvas.focusTitle();
}

function closeCanvas(): void {
  if (!canvasOpen()) return;
  setOpen(false);
  thread.setOpenTurn(null);
  if (opener !== null && opener.isConnected) opener.focus();
  else composer.focus();
}

function step(by: -1 | 1): void {
  const all = repliesOf();
  const at = all.findIndex((entry) => entry.turn === canvasTurn);
  const next = all[at + by];
  if (next !== undefined) void openCanvas(next.turn, null);
}

async function replay(): Promise<void> {
  if (app === null || canvasTurn === null) return;
  if (app.status().busy) {
    app.announce('The canvas is busy with the answer being made.');
    return;
  }
  const script = answerScript(turnsOf(), canvasTurn);
  if (script === null || script.trim() === '') return;
  app.showPage(script);
  stageKey = `${active.kind === 'live' ? 'live' : active.id}:${canvasTurn}`;
}

canvas.root.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented || !canvasOpen() || document.querySelector('dialog[open]') !== null) return;
  // Escape inside an open menu or the words panel closes that first
  const target = event.target;
  if (target instanceof Element && target.closest('[role="menu"], .transcript__panel, .ink-stage') !== null) return;
  event.preventDefault();
  closeCanvas();
});

// ---- the list as a drawer on a phone

function closeDrawer(): void {
  shell.dataset['drawer'] = 'closed';
  scrim.hidden = true;
  menuButton.setAttribute('aria-expanded', 'false');
  main.removeAttribute('inert');
}
function openDrawer(): void {
  shell.dataset['drawer'] = 'open';
  scrim.hidden = false;
  menuButton.setAttribute('aria-expanded', 'true');
  main.setAttribute('inert', '');
  (part('#shell-list').querySelector<HTMLElement>('.conv[aria-current="true"]') ?? part('#shell-list').querySelector<HTMLElement>('button'))?.focus();
}
menuButton.addEventListener('click', () => (shell.dataset['drawer'] === 'open' ? closeDrawer() : openDrawer()));
scrim.addEventListener('click', () => {
  closeDrawer();
  menuButton.focus();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || shell.dataset['drawer'] !== 'open') return;
  event.preventDefault();
  closeDrawer();
  menuButton.focus();
});
window.matchMedia(DRAWER).addEventListener('change', (event) => {
  if (!event.matches) closeDrawer();
});
window.matchMedia(SIDE_PANEL).addEventListener('change', () => setOpen(canvasOpen()));

// The canvas leaves room for the pill under it: the pill's height (it grows with a status line or a photo) is the canvas's bottom margin on a phone.
const pillBox = part('.shell-composer');
const measurePill = (): void => shell.style.setProperty('--sh-pill-h', `${Math.ceil(pillBox.getBoundingClientRect().height)}px`);
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measurePill).observe(pillBox);
measurePill();

followVisualViewport();

// ---- the stage, once it is up

let statusTimer: ReturnType<typeof setTimeout> | undefined;
const LASTING = /connection lost|reconnecting|offline|unavailable/;
function showStatus(status: StageStatus): void {
  composer.setBusy(status.busy);
  clearTimeout(statusTimer);
  if (status.cancel !== null) {
    composer.setStatus(status.text, { announce: false, cancel: status.cancel });
    return;
  }
  if (!status.announce) {
    composer.setStatus(null);
    return;
  }
  composer.setStatus(status.text, { announce: true });
  if (!LASTING.test(status.text)) statusTimer = setTimeout(() => composer.setStatus(null), 5000);
}

function unavailable(message: string): void {
  const note = document.createElement('p');
  note.className = 'stage__unavailable';
  note.setAttribute('role', 'alert');
  note.textContent = `Stage unavailable. ${message}`;
  canvas.stageHost.append(note);
  composer.setStatus('The stage is unavailable, so nothing can be asked.', { announce: true });
}

async function start(): Promise<void> {
  try {
    app = await mountStage({ host: canvas.stageHost, params, lockLook: params.look, autoplay: null });
  } catch (cause) {
    unavailable(cause instanceof Error ? cause.message : String(cause));
    return;
  }
  const mounted = app;
  window.__stage = mounted.hook;
  // The words panel opens over the room (the stage's box), so it is made there; its button goes up to the header with the rest of the tools.
  const menu = composer.menu;
  transcript = mountTranscript(canvas.room, mounted.painter, { menu, onChoice: (key) => mounted.choose(key), onCopyAnswer: (turn) => void copyAnswer(mounted, turn) });
  stageInk = mountStageInk(canvas.stageHost, menu, {
    upload: async (png) => (await mounted.link.uploadPhoto(png)).id,
    lastTurn: () => mounted.lastTurn(),
    capture: (maxSide) => mounted.capture(maxSide),
    prompt: (words, marks) => mounted.prompt(words, [], marks),
    announce: (text) => mounted.announce(text),
  });
  stageInk.ink.onChange(() => composer.refresh());
  mountActions(canvas.tools, mounted, transcript, canvas.stageHost, { top: canvas.navTop, menu });
  mountSound(canvas.navTop, mounted);
  picker = mountPicker(menu, mounted);
  mountReport(menu, mounted, canvas.stageHost);
  mountAbout(menu, mounted, (body) => mountUsage(body, mounted, menu.button));
  mountOverflow(part('.shell-bar'), mounted);
  mountActivity(part('.shell-activity'), mounted);
  mountPermission(mounted);
  live = mountLive(mounted, transcript, {
    put: (message: Message) => {
      if (active.kind === 'live') thread.put(message);
    },
    remove: (id) => {
      if (active.kind === 'live') thread.remove(id);
    },
    onTurn: () => {
      setTitle();
      renderList();
      refreshList(200);
    },
    brain: () => (brainNow === null ? null : { id: 'claude-cli', model: brainNow.model, effort: brainNow.effort }),
    fetchTrace: async (turn) => {
      const session = mounted.link.session;
      if (session === null) return null;
      const found = (await listConversations()).find((entry) => entry.session === session);
      if (found === undefined) return null;
      return (await readConversation(found.id)).turns.find((entry) => entry.turn === turn)?.trace ?? null;
    },
    onStage: (turn) => {
      stageKey = `live:${turn}`;
      if (active.kind === 'live') {
        // the canvas follows the answer being made; on a wide screen it opens for it
        canvasTurn = turn;
        if (canvasOpen() || !overlay()) void openCanvas(turn, null);
      }
    },
  });
  mounted.hook.ready.then(() => mounted.link.brain()).then(
    (choice) => {
      brainNow = choice;
      picker?.show(choice);
    },
    () => undefined,
  );
  mounted.onStatus((status) => {
    showStatus(status);
    if (!status.busy) refreshList(600);
  });
  showStatus(mounted.status());
  if (params.debug) mountHud(document.body, mounted);
  setTitle();
  renderList();
  // for the browser checks (web/scripts/shell-check.mjs): where the shell stands, and the one box it gives the stage
  window.__shell = {
    insets: () => canvas.insets(),
    scheme: () => document.documentElement.dataset['theme'] ?? 'light',
    state: () => ({ active: active.kind === 'live' ? 'live' : active.id, canvasOpen: canvasOpen(), canvasTurn, stageKey, liveId: liveId(), conversations: summaries.length }),
  };
}

// ---- first look

list.setItems([{ id: 'live', title: UNTITLED, when: '' }], 'live');
thread.setMessages([]);
setTitle();
syncNav();
void (async () => {
  const wanted = new URLSearchParams(window.location.search).get('c');
  const first = start();
  try {
    summaries = await listConversations();
  } catch (cause) {
    list.setProblem(cause instanceof Error ? cause.message : 'The list could not be read.');
  }
  renderList();
  if (wanted !== null && CONVERSATION_ID.test(wanted)) await showPast(wanted);
  await first;
  // words kept across the fresh page that opened a conversation to continue it
  try {
    const kept = sessionStorage.getItem(DRAFT_KEY);
    sessionStorage.removeItem(DRAFT_KEY);
    const draft = kept === null ? null : (JSON.parse(kept) as { id?: unknown; text?: unknown });
    if (draft !== null && draft.id === wanted && typeof draft.text === 'string') {
      composer.restore(draft.text);
      composer.focus();
    }
  } catch {
    // nothing kept
  }
})();

declare global {
  interface Window {
    __shell?: {
      insets(): { top: number; right: number; bottom: number; left: number };
      scheme(): string;
      state(): unknown;
    };
  }
}
