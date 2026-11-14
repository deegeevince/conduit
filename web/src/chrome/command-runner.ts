// What each slash command does. A command is the app's, never the brain's: it never becomes a turn, and a page it prints on
// the stage (`/help`, `/status`, `/tools`) is a turn the app plays for itself and the server never hears of.

import { APP_COMMANDS, LOOK_IDS, REFINE_LIMITS } from '@conduit/language';
import type { BrainChoice } from '@conduit/language';
import type { StageApp } from '../app/stage-app';
import { confirmation, parseCommand, usageOf } from './commands';
import type { Command } from './commands';
import { copyScript, defaultSize, runExport, saveScript, saveStill } from './files';

/** A cell or a line of Series made from words that came from elsewhere: one line, no bar, no longer than it needs to be. */
function plain(text: string, limit = 160): string {
  const flat = text.replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** A page of the app's own as lines of Series: a heading, a table, a closing line. */
export function pageSource(title: string, columns: readonly string[], rows: readonly (readonly string[])[], closing: string | null): string {
  const lines = ['scene stack', `table rows | ${plain(title, 80)}`, `| ${columns.map((column) => plain(column, 40)).join(' | ')}`];
  for (const row of rows) lines.push(`| ${row.map((cell) => plain(cell)).join(' | ')}`);
  if (closing !== null) lines.push(`say | ${plain(closing, 200)}`);
  return lines.join('\n');
}

export function helpPage(): string {
  return pageSource(
    'What you can type',
    ['Command', 'What it does'],
    APP_COMMANDS.map((command) => [usageOf(command), command.gist]),
    'Anything that does not start with a slash is a question for the brain.',
  );
}

/** Runs one command line. Resolves when it has said what it did; never rejects. */
export async function runCommand(app: StageApp, text: string, onChoice: (choice: BrainChoice) => void): Promise<void> {
  const command = parseCommand(text);
  try {
    await perform(app, command, onChoice);
  } catch (cause) {
    app.announce(cause instanceof Error ? cause.message : String(cause));
  }
}

async function perform(app: StageApp, command: Command, onChoice: (choice: BrainChoice) => void): Promise<void> {
  switch (command.kind) {
    case 'refused':
      app.announce(command.message);
      return;
    case 'help':
      app.showPage(helpPage());
      return;
    case 'show':
    case 'set': {
      const choice = command.kind === 'set' ? await app.link.setBrain(command.change) : await app.link.brain();
      onChoice(choice);
      app.announce(confirmation(command, choice));
      return;
    }
    case 'tools': {
      const tools = command.change === null ? await app.link.tools() : await app.link.setTool(command.change.name, command.change.on);
      if (command.change !== null) app.announce(`${command.change.name}: ${command.change.on ? 'on' : 'off'} for this conversation`);
      if (command.change === null || tools.length > 0) {
        const brain = await app.link.brain();
        const where = brain.mode !== undefined && brain.mode !== 'agent' ? ' They are used only in agent mode (/brain agent).' : '';
        app.showPage(
          pageSource(
            'What the brain may use',
            ['Tool', 'Now', 'What it does'],
            tools.map((tool) => [tool.name, tool.on ? 'on' : 'off', `${tool.gist}${tool.reads ? '' : ' (asks you first)'}`]),
            tools.length === 0 ? `Nothing is offered here.${where}` : `/tools <name> on or off changes one.${where}`,
          ),
        );
      }
      return;
    }
    case 'new':
      // Not a page of the app's own: a turn like any other, whose brief carries the changelog, so the brain draws what changed.
      await app.prompt("What's new in this app? Showcase it.");
      return;
    case 'status': {
      const status = await app.link.appStatus();
      const rows: string[][] = [];
      for (const [heading, items] of [['Live', status.live], ['Being built', status.building], ['Waiting on you', status.waiting]] as const) {
        for (const item of items.slice(0, 5)) rows.push([heading, item]);
        if (items.length > 5) rows.push([heading, `and ${items.length - 5} more`]);
      }
      if (rows.length === 0) {
        app.announce('There is no status to show: the steward has not written one.');
        return;
      }
      app.showPage(pageSource('Where things stand', ['Where', 'What'], rows, status.updated === null ? null : `Written ${status.updated.slice(0, 10)}.`));
      return;
    }
    case 'asks': {
      const asks = await app.link.asks(command.clear);
      if (command.clear) app.announce('Forgot what you asked to hold for every reply.');
      else if (asks.length === 0) app.announce('Nothing is held for every reply. Say "from now on …" and it will be.');
      else app.showPage(pageSource('Held for every reply', ['#', 'Your words'], asks.map((ask, index) => [String(index + 1), ask]), '/asks clear forgets them.'));
      return;
    }
    case 'look': {
      if (command.look === null) {
        app.announce(`Looks: ${LOOK_IDS.join(', ')}`);
        return;
      }
      if (app.painter.snapshot().lookLocked) {
        app.announce(`This page is locked to the ${app.painter.snapshot().look} look.`);
        return;
      }
      app.showPage(`look ${command.look}`);
      app.announce(`Look: ${command.look}`);
      return;
    }
    case 'review': {
      if (!app.review.available) {
        app.announce('This server does not check drawings.');
        return;
      }
      if (command.on !== null) app.review.set(command.on);
      app.announce(`Check the drawing: ${app.review.on ? 'on' : 'off'}`);
      return;
    }
    case 'better': {
      if (app.diagnostics().services?.refine !== true) {
        app.announce('This server cannot keep making a picture better yet.');
        return;
      }
      if (app.painter.recording() === null) {
        app.announce('There is nothing to make better yet. Ask for something first.');
        return;
      }
      await app.refine(Math.min(command.passes, REFINE_LIMITS.max));
      return;
    }
    case 'stop':
      app.interrupt();
      return;
    case 'show-all':
      if (app.status().busy) app.showAll();
      else app.announce('Nothing is being written.');
      return;
    case 'copy':
      if (command.what === 'script') await copyScript(app);
      else app.announce('Say "/copy script" to copy the answer as lines of Series. Copying the words themselves comes with the text layer.');
      return;
    case 'export':
      exportAs(app, command.format);
      return;
    case 'capture': {
      const turn = app.lastTurn();
      if (turn === null || app.painter.recording() === null) {
        app.announce('There is nothing to film yet. Ask for something first.');
        return;
      }
      const formats = await app.formats();
      if (!formats.video.includes('webm')) {
        app.announce('This browser cannot make a WebM film, which /capture needs.');
        return;
      }
      const job = app.export({ kind: 'video', format: 'webm', width: 390, height: 844, fps: 30 });
      app.announce('Filming the last answer for the steward…');
      const film = await job.done;
      await app.link.saveCapture(turn, film.blob);
      app.announce(`Filmed ${turn} for the steward.`);
      return;
    }
  }
}

function exportAs(app: StageApp, format: 'png' | 'svg' | 'film' | 'frames' | 'pdf' | 'script'): void {
  switch (format) {
    case 'png':
    case 'svg':
      saveStill(app, format);
      return;
    case 'script':
      if (app.script() === '') app.announce('There is nothing to save yet. Ask for something first.');
      else saveScript(app);
      return;
    case 'film':
      runExport(app, { kind: 'video', format: 'webm', ...defaultSize(app), fps: 30 });
      return;
    case 'frames':
      runExport(app, { kind: 'frames', ...defaultSize(app), fps: 30 });
      return;
    case 'pdf':
      app.announce('A PDF is made from slides, and slides come with decks. Save a film or the pictures for now.');
      return;
  }
}
