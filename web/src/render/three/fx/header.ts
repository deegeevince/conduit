import type { Effect } from '.';
import type { ElementFrame, Frame, RunFrame } from '../../../contracts/frame';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const two = (value: number): string => String(value).padStart(2, '0');

/** The teletext header row: page number, name, date and a clock, on the character grid. */
function headerElement(frame: Frame): ElementFrame {
  const { viewport, margin, spec } = frame;
  const size = Math.max(10, Math.min(frame.bodySize, margin - 6));
  const cell = size * spec.type.advance;
  const padding = Math.min(margin, 24);
  const width = viewport.width - padding * 2;
  const cols = Math.max(1, Math.floor(width / cell));

  const searching = frame.clock === 'waiting' || frame.clock === 'holding';
  const rolling = !frame.reducedMotion && searching;
  // The waiting signal: the page number rolls while the set searches; under reduced motion it stands still as dashes, as a set shows a page it has not found yet.
  const page = rolling ? String(100 + (Math.floor(frame.ambient * 6) % 700)) : searching && frame.reducedMotion ? '---' : '100';
  const date = new Date(frame.wallTime);
  const stamp = `${WEEKDAYS[date.getDay()] ?? ''} ${two(date.getDate())} ${MONTHS[date.getMonth()] ?? ''}`;
  const clock = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;

  const parts: { text: string; col: number; colour: string }[] = [
    { text: `P${page}`, col: 0, colour: spec.roles.ink },
    { text: 'CONDUIT', col: 5, colour: spec.roles.alt },
  ];
  const clockCol = cols - clock.length;
  const dateCol = clockCol - stamp.length - 1;
  if (dateCol >= 13) parts.push({ text: stamp, col: dateCol, colour: spec.roles.accent });
  if (clockCol >= 13) parts.push({ text: clock, col: clockCol, colour: spec.roles.ink });

  const height = size * spec.type.lineHeight;
  const runs: RunFrame[] = parts.map((part) => ({
    text: part.text,
    x: -width / 2 + part.col * cell,
    y: -height / 2,
    width: part.text.length * cell,
    colour: part.colour,
    opacity: 1,
    dx: 0,
    dy: 0,
    scale: 1,
    reveal: 1,
  }));
  return {
    key: 'header',
    id: 'header',
    layer: 'mid',
    x: 0,
    y: -viewport.height / 2 + 3 + height / 2,
    width,
    height,
    fontSize: size,
    stretch: 1,
    weight: 'normal',
    opacity: 1,
    scale: 1,
    rotation: 0,
    runs,
    lines: [{ x: -width / 2, y: -height / 2, width, height }],
    mark: 'none',
    markColour: spec.roles.ink,
    strike: 0,
    ghost: false,
    tappable: false,
    z: 0,
    face: spec.type.face,
    plate: 0,
  };
}

/** The only furniture inside any stage: a top row like a teletext page header, drawn fixed to the screen. */
export function createHeader(): Effect {
  return {
    name: 'header',
    apply() {},
    furniture(frame) {
      return [headerElement(frame)];
    },
    dispose() {},
  };
}
