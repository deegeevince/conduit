// A maths question's place on the stage: the question itself, large and centred, with its blank. The working workspace (hints, pictures, the pen's
// blank, Check) is drawn by the page's problem view (`painter/problem/view.ts`) over the whole screen while the question is to be worked out; this is
// what the stage holds under it and what stays when the person puts the workspace away: a snapshot, an export and the critic's picture show the
// question, plainly, and never the answer.
//
// Pure, like every engine.

import { readProblem } from '@conduit/language';
import type { BlockPart, StructureInput, StructureLayout } from '../../contracts/blocks';
import { box } from './geom';
import { Env } from './kit';

export function layoutProblem(input: StructureInput): StructureLayout {
  const structure = input.structure;
  const figure = structure.figure;
  const key = structure.key;
  const room = input.room;
  const env = new Env(input, 1, 1, input.look.stroke);
  const question = figure?.kind === 'structure' ? (figure.problem?.question ?? '') : '';
  const read = readProblem(question === '' ? structure.text : question);
  const words = read.tokens.map((token) => token.text).join(' ').replace(/\s+([?.,!])/g, '$1');
  const spec = { ...env.spec, size: 'xl' as const };
  const pad = env.up(env.body * 0.8, 'x');
  const measured = input.measure(words, spec, Math.max(env.body * 6, room.width - pad * 2));
  const parts: BlockPart[] = [];
  if (words !== '') {
    parts.push({
      kind: 'text',
      owner: key,
      part: 'question',
      text: words,
      emphasis: [],
      box: box(room.x + (room.width - measured.width) / 2, room.y + (room.height - measured.height) / 2, measured.width, measured.height),
      spec,
      align: 'center',
      role: 'title',
      plate: false,
    });
  }
  return { boxes: new Map([[key, room]]), parts, routes: new Map(), notes: [], shrink: 1 };
}
