// Fixture documents for the bench: the lesson with no model. Each is a `Document` as WS4 keeps it (nodes with ids, parents, titles, tags, bodies
// of steps, statuses), written by hand. Case zero is the owner's own typed problem (the florist, `c3` t13 to t16); the three sheets are
// made-up worksheets in the style of the kind the owner showed (a year-two maths book), and say nothing the owner's photos said.
// The question with a crop shows a drawn stand-in, not a photograph. Nothing here is read from the learner's photos.

import { freshState } from './model';
import { isTechnique } from './types';
import type { CatalogueEntry, DocNode, DocState, DocStep, Document, NodeId, Status, Technique } from './types';

const step = (id: string, words: string, show: string | null = null): DocStep => ({ kind: 'step', id, show, words });
const ask = (id: string, prompt: string, accepted: readonly string[], o: { pick?: readonly string[]; unit?: string; hints?: readonly string[] } = {}): DocStep => ({ kind: 'ask', id, prompt, accepted, pick: o.pick ?? null, unit: o.unit ?? null, hints: o.hints ?? [] });

interface Spec {
  readonly id: NodeId;
  readonly title: string;
  readonly tag?: Technique;
  readonly steps?: readonly DocStep[];
  readonly status?: Status;
  readonly kids?: readonly Spec[];
}

/** A tree of specs into the flat `nodes` of a document, parents and children filled in. */
function build(id: string, title: string, root: Spec): Document {
  const nodes: Record<NodeId, DocNode> = {};
  const add = (spec: Spec, parent: NodeId | null): void => {
    nodes[spec.id] = {
      id: spec.id,
      parent,
      title: spec.title,
      tag: spec.tag ?? null,
      children: (spec.kids ?? []).map((k) => k.id),
      body: spec.steps === undefined ? null : { kind: 'lesson', steps: spec.steps },
      status: spec.status ?? (spec.steps === undefined ? (spec.tag === undefined && (spec.kids ?? []).length > 0 ? 'filled' : 'outlined') : 'verified'),
    };
    for (const kid of spec.kids ?? []) add(kid, spec.id);
  };
  add(root, null);
  return { id, title, root: root.id, nodes, defs: {} };
}

// ------------------------------------------------------------------ case zero: the florist

const FLORIST = 'A florist had 3 different kinds of flowers to arrange into 5 vases. If there are 6 yellow flowers, 2 blue flowers and 4 green flowers in each vase, how many flowers does she have altogether?';

export const CASE_ZERO: Document = build('case0', 'The florist', {
  id: 'w1',
  title: 'The florist and her vases',
  kids: [
    {
      id: 'q1',
      title: FLORIST,
      kids: [
        {
          id: 'q1a',
          title: 'One vase first, then five',
          tag: 'break-it-apart',
          steps: [
            step('s1', 'Look at just one vase first. Tap it to count the flowers inside.', 'groups n=5 of=12 parts=6,2,4 start=1 noun=vase thing=flower'),
            ask('a1', 'How many flowers are in one vase?', ['12'], { hints: ['Count the yellow ones, then the blue ones, then the green ones.', '6 yellow and 2 blue make 8. Now add the 4 green ones.'] }),
            step('s2', 'The florist has more vases, and every vase is the same. Tap Add another vase until there are five.', 'groups n=5 of=12 parts=6,2,4 start=1 noun=vase thing=flower'),
            step('s3', 'Now tap each vase to count it. Watch the sum grow as you go.', 'groups n=5 of=12 parts=6,2,4 start=1 noun=vase thing=flower'),
            ask('a2', 'How many flowers altogether?', ['60'], { pick: ['50', '60', '70'], hints: ['Add the twelves one at a time: 12, 24, 36, and on.', 'Tap each vase and watch the sum under the vases.'] }),
            step('s4', 'Five vases of 12 flowers is 12 + 12 + 12 + 12 + 12 = 60 flowers.'),
          ],
        },
        {
          id: 'q1b',
          title: 'Hop along in twelves',
          tag: 'count-on-a-line',
          steps: [
            step('s1', 'One vase has 12 flowers. We will hop along a number line in twelves, one hop for each vase.', 'numberline 0..60 tick=12 mark=0'),
            step('s2', 'Tap Hop on 12. Count the hops: that is the number of vases.', 'numberline 0..60 tick=12 mark=0 hops=12,12,12,12,12'),
            ask('a1', 'Where did you land after the last hop?', ['60'], { hints: ['Say each landing place as you hop: 12, 24, 36, and on.', 'You hop five times. What is the fifth place?'] }),
            step('s3', 'You landed on 60. Five hops of 12 makes 60 flowers.'),
          ],
        },
        {
          id: 'q1c',
          title: 'Make ten first',
          tag: 'make-ten',
          steps: [
            step('s1', 'In one vase: 6 yellow, 2 blue, 4 green. Tap the pieces of the bar to add them up.', 'bar parts=6,2,4'),
            ask('a1', 'How many flowers are in one vase?', ['12'], { hints: ['6 + 4 makes a ten. Then add the 2.'] }),
            step('s2', 'Each vase is one bar of 12. Tap Add another bar to line up the five vases.', 'bar of=12 n=5'),
            ask('a2', 'How many flowers altogether? Type it in.', ['60'], { hints: ['Ten five times is 50. Two five times is 10. Put them together.'] }),
          ],
        },
        { id: 'q1d', title: 'Share it out', tag: 'share-it-out', status: 'filling', steps: [step('s1', 'Pretend you pour all the flowers out and share them back between the vases.')] },
      ],
    },
  ],
});

// ------------------------------------------------------------------ sheet one: take away tens, make 100

export const SHEET_TENS: Document = build('tens', 'Sheet 1', {
  id: 'w1',
  title: 'Sheet 1',
  kids: [
    {
      id: 's1',
      title: 'Take away tens',
      kids: [
        {
          id: 'q1',
          title: '64 − 30 =',
          kids: [
            {
              id: 'q1a',
              title: 'Hop back along a number line',
              tag: 'count-on-a-line',
              steps: [
                step('s1', 'Find 64 on the line. That is where we start.', 'numberline 0..70 tick=10 mark=64'),
                step('s2', 'Thirty is three tens. Hop back ten, three times.', 'numberline 0..70 tick=10 mark=64 hops=-10,-10,-10'),
                ask('a1', 'Where did you land?', ['34'], { hints: ['Say each landing place: 54, 44, and on.', 'Three hops back from 64. The last landing place is your answer.'] }),
                step('s3', 'Taking away 30 from 64 leaves 34.'),
              ],
            },
            {
              id: 'q1b',
              title: 'Take away tens with blocks',
              tag: 'draw-it',
              steps: [
                step('s1', 'Here is 64 in blocks: 6 tens and 4 ones.', 'blocks tens=6 ones=4'),
                step('s2', 'Take away 30. How many tens is that? Tap that many tens to take them away.', 'blocks tens=6 ones=4'),
                ask('a1', 'What is left?', ['34'], { hints: ['Three tens are gone. Count the tens left, then the ones.'] }),
              ],
            },
            {
              id: 'q1c',
              title: 'Break 64 apart',
              tag: 'break-it-apart',
              steps: [
                step('s1', '64 is 60 and 4. Tap the pieces.', 'bar parts=60,4'),
                step('s2', 'Take the 30 from the 60 first, and keep the 4 aside.'),
                ask('a1', 'What do you get when you put them together again?', ['34'], { pick: ['24', '34', '94'], hints: ['60 take away 30 is 30. Now add the 4.'] }),
              ],
            },
          ],
        },
        {
          id: 'q2',
          title: '50 less than 61 =',
          kids: [
            {
              id: 'q2a',
              title: 'Blocks: take away five tens',
              tag: 'draw-it',
              steps: [
                step('s1', 'Show 61 in blocks.', 'blocks tens=6 ones=1'),
                step('s2', '50 is five tens. Tap five tens to take them away.', 'blocks tens=6 ones=1'),
                ask('a1', 'What is left?', ['11'], { hints: ['One ten and one one is left. Say it as a number.'] }),
              ],
            },
            {
              id: 'q2b',
              title: 'Hop back fifty',
              tag: 'count-on-a-line',
              steps: [
                step('s1', 'Start at 61.', 'numberline 0..70 tick=10 mark=61'),
                step('s2', 'Hop back five tens, one ten at a time.', 'numberline 0..70 tick=10 mark=61 hops=-10,-10,-10,-10,-10'),
                ask('a1', 'Where did you land?', ['11'], { hints: ['Count your hops. Where does the fifth one end?'] }),
              ],
            },
          ],
        },
        {
          id: 'q3',
          title: '100 − [ ] = 50',
          kids: [
            {
              id: 'q3a',
              title: 'Hop back along the hundreds line',
              tag: 'work-backwards',
              steps: [
                step('s1', 'We start at 100 and finish at 50. How far did we hop?', 'numberline 0..100 tick=10 mark=100'),
                step('s2', 'Hop back one ten at a time and count the hops.', 'numberline 0..100 tick=10 mark=100 hops=-10,-10,-10,-10,-10'),
                ask('a1', 'How many did you take away in all?', ['50'], { hints: ['Five hops of ten. How much is that?'] }),
              ],
            },
            { id: 'q3b', title: 'Think of two halves', tag: 'break-it-apart' },
          ],
        },
      ],
    },
    {
      id: 's2',
      title: 'Make 100',
      kids: [
        {
          id: 'q4',
          title: '60 + [ ] = 100',
          kids: [
            {
              id: 'q4a',
              title: 'Hop on to 100',
              tag: 'count-on-a-line',
              steps: [
                step('s1', 'Start at 60 and hop on in tens until you reach 100.', 'numberline 0..100 tick=10 mark=60 hops=10,10,10,10'),
                ask('a1', 'How much did you hop altogether?', ['40'], { hints: ['Count your hops of ten. How many hops did it take?'] }),
              ],
            },
          ],
        },
        { id: 'q5', title: '4 × [ ] = 100' },
      ],
    },
  ],
});

// ------------------------------------------------------------------ sheet two: money and time, a crop, a disputed answer

export const SHEET_MONEY: Document = build('money', 'Sheet 2', {
  id: 'w1',
  title: 'Sheet 2',
  kids: [
    {
      id: 's1',
      title: 'Coins',
      kids: [
        {
          id: 'q1',
          title: 'How much is 50c + 20c + 5c?',
          kids: [
            {
              id: 'q1a',
              title: 'Put the coins in the tray',
              tag: 'draw-it',
              steps: [
                step('s1', 'Here are some coins. Tap the 50c, the 20c and the 5c to put them in the tray.', 'coins 50,20,5,10,20'),
                ask('a1', 'How much is in the tray?', ['75c', '75', '$0.75'], { unit: 'c', hints: ['Start with the biggest coin, 50. Then add 20. Then add 5.'] }),
              ],
            },
            {
              id: 'q1b',
              title: 'Add the pieces',
              tag: 'break-it-apart',
              steps: [
                step('s1', 'Tap each piece of the bar to add it in.', 'bar parts=50,20,5'),
                ask('a1', 'How many cents altogether?', ['75'], { unit: 'c', hints: ['50 and 20 make 70. Then 5 more.'] }),
              ],
            },
          ],
        },
      ],
    },
    {
      id: 's2',
      title: 'Time',
      kids: [
        {
          id: 'q2',
          title: 'What time is it when the short hand points at 3 and the long hand at 6?',
          kids: [
            {
              id: 'q2a',
              title: 'Set the clock yourself',
              tag: 'draw-it',
              steps: [
                step('s1', 'The short hand is the hour hand. It points at 3. Tap the 6 on the clock to point the long hand at it.', 'clock 3:00'),
                ask('a1', 'What time does the clock say? Write it like 4:15.', ['3:30', 'half past 3', 'half past three', 'three thirty'], { hints: ['The long hand on the 6 means thirty minutes past.'] }),
              ],
            },
          ],
        },
        {
          id: 'q3',
          title: 'Put these in order from smallest to biggest: 117, 197, 101, 152',
          kids: [
            {
              id: 'q3a',
              title: 'Find each number on a line',
              tag: 'count-on-a-line',
              status: 'refused',
              steps: [
                step('s1', 'Here is a line from 100 to 200. Put each number where it belongs.', 'numberline 100..200 tick=10'),
                ask('a1', 'Which number is the smallest?', ['101']),
                step('s2', 'The smallest is the one nearest the start of the line.'),
              ],
            },
          ],
        },
        { id: 'q4', title: 'Count the cubes in tower A and tower B. How many more does A have?' },
      ],
    },
  ],
});

/** A drawn stand-in for a question's crop of its photo (never a photograph): a plain box with a line for each row of the question. */
export function standInCrop(dark: boolean): string {
  const ink = dark ? '#d8d3c6' : '#2a2f3d';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="150" viewBox="0 0 360 150"><rect width="360" height="150" rx="10" fill="${dark ? '#222a3a' : '#fffdf6'}"/><text x="14" y="38" font-family="Georgia,serif" font-size="22" fill="${ink}">21. Put these in order:</text><text x="34" y="78" font-family="Georgia,serif" font-size="22" fill="${ink}">117, 197, 101, 152</text><path d="M30 118 H110 M130 118 H210 M230 118 H310" stroke="${ink}" stroke-width="2"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const FIXTURES: Readonly<Record<string, Document>> = { case0: CASE_ZERO, tens: SHEET_TENS, money: SHEET_MONEY };

export function fixtureState(doc: Document): DocState {
  return freshState(doc);
}

/** The catalogue as the server's index would give it, read from the documents' own outlines (WS4's `DocumentSummary` is what the page really gets). */
export function catalogueFrom(docs: readonly Document[], states: Readonly<Record<string, DocState>>, current: string): readonly CatalogueEntry[] {
  return docs.map((doc, i) => {
    const questions = Object.values(doc.nodes)
      .filter((n) => n.tag === null && n.children.length > 0 && n.children.every((c) => doc.nodes[c]?.tag !== null && doc.nodes[c]?.tag !== undefined))
      .map((n) => ({
        id: n.id,
        title: n.title,
        done: states[doc.id]?.progress[n.id]?.done === true,
        techniques: n.children.flatMap((c) => {
          const tag = doc.nodes[c]?.tag ?? null;
          return isTechnique(tag) ? [tag] : [];
        }),
      }));
    return { id: doc.id, title: doc.title, updated: 1_000_000 - i, current: doc.id === current, questions };
  });
}
