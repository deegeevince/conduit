import { cropTokens, encodeValue, showTokens } from './lesson';
import { CODE_LANGUAGES } from './vocabulary';
import type { BindOn, CanvasBox, ColourRef, FillRef, Line, LookProps, Point, ShapeGeometry, SpriteKey, StyleProps, Target, When } from './types';

function seconds(value: number): string {
  return `${Number(value.toFixed(3))}s`;
}

/** A hold may be shorter than a millisecond and must still read back as a hold: it keeps six decimals and never rounds to zero. */
function stayOf(value: number): string {
  return `${Math.max(0.000001, Number(value.toFixed(6)))}s`;
}

function number(value: number): string {
  return String(Number(value.toFixed(3)));
}

function point(value: Point): string {
  return `${number(value.x)},${number(value.y)}`;
}

function whenToken(when: When | undefined): string[] {
  if (when === undefined) return [];
  if (when.kind === 'with') return ['@with'];
  if (when.kind === 'after') return [`@+${number(when.seconds)}`];
  if (when.kind === 'before') return [`@-${number(when.seconds)}`];
  return [`@${number(when.seconds)}`];
}

function targetToken(target: Target): string {
  return target.kind === 'id' ? target.id : target.kind;
}

function colour(value: ColourRef): string {
  return typeof value === 'string' ? value : value.named;
}

function fill(value: FillRef): string {
  if (value === 'none') return 'none';
  if (typeof value === 'object' && 'from' in value) return `${colour(value.from)}>${colour(value.to)}`;
  return colour(value);
}

/** Properties are written in one fixed order so the same line always serialises to the same text. */
function propTokens(props: StyleProps): string[] {
  const out: string[] = [];
  if (props.layer !== undefined) out.push(`layer=${props.layer}`);
  if (props.at !== undefined) out.push(typeof props.at === 'string' ? `at=${props.at}` : `at=${point(props.at)}`);
  if (props.near !== undefined) out.push(props.near.side === 'auto' ? `near=${props.near.id}` : `near=${props.near.id}:${props.near.side}`);
  if (props.leader !== undefined) out.push(`leader=${props.leader ? 'yes' : 'no'}`);
  if (props.in !== undefined) out.push(`in=${props.in}`);
  if (props.size !== undefined) out.push(`size=${props.size}`);
  if (props.ink !== undefined) out.push(`ink=${colour(props.ink)}`);
  if (props.weight !== undefined) out.push(`weight=${props.weight}`);
  if (props.face !== undefined) out.push(`face=${props.face}`);
  if (props.case !== undefined) out.push(`case=${props.case}`);
  if (props.mark !== undefined) out.push(`mark=${props.mark}`);
  if (props.fill !== undefined) out.push(`fill=${fill(props.fill)}`);
  if (props.stroke !== undefined) out.push(`stroke=${props.stroke === 'none' ? 'none' : colour(props.stroke)}`);
  if (props.bleed !== undefined) out.push(`bleed=${props.bleed}`);
  if (props.thick !== undefined) out.push(`thick=${number(props.thick)}`);
  if (props.brush !== undefined) out.push(`brush=${props.brush}`);
  if (props.tex !== undefined) out.push(`tex=${props.tex}`);
  if (props.soft !== undefined) out.push(`soft=${number(props.soft)}`);
  if (props.scale !== undefined) out.push(`scale=${number(props.scale)}`);
  if (props.rot !== undefined) out.push(`rot=${number(props.rot)}`);
  if (props.opacity !== undefined) out.push(`opacity=${number(props.opacity)}`);
  if (props.enter !== undefined) out.push(`enter=${props.enter}`);
  if (props.by !== undefined) out.push(`by=${props.by}`);
  if (props.dur !== undefined) out.push(`dur=${seconds(props.dur)}`);
  if (props.exit !== undefined) out.push(`exit=${props.exit}`);
  if (props.loop !== undefined) out.push(`loop=${props.loop}`);
  if (props.stay !== undefined) out.push(typeof props.stay === 'string' ? `stay=${props.stay}` : `stay=${stayOf(props.stay.seconds)}`);
  if (props.tap !== undefined) out.push(`tap=${props.tap ? 'yes' : 'no'}`);
  return out;
}

function lookTokens(props: LookProps): string[] {
  const out: string[] = [];
  if (props.ground !== undefined) out.push(`ground=${props.ground}`);
  if (props.ink !== undefined) out.push(`ink=${props.ink}`);
  if (props.dim !== undefined) out.push(`dim=${props.dim}`);
  if (props.accent !== undefined) out.push(`accent=${props.accent}`);
  if (props.alt !== undefined) out.push(`alt=${props.alt}`);
  if (props.face !== undefined) out.push(`face=${props.face}`);
  if (props.fx !== undefined) out.push(`fx=${props.fx.length === 0 ? 'none' : props.fx.join(',')}`);
  if (props.stroke !== undefined) out.push(`stroke=${props.stroke}`);
  if (props.enter !== undefined) out.push(`enter=${props.enter}`);
  if (props.by !== undefined) out.push(`by=${props.by}`);
  if (props.exit !== undefined) out.push(`exit=${props.exit}`);
  return out;
}

function geometryTokens(geometry: ShapeGeometry): string[] {
  switch (geometry.shape) {
    case 'circle':
      return [`${number(geometry.cx)},${number(geometry.cy)}`, number(geometry.r)];
    case 'ellipse':
      return [`${number(geometry.cx)},${number(geometry.cy)}`, `${number(geometry.rx)}x${number(geometry.ry)}`];
    case 'rect':
      if (geometry.full) return ['full'];
      return [`${number(geometry.x)},${number(geometry.y)}`, `${number(geometry.w)}x${number(geometry.h)}`, ...(geometry.r > 0 ? [`r=${number(geometry.r)}`] : [])];
    case 'line':
    case 'poly':
      return geometry.points.map(point);
    case 'path':
      return [];
  }
}

function keyToken(key: SpriteKey): string[] {
  const entries = Object.entries(key);
  if (entries.length === 0) return [];
  return [`key=${entries.map(([char, value]) => `${char}:${value === 'none' ? 'none' : colour(value)}`).join(',')}`];
}

function boxTokens(box: CanvasBox | undefined): string[] {
  return box === undefined ? [] : [`${number(box.x)},${number(box.y)}`, `${number(box.w)}x${number(box.h)}`];
}

function bindTokens(control: string, on: BindOn): string[] {
  if (on.kind === 'is') return [`${control}=${on.value}`];
  if (on.kind === 'range') return [control, `${number(on.from)}..${number(on.to)}`];
  return [control];
}

function withText(head: string[], text: string | undefined): string {
  return text === undefined ? head.join(' ') : `${head.join(' ')} | ${text}`;
}

/** The canonical text of a line. `parseLine(serializeLine(line))` gives back an equal line. */
export function serializeLine(line: Line): string {
  switch (line.verb) {
    case 'scene': {
      const head: string[] = ['scene'];
      if (line.id !== undefined) head.push(line.id);
      if (line.layout !== undefined) head.push(`layout=${line.layout}`);
      if (line.canvas !== undefined) head.push(`canvas=${line.canvas}`);
      if (line.lines !== undefined) head.push(`lines=${line.lines}`);
      if (line.mood !== undefined) head.push(`mood=${line.mood}`);
      if (line.pace !== undefined) head.push(`pace=${line.pace}`);
      if (line.align !== undefined) head.push(`align=${line.align}`);
      if (line.clear !== undefined) head.push(`clear=${line.clear}`);
      return [...head, ...whenToken(line.when)].join(' ');
    }
    case 'plan': {
      const head: string[] = ['plan'];
      if (line.lines !== undefined) head.push(`lines=${line.lines}`);
      if (line.mood !== undefined) head.push(`mood=${line.mood}`);
      if (line.pace !== undefined) head.push(`pace=${line.pace}`);
      return head.join(' ');
    }
    case 'style': {
      const head: string[] = ['style', line.name];
      if (line.like !== undefined) head.push(`like=${line.like}`);
      return [...head, ...propTokens(line.props)].join(' ');
    }
    case 'color':
      return ['color', ...Object.entries(line.colors).map(([name, hex]) => `${name}=${hex}`)].join(' ');
    case 'look': {
      const head: string[] = ['look', line.look];
      if (line.like !== undefined) head.push(`like=${line.like}`);
      return [...head, ...lookTokens(line.props), ...whenToken(line.when)].join(' ');
    }
    case 'say':
      return withText(
        ['say', line.id, ...line.styles, ...(line.approx === undefined ? [] : [line.approx === 'yes' ? 'approx' : `approx=${line.approx}`]), ...(line.optional === true ? ['optional'] : []), ...propTokens(line.props), ...(line.href === undefined ? [] : [`href=${line.href}`]), ...whenToken(line.when)],
        [line.text, ...(line.alts ?? [])].join(' || '),
      );
    case 'circle':
    case 'ellipse':
    case 'rect':
    case 'line':
    case 'poly':
    case 'path':
      return withText(
        [line.verb, line.id, ...geometryTokens(line.geometry), ...line.styles, ...propTokens(line.props), ...whenToken(line.when)],
        line.geometry.shape === 'path' ? line.geometry.d : undefined,
      );
    case 'pix': {
      const head: string[] = ['pix', line.id, ...line.styles, ...propTokens(line.props)];
      if (line.fps !== undefined) head.push(`fps=${number(line.fps)}`);
      return [...head, ...keyToken(line.key), ...whenToken(line.when)].join(' ');
    }
    case 'row':
      return `row ${line.id} | ${line.cells}`;
    case 'frame':
      return `frame ${line.id}`;
    case 'draw':
      return [
        ['draw', ...(line.id === '-' ? [] : [line.id]), line.subject, ...propTokens(line.props), ...(line.size === undefined ? [] : [`size=${number(line.size)}`]), ...(line.as === undefined ? [] : [`as=${line.as}`]), ...(line.fresh === true ? ['new'] : []), ...whenToken(line.when)].join(' '),
        ...(line.detail === '' ? [] : [line.detail]),
      ].join(' | ');
    case 'group':
      return ['group', line.id, ...line.styles, ...propTokens(line.props), ...whenToken(line.when)].join(' ');
    case 'use':
      return ['use', line.id, line.source, ...line.styles, ...propTokens(line.props), ...whenToken(line.when)].join(' ');
    case 'paint': {
      const head: string[] = ['paint', line.id, ...boxTokens(line.box)];
      head.push(...line.styles);
      if (line.over !== undefined) head.push(`over=${line.over}`);
      if (line.medium !== undefined) head.push(`as=${line.medium}`);
      if (line.sketch !== undefined) head.push(`sketch=${line.sketch}`);
      if (line.mask !== undefined) head.push(`mask=${line.mask}`);
      return withText([...head, ...propTokens(line.props), ...whenToken(line.when)], line.prompt === '' ? undefined : line.prompt);
    }
    case 'pic': {
      const head: string[] = ['pic', line.id, ...boxTokens(line.box), ...line.styles, `from=${line.from}`];
      return [...head, ...propTokens(line.props), ...whenToken(line.when)].join(' ');
    }
    case 'deck':
      return withText(['deck', ...whenToken(line.when)], line.title === '' ? undefined : line.title);
    case 'standing':
      return 'drop' in line ? `standing drop ${line.drop}` : `standing | ${line.text}`;
    case 'refine':
      return line.passes === undefined ? 'refine' : `refine ${line.passes}`;
    case 'flow':
    case 'tree':
    case 'cycle':
    case 'timeline':
    case 'map':
    case 'table':
    case 'chart':
    case 'code':
    case 'tune':
    case 'app':
    case 'figure':
    case 'problem':
    case 'screen': {
      const head: string[] = [line.verb, line.id];
      if (line.answer !== undefined && line.answer.length > 0) head.push(`answer=${line.answer.map(encodeValue).join(',')}`);
      if (line.ways !== undefined && line.ways.length > 0) head.push(`ways=${line.ways.join(',')}`);
      if (line.for !== undefined) head.push(`for=${line.for}`);
      if (line.mode !== undefined) head.push(line.mode);
      if (line.grow !== undefined) head.push(line.grow);
      if (line.chart !== undefined) head.push(line.chart);
      head.push(...(line.words ?? []));
      if (line.route === true) head.push('route');
      if (line.bars === true) head.push('bars');
      if (line.voice !== undefined) head.push(line.voice);
      if (line.tempo !== undefined) head.push(`tempo=${line.tempo}`);
      if (line.height !== undefined) head.push(`height=${line.height}`);
      if (line.lang !== undefined) head.push((CODE_LANGUAGES as readonly string[]).includes(line.lang) ? line.lang : `lang=${line.lang}`);
      head.push(...boxTokens(line.box), ...line.styles);
      if (line.file !== undefined) head.push(`file=${line.file}`);
      if (line.data !== undefined) head.push(`data=${line.data}`);
      return withText([...head, ...propTokens(line.props), ...whenToken(line.when)], line.title);
    }
    case 'node': {
      const head: string[] = ['node', line.id, ...line.values.map(number)];
      if (line.shape !== undefined) head.push(line.shape);
      if (line.from !== undefined) head.push(line.from.label === undefined ? `from=${line.from.id}` : `from=${line.from.id}:${line.from.label}`);
      if (line.x !== undefined) head.push(`x=${line.x}`);
      if (line.y !== undefined) head.push(`y=${number(line.y)}`);
      if (line.approx !== undefined) head.push(line.approx === 'yes' ? 'approx' : `approx=${line.approx}`);
      return withText([...head, ...line.styles, ...propTokens(line.props), ...whenToken(line.when)], line.text);
    }
    case 'link': {
      const head: string[] = ['link', ...line.nodes, `id=${line.id}`];
      if (line.ends !== undefined) head.push(line.ends);
      if (line.dashed === true) head.push('dashed');
      return withText([...head, ...propTokens(line.props), ...whenToken(line.when)], line.text);
    }
    case 'button':
    case 'toggle':
    case 'slider':
    case 'pick':
    case 'input': {
      const head: string[] = [line.verb, line.id];
      if (line.form !== undefined) head.push(line.form);
      if (line.range !== undefined) head.push(number(line.range.min), number(line.range.max));
      if (typeof line.initial === 'number') head.push(number(line.initial));
      if (typeof line.initial === 'boolean') head.push(line.initial ? 'on' : 'off');
      if (line.range?.step !== undefined) head.push(`step=${number(line.range.step)}`);
      if (line.unit !== undefined) head.push(`unit=${line.unit}`);
      if (line.send === true) head.push('send');
      return withText([...head, ...line.styles, ...propTokens(line.props), ...whenToken(line.when)], line.options === undefined ? line.text : line.options.join(' | '));
    }
    case 'card':
      return withText(['card', line.id, ...boxTokens(line.box), ...line.styles, ...propTokens(line.props), ...whenToken(line.when)], line.title);
    case 'bind':
      return `${['bind', ...bindTokens(line.control, line.on)].join(' ')} | ${serializeLine(line.change)}`;
    case 'ambient': {
      const head: string[] = ['ambient', line.id, line.kind];
      if (line.amount !== undefined) head.push(line.amount);
      return [...head, ...line.styles, ...propTokens(line.props), ...whenToken(line.when)].join(' ');
    }
    case 'set': {
      const head: string[] = ['set', line.part === undefined ? targetToken(line.target) : `${targetToken(line.target)}.${'row' in line.part ? `row${line.part.row}` : `cell${line.part.cell[0]},${line.part.cell[1]}`}`, ...line.styles, ...propTokens(line.props)];
      if (line.speed !== undefined) head.push(line.speed);
      if (line.over !== undefined) head.push(`over=${seconds(line.over)}`);
      return [...head, ...whenToken(line.when)].join(' ');
    }
    case 'move': {
      const head: string[] = ['move', line.id];
      if (line.to !== undefined) head.push(typeof line.to === 'string' ? line.to : point(line.to));
      if (line.speed !== undefined) head.push(line.speed);
      if (line.over !== undefined) head.push(`over=${seconds(line.over)}`);
      if (line.along !== undefined) head.push(`along=${line.along}`);
      return [...head, ...whenToken(line.when)].join(' ');
    }
    case 'drop': {
      const head: string[] = ['drop', targetToken(line.target), ...(line.also ?? [])];
      if (line.exit !== undefined) head.push(`exit=${line.exit}`);
      return [...head, ...whenToken(line.when)].join(' ');
    }
    case 'hit':
      return ['hit', line.id, line.gesture, ...whenToken(line.when)].join(' ');
    case 'cam': {
      const head: string[] = ['cam', line.move];
      if (line.target !== undefined) head.push(line.target);
      if (line.direction !== undefined) head.push(line.direction);
      if (line.speed !== undefined) head.push(line.speed);
      if (line.over !== undefined) head.push(`over=${seconds(line.over)}`);
      if (line.amount !== undefined) head.push(`amount=${number(line.amount)}`);
      return [...head, ...whenToken(line.when)].join(' ');
    }
    case 'wait':
      if (line.seconds !== undefined) return `wait ${seconds(line.seconds)}`;
      return `wait ${number(line.beats ?? 1)}`;
    case 'correct':
      return withText(['correct', line.id, ...whenToken(line.when)], line.text);
    case 'revise':
      return withText(['revise', line.id, ...line.styles, ...propTokens(line.props)], line.text);
    case 'cancel':
      return line.id === undefined ? 'cancel' : `cancel ${line.id}`;
    case 'part':
      return withText(['part', line.id, ...(line.in === undefined ? [] : [`in=${line.in}`]), ...(line.tag === undefined ? [] : [`tag=${line.tag}`]), ...(line.for === undefined ? [] : [`for=${line.for}`]), ...(line.crop === undefined ? [] : cropTokens(line.crop))], line.title);
    case 'step':
      return withText(['step', line.id, ...(line.in === undefined ? [] : [`in=${line.in}`]), ...(line.show === undefined ? [] : showTokens(line.show))], line.text === '' ? undefined : line.text);
    case 'ask':
      return withText(
        ['ask', line.id, ...(line.in === undefined ? [] : [`in=${line.in}`]), ...(line.is.length === 0 ? [] : [`is=${line.is.map(encodeValue).join(',')}`]), ...(line.pick === undefined ? [] : [`pick=${line.pick.map(encodeValue).join(',')}`]), ...(line.unit === undefined ? [] : [`unit=${line.unit}`]), ...(line.check === undefined ? [] : [`check=${line.check}`]), ...(line.send === undefined ? [] : [`send=${line.send ? 'yes' : 'no'}`]), ...(line.stage === undefined ? [] : [`stage=${line.stage.n}${line.stage.after === null ? '' : `:${line.stage.after}`}`])],
        line.text,
      );
    case 'hint':
      return withText(['hint', ...(line.in === undefined ? [] : [`in=${line.in}`]), ...(line.stage === true ? ['stage=yes'] : [])], line.text);
    case 'fill':
      return `fill ${line.id} | ${line.text}`;
    case 'reply':
      return `reply | ${line.text}`;
    case 'end':
      return 'end';
  }
}
