// Read aloud: words as they should be heard. A speech engine reads what is written, so "1 000 = ___ ÷ 3" would come out as symbols, a gap and a stray
// letter. This turns the signs of primary maths into the words a child would say, and takes out what a voice cannot say (emphasis marks, pictures).
// Pure: text in, text out.

const WORDS: readonly (readonly [RegExp, string])[] = [
  // a blank to fill in: a run of underscores or a lone one standing by itself
  [/_{2,}/g, ' blank '],
  [/(^|[\s(])_(?=$|[\s).,;:?!])/g, '$1 blank '],
  [/\[\s*\]|\(\s*\)|□|▢|⬜/g, ' blank '],
  [/÷/g, ' divided by '],
  [/\s\/\s/g, ' divided by '],
  [/[×✕✖⋅]/g, ' times '],
  [/(\d)\s*[x*]\s*(?=\d)/gi, '$1 times '],
  [/(?<=\s|^)[−–]\s*(?=\d|blank)/g, ' minus '],
  [/(?<=\d)\s*−\s*(?=\d|blank)/g, ' minus '],
  [/(?<=\d)\s+[-–]\s+(?=\d|blank)/g, ' minus '],
  [/\+/g, ' plus '],
  [/≠/g, ' does not equal '],
  [/≈/g, ' is about '],
  [/≤/g, ' is less than or equal to '],
  [/≥/g, ' is greater than or equal to '],
  [/</g, ' is less than '],
  [/>/g, ' is greater than '],
  [/=/g, ' equals '],
  [/(\d)\s*%/g, '$1 percent'],
  [/(\d)\s*°C/g, '$1 degrees Celsius'],
  [/(\d)\s*°/g, '$1 degrees'],
  [/²/g, ' squared'],
  [/³/g, ' cubed'],
  [/√/g, ' square root of '],
  [/π/g, ' pi '],
  [/→|⇒|➜/g, ' to '],
  [/(\d)\/(\d)/g, '$1 over $2'],
];

/** Marks the engine would read out or stumble on: pictures and emoji, markdown emphasis, box-drawing. */
const NOISE = /[\p{Extended_Pictographic}‍️]|[*`~^|]+|[─-╿]/gu;

/** A number written with a space or thin space for thousands ("1 000", "12 500 000") is one number to say. */
function joinThousands(text: string): string {
  let out = text;
  for (let i = 0; i < 3; i += 1) out = out.replace(/(\d)[\s   ](\d{3})(?!\d)/g, '$1$2');
  return out;
}

/** The words to speak for a line of the stage: maths signs said, blanks called blank, emphasis and pictures dropped. */
export function spokenText(text: string): string {
  let out = text.normalize('NFC');
  out = joinThousands(out);
  for (const [pattern, words] of WORDS) out = out.replace(pattern, words);
  out = out.replace(NOISE, ' ');
  // a hyphen or underscore left inside words is a space to the ear
  out = out.replace(/(?<=\p{L})[_]+(?=\p{L})/gu, ' ');
  return out.replace(/\s+/g, ' ').replace(/\s+([.,;:?!])/g, '$1').trim();
}

/** Choices as a sentence: "You can choose: A, B or C". Nothing for fewer than two. */
export function spokenChoices(options: readonly string[]): string {
  const said = options.map((option) => spokenText(option)).filter((option) => option !== '');
  if (said.length === 0) return '';
  if (said.length === 1) return `You can choose: ${said[0]}`;
  return `You can choose: ${said.slice(0, -1).join(', ')} or ${said[said.length - 1]}`;
}

/** A long line is spoken in sentences: some engines drop out part way through one long utterance, and a stop between sentences is a place to breathe. */
export function sentencesOf(text: string, limit = 220): string[] {
  const parts = text.match(/[^.!?;:]+[.!?;:]*\s*/g) ?? [text];
  const out: string[] = [];
  let line = '';
  for (const part of parts) {
    if (line !== '' && line.length + part.length > limit) {
      out.push(line.trim());
      line = '';
    }
    line += part;
    while (line.length > limit * 1.5) {
      const cut = line.lastIndexOf(' ', limit);
      const at = cut > 40 ? cut : limit;
      out.push(line.slice(0, at).trim());
      line = line.slice(at);
    }
  }
  if (line.trim() !== '') out.push(line.trim());
  return out.filter((sentence) => /[\p{L}\p{N}]/u.test(sentence));
}
