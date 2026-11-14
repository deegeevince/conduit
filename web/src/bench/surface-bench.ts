// The hostile bench: runs one hostile fixture (web/src/surfaces/hostile.ts) in a surface host on a bare page, and says what the host saw.
// Driven by web/scripts/surface-hostile.mjs, which also listens on the address the fixtures reach for.

import type { AppShelf } from '@conduit/language';
import type { AppTokens } from '../contracts/app';
import type { SurfaceEmit, SurfaceProbe } from '../contracts/surface';
import { HOSTILE } from '../surfaces/hostile';
import { createSurfaceHost } from '../surfaces/host';

const TOKENS: AppTokens = { ground: '#f4efe4', ink: '#1c1a17', dim: '#5d5a53', accent: '#c1401f', onAccent: '#ffffff', alt: '#2a6f6a', line: '#d9d2c3', good: '#2c7a43', bad: '#b3261e', font: 'Georgia, serif', fontPx: 16, radius: 8, gap: 12, dark: false };

export interface BenchResult {
  readonly name: string;
  readonly events: readonly SurfaceEmit[];
  readonly notes: readonly string[];
  readonly probe: SurfaceProbe | null;
  /** how many iframes are in the page when it is over */
  readonly frames: number;
  /** the document's own address, to show the page was never navigated */
  readonly href: string;
}

async function run(name: string, depth: boolean, settleMs: number, program?: string, uses?: readonly AppShelf[], room?: { readonly width: number; readonly height: number }): Promise<BenchResult> {
  const stage = document.getElementById('stage') as HTMLElement;
  const fixture = HOSTILE.find((candidate) => candidate.name === name);
  const source = program ?? fixture?.source;
  if (source === undefined) throw new Error(`no fixture called ${name}`);
  const events: SurfaceEmit[] = [];
  const notes: string[] = [];
  const host = createSurfaceHost({ stage, onEmit: (emit) => events.push(emit), onNote: (text) => notes.push(text), ...(depth ? {} : { withoutDepth: true }) });
  const box = { x: 20, y: 20, width: room?.width ?? 640, height: room?.height ?? 400 };
  const spec = { key: `${name}@1`, id: name, title: name, source, ...(uses === undefined ? {} : { uses }), ready: true, box, rest: box, opacity: 1, z: 1, tokens: TOKENS };
  host.sync([spec]);
  // the page's own frame loop: a host is told every frame
  const until = performance.now() + settleMs;
  while (performance.now() < until) {
    host.sync([spec]);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const probe = host.probe().find((entry) => entry.key === spec.key) ?? null;
  const frames = document.querySelectorAll('iframe').length;
  host.dispose();
  return { name, events, notes, probe, frames, href: location.href };
}

declare global {
  interface Window {
    __surfaceBench: { run: typeof run; fixtures: readonly { name: string; policyOnly: boolean }[]; must: (name: string) => unknown };
  }
}
window.__surfaceBench = { run, fixtures: HOSTILE.map((fixture) => ({ name: fixture.name, policyOnly: fixture.policyOnly === true })), must: (name) => HOSTILE.find((fixture) => fixture.name === name)?.must ?? null };
