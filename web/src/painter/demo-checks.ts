// What a demo's drawings do on their canvas, from the schedule and the painter's own `canvasBoxOf` (where each part stands before, during and after a move, in canvas units): no
// browser. Run by `pnpm demo-checks` and by `pnpm check` (the group `fb-002`; `pnpm check --only fb-002`).
//
//   fb-002  Parts of one object moving apart: `move` lines that start within a beat of each other on top-level shapes. When two movers touch before the move and travel different
//           distances, the object comes apart: put them in a group and move the group. Three or more such moves together are said anyway.
//   fb-002, 003, 029, 032  A drawing past its canvas: every scene of every demo, and of the memory card's scripts, keeps its drawing space at the canvas it declared (the painter grows it to
//           take in what is drawn past the edge, and the picture then changes scale from scene to scene), and no top-level shape runs more than two units past it (a `rect ... full`
//           and a backdrop excepted).
//
//   fb-050  A shape said twice and then moved: a move sends the centre of the outline that is drawn to the point it names, after any morph (measured from the outline it entered with, it
//           landed as far from its point as the two centres were apart). Played as a case of its own.
//
// The scripts to read come in from the runner (language/scripts/demo-checks.ts), which can read files; this file is pure.
import { CANVAS, cutScenes, MEMORY_STEPS, playSource } from '@conduit/language';
import type { ElementSpan, SceneCut } from '@conduit/language';
import { canvasBoxOf, sceneCanvasOf } from './figures';

/** A beat on the steady pace, seconds: moves that start within this of one another are one gesture. */
const BEAT = 0.6;
/** Boxes this close (canvas units) or closer are touching. */
const TOUCH = 1;
/** Two parts of one object move together to within this (canvas units). */
const SAME_TRAVEL = 0.5;
/** A drawing may run this far past its canvas (canvas units) before it is called past it. */
const PAST = 2;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const gap = (a: Rect, b: Rect): number => Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)), Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));

function movesOf(cut: SceneCut): { readonly element: ElementSpan; readonly start: number; readonly end: number }[] {
  const out: { readonly element: ElementSpan; readonly start: number; readonly end: number }[] = [];
  for (const element of cut.elements) {
    if (element.kind !== 'shape' || element.parent !== null) continue;
    for (const change of element.changes) if (change.kind === 'move' && change.along === null && change.end > change.start) out.push({ element, start: change.start, end: change.end });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function demoChecks(demos: readonly { readonly name: string; readonly source: string }[], out: (text: string) => void): boolean {
  let ok = true;
  let scenes = 0;
  let moves = 0;
  const fail = (id: string, where: string, what: string): void => {
    ok = false;
    out(`  DEMO CHECK FAILED (${id}) ${where}: ${what}\n`);
  };

  const scripts: { readonly name: string; readonly source: string }[] = [
    ...demos,
    // the memory card plays real turns one after another; the ones that draw (they open a scene) are read here, the rest are restores that draw nothing of their own
    ...MEMORY_STEPS.map((step, index) => ({ name: `memory-step-${index + 1}`, source: step.replaceAll('{1}', 'a1') })),
  ];
  for (const script of scripts) {
    // the check's own scripts are not shows: `problem` is a fixture of old logs
    if (script.name === 'problem') continue;
    const played = playSource(script.source);
    const { schedule } = played;
    for (const cut of cutScenes(played)) {
      scenes += 1;
      const where = `${script.name}#${cut.number}`;
      const declared = CANVAS[cut.scene.canvas];
      // fb-002 (canvas): the drawing space stays the declared one
      const space = sceneCanvasOf(schedule, cut.scene);
      if (space.width !== declared.width || space.height !== declared.height) {
        fail('fb-002', where, `drawn for a bigger canvas than "${cut.scene.canvas}" (${declared.width}x${declared.height}): the painter grew the drawing space to ${Math.round(space.width)}x${Math.round(space.height)}, so the picture is smaller than it should be and changes scale from scene to scene. Draw within the canvas, or name the canvas that fits (canvas=wide)`);
      }
      // a top-level shape runs past the canvas
      const rested = Math.max(cut.scene.start, cut.leaves - 0.01);
      for (const element of cut.elements) {
        if (element.kind !== 'shape' || element.parent !== null || element.figure?.kind !== 'shape') continue;
        if (element.style.layer !== 'mid' || (element.figure.geometry.shape === 'rect' && element.figure.geometry.full)) continue;
        for (const at of [Math.max(0, element.enter?.end ?? 0), rested]) {
          const box = canvasBoxOf(element, schedule, at);
          if (box === null) continue;
          if (box.x < -PAST || box.y < -PAST || box.x + box.w > declared.width + PAST || box.y + box.h > declared.height + PAST) {
            fail('fb-002', where, `${element.id} (${Math.round(box.x)}..${Math.round(box.x + box.w)}, ${Math.round(box.y)}..${Math.round(box.y + box.h)}) runs past the ${cut.scene.canvas} canvas (${declared.width}x${declared.height}) at ${at.toFixed(1)} s`);
            break;
          }
        }
      }
      // fb-002 (parts apart): one gesture moves the parts of one object by different distances
      const all = movesOf(cut);
      moves += all.length;
      let from = 0;
      while (from < all.length) {
        let to = from + 1;
        while (to < all.length && (all[to] as (typeof all)[number]).start - (all[to - 1] as (typeof all)[number]).start <= BEAT) to += 1;
        const cluster = all.slice(from, to);
        from = to;
        if (cluster.length < 2) continue;
        const travels = cluster.map((mover) => {
          const before = canvasBoxOf(mover.element, schedule, mover.start - 0.001);
          const after = canvasBoxOf(mover.element, schedule, mover.end + 0.001);
          return before === null || after === null ? null : { mover, before, dx: after.x + after.w / 2 - (before.x + before.w / 2), dy: after.y + after.h / 2 - (before.y + before.h / 2) };
        });
        const apart: string[] = [];
        for (let a = 0; a < travels.length; a += 1) {
          for (let b = a + 1; b < travels.length; b += 1) {
            const first = travels[a];
            const second = travels[b];
            if (first === null || second === null || first === undefined || second === undefined) continue;
            if (gap(first.before, second.before) <= TOUCH && Math.hypot(first.dx - second.dx, first.dy - second.dy) > SAME_TRAVEL) {
              apart.push(`${first.mover.element.id} (${first.dx.toFixed(0)},${first.dy.toFixed(0)}) and ${second.mover.element.id} (${second.dx.toFixed(0)},${second.dy.toFixed(0)})`);
            }
          }
        }
        if (apart.length > 0) fail('fb-002', where, `parts that touch are moved by different distances in one gesture, so the object comes apart: ${apart.slice(0, 3).join('; ')}. Put them in a group and move the group`);
        else if (cluster.length >= 3) fail('fb-002', where, `${cluster.length} shapes are moved in one gesture (${cluster.map((mover) => mover.element.id).join(', ')}): put the parts of one object in a group and move the group`);
      }
    }
  }
  // fb-050: said twice (a morph), then sent to a point: its centre ends there, and at the half way point is on the way
  const morphed = playSource(['scene s figure canvas=square', 'poly a 10,10 10,30 30,30 fill=ink', 'poly a 10,10 10,30 50,30 fill=ink', 'wait 2s', 'move a 70,50 over=1s', 'wait 3s'].join('\n'));
  const shape = morphed.schedule.elements.filter((element) => element.id === 'a').at(-1);
  const landed = shape === undefined ? null : canvasBoxOf(shape, morphed.schedule, morphed.schedule.end);
  if (landed === null || Math.hypot(landed.x + landed.w / 2 - 70, landed.y + landed.h / 2 - 50) > 0.5) {
    fail('fb-050', 'a shape said twice, then moved', `it was sent to 70,50 and its centre is at ${landed === null ? 'nowhere' : `${(landed.x + landed.w / 2).toFixed(1)},${(landed.y + landed.h / 2).toFixed(1)}`}: a move measures the shape from the outline it entered with, not the one it has become`);
  }
  out(`demo checks (fb-002, fb-050): ${scenes} scenes and ${moves} moves read, ${ok ? 'every drawing stays on its canvas, no object comes apart in a move, and a morphed shape lands where it is sent' : 'see the lines above'}\n`);
  return ok;
}

