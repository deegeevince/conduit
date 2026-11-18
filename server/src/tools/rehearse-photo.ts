// The worksheet photo for the iPad rehearsal (`pnpm rehearse`): a printed-looking page with one word problem, a little paper texture, a small tilt and a
// bit of desk at the edges, made by headless Chrome from a page of HTML. Never a real child's worksheet: the sentence and the page are made here.
//
//   tsx rehearse-photo.ts <out.jpg>      writes the photo and <out>.spots.json (where each number sits, as a fraction of the photo)

import { writeFile } from 'node:fs/promises';
import { sleep } from './explore-browser';
import { Tab } from './smoke';

export const QUESTION = { before: 'A shop had ', a: '503', middle: ' apples. It sold ', b: '278', after: '. How many apples are left?' } as const;

export interface PhotoSpots {
  readonly width: number;
  readonly height: number;
  /** the middle of each number as a fraction of the photo's width and height */
  readonly spots: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
}

const WIDTH = 1200;
const HEIGHT = 1500;

function page(): string {
  const paper = `
    <div id="sheet">
      <div class="head"><span>Name ______________</span><span>Date ________</span></div>
      <h1>Word problems</h1>
      <p class="q">${QUESTION.before}<span id="n503">${QUESTION.a}</span>${QUESTION.middle}<span id="n278">${QUESTION.b}</span>${QUESTION.after}</p>
      <div class="working"><i></i><i></i><i></i><i></i></div>
      <p class="ans">Answer: ____________ apples</p>
    </div>`;
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#7a6650}
    body{background:radial-gradient(ellipse at 30% 20%,#8a7258 0%,#6c5842 70%,#5d4b38 100%)}
    #sheet{position:absolute;left:70px;top:90px;width:1090px;height:1380px;transform:rotate(-2.1deg);transform-origin:50% 50%;
      background:#f4f1e8;box-shadow:0 10px 28px rgba(0,0,0,.45),0 0 0 1px rgba(0,0,0,.08);font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1c1c1c;padding:90px 80px;box-sizing:border-box}
    #sheet::before{content:'';position:absolute;inset:0;background:linear-gradient(115deg,rgba(255,255,255,.35) 0%,rgba(255,255,255,0) 40%,rgba(0,0,0,.07) 100%);pointer-events:none}
    .head{display:flex;justify-content:space-between;font-size:34px;color:#444;margin-bottom:70px}
    h1{font-size:64px;margin:0 0 60px;letter-spacing:.5px}
    .q{font-size:60px;line-height:1.42;margin:0 0 70px}
    .working{margin:0 0 50px}.working i{display:block;height:82px;border-bottom:2px solid #9aa7b8}
    .ans{font-size:44px;margin:60px 0 0}
    svg.tex{position:absolute;inset:0;width:100%;height:100%;mix-blend-mode:multiply;opacity:.55;pointer-events:none}
  </style>
  ${paper}
  <svg class="tex" width="${WIDTH}" height="${HEIGHT}"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="3" seed="7"/><feColorMatrix values="0 0 0 0 .45  0 0 0 0 .42  0 0 0 0 .38  0 0 0 .55 0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>`;
}

export async function makePhoto(file: string): Promise<PhotoSpots> {
  const tab = await Tab.open(WIDTH, HEIGHT, { dpr: 1 });
  try {
    await tab.send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(page())}` });
    await sleep(900);
    const spots = await tab.eval<Record<string, { x: number; y: number }>>(`(() => { const out = {}; for (const id of ['n503', 'n278']) { const r = document.getElementById(id).getBoundingClientRect(); out[id.slice(1)] = { x: (r.left + r.width / 2) / ${WIDTH}, y: (r.top + r.height / 2) / ${HEIGHT} }; } return out; })()`);
    const shot = await tab.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 86, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 } });
    await writeFile(file, Buffer.from(shot.data, 'base64'));
    const out: PhotoSpots = { width: WIDTH, height: HEIGHT, spots };
    await writeFile(`${file}.spots.json`, JSON.stringify(out, null, 2));
    return out;
  } finally {
    await tab.close();
  }
}

if (process.argv[1] !== undefined && /rehearse-photo\.ts$/.test(process.argv[1])) {
  const out = process.argv[2];
  if (out === undefined) throw new Error('usage: tsx rehearse-photo.ts <out.jpg>');
  void makePhoto(out).then((spots) => {
    process.stdout.write(`${JSON.stringify(spots)}\n`);
    process.exit(0);
  });
}
