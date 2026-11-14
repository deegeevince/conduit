// Fixture documents for the bench: the lesson with no model. Each is written in the lesson lines of PLAN-v3-core 2.10 and read by WS3's
// `foldSource`, so the bench plays what the brain will write and the reader checks it first (a spoiler is refused here as it will be
// on the wire). Case zero is the owner's own typed problem (`c3`, t13 to t16: the florist and her vases); the three sheets are made-up
// worksheets in the manner of a year-two maths book, and say nothing the owner's photos said. The question with a crop shows a drawn
// stand-in, never a photograph. Nothing here is read from the learner's photos.

import { findNode, foldSource } from '@conduit/language';
import type { DocNode, NodeStatus } from '@conduit/language';
import { isTechnique } from './types';
import type { CatalogueEntry, DocState, Document, NodeId } from './types';

const CASE_ZERO = `
part w1 | The florist and her vases
part q1 in=w1 | A florist had 3 different kinds of flowers to arrange into 5 vases. If there are 6 yellow flowers, 2 blue flowers and 4 green flowers in each vase, how many flowers does she have altogether?
ask a0 in=q1 is=60 | Work it out and write your answer.
hint in=a0 | Start with one vase. How many flowers are in it?
hint in=a0 | Every vase is the same. Add one vase at a time.
part q1a in=q1 tag=break-it-apart | One vase first, then five
step in=q1a show=groups count=1 parts=6,2,4 label=flowers | Look at just one vase first. Tap it to count the flowers inside.
ask a1 in=q1a is=12 | How many flowers are in one vase?
hint in=a1 | Count the yellow ones, then the blue ones, then the green ones.
hint in=a1 | 6 yellow and 2 blue make 8. Now add the 4 green ones.
step in=q1a show=groups count=5 each=12 label=flowers | Now the florist has five vases, and every vase is the same. Tap each vase to count it, and watch the sum grow.
step in=q1a | Add the twelves one at a time as you tap. Then go back and write what you found.
part q1b in=q1 tag=count-on-a-line | Hop along in twelves
step in=q1b show=numberline 0..60 step=12 mark=0 | One vase has 12 flowers. We hop along a number line in twelves, one hop for each vase.
step in=q1b show=numberline 0..60 step=12 mark=0 hops=12,12,12,12,12 | Tap Hop on 12 and count the hops. That is the number of vases.
ask b1 in=q1b is=24 | Where are you after two hops?
hint in=b1 | One hop is 12. Two hops is 12 and 12 again.
step in=q1b | Keep hopping to the end of the line. Where you land is how many flowers there are. Go back and write it.
part q1c in=q1 tag=make-ten | Make ten first
step in=q1c show=bar parts=6,2,4 | In one vase: 6 yellow, 2 blue, 4 green. Tap the pieces of the bar to add them up.
step in=q1c show=bar parts=12,12,12,12,12 | Now one bar for each vase, five bars the same.
step in=q1c | Ten five times is 50. Two five times is 10. Put them together, then go back and write it.
part q1d in=q1 tag=share-it-out | Share it out
step in=q1d show=groups count=5 each=12 label=flowers | Pretend you pour all the flowers out and share them back between the vases.
`;

const SHEET_TENS = `
part w1 | Sheet 1
part s1 in=w1 | Take away tens
part q1 in=s1 | 1. 64 − 30 =
ask a0 in=q1 is=34 | Write your answer.
hint in=a0 | Thirty is three tens. Take three tens away.
hint in=a0 | Start at 64 and count back ten, three times.
part q1a in=q1 tag=count-on-a-line | Hop back along a number line
step in=q1a show=numberline 0..70 step=10 mark=64 | Find 64 on the line. That is where we start.
step in=q1a show=numberline 0..70 step=10 mark=64 hops=-10,-10,-10 | Thirty is three tens. Hop back ten, three times.
ask a1 in=q1a is=54 | Where are you after one hop?
hint in=a1 | One hop back is ten less than where you started.
step in=q1a | Keep hopping. Where you land is your answer. Now go back and write it.
part q1b in=q1 tag=draw-it | Take away tens with blocks
step in=q1b show=blocks tens=6 ones=4 | Here is 64 in blocks: 6 tens and 4 ones.
step in=q1b show=blocks tens=6 ones=4 take=30 | Take away 30. How many tens is that? Tap that many tens to take them away.
step in=q1b | Count what is left, the tens and then the ones. Now go back and write it.
part q1c in=q1 tag=break-it-apart | Break 64 apart
step in=q1c show=bar parts=60,4 | 64 is 60 and 4. Tap the pieces.
step in=q1c | Take the 30 from the 60 first, and keep the 4 aside. Then put them together again.
part q2 in=s1 | 2. 50 less than 61 =
ask a0 in=q2 is=11 | Write your answer.
hint in=a0 | Fifty is five tens.
part q2a in=q2 tag=draw-it | Blocks: take away five tens
step in=q2a show=blocks tens=6 ones=1 | Show 61 in blocks.
step in=q2a show=blocks tens=6 ones=1 | 50 is five tens. Tap five tens to take them away. Then say what is left.
part q2b in=q2 tag=count-on-a-line | Hop back fifty
step in=q2b show=numberline 0..70 step=10 mark=61 | Start at 61.
step in=q2b show=numberline 0..70 step=10 mark=61 hops=-10,-10,-10,-10,-10 | Hop back five tens, one ten at a time. Where do you land?
part q3 in=s1 | 3. 100 − [ ] = 50
ask a0 in=q3 is=50 | Write the missing number.
hint in=a0 | How far is it from 100 down to 50?
part q3a in=q3 tag=work-backwards | Hop back along the hundreds line
step in=q3a show=numberline 0..100 step=10 mark=100 | We start at 100 and finish at 50. How far did we hop?
step in=q3a show=numberline 0..100 step=10 mark=100 hops=-10,-10,-10,-10,-10 | Hop back one ten at a time and count the hops.
part q3b in=q3 tag=break-it-apart | Think of two halves
part s2 in=w1 | Make 100
part q4 in=s2 | 4. 60 + [ ] = 100
ask a0 in=q4 is=40 | Write the missing number.
hint in=a0 | Count on in tens from 60 to 100.
part q4a in=q4 tag=count-on-a-line | Hop on to 100
step in=q4a show=numberline 0..100 step=10 mark=60 hops=10,10,10,10 | Start at 60 and hop on in tens until you reach 100. How many hops did it take?
part q5 in=s2 | 5. 4 × [ ] = 100
`;

const SHEET_MONEY = `
part w1 | Sheet 2
part s1 in=w1 | Coins
part q1 in=s1 | 1. How much is 50c + 20c + 5c?
ask a0 in=q1 is=75c,75,$0.75 unit=c | Write your answer.
hint in=a0 | Start with the biggest coin.
part q1a in=q1 tag=draw-it | Put the coins in the tray
step in=q1a show=coins coins=50,20,5,10,20 | Here are some coins. Tap the 50c, the 20c and the 5c to put them in the tray, and look at what the tray says.
part q1b in=q1 tag=break-it-apart | Add the pieces
step in=q1b show=bar parts=50,20,5 | Tap each piece of the bar to add it in.
part s2 in=w1 | Time
part q2 in=s2 | 2. What time is it when the short hand points at 3 and the long hand at 6?
ask a0 in=q2 is=3:30,half_past_3,half_past_three,three_thirty | Write the time, like 4:15.
hint in=a0 | The long hand on the 6 means thirty minutes past.
part q2a in=q2 tag=draw-it | Set the clock yourself
step in=q2a show=clock time=3:00 | The short hand is the hour hand. It points at 3. Tap the 6 on the clock to point the long hand at it, and read what the clock says.
part q3 in=s2 | 3. Put these in order from smallest to biggest: 117, 197, 101, 152
ask a0 in=q3 is=101_117_152_197 | Write the numbers in order.
part q3a in=q3 tag=count-on-a-line | Find each number on a line
step in=q3a show=numberline 100..200 step=10 | Here is a line from 100 to 200. Put each number where it belongs.
step in=q3a | The smallest is the one nearest the start of the line.
part q4 in=s2 | 4. Count the cubes in tower A and tower B. How many more does A have?
`;

// a document that is not homework, drawn by the same view: three parts to step through, a question in the middle, a branch at the end
const EXPLAINER = `
part w1 | How saving up works
part p1 in=w1 | One coin to begin
step in=p1 show=coins coins=20,10,5 | You start with a few coins in a jar. Tap them into the tray to see what you have.
step in=p1 | Every coin counts, even the small ones.
part p2 in=w1 | A little each week
step in=p2 show=numberline 0..50 step=10 mark=0 | Say you add ten each week. We hop along a line to see it grow.
step in=p2 show=numberline 0..50 step=10 mark=0 hops=10,10,10,10,10 | Tap Hop on 10 once for each week.
ask g1 in=p2 is=30 | Before you hop all the way: what will you have after three weeks?
hint in=g1 | Three weeks of ten, one after another.
step in=p2 | Slow and steady adds up.
part p3 in=w1 | Where you end up
step in=p3 show=bar parts=10,10,10,10,10 | Five weeks, five bars the same size. Tap the bars to put them together.
step in=p3 | Small amounts, saved often, make a big one.
part p3a in=p3 tag=count-on-a-line | See it as a line
step in=p3a show=numberline 0..50 step=10 mark=0 hops=10,10,10,10,10 | The same five weeks, hopped along a line.
part p3b in=p3 tag=draw-it | See it as stacks
step in=p3b show=blocks tens=5 ones=0 | The same five weeks, as five stacks of ten.
`;

function fold(source: string, id: string, status: Readonly<Record<string, NodeStatus>> = {}): Document {
  const folded = foldSource(source, 'prompt');
  for (const found of folded.issues) console.error(`fixture ${id}: ${found.issue.message} (${found.text.slice(0, 80)})`);
  const doc = folded.document;
  const nodes: Record<NodeId, DocNode> = { ...doc.nodes };
  for (const [short, st] of Object.entries(status)) {
    const node = findNode(doc, short);
    if (node !== null) nodes[node.id] = { ...node, status: st };
  }
  return { ...doc, id, nodes };
}

export const CASE_ZERO_DOC: Document = fold(CASE_ZERO, 'case0', { q1d: 'filling' });
export const SHEET_TENS_DOC: Document = fold(SHEET_TENS, 'tens');
export const SHEET_MONEY_DOC: Document = fold(SHEET_MONEY, 'money', { q3: 'refused' });
export const EXPLAINER_DOC: Document = fold(EXPLAINER, 'explain');
export const FIXTURES: Readonly<Record<string, Document>> = { case0: CASE_ZERO_DOC, tens: SHEET_TENS_DOC, money: SHEET_MONEY_DOC, explain: EXPLAINER_DOC };

/** A drawn stand-in for a question's crop of its photo (never a photograph): a plain box with a line for each row of the question. */
export function standInCrop(dark: boolean): string {
  const ink = dark ? '#d8d3c6' : '#2a2f3d';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="150" viewBox="0 0 360 150"><rect width="360" height="150" rx="10" fill="${dark ? '#222a3a' : '#fffdf6'}"/><text x="14" y="38" font-family="Georgia,serif" font-size="22" fill="${ink}">21. Put these in order:</text><text x="34" y="78" font-family="Georgia,serif" font-size="22" fill="${ink}">117, 197, 101, 152</text><path d="M30 118 H110 M130 118 H210 M230 118 H310" stroke="${ink}" stroke-width="2"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The catalogue as the server's index would give it, read from the documents' own outlines (WS4's `DocumentSummary` is what the page really gets). */
export function catalogueFrom(docs: readonly Document[], states: Readonly<Record<string, DocState>>, current: string): readonly CatalogueEntry[] {
  return docs.map((doc, i) => {
    const questions = Object.values(doc.nodes)
      .filter((n) => n.tag === null && n.children.length > 0 && n.children.some((c) => isTechnique(doc.nodes[c]?.tag ?? null)))
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
