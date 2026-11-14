// The agent's activity strip: one quiet line in the bar saying what the brain is doing with its tools, and a list behind it
// of every call this turn. Nothing is announced to a screen reader except what needs the owner (a call waiting, denied, or
// failed): routine calls are read from the list when the viewer asks for it.

import type { ActivityState } from '@conduit/language';
import type { AgentNote, StageApp } from '../app/stage-app';

export interface ActivityStrip {
  dispose(): void;
}

interface Call {
  readonly id: string;
  readonly tool: string;
  summary: string;
  state: ActivityState;
  ms: number | null;
}

const STATE_WORDS: Readonly<Record<ActivityState, string>> = {
  running: 'working',
  done: 'done',
  failed: 'failed',
  waiting: 'waiting for you',
  denied: 'not allowed',
};

let counter = 0;

function seconds(ms: number | null): string {
  return ms === null ? '' : ` in ${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}`;
}

export function mountActivity(host: HTMLElement, app: StageApp): ActivityStrip {
  counter += 1;
  const listId = `activity-list-${counter}`;
  const root = document.createElement('div');
  root.className = 'activity';
  root.hidden = true;
  root.innerHTML = `
    <button class="activity__line" type="button" aria-expanded="false" aria-controls="${listId}"></button>
    <ol class="activity__list" id="${listId}" aria-label="What the brain did this answer" hidden></ol>
    <p class="visually-hidden" role="status"></p>`;
  host.append(root);
  const line = root.querySelector<HTMLButtonElement>('.activity__line');
  const list = root.querySelector<HTMLElement>('.activity__list');
  const status = root.querySelector<HTMLElement>('[role="status"]');
  if (line === null || list === null || status === null) throw new Error('The activity strip could not be built.');

  const calls = new Map<string, Call>();
  let open = false;

  const setOpen = (next: boolean): void => {
    open = next;
    list.hidden = !next;
    line.setAttribute('aria-expanded', String(next));
  };

  const draw = (): void => {
    root.hidden = calls.size === 0;
    if (calls.size === 0) {
      setOpen(false);
      return;
    }
    const all = [...calls.values()];
    const latest = all[all.length - 1];
    if (latest === undefined) return;
    const running = all.filter((call) => call.state === 'running' || call.state === 'waiting').length;
    line.textContent = `${latest.tool}: ${latest.summary} (${STATE_WORDS[latest.state]})${all.length > 1 ? `, ${all.length} calls` : ''}`;
    line.title = running > 0 ? 'What the brain is doing; open the list' : 'What the brain did; open the list';
    list.replaceChildren(
      ...all.map((call) => {
        const item = document.createElement('li');
        item.className = `activity__item activity__item--${call.state}`;
        item.textContent = `${call.tool}: ${call.summary}. ${STATE_WORDS[call.state][0]?.toUpperCase() ?? ''}${STATE_WORDS[call.state].slice(1)}${seconds(call.ms)}.`;
        return item;
      }),
    );
  };

  line.addEventListener('click', () => setOpen(!open));
  list.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
      line.focus();
    }
  });

  const hear = (note: AgentNote): void => {
    if (note.type === 'over') {
      // The list stays until the next answer starts: what was done is still worth reading. A request that was waiting is gone.
      if (note.turn === null) calls.clear();
      draw();
      return;
    }
    if (note.type !== 'activity') return;
    const known = calls.get(note.id);
    if (known === undefined) calls.set(note.id, { id: note.id, tool: note.tool, summary: note.summary, state: note.state, ms: note.ms });
    else {
      known.summary = note.summary;
      known.state = note.state;
      known.ms = note.ms;
    }
    if (note.state === 'waiting' || note.state === 'denied' || note.state === 'failed') status.textContent = `${note.tool}: ${note.summary}, ${STATE_WORDS[note.state]}`;
    draw();
  };
  const off = app.onAgent(hear);

  return {
    dispose() {
      off();
      root.remove();
    },
  };
}
