// The wall's nodes, from turns: the source before the document's own merge (PLAN-wall section 8, WL3). Pure and DOM-free; the same list
// is made on the page (from SH1's `ConversationTurn`s) and on the server (from the folded log), so both plan the same wall.
//
// The rule, from the plan's table:
//   - a turn that writes no `scene` makes no node: it changes the frame in focus in place;
//   - a prompt, demo or script turn that writes `scene` opens a node in a new lane (a new subject), unless `scene in=<node>` names one;
//   - a tap, act or refine turn that writes `scene`, and a second `scene` in one turn, is the next slot of the lane of the node before, `from` it;
//   - `scene <id of a scene that exists>` reopens that node: no new node.
// Nothing here is a coordinate.

import type { WallNode } from '../engine/wall';
import type { AnswerTurn } from '../shell/model';

/** A turn as the wall needs it: `AnswerTurn` and the words the person said (`ConversationTurn` satisfies this). */
export interface WallTurn extends AnswerTurn {
  readonly said: string;
}

const SCENE = /^\s*scene(?:\s+(.*))?$/;
const TITLE_CHARS = 60;

function titleOf(text: string, fallback: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one === '') return fallback;
  return one.length > TITLE_CHARS ? `${one.slice(0, TITLE_CHARS - 1).trimEnd()}…` : one;
}

interface SceneWords {
  /** the bare word that names a scene, if any */
  readonly id: string | null;
  readonly in: string | null;
}

function wordsOf(rest: string): SceneWords {
  let id: string | null = null;
  let into: string | null = null;
  for (const token of rest.trim().split(/\s+/)) {
    if (token === '' || token === '|') break;
    const eq = token.indexOf('=');
    if (eq < 0) {
      if (id === null && !token.includes('|')) id = token;
    } else if (token.slice(0, eq) === 'in') into = token.slice(eq + 1);
  }
  return { id, in: into };
}

export function wallNodesOfTurns(turns: readonly WallTurn[]): readonly WallNode[] {
  const nodes: WallNode[] = [];
  /** a node id to the node (a layout word such as `page` or `caption` is not a name: only an id that exists reopens a frame) */
  const byName = new Map<string, WallNode>();
  for (const turn of turns) {
    let inTurn = 0;
    for (const line of turn.lines) {
      const match = SCENE.exec(line);
      if (match === null) continue;
      const words = wordsOf(match[1] ?? '');
      // reopening an earlier frame: it is already on the wall
      if (words.id !== null && words.in === null && byName.has(words.id)) {
        inTurn += 1;
        continue;
      }
      const into = words.in !== null ? byName.get(words.in) : undefined;
      const before = nodes[nodes.length - 1];
      let lane: string | null;
      let from: string | null;
      if (into !== undefined) {
        lane = into.lane ?? into.id;
        from = into.id;
      } else if (before !== undefined && (inTurn > 0 || !(turn.kind === 'prompt' || turn.kind === 'demo' || turn.kind === 'script'))) {
        lane = before.lane ?? before.id;
        from = before.id;
      } else {
        lane = null;
        from = null;
      }
      const id = nodes.some((node) => node.id === turn.turn) ? `${turn.turn}.${inTurn + 1}` : turn.turn;
      const node: WallNode = { id, lane, from, seq: nodes.length + 1, title: titleOf(turn.said, id) };
      nodes.push(node);
      byName.set(id, node);
      inTurn += 1;
    }
  }
  return nodes;
}
