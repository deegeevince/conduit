// What can be counted about an answer, from the lines it was written in and the schedule they add up to.
import { isInFlow } from '@conduit/language';
import type { ElementSpan, ExploreChecks, ExploreExpectation, ElementKind, Issue, Line, Schedule } from '@conduit/language';

const ABOUT_THE_MEDIUM: readonly RegExp[] = [
  /\bstage\b/i,
  /\bcanvas\b/i,
  /\bmedium\b/i,
  /\bi can (draw|show|animate|paint)\b/i,
  /\blet me (draw|show)\b/i,
  /\bhere is a (drawing|sketch|picture)\b/i,
  /\bwatch (this|me)\b/i,
  /\bthis is not a chat\b/i,
  // "I can make pixels, tell stories, and explain things." is the answer talking about itself, not answering.
  /\bi can (?:make|draw|show|animate|paint|tell|explain|do|help|create|build|perform|turn|bring)\b/i,
  /\bi(?:'m| am) (?:a |an )?(?:stage|painter|language model|assistant)\b/i,
  /\b(?:this|the) (?:stage|screen|canvas) (?:can|is|shows|will)\b/i,
  /\bwhat (?:else )?(?:i|this) can do\b/i,
];

const LARGE_SIZES: ReadonlySet<string> = new Set(['l', 'xl', 'xxl']);

/** An exact value the brain should have left to the painter: a time (`@N`, `dur=`, `stay=Ns`) or a length of travel (`over=` on `cam`, `move`, `set`). */
function isHandLevel(line: Line): boolean {
  if (line.verb === 'row' || line.verb === 'frame') return false;
  if ('when' in line && line.when?.kind === 'at') return true;
  if ((line.verb === 'cam' || line.verb === 'move' || line.verb === 'set') && line.over !== undefined) return true;
  if ('props' in line && line.verb !== 'look') {
    if (line.props.dur !== undefined) return true;
    const stay = line.props.stay;
    if (stay !== undefined && typeof stay === 'object') return true;
  }
  return false;
}

function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function wordsIn(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

function countByKind(elements: readonly ElementSpan[]): Partial<Record<ElementKind, number>> {
  const kinds: Partial<Record<ElementKind, number>> = {};
  for (const element of elements) kinds[element.kind] = (kinds[element.kind] ?? 0) + 1;
  return kinds;
}

function meets(expects: ExploreExpectation, elements: readonly ElementSpan[], schedule: Schedule): boolean {
  const shapes = elements.filter((element) => element.kind === 'shape');
  const drawn = elements.some((element) => element.kind !== 'text');
  switch (expects) {
    case 'any':
      return true;
    case 'plain': {
      const scenes = schedule.scenes.filter((scene) => scene.seq !== 0);
      return scenes.length > 0 && scenes.every((scene) => scene.layout === 'page') && !drawn;
    }
    case 'drawn':
      return shapes.length >= 4;
    // The full checks for these two (the structure the prompt has in mind was the one named; a control drives something) are package H's.
    case 'structure':
      return elements.some((element) => element.kind === 'structure');
    case 'chart':
      return elements.some((element) => element.figure?.kind === 'structure' && element.figure.structure === 'chart' && (element.figure.rows.length >= 3 || element.figure.data !== null));
    case 'explorable':
      return elements.some((element) => element.kind === 'control' && element.figure?.kind === 'control' && element.figure.control !== 'button');
    case 'pixels':
      return elements.some((element) => element.figure?.kind === 'sprite' && (element.figure.sprite.frames[0]?.length ?? 0) >= 4);
    case 'scene': {
      const layers = new Set(shapes.map((shape) => shape.style.layer).filter((layer) => layer !== 'mid'));
      return layers.size >= 2 && schedule.camera.length >= 1;
    }
    case 'type':
      return shapes.length === 0 && elements.some((element) => element.kind === 'text' && LARGE_SIZES.has(element.style.size));
    case 'motion':
      return elements.some(
        (element) =>
          element.changes.some((change) => change.kind === 'move' || change.kind === 'morph') ||
          element.style.loop !== 'none' ||
          (element.figure?.kind === 'sprite' && element.figure.sprite.frames.length >= 2),
      );
  }
}

/** Median of in-flow text lines per scene, over scenes that are not `page`. */
function inFlowMedianOf(elements: readonly ElementSpan[], schedule: Schedule): number | null {
  const counts: number[] = [];
  for (const scene of schedule.scenes) {
    if (scene.seq === 0 || scene.layout === 'page') continue;
    counts.push(elements.filter((element) => element.scene === scene.id && isInFlow(element.style, scene.layout, element.kind)).length);
  }
  if (counts.length === 0) return null;
  counts.sort((a, b) => a - b);
  const middle = Math.floor(counts.length / 2);
  return counts.length % 2 === 1 ? (counts[middle] ?? 0) : ((counts[middle - 1] ?? 0) + (counts[middle] ?? 0)) / 2;
}

export function checksOf(
  accepted: readonly Line[],
  rejects: number,
  lines: readonly { readonly issues: readonly Issue[] }[],
  schedule: Schedule,
  expects: ExploreExpectation,
): ExploreChecks {
  const elements = schedule.elements.filter((element) => !element.carried);
  const text = elements.filter((element) => element.kind === 'text');
  const countable = accepted.filter((line) => line.verb !== 'row' && line.verb !== 'frame');
  const hand = countable.filter(isHandLevel).length;
  const layers = new Set(elements.filter((element) => element.kind !== 'group').map((element) => element.style.layer).filter((layer) => layer !== 'mid'));
  return {
    lines: accepted.length,
    rejects,
    warnings: lines.reduce((sum, line) => sum + line.issues.filter((issue) => issue.severity === 'warn').length, 0),
    kinds: countByKind(elements),
    words: text.reduce((sum, element) => sum + wordsIn(element.text), 0),
    scenes: schedule.scenes.filter((scene) => scene.seq !== 0).length,
    cameraMoves: schedule.camera.length,
    depthLayers: layers.size,
    handLevel: countable.length === 0 ? 0 : round(hand / countable.length, 3),
    aboutTheMedium: text.map((element) => element.text).filter((words) => ABOUT_THE_MEDIUM.some((pattern) => pattern.test(words))),
    playSeconds: schedule.end,
    meetsExpectation: meets(expects, elements, schedule),
    opening: accepted[0]?.verb ?? null,
    shapes: elements.filter((element) => element.kind === 'shape').length,
    labels: text.filter((element) => element.style.near !== null || element.style.group !== null || element.style.at !== null).length,
    inFlowMedian: inFlowMedianOf(elements, schedule),
    spriteFrames: Math.max(0, ...elements.map((element) => (element.figure?.kind === 'sprite' ? element.figure.sprite.frames.length : 0))),
  };
}
