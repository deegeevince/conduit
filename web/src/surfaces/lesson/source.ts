// The lesson's document for the surface host: the kit's CSS, the lesson's CSS and the lesson program, as the one HTML source the host builds its
// frame from. The host cuts a source at 64,000 characters and cleans its markup, so this file refuses to hand over one that is changed by either:
// the program is bundled minified (scripts/lesson-program.ts) and the CSS is stripped of what it does not need.

import program from 'virtual:lesson-program';
import kit from '../kit.css?raw';
import { SURFACE_SOURCE_MAX, cleanMarkup } from '../document';
import lessonCss from './lesson.css?raw';

function squeeze(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/ ?([{};,]) ?/g, '$1')
    .replace(/: /g, ':')
    .trim();
}

/** The boot line: the program is packed (gzip, base64), and unpacked here into a script element the frame's policy lets run (inline script is allowed). */
function unpack(packed: string): string {
  return `(async()=>{try{const b=atob("${packed}"),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);const t=await new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream("gzip"))).text(),s=document.createElement("script");s.textContent=t;document.head.append(s)}catch(e){window.conduit&&window.conduit.send("unpack",String(e).slice(0,200));document.getElementById("root").textContent="This lesson needs a newer browser."}})()`;
}

export interface LessonSource {
  readonly source: string;
  /** why it cannot run, or null */
  readonly problem: string | null;
}

let made: LessonSource | null = null;

export function lessonSource(): LessonSource {
  if (made !== null) return made;
  const source = `<style>${squeeze(kit)}${squeeze(lessonCss)}</style><div id="root"></div><script>${unpack(program)}</script>`;
  const problem = source.length > SURFACE_SOURCE_MAX ? `the lesson is ${source.length} characters and the host runs ${SURFACE_SOURCE_MAX}` : cleanMarkup(source) !== source ? 'the host would change the lesson program when it cleaned its markup' : null;
  made = { source, problem };
  return made;
}
