import type { StageApp } from '../app/stage-app';

export interface Hud {
  dispose(): void;
}

const POLL_MS = 200;

function fixed(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

function row(label: string, value: string, tone: '' | 'warn' | 'bad' | 'ok' = ''): HTMLElement {
  const element = document.createElement('div');
  element.className = 'hud__row';
  const name = document.createElement('span');
  name.className = 'hud__label';
  name.textContent = label;
  const text = document.createElement('span');
  text.className = tone === '' ? 'hud__value' : `hud__value hud__value--${tone}`;
  text.textContent = value;
  element.append(name, text);
  return element;
}

function heading(text: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'hud__heading';
  element.textContent = text;
  return element;
}

function item(text: string, tone: '' | 'warn' | 'bad' = ''): HTMLElement {
  const element = document.createElement('div');
  element.className = tone === '' ? 'hud__item' : `hud__item hud__item--${tone}`;
  element.textContent = text;
  return element;
}

/**
 * The debug overlay behind ?debug=1: playhead, pen, lead and clock state
 * (including `hidden`), look, renderer, quality and fps, the recent lines
 * with their scheduled times and issues, rejected lines, and the recent
 * back-channel events. Read-only; it polls the painter's snapshot.
 */
export function mountHud(host: HTMLElement, app: StageApp): Hud {
  const root = document.createElement('aside');
  root.className = 'hud';
  root.setAttribute('aria-label', 'Debug');
  host.append(root);

  const render = (): void => {
    const snap = app.painter.snapshot();
    const diag = app.diagnostics();
    const children: HTMLElement[] = [];

    const clockTone = snap.hidden || snap.clock === 'hidden' ? 'bad' : snap.clock === 'holding' ? 'warn' : '';
    const lead = diag.lead;
    let leadTone: '' | 'warn' | 'bad' | 'ok' = '';
    if (snap.turn !== null && lead !== null) {
      leadTone = snap.lead < lead.low ? 'warn' : snap.lead > lead.high ? 'warn' : 'ok';
    }
    children.push(
      row('turn', snap.turn ?? '-'),
      row('clock', snap.hidden ? `${snap.clock} (tab hidden)` : snap.clock.toUpperCase(), clockTone),
      row('playhead', `${fixed(snap.playhead)} s`),
      row('pen', `${fixed(snap.pen)} s`),
      row('end', `${fixed(snap.end)} s`),
      row('lead', `${fixed(snap.lead)} s${lead === null ? '' : ` (window ${lead.low} to ${lead.high})`}`, leadTone),
      row('look', `${snap.look}${snap.lookLocked ? ' (locked)' : ''}`),
      row('scene', `${snap.scene.id} ${snap.scene.layout} ${snap.scene.mood} ${snap.scene.pace}`),
      row('renderer', snap.renderer),
      row('quality', snap.quality, snap.quality === 'lite' ? 'warn' : ''),
      row('fps', fixed(snap.fps, 0)),
      row('motion', snap.reducedMotion ? 'reduced' : 'full'),
      row('viewport', `${snap.viewport.width}x${snap.viewport.height} @${snap.viewport.dpr}`),
      row('screen', `${snap.screen.cols} cols, ${snap.screen.rows} rows`),
      row('link', diag.linkStatus, diag.linkStatus === 'open' ? 'ok' : 'bad'),
      row('services', diag.services === null ? 'not heard yet' : `paint ${diag.services.paint ? 'on' : 'off'}, look and fix ${diag.services.review ? (app.review.on ? 'on' : 'switched off') : 'off'}`),
      row('pass', snap.pass === null ? '-' : `${snap.pass.pass} ${snap.pass.state}`),
      row('heard', snap.anticipating ? 'ANTICIPATING (waiting for the turn to open)' : 'no', snap.anticipating ? 'warn' : ''),
      row('show all', snap.showingAll ? 'ON: later lines land settled' : 'off', snap.showingAll ? 'warn' : ''),
    );
    const pictures = snap.elements.filter((element) => element.kind === 'picture');
    for (const picture of pictures.slice(0, 6)) {
      children.push(row('painting', `${picture.id}: ${picture.painting ?? '-'}`, picture.painting === 'unpainted' ? 'warn' : ''));
    }
    for (const control of snap.controls.slice(0, 8)) {
      children.push(row('control', `${control.id} (${control.control}) = ${control.valueText}${control.enabled ? '' : ' [disabled]'}${control.bound ? ' [bound]' : ''}`));
    }
    for (const chart of snap.charts.slice(0, 4)) {
      const probe = app.charts?.probe(chart.key) ?? null;
      children.push(row('chart', `${chart.id} ${chart.kind}, ${chart.points} points${chart.waiting ? ', waiting' : ''}${probe === null ? '' : `, ${probe.frameMs.median.toFixed(1)} ms median`}`));
    }
    if (snap.glyphStall) children.push(item('renderer is not drawing text', 'bad'));
    if (snap.fault !== null) children.push(item(`painter fault: ${snap.fault}`, 'bad'));
    if (diag.dropped > 0) children.push(row('dropped', `${diag.dropped} back events`, 'bad'));
    for (const note of diag.notes.slice(-3)) children.push(item(note, 'warn'));

    children.push(heading(`lines (${snap.lines.length})`));
    for (const line of snap.lines.slice(-10)) {
      const issues = line.issues.length > 0 ? `  [${line.issues.map((issue) => `${issue.severity}: ${issue.message}`).join('; ')}]` : '';
      const tone = line.issues.some((issue) => issue.severity === 'error') ? 'bad' : line.issues.length > 0 ? 'warn' : '';
      children.push(item(`${line.seq} ${fixed(line.start)}-${fixed(line.end)}  ${line.text}${issues}`, tone));
    }

    children.push(heading('last sight'));
    if (diag.sight === null) {
      children.push(item('no report yet'));
    } else {
      const noted = diag.sight.items.filter((entry) => entry.notes.length > 0);
      children.push(item(`${diag.sight.canvas} canvas, ${Math.round(diag.sight.coverage * 100)}% of the screen, ${diag.sight.items.length} things${diag.sight.snapshot ? ', with a snapshot' : ''}`));
      for (const entry of noted.slice(0, 6)) children.push(item(`${entry.id} (${entry.kind}): ${entry.notes.join(', ')}`, 'warn'));
    }

    children.push(heading(`rejects (${diag.rejects.length})`));
    for (const reject of diag.rejects.slice(-5)) {
      children.push(item(`${reject.raw}  [${reject.issues.map((issue) => issue.message).join('; ')}]`, 'bad'));
    }

    const events = app.hook.events();
    children.push(heading('back channel'));
    for (const event of events.slice(-8)) {
      let detail = '';
      if (event.type === 'progress') detail = `${event.clock} ph ${fixed(event.playhead, 1)} pen ${fixed(event.pen, 1)} +${event.shown.length}/-${event.gone.length}`;
      else if (event.type === 'tap') detail = `${event.id} ${event.choice ? 'choice' : ''} "${event.text}"`;
      else if (event.type === 'report') detail = `${event.report.turn} ${event.report.outcome} shown ${event.report.shown.length}`;
      else if (event.type === 'started') detail = event.turn;
      else if (event.type === 'control') detail = `${event.id} = ${event.text}${event.send ? ' (sent)' : ''}`;
      else if (event.type === 'draft') detail = `${event.turn} pass ${event.pass}, ${event.sight.items.length} things${event.snapshot ? ', picture' : ''}`;
      else if (event.type === 'permit') detail = `${event.request} ${event.allow ? 'allowed' : 'denied'}`;
      else if (event.type === 'state') detail = event.change.kind;
      else if (event.type === 'observe') detail = event.items.map((one) => one.kind).join(', ');
      else if (event.type === 'presence') detail = `${event.typing ? 'typing' : 'not typing'}, repair ${event.repair ? 'on' : 'off'}`;
      else detail = `${event.look} ${event.screen.cols}x${event.screen.rows}`;
      children.push(item(`${event.type} ${detail}`));
    }

    root.replaceChildren(...children);
  };

  render();
  const timer = setInterval(render, POLL_MS);

  return {
    dispose() {
      clearInterval(timer);
      root.remove();
    },
  };
}
