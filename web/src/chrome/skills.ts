// The owner's skills in the composer: a "Skills" view in the [+] menu, with a search box and one row per skill, and a chip in
// the tray above the field for the skill held for the next message. Reading only: a tap holds a skill, and the server reads and uses its text
// when the message is sent. Nothing here runs a skill's scripts or sees its text; the page holds names and ids.

import { SKILL_HOLD } from '@conduit/language';
import type { SkillSummary } from '@conduit/language';
import type { ComposerMenu } from './menu';

/** What the shelf needs of the app: the list as the server has it. Rejects with a sentence when there is no conversation yet. */
export interface SkillPort {
  list(refresh?: boolean): Promise<readonly SkillSummary[]>;
}

/** A skill held for the next message: its id (what the server is sent) and the name the chip shows. */
export interface HeldSkill {
  readonly id: string;
  readonly name: string;
}

export interface SkillShelf {
  held(): readonly HeldSkill[];
  /** holds a skill for the next message; returns a sentence when it cannot be held, null when it is */
  hold(skill: HeldSkill): string | null;
  /** puts skills back that were not sent */
  restore(skills: readonly HeldSkill[]): void;
  /** empties the tray: what was held went with the message */
  clear(): void;
  /** the words sent when the field is empty and a skill is held: the brain draws what the skill is for, and three things to try */
  readonly bareWords: (skills: readonly HeldSkill[]) => string;
  dispose(): void;
}

/** What is sent when a skill is held and nothing else is said. */
export function bareSkillWords(skills: readonly HeldSkill[]): string {
  const names = skills.map((skill) => skill.name).join(' and ');
  return `Use my ${names} ${skills.length === 1 ? 'skill' : 'skills'}: show me here what ${skills.length === 1 ? 'it is' : 'they are'} for, and three things I could try with ${skills.length === 1 ? 'it' : 'them'}.`;
}

/** Whether a skill matches what was typed: every word of it starts a word of the name or appears in the description. */
export function skillMatches(skill: Pick<SkillSummary, 'name' | 'description'>, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return true;
  const name = skill.name.toLowerCase();
  const description = skill.description.toLowerCase();
  return words.every((word) => name.includes(word) || description.includes(word));
}

/** The small line under a skill's name: where it is from, and what to know before relying on it. */
export function tagsOf(skill: SkillSummary, alsoIn: string | null): string {
  const tags: string[] = [skill.source];
  if (skill.state === 'off-claude') tags.push('off in Claude Code');
  if (skill.state === 'unreadable') tags.push('cannot be read');
  if (skill.hasScripts) tags.push('has scripts (not run here)');
  if (skill.knowHowOnly && skill.state === 'on') tags.push('know-how only here');
  if (alsoIn !== null) tags.push(`also in ${alsoIn}`);
  return tags.join(' · ');
}

let counter = 0;

export function mountSkills(menu: ComposerMenu, before: HTMLElement, port: SkillPort, focusField: () => void): SkillShelf {
  counter += 1;
  const id = `skills-${counter}`;
  const tray = document.createElement('div');
  tray.className = 'prompt__skills';
  tray.hidden = true;
  tray.innerHTML = `<ul class="skill-chips" aria-label="Skills held for the next message"></ul><p class="skills__note skills__note--tray" role="status"></p>`;
  before.before(tray);
  const chips = tray.querySelector<HTMLUListElement>('.skill-chips');
  const trayNote = tray.querySelector<HTMLElement>('.skills__note');
  if (chips === null || trayNote === null) throw new Error('The skills tray could not be built.');

  const held: HeldSkill[] = [];
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  const tell = (text: string): void => {
    trayNote.textContent = text;
    tray.hidden = held.length === 0 && text === '';
    clearTimeout(noteTimer);
    if (text !== '') noteTimer = setTimeout(() => tell(''), 5000);
  };
  const paint = (): void => {
    chips.replaceChildren();
    for (const skill of held) {
      const item = document.createElement('li');
      item.className = 'skill-chip';
      item.dataset['skill'] = skill.id;
      const name = document.createElement('span');
      name.className = 'skill-chip__name';
      name.textContent = skill.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'skill-chip__remove';
      remove.setAttribute('aria-label', `Do not use the ${skill.name} skill`);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        const at = held.findIndex((entry) => entry.id === skill.id);
        if (at >= 0) held.splice(at, 1);
        paint();
        focusField();
      });
      item.append(name, remove);
      chips.append(item);
    }
    tray.hidden = held.length === 0 && trayNote.textContent === '';
  };

  const hold = (skill: HeldSkill): string | null => {
    if (held.some((entry) => entry.id === skill.id)) return null;
    if (held.length >= SKILL_HOLD.held) return `At most ${SKILL_HOLD.held} skills go with one message. Remove one first.`;
    held.push(skill);
    paint();
    return null;
  };

  // ---- the view in the [+] menu

  const body = menu.addView('skills', 'Skills');
  body.classList.add('skills');
  body.innerHTML = `
    <div class="skills__find">
      <label class="visually-hidden" for="${id}-search">Search your skills</label>
      <input class="skills__search" id="${id}-search" type="search" placeholder="Search your skills" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" />
    </div>
    <p class="skills__note" role="status"></p>
    <div class="skills__list" role="group" aria-label="Your skills"></div>`;
  const search = body.querySelector<HTMLInputElement>('.skills__search');
  const note = body.querySelector<HTMLElement>('.skills__note');
  const list = body.querySelector<HTMLElement>('.skills__list');
  if (search === null || note === null || list === null) throw new Error('The skills view could not be built.');

  let skills: readonly SkillSummary[] = [];
  let loaded = false;
  let showApart = false;
  const rows = new Map<string, HTMLButtonElement>();

  const chosen = (skill: SkillSummary): void => {
    if (skill.state !== 'on') {
      note.textContent = skill.note === undefined ? `The ${skill.name} skill cannot be used.` : `The ${skill.name} skill is ${skill.note}.`;
      return;
    }
    const refused = hold({ id: skill.id, name: skill.name });
    if (refused !== null) {
      note.textContent = refused;
      return;
    }
    menu.close(false);
    focusField();
    tell(`${skill.name} will go with your next message. Reading only: nothing in it is run.`);
  };

  const row = (skill: SkillSummary, alsoIn: string | null): HTMLButtonElement => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `composer__item skill${skill.state === 'on' ? '' : ' skill--off'}`;
    el.dataset['skill'] = skill.id;
    el.setAttribute('role', 'menuitem');
    el.setAttribute('aria-disabled', String(skill.state !== 'on'));
    const label = document.createElement('span');
    label.className = 'composer__label';
    label.textContent = skill.name;
    const gist = document.createElement('span');
    gist.className = 'composer__gist skill__brief';
    gist.textContent = skill.brief;
    const tags = document.createElement('span');
    tags.className = 'composer__gist skill__tags';
    tags.textContent = tagsOf(skill, alsoIn);
    el.append(label, gist, tags);
    el.addEventListener('click', () => chosen(skill));
    return el;
  };

  const render = (): void => {
    list.replaceChildren();
    rows.clear();
    const shown = skills.filter((skill) => skill.state !== 'shadowed');
    const primary = shown.filter((skill) => !skill.needsApp);
    const apart = shown.filter((skill) => skill.needsApp);
    const alsoIn = (skill: SkillSummary): string | null => {
      const other = skills.find((entry) => entry.state === 'shadowed' && entry.name.toLowerCase() === skill.name.toLowerCase());
      return other === undefined ? null : other.source;
    };
    for (const skill of primary) {
      const el = row(skill, alsoIn(skill));
      rows.set(skill.id, el);
      list.append(el);
    }
    if (apart.length > 0) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'composer__item skills__apart';
      toggle.setAttribute('aria-expanded', String(showApart));
      toggle.innerHTML = `<span class="composer__label">About another app (${apart.length})</span><span class="composer__gist">written for tools this app does not have; they only partly work here</span>`;
      list.append(toggle);
      for (const skill of apart) {
        const el = row(skill, alsoIn(skill));
        el.classList.add('skill--apart');
        rows.set(skill.id, el);
        list.append(el);
      }
      toggle.addEventListener('click', () => {
        showApart = !showApart;
        toggle.setAttribute('aria-expanded', String(showApart));
        filter();
      });
    }
    filter();
  };

  const filter = (): void => {
    const query = search.value;
    let count = 0;
    for (const skill of skills) {
      const el = rows.get(skill.id);
      if (el === undefined) continue;
      const match = skillMatches(skill, query);
      const apart = skill.needsApp;
      // a skill about another app is folded away until its heading is opened, or until a search names it
      el.hidden = !match || (apart && !showApart && query.trim() === '');
      if (!el.hidden) count += 1;
    }
    const toggle = list.querySelector<HTMLElement>('.skills__apart');
    if (toggle !== null) toggle.hidden = query.trim() !== '';
    if (!loaded) return;
    note.textContent = skills.length === 0 ? 'No skills were found in the folders this server reads.' : count === 0 ? `No skill matches "${query.trim()}".` : '';
  };

  const load = (refresh: boolean): void => {
    note.textContent = loaded ? '' : 'Reading your skills…';
    port.list(refresh).then(
      (found) => {
        skills = found;
        loaded = true;
        render();
      },
      (cause: unknown) => {
        loaded = true;
        note.textContent = cause instanceof Error ? cause.message : 'The skills could not be listed.';
      },
    );
  };

  search.addEventListener('input', filter);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      [...list.querySelectorAll<HTMLButtonElement>('.composer__item')].find((el) => !el.hidden)?.focus({ preventScroll: true });
    } else if (event.key === 'Enter') {
      event.preventDefault();
    }
  });

  // Opened by its entry: the list is asked for again each time, so a skill added or switched off a moment ago shows.
  const entry = menu.add({ id: 'skills', label: 'Skills', gist: 'your own, read only', order: 35, view: 'skills' });
  entry.el.addEventListener('click', () => {
    search.value = '';
    load(true);
  });

  return {
    held: () => held,
    hold,
    restore(back) {
      if (held.length > 0) return;
      for (const skill of back) hold(skill);
    },
    clear() {
      held.length = 0;
      paint();
      tell('');
    },
    bareWords: bareSkillWords,
    dispose() {
      clearTimeout(noteTimer);
      entry.remove();
      tray.remove();
    },
  };
}
