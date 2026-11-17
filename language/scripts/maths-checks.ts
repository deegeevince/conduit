// Checks of the exact maths checker (language/src/maths): exact numbers, quantities with units, expressions, the step checker and the slips it
// names, the word-problem relations, reading a worksheet question's words, verifying a lesson, and `check=working`. Run by `pnpm timeline`.
//
// Every question here is made up, in the same kinds as a primary-maths worksheet (fifty less, missing numbers, times to 100, metric
// conversions, ordering numbers, halving chains, months from an age, a time after a bus journey, change from a note, a fraction of a number).
// Nothing is copied from a real worksheet, and nothing names a learner.
import { accepts, foldSource, LineNormalizer, maths, parseLine, serializeLine } from '../src/index';

let passed = 0;
let failed = 0;

function expect(what: string, got: unknown, want: unknown): void {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) {
    passed += 1;
    return;
  }
  failed += 1;
  process.stdout.write(`  MATHS CHECK FAILED: ${what}\n      got    ${a}\n      wanted ${b}\n`);
}

const calc = (expr: string): string | null => {
  try {
    return maths.show(maths.evaluateConstant(expr));
  } catch {
    return null;
  }
};

const said = (lines: readonly string[]): readonly (string | null)[] => maths.checkSteps(lines).steps.map((s) => s.said);

// ---------------------------------------------------------------------------------------------------------------------------------
// exact numbers

function exactChecks(): void {
  const table: readonly (readonly [string, string])[] = [
    ['0.1 + 0.2', '0.3'],
    ['0.3 - 0.1', '0.2'],
    ['4.35 * 100', '435'],
    ['1.1 * 1.1', '1.21'],
    ['1/3 + 1/3 + 1/3', '1'],
    ['2/3 + 1/6', '5/6'],
    ['2/3 of 96', '64'],
    ['1/3 of 10', '3 1/3'],
    ['3/4 of 48', '36'],
    ['25% of 80', '20'],
    ['10% of 45', '4.5'],
    ['0.5 × 0.5', '0.25'],
    ['7/2', '3.5'],
    ['1/7', '1/7'],
    ['1 1/2 + 2 1/2', '4'],
    ['1,000 + 1', '1001'],
    ['99999999999999999999 + 1', '100000000000000000000'],
    ['(1/3) × 3', '1'],
    ['4 ÷ 0.8', '5'],
    ['10 × 10 − 5 × 10', '50'],
    ['3 × 50 − 50', '100'],
    ['(3 + 4) × 2', '14'],
    ['3 + 4 × 2', '11'],
    ['half of 64', '32'],
    ['half of 64 − 12', '20'],
    ['double 35', '70'],
    ['twice 35', '70'],
    ['a quarter of 80', '20'],
    ['three quarters of 80', '60'],
    ['50 less than 200', '150'],
    ['10 more than 38', '48'],
    ['forty two + 8', '50'],
    ['two thirds of 96', '64'],
    ['½ of 64', '32'],
    ['100 ÷ 8', '12.5'],
  ];
  for (const [expr, want] of table) expect(`exact: ${expr}`, calc(expr), want);
  expect('exact: dividing by zero is no number', calc('1 ÷ 0'), null);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// quantities with units

function unitChecks(): void {
  const table: readonly (readonly [string, string | null])[] = [
    ['25 cm + 75 cm', '100 cm'],
    ['1 m 25 cm', '125 cm'],
    ['1 m + 25 cm', '125 cm'],
    ['4 × 25 cm', '100 cm'],
    ['2 kg + 500 g', '2500 g'],
    ['1 l − 250 ml', '750 ml'],
    ['$20 − $13.50', '$6.50'],
    ['£1.50 + 75p', '£2.25'],
    ['$3.50 × 2', '$7.00'],
    ['150p', '150p'],
    ['50c + 50c', '100c'],
    ['9:15 am + 45 minutes', '10:00 am'],
    ['8:45 am + 35 minutes', '9:20 am'],
    ['11:45 am + 40 min', '12:25 pm'],
    ['4:05 pm − 3:15 pm', '50 min'],
    ['9:30 + 1 h 45 min', '11:15'],
    ['2 h 30 min + 45 min', '195 min'],
    ['3 weeks + 2 days', '23 days'],
    ['1 fortnight', '1 fortnight'],
    ['7 years 3 months', '87 months'],
    ['25 cm + 3 kg', null],
    ['$5 + £5', null],
    ['3 months + 2 days', null],
    ['2 m × 3 m', null],
    ['9:15 + 10:15', null],
  ];
  for (const [expr, want] of table) expect(`units: ${expr}`, calc(expr), want);
  const convert: readonly (readonly [string, string, string])[] = [
    ['2.86 m', 'cm', '286 cm'],
    ['3 kg', 'g', '3000 g'],
    ['2500 ml', 'l', '2.5 l'],
    ['1.5 km', 'm', '1500 m'],
    ['90 minutes', 'h', '1.5 h'],
    ['2 weeks', 'days', '14 days'],
    ['3 years', 'months', '36 months'],
    ['£2.50', 'p', '250p'],
  ];
  for (const [value, to, want] of convert) {
    const r = maths.checkRelation({ kind: 'convert', value, to }, want.split(' ')[0] ?? '');
    expect(`convert ${value} to ${to}`, [r.status, r.expected], ['agree', want]);
  }
  expect('convert months to days is refused, not guessed', maths.checkRelation({ kind: 'convert', value: '3 months', to: 'days' }, '90').status, 'unchecked');
  expect('convert cm to kg is refused', maths.checkRelation({ kind: 'convert', value: '5 cm', to: 'kg' }, '5').status, 'unchecked');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the step checker: right, wrong (which step, and how), unreadable, going on, gaps

function stepChecks(): void {
  const right: readonly (readonly string[])[] = [
    ['61 - 50 = 11'],
    ['12 + 12 + 12 + 12 + 12 = 60'],
    ['half of 64 = 32'],
    ['64 ÷ 2 = 32', '32 ÷ 2 = 16', '16 ÷ 2 = 8'],
    ['3 × 4 = 12'],
    ['10 x 10 - 5 x 10 = 50'],
    ['0.1 + 0.2 = 0.3'],
    ['4.35 × 100 = 435'],
    ['1/3 + 1/3 + 1/3 = 1'],
    ['2/3 of 96 = 64'],
    ['1 1/2 + 2 1/2 = 4'],
    ['25% of 80 = 20'],
    ['$20 - $13.50 = $6.50'],
    ['25 cm + 75 cm = 1 m'],
    ['1 m 25 cm = 125 cm'],
    ['2.86 m = 286 cm'],
    ['1500 g = 1.5 kg'],
    ['2 l = 2000 ml'],
    ['8:45 am + 35 minutes = 9:20 am'],
    ['9:15 a.m. + 15 min + 22 min + 13 min = 10:05 a.m.'],
    ['3 weeks = 21 days'],
    ['1 fortnight = 14 days'],
    ['7 years 3 months = 87 months'],
    ['150p = £1.50'],
    ['£1.50 + 75p = £2.25'],
    ['double 50 cm = 100 cm'],
    ['50 less than 200 = 150'],
    ['(3 + 4) × 2 = 14'],
    ['5 × 12 = 60 flowers'],
    ['half of 64 = 32', 'half again = 16', 'half again = 8'],
    ['61 - 50 = 11', '+ 5 = 16', '× 2 = 32'],
    ['12345678901234567890 + 1 = 12345678901234567891'],
    ['100 ÷ 8 = 12.5'],
    ['½ of 64 = 32'],
    ['forty two + 8 = 50'],
    ['twice 35 = 70'],
    ['Step 2: 12 + 12 = 24'],
    ['half of 64 is 32'],
    ['3/4 + 1/4 = 1'],
    ['12 + 12 = 24', '= 24', '24 + 12 = 36'],
    ['61−50=11'],
    ['5x12=60'],
    ['1m = 100cm'],
    ['7 × 8 = 56 ✓'],
    ['6 + 4 = 10 (the answer)'],
    ['25 + 25 = 50 → 50 + 50 = 100'],
    ['7 + 7 = 14 so double 7 = 14'],
    ['3 × 4 = 12 cm'],
  ];
  for (const lines of right) {
    const r = maths.checkSteps(lines);
    expect(`right: ${lines.join(' | ')}`, [r.ok, r.firstWrong, r.unreadable], [true, null, []]);
  }

  /** [the working, the step it first goes wrong at, what is said of that step] */
  const wrong: readonly (readonly [readonly string[], number, string])[] = [
    [['12 + 12 = 22'], 0, '12 + 12 is 24, not 22'],
    [['61 - 50 = 12'], 0, '61 - 50 is 11, not 12'],
    [['61 - 50 = 11', '11 + 5 = 17'], 1, '11 + 5 is 16, not 17'],
    [['12 + 12 = 24', '24 + 12 = 36', '36 + 12 = 50'], 2, '36 + 12 is 48, not 50'],
    [['half of 64 = 34'], 0, 'half of 64 is 32, not 34'],
    [['half of 64 = 128'], 0, 'half of 64 is 32, not 128'],
    [['2/3 of 96 = 62'], 0, '2/3 of 96 is 64, not 62'],
    [['3 x 4 = 7'], 0, '3 x 4 is 12, not 7'],
    [['1/3 + 1/3 = 1/2'], 0, '1/3 + 1/3 is 2/3, not 1/2'],
    [['$20 - $13.50 = $7.50'], 0, '$20 - $13.50 is $6.50, not $7.50'],
    [['25 cm + 75 cm = 1 cm'], 0, '25 cm + 75 cm is 100 cm, not 1 cm'],
    [['8:45 am + 35 minutes = 9:25 am'], 0, '8:45 am + 35 minutes is 9:20 am, not 9:25 am'],
    [['25% of 80 = 25'], 0, '25% of 80 is 20, not 25'],
    [['5 + 5 = 55'], 0, '5 + 5 is 10, not 55'],
    [['3 + 4 = 8 flowers'], 0, '3 + 4 is 7, not 8 flowers'],
    [['3 weeks = 20 days'], 0, '3 weeks is 21 days, not 20 days'],
    [['50 less than 200 = 250'], 0, '50 less than 200 is 150, not 250'],
    [['10 x 10 - 5 x 10 = 95'], 0, '10 x 10 - 5 x 10 is 50, not 95'],
    [['100 ÷ 8 = 12'], 0, '100 ÷ 8 is 12.5, not 12'],
    [['5 = 6'], 0, '5 is not 6'],
    [['3 x 4 = 13', '= 12'], 0, '3 x 4 is 12, not 13'],
    [['7 + 7 = 14 so 14 + 1 = 16'], 0, '14 + 1 is 15, not 16'],
    [['100 - 30 = 70 - 20 = 50'], 0, '100 - 30 is 70, but 70 - 20 is 50'],
    [['5 + 3 = 8 + 1 = 9'], 0, '5 + 3 is 8, but 8 + 1 is 9'],
    [['half of 64 = 32', 'half again = 18'], 1, 'half again is 16, not 18'],
  ];
  for (const [lines, at, text] of wrong) {
    const r = maths.checkSteps(lines);
    expect(`wrong at ${at}: ${lines.join(' | ')}`, [r.ok, r.firstWrong, r.steps[at]?.said], [false, at, text]);
  }

  // one slip is one finding: a step that goes on from a wrong one goes on from what she wrote
  const carried = maths.checkSteps(['3 x 4 = 13', '+ 2 = 15']);
  expect('a slip carries: only the first step is wrong', carried.steps.map((s) => s.verdict), ['wrong', 'right']);
  expect('a line that goes on says what it goes on from', said(['3 x 4 = 13', '+ 2 = 16'])[1], '13 + 2 is 15, not 16');

  // the slips it can name
  const slip = (line: string): string | null => maths.checkSteps([line]).steps[0]?.slip ?? null;
  expect('slip: out by one', slip('3 + 4 = 8'), 'out-by-one');
  expect('slip: out by ten', slip('48 + 36 = 74'), 'out-by-ten');
  expect('slip: digits swapped', slip('27 + 27 = 45'), 'digits-swapped');
  expect('slip: added instead of multiplied', slip('3 x 4 = 7'), 'wrong-operation');
  expect('slip: took away instead of adding', slip('12 + 12 = 0'), 'wrong-operation');
  expect('slip: a conversion out by a hundred', slip('25 cm + 75 cm = 1 cm'), 'conversion');
  expect('slip: a zero missing', slip('10 x 10 - 5 x 10 = 5'), 'place-value');
  expect('slip: none for a wild answer', slip('12 + 12 = 91'), null);

  // things that are wrong in kind
  expect('kinds: cm and kg', maths.checkSteps(['25 cm + 3 kg = 28']).steps[0]?.slip, 'units');
  expect('kinds: divide by zero', maths.checkSteps(['5 ÷ 0 = 0']).steps[0]?.slip, 'divide-by-zero');

  // a line it cannot read is never a mistake
  for (const line of ['banana', '12 +', '= ', 'I just knew it', '12 + + 4 = 16']) {
    const r = maths.checkSteps([line]);
    expect(`unreadable, not wrong: ${line}`, [r.ok, r.steps[0]?.verdict], [true, 'unreadable']);
  }

  // a gap is solved, never marked
  const gaps: readonly (readonly [string, string])[] = [
    ['8 + □ = 20', 'the missing number in 8 + □ = 20 is 12'],
    ['25 cm + ___ cm = 1 m', 'the missing number in 25 cm + ___ cm = 1 m is 75 cm'],
    ['24 ÷ ? = 6', 'the missing number in 24 ÷ ? = 6 is 4'],
    ['100 = 20 x ___', 'the missing number in 100 = 20 x ___ is 5'],
  ];
  for (const [line, text] of gaps) expect(`gap: ${line}`, [maths.checkSteps([line]).steps[0]?.verdict, maths.checkSteps([line]).steps[0]?.said], ['unchecked', text]);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// reading a question's words: the kinds of question a worksheet sets

function solves(question: string, want: readonly string[] | null): void {
  const got = maths.solveQuestion(question);
  expect(`reads: ${question.slice(0, 70)}`, got === null ? null : got.answers.map(maths.answerText), want);
}

function questionChecks(): void {
  // fifty less, and plain sums
  solves('50 less than 87 =', ['37']);
  solves('125 − 50 =', ['75']);
  solves('75 minus 50 =', ['25']);
  solves('50 less than 250 =', ['200']);
  solves('3 × 50 − 50 =', ['100']);
  solves('10 × 10 − 5 × 10 =', ['50']);
  solves('What is 50 less than 200?', ['150']);
  solves('4. 100 − 50 =', ['50']);
  // missing numbers
  solves('100 − □ = 50', ['50']);
  solves('□ + 7 = 20', ['13']);
  solves('45 + □ = 100', ['55']);
  solves('□ − 8 = 12', ['20']);
  solves('36 ÷ □ = 4', ['9']);
  solves('□ × 6 = 54', ['9']);
  // times to one hundred
  solves('10 × ____ = 100', ['10']);
  solves('4 × ____ = 100', ['25']);
  solves('25 × ___ = 100', ['4']);
  solves('100 ÷ 4 =', ['25']);
  solves('500 ÷ ____ = 100', ['5']);
  solves('100 = 20 × ____', ['5']);
  solves('60 + ____ = 100', ['40']);
  // metric measures
  solves('25 cm + ____ cm = 1 m', ['75 cm']);
  solves('300 centimetres = ____ metres', ['3 m']);
  solves('1 1/2 m = 100 cm + ____ cm', ['50 cm']);
  solves('4 × 25 cm =', ['100 cm']);
  solves('double 50 cm =', ['100 cm']);
  solves('150 cm + 50 cm = ____ m', ['2 m']);
  solves('How many centimetres are there in 2.86 m?', ['286 cm']);
  solves('2.5 kg = ____ g', ['2500 g']);
  solves('How many ml in 3 litres?', ['3000 ml']);
  solves('How many days are in 3 weeks?', ['21 days']);
  solves('How many months in 5 years?', ['60 months']);
  // ordering numbers
  solves('Put these numbers in order, smallest first: 405, 45, 504, 54', ['45, 54, 405, 504']);
  solves('Put these in order, largest first: 405, 45, 504, 54', ['504, 405, 54, 45']);
  solves('Which is the largest number? 45, 405, 54', ['405']);
  solves('Which is the smallest number? 45, 405, 54', ['45']);
  solves('Write <, > or = in the circle: 45 ○ 54', ['<']);
  // halving chains
  solves('Half of 64 =', ['32']);
  solves('What is half of 16?', ['8']);
  solves('Ana has $64. Her brother has half as much money. Her sister has half as much as her brother. How much does her sister have?', ['$32.00', '$16.00']);
  // months from an age
  solves("Mia's birthday is in March. She is 7 years and 5 months old. Her brother's birthday is in another 3 months. What month is her brother's birthday?", ['november']);
  solves('How many months old is a child who is 6 years and 4 months?', ['76 months']);
  // a time after a bus journey
  solves('The bus leaves at 8:30 a.m. The journey takes 25 minutes. What time does it arrive?', ['8:55 am']);
  solves('I left home at 7:50 a.m. It takes 10 minutes to walk to the stop, 20 minutes by bus and 5 minutes to walk to school. What time did I arrive?', ['8:25 am']);
  solves('I need to get to the station at 10:15 a.m. The walk takes 20 minutes. What time do I need to leave?', ['9:55 am']);
  solves('The film starts at 11:45 a.m. and lasts 40 minutes. What time does it end?', ['12:25 pm']);
  solves('She woke up at 8:30 a.m. It takes her 20 minutes to get ready and 30 minutes on the bus. If school starts at 9:00 a.m., how late would she be?', ['20 min']);
  solves('How many minutes are there from 3:15 p.m. to 4:05 p.m.?', ['50 min']);
  // change from a note
  solves('One pen costs $2.30. If I bought 3 pens, how much change would I get from $10?', ['$3.10']);
  solves('A jacket costs $12.50. How much change from a $20 note?', ['$7.50']);
  solves('A book costs £3.20 and a pen costs 85p. How much change from £5?', ['£0.95']);
  // a fraction of a number
  solves('Gavin has 90 marbles. Cam has 2/3 as much as Gavin. How many marbles does Cam have?', ['60']);
  solves('What is 2/3 of 96?', ['64']);
  solves('What is 3/4 of 48?', ['36']);
  solves('What is 25% of 80?', ['20']);
  solves('Find 1/5 of 35.', ['7']);
  // number patterns
  solves('Find the next number in the sequence: 2, 4, 8, 16, 32,', ['64', '64']);
  solves('Find the next number in the pattern: 1, 1, 2, 3, 5, 8, 13, 21,', ['34']);
  solves('Find the next number in the pattern: 1, 2, 5, 14,', ['41']);
  solves('Find the next number in the pattern: 99, 1, 97, 3, 95,', ['5']);
  solves('Find the next number in the pattern: 100, 90, 80, 70,', ['60']);
  // not a shape it reads: no answer, no guess
  solves('Hop 3 times. Where do you land?', null);
  solves('Draw the bags.', null);
  solves('Ben has 12 apples and eats 5. How many are left?', null);
  solves('A farmer has 360 oranges and each box holds 12 oranges. How many boxes does the farmer need?', ['30']);
  solves('A baker has 100 buns and each tray holds 12. How many trays are needed?', ['9']);
  solves('Each box holds 12 oranges. How many oranges are in 5 boxes?', null);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the word-problem relation: the quantities as the question gives them, and the answer claimed

function relationChecks(): void {
  const r = maths.checkRelation;
  const kinds: readonly (readonly [string, maths.Relation, string, string])[] = [
    ['a total', { kind: 'total', parts: ['3', '4', '5'] }, '12', 'agree'],
    ['a total, wrong', { kind: 'total', parts: ['3', '4', '5'] }, '13', 'mismatch'],
    ['what is left', { kind: 'left', start: '20', take: ['3', '4'] }, '13', 'agree'],
    ['equal groups', { kind: 'groups', groups: '3', each: '4' }, '12', 'agree'],
    ['a share', { kind: 'share', total: '96', groups: '4' }, '24', 'agree'],
    ['a share that does not come out even', { kind: 'share', total: '10', groups: '4' }, '2.5', 'unchecked'],
    ['a share with a remainder', { kind: 'share', total: '10', groups: '4', remainder: true }, '2.5', 'agree'],
    ['boxes for 360 at 12', { kind: 'fit', total: '360', size: '12' }, '30', 'agree'],
    ['boxes for 100 at 12 (a part-filled one counts)', { kind: 'fit', total: '100', size: '12' }, '9', 'agree'],
    ['boxes for 100 at 12, rounded down', { kind: 'fit', total: '100', size: '12' }, '8', 'mismatch'],
    ['two thirds of 96', { kind: 'fraction', fraction: '2/3', of: '96' }, '64', 'agree'],
    ['two thirds of 96, wrong', { kind: 'fraction', fraction: '2/3', of: '96' }, '48', 'mismatch'],
    ['a quarter of 80 as a percentage', { kind: 'fraction', fraction: '25%', of: '80' }, '20', 'agree'],
    ['halving three times', { kind: 'chain', start: '64', by: '1/2', times: 3 }, '8', 'agree'],
    ['halving three times, every stop', { kind: 'chain', start: '64', by: '1/2', times: 3, all: true }, '32, 16, 8', 'agree'],
    ['halving three times, the wrong stop', { kind: 'chain', start: '64', by: '1/2', times: 3 }, '32', 'mismatch'],
    ['how many more', { kind: 'difference', a: '45', b: '28' }, '17', 'agree'],
    ['change from $20 for four at $4.60', { kind: 'change', paid: '$20', items: [{ price: '$4.60', count: '4' }] }, '$1.60', 'agree'],
    ['change, wrong', { kind: 'change', paid: '$20', items: [{ price: '$4.60', count: '4' }] }, '$2.40', 'mismatch'],
    ['change from two things', { kind: 'change', paid: '£5', items: [{ price: '£3.20' }, { price: '85p' }] }, '95p', 'agree'],
    ['change that is not enough', { kind: 'change', paid: '$5', items: [{ price: '$4.60', count: '4' }] }, '1', 'unchecked'],
    ['a time after a journey', { kind: 'time', start: '9:15 am', spans: ['15 minutes', '22 minutes', '13 minutes'] }, '10:05 am', 'agree'],
    ['a time to leave by', { kind: 'time', start: '11:30 am', spans: ['18 minutes', '15 minutes'], direction: 'before' }, '10:57 am', 'agree'],
    ['minutes between two times', { kind: 'elapsed', from: '3:15 pm', to: '4:05 pm' }, '50 minutes', 'agree'],
    ['an age in months', { kind: 'ageMonths', age: '8 years 3 months' }, '99', 'agree'],
    ['a month some months on', { kind: 'monthAfter', month: 'April', months: 3 }, 'July', 'agree'],
    ['a month some months on, round the year', { kind: 'monthAfter', month: 'November', months: 4 }, 'March', 'agree'],
    ['numbers in order', { kind: 'order', values: ['405', '45', '54'], direction: 'ascending' }, '45, 54, 405', 'agree'],
    ['numbers in order, wrong', { kind: 'order', values: ['405', '45', '54'], direction: 'ascending' }, '45, 405, 54', 'mismatch'],
    ['the next in a pattern', { kind: 'sequence', values: ['2', '4', '8', '16', '32'] }, '64', 'agree'],
    ['the fewest coins for $7.60', { kind: 'leastCoins', amount: '$7.60' }, '$5, $2, 50c, 10c', 'agree'],
    ['more coins than the fewest', { kind: 'leastCoins', amount: '$7.60' }, '$5, $2, 20c, 20c, 20c', 'mismatch'],
    ['the fewest coins for $18.75', { kind: 'leastCoins', amount: '$18.75' }, '$10, $5, $2, $1, 50c, 20c, 5c', 'agree'],
    ['an expression', { kind: 'expression', expr: '20 - 4 x 4.60' }, '1.60', 'agree'],
  ];
  for (const [what, rel, claimed, status] of kinds) expect(`relation: ${what}`, r(rel, claimed).status, status);
  expect('relation: the arithmetic is shown as lines', r({ kind: 'change', paid: '$20', items: [{ price: '$4.60', count: '4' }] }, '$1.60').working, ['4 × $4.60 = $18.40', '$20.00 − $18.40 = $1.60']);
  expect('relation: a mismatch says what it should be', r({ kind: 'total', parts: ['3', '4', '5'] }, '13').reason, 'the quantities give 12, not 13');
  expect('relation: the fewest-coins note', r({ kind: 'leastCoins', amount: '$7.60' }, '$5, $2, 20c, 20c, 20c').reason.includes('4 is the fewest'), true);
  expect('relation: a word that is not an answer is unchecked', r({ kind: 'total', parts: ['3', '4'] }, '').status, 'unchecked');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// patterns, coins and months on their own

function pieceChecks(): void {
  const next = (values: readonly number[]): readonly string[] => maths.nextInSequence(values.map((v) => maths.q(v))).map((f) => maths.qText(f.next));
  expect('pattern: add each time', next([5, 10, 15, 20]), ['25']);
  expect('pattern: take away each time', next([100, 90, 80]), ['70']);
  expect('pattern: doubling', next([3, 6, 12, 24]).includes('48'), true);
  expect('pattern: squares', next([1, 4, 9, 16]), ['25']);
  expect('pattern: too short to say', next([1, 2]), []);
  expect('months: round the year', maths.monthAfter('Nov', 4), 'March');
  expect('months: backwards', maths.monthAfter('March', -3), 'December');
  expect('months: a word that is not a month', maths.monthAfter('Tuesday', 1), null);
  const coins = maths.leastCoins(maths.valueOf('$7.60'), maths.AUD_COINS.map(maths.valueOf));
  expect('coins: $7.60 in four', coins?.map((c) => maths.show(c)), ['$5.00', '$2.00', '50c', '10c']);
  expect('coins: can not be made from nothing', maths.leastCoins(maths.valueOf('$7.61'), maths.AUD_COINS.map(maths.valueOf)), null);
  expect('answers: 60 flowers is 60', maths.agrees('60', maths.valueOf('60 flowers')), true);
  expect('answers: 9.20 and 9:20 am', maths.agrees('9:20', maths.valueOf('9:20 am')), true);
  expect('answers: 6.50 and $6.50', maths.agrees('6.50', maths.valueOf('$6.50')), true);
  expect('answers: 30 cm and 0.3 m', maths.agrees('30 cm', maths.valueOf('0.3 m')), true);
  expect('answers: 30 cm and 30 kg', maths.agrees('30 cm', maths.valueOf('30 kg')), false);
  expect('answers: a sum is not an answer', maths.parseValue('3 + 4'), null);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// verifying a lesson: every ask recomputed, every stated sum checked

const LESSON_BASE = ['part w1 | Sheet', 'part s1 in=w1 | Practice'];

function lessonOf(lines: readonly string[]): ReturnType<typeof maths.checkLessonDocument> {
  return maths.checkLessonDocument(foldSource([...LESSON_BASE, ...lines].join('\n')).document);
}

function lessonChecks(): void {
  const ok = lessonOf(['part q1 in=s1 | 2/3 of 96 =', 'part q1a in=q1 tag=share-it-out | Share it out', 'step in=q1a | Three equal parts.', 'ask a1 in=q1a is=64 | How many in two parts?']);
  expect('lesson: a fraction question agrees', [ok.ok, ok.counts.agree, ok.counts.mismatch], [true, 1, 0]);
  const bad = lessonOf(['part q1 in=s1 | 2/3 of 96 =', 'part q1a in=q1 tag=share-it-out | Share it out', 'step in=q1a | Three equal parts.', 'ask a1 in=q1a is=66 | How many in two parts?']);
  expect('lesson: a wrong accepted answer is refused', [bad.ok, bad.findings[0]?.where, bad.findings[0]?.why], [false, 'question', 'the question "2/3 of 96 =" works out to 64 and no ask of this way accepts it']);
  const prompt = lessonOf(['part q1 in=s1 | Add them up', 'part q1a in=q1 tag=draw-it | Draw them', 'step in=q1a | Two sets of twelve.', 'ask a1 in=q1a is=22 | What is 12 + 12?']);
  expect('lesson: an ask whose own words are a sum is recomputed', [prompt.ok, prompt.asks[0]?.status, prompt.asks[0]?.computed], [false, 'mismatch', '24']);
  expect('lesson: the reason says how they differ', prompt.findings[0]?.why, 'ask a1 says "What is 12 + 12?": "12 + 12" works out to 24, and the ask accepts 22');
  const stated = lessonOf(['part q1 in=s1 | How many flowers?', 'part q1a in=q1 tag=draw-it | Draw them', 'step s1 in=q1a | Five vases, so 5 x 12 = 50 flowers.', 'ask a1 in=q1a is=60 | How many flowers?']);
  expect('lesson: a sum stated in a step is checked', [stated.ok, stated.findings[0]?.where, stated.findings[0]?.why], [false, 'step', 'step s1 says "5 x 12 = 50", and 5 x 12 is 60, not 50']);
  const money = lessonOf(['part q1 in=s1 | Change', 'part q1a in=q1 tag=count-on-a-line | Count up', 'step in=q1a | Start at the price.', 'ask a1 in=q1a is=6.50 | What is $20 − $13.50?']);
  expect('lesson: money, with the dollar sign left off the answer', [money.ok, money.asks[0]?.status], [true, 'agree']);
  const clock = lessonOf(['part q1 in=s1 | The bus', 'part q1a in=q1 tag=count-on-a-line | Count on', 'step in=q1a | Add the minutes.', 'ask a1 in=q1a is=9:20 | What time is 8:45 + 35 minutes?']);
  expect('lesson: a time, written without am or pm', [clock.ok, clock.asks[0]?.status], [true, 'agree']);
  const pick = lessonOf(['part q1 in=s1 | Choose', 'part q1a in=q1 tag=draw-it | Draw', 'step in=q1a | Look.', 'ask a1 in=q1a is=60 pick=50,60,70 | What is 5 × 12?']);
  expect('lesson: one right choice among three', [pick.ok, pick.asks[0]?.status], [true, 'agree']);
  const blind = lessonOf(['part q1 in=s1 | Look at the picture', 'part q1a in=q1 tag=draw-it | Draw', 'step in=q1a | Look.', 'ask a1 in=q1a is=blue | Which colour is the bag?']);
  expect('lesson: words that are not a sum are not recomputed, and not refused', [blind.ok, blind.asks[0]?.status, blind.counts.unchecked], [true, 'unchecked', 1]);
  const month = lessonOf(['part q1 in=s1 | Birthdays', 'part q1a in=q1 tag=count-on-a-line | Count on', 'step in=q1a | Count the months.', "ask a1 in=q1a is=November | Mia's birthday is in March. She is 7 years and 5 months old. Her brother's birthday is in another 3 months. What month is it?"]);
  expect('lesson: a month sum', [month.ok, month.asks[0]?.status, month.asks[0]?.computed], [true, 'agree', 'november']);
  const wrongMonth = lessonOf(['part q1 in=s1 | Birthdays', 'part q1a in=q1 tag=count-on-a-line | Count on', 'step in=q1a | Count the months.', "ask a1 in=q1a is=August | Mia's birthday is in March. She is 7 years and 5 months old. Her brother's birthday is in another 3 months. What month is it?"]);
  expect('lesson: a wrong month is refused', [wrongMonth.ok, wrongMonth.asks[0]?.status], [false, 'mismatch']);
  const ordering = lessonOf(['part q1 in=s1 | Order', 'part q1a in=q1 tag=draw-it | Draw', 'step in=q1a | Compare the hundreds.', 'ask a1 in=q1a is=45_54_405 | Put these in order, smallest first: 405, 45, 54']);
  expect('lesson: an ordering, answer written with spaces', [ordering.ok, ordering.asks[0]?.status], [true, 'agree']);
  expect('lesson: the summary counts', ok.summary, '1 ask: 1 recomputed and agree, 0 disagree, 0 not recomputable; 0 refused');
  const empty = maths.checkLessonDocument(foldSource('part w1 | Sheet').document);
  expect('lesson: a document with no lesson is fine', [empty.ok, empty.counts.asks], [true, 0]);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// check=working

function workingChecks(): void {
  const ask = { accepted: ['34'], unit: null, check: 'working' } as const;
  const line = parseLine('ask a1 in=q1a is=34 check=working | Show your working.');
  expect('check=working: the line reads', line.kind === 'line' && line.line.verb === 'ask' ? line.line.check : null, 'working');
  expect('check=working: and writes back as it was', line.kind === 'line' ? serializeLine(line.line) : null, 'ask a1 in=q1a is=34 check=working | Show your working.');
  const plain = parseLine('ask a1 in=q1a is=34 | Where?');
  expect('check=working: a plain ask is as it was', plain.kind === 'line' ? serializeLine(plain.line) : null, 'ask a1 in=q1a is=34 | Where?');
  expect('check=working: working that is right is accepted', accepts(ask, '64 - 30 = 34'), true);
  expect('check=working: working that ends elsewhere is not', accepts(ask, '64 - 30 = 36'), false);
  expect('check=working: the answer on its own still is', accepts(ask, '34'), true);
  expect('check=working: several steps, each right', accepts(ask, '64 - 40 = 24\n24 + 10 = 34'), true);
  expect('check=working: steps joined by a semicolon', accepts(ask, '64 - 40 = 24; 24 + 10 = 34'), true);
  expect('check=working: a wrong step on the way is not accepted, even landing right', accepts(ask, '64 - 40 = 25\n25 + 9 = 34'), false);
  expect('check=working: an ask without it still compares one answer', accepts({ accepted: ['34'], unit: null }, '64 - 30 = 34'), false);

  const wrong = maths.checkWorking(ask, '64 - 30 = 36');
  expect('working: a wrong step is named', [wrong.verdict, wrong.firstWrong], ['wrong-step', 0]);
  expect('working: and what it should have been is not handed over when it is the answer', [wrong.leaks, wrong.said], [true, 'Look again at step 1.']);
  expect('working: the detail has the numbers', wrong.detail, 'step 1 is wrong: 64 - 30 is 34, not 36');
  const middle = maths.checkWorking(ask, '64 - 40 = 25\n25 + 9 = 34');
  expect('working: a wrong step that is not the answer can be named', [middle.verdict, middle.leaks, middle.said], ['wrong-step', false, 'Look again at step 1: 64 - 40 is not 25.']);
  const overshoot = maths.checkWorking(ask, '64 - 30 = 34\n34 + 1 = 35');
  expect('working: right steps that end elsewhere', [overshoot.verdict, overshoot.final], ['wrong-answer', '35']);
  expect('working: nothing written', maths.checkWorking(ask, '   ').verdict, 'empty');
  expect('working: nothing readable', maths.checkWorking(ask, 'I did it in my head').verdict, 'unreadable');
  expect('working: lines split on a newline or a semicolon', maths.workingLines('1 + 1 = 2; 2 + 2 = 4\n4 + 4 = 8'), ['1 + 1 = 2', '2 + 2 = 4', '4 + 4 = 8']);
  const typed = maths.checkWorking({ accepted: ['9:20'], unit: null }, '8:45 + 35 min = 9:20');
  expect('working: a time sum', typed.verdict, 'right');
  const money = maths.checkWorking({ accepted: ['1.60'], unit: null }, '4 x $4.60 = $18.40\n$20 - $18.40 = $1.60');
  expect('working: money, over two lines', money.verdict, 'right');
}


// ---------------------------------------------------------------------------------------------------------------------------------
// check=order

function orderChecks(): void {
  const ask = { accepted: ['101', '117', '120', '152', '165', '197'], unit: null, check: 'order' } as const;
  const line = parseLine('ask a1 in=q18 is=101,117,120,152,165,197 check=order | Put these in order, smallest to largest.');
  expect('check=order: the line reads', line.kind === 'line' && line.line.verb === 'ask' ? [line.line.check, line.line.is.length] : null, ['order', 6]);
  expect('check=order: and writes back as it was', line.kind === 'line' ? serializeLine(line.line) : null, 'ask a1 in=q18 is=101,117,120,152,165,197 check=order | Put these in order, smallest to largest.');
  expect('check=order: the right order is accepted', accepts(ask, '101, 117, 120, 152, 165, 197'), true);
  expect('check=order: spaces or arrows will do', accepts(ask, '101 117 120 152 165 197'), true);
  expect('check=order: a swap is not', accepts(ask, '101, 120, 117, 152, 165, 197'), false);
  expect('check=order: the reverse is not', accepts(ask, '197, 165, 152, 120, 117, 101'), false);
  expect('check=order: a tile missing is not', accepts(ask, '101, 117, 120, 152, 165'), false);
  expect('check=order: the items are numbers, not text', accepts({ accepted: ['4', '10'], unit: null, check: 'order' }, '4.0, 10'), true);
  expect('check=order: words are ordered as words', accepts({ accepted: ['small', 'medium', 'large'], unit: null, check: 'order' }, 'small, medium, large'), true);
  const doc = (accepted: string, text: string): ReturnType<typeof maths.checkLessonDocument> =>
    maths.checkLessonDocument(foldSource(['part w1 | Sheet', 'part q18 in=w1 | 18. Put these numbers in order, smallest to largest: 117 197 101 152 165 120', `ask a1 in=q18 is=${accepted} check=order | ${text}`].join('\n')).document);
  const good = doc('101,117,120,152,165,197', 'Put these numbers in order, smallest to largest.');
  expect('check=order: a sequence that is sorted agrees, and the items in the question are no spoiler', [good.ok, good.asks[0]?.status], [true, 'agree']);
  const bad = doc('101,117,152,120,165,197', 'Put these numbers in order, smallest to largest.');
  expect('check=order: a sequence that is not sorted is refused', [bad.ok, bad.asks[0]?.status], [false, 'mismatch']);
  const down = doc('197,165,152,120,117,101', 'Put them in order, from the greatest to the least.');
  expect('check=order: greatest first is read', [down.ok, down.asks[0]?.status], [true, 'agree']);
  const unknown = doc('b,a,c', 'Put these in the order of the story.');
  expect('check=order: an order it cannot tell is left alone', [unknown.ok, unknown.asks[0]?.status], [true, 'unchecked']);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// whatever is typed, it must not break

function hardChecks(): void {
  const verdict = (line: string): string | undefined => maths.checkSteps([line]).steps[0]?.verdict;
  expect('hard: a line far too long is unreadable', verdict(`1 + ${'1 + '.repeat(600)}1 = 5`), 'unreadable');
  expect('hard: brackets inside brackets', verdict(`${'('.repeat(500)}1${')'.repeat(500)} = 1`), 'unreadable');
  expect('hard: a number of five thousand digits', verdict(`${'9'.repeat(5000)} + 1 = 2`), 'unreadable');
  expect('hard: a number of forty digits is fine', verdict(`${'9'.repeat(39)} + 1 = 1${'0'.repeat(39)}`), 'right');
  expect('hard: a huge product is refused, not computed', verdict(`${Array.from({ length: 20 }, () => '9'.repeat(40)).join(' x ')} = 1`), 'unreadable');
  expect('hard: nothing but symbols', verdict('?!?! ### ***'), 'unreadable');
  expect('hard: a solved question that is nonsense is no answer', maths.solveQuestion(`${'9'.repeat(5000)} + 1 =`), null);
  expect('hard: a relation with words for numbers is unchecked, not a throw', maths.checkRelation({ kind: 'total', parts: ['banana', '3'] }, '4').status, 'unchecked');
  expect('hard: working with nothing in it', maths.checkWorking({ accepted: ['4'] }, ['', ' ']).verdict, 'empty');
}


// --- the written methods (PLAN-maths M0 and M1): the contract, and the digit algorithms over ranges of sums -----------------------------------------

type Grid = maths.Grid;
type Cell = maths.Cell;

const showN = (text: string): string => maths.showDec(maths.readDec(text) as maths.Dec);
const cellsOf = (grid: Grid, role: Cell['role']): Cell[] => grid.cells.filter((cell) => cell.role === role);
const gridOf = (method: 'column' | 'times' | 'split' | 'bond', sum: string, options: { worked?: boolean; blank?: 'answer' | 'all'; carry?: 'write' | 'shown' | 'none' } = {}): Grid | null =>
  maths.gridOf({ method, sum, ...options });

/** The number the given cells of row `r<n>` write, as the digits of its places. */
function rowNumber(grid: Grid, row: number): string {
  const digits = new Map<number, string>();
  for (const cell of cellsOf(grid, 'given')) if (cell.part.startsWith(`r${row}-`) && cell.place !== null) digits.set(cell.place, cell.value);
  if (digits.size === 0) return '0';
  const places = [...digits.keys()];
  let text = '';
  for (let at = Math.max(...places, 0); at >= Math.min(...places, 0); at -= 1) {
    text += digits.get(at) ?? '0';
    if (at === 0 && Math.min(...places) < 0) text += '.';
  }
  return showN(text);
}

/** The number the answer cells write. */
function answerNumber(grid: Grid): string {
  const digits = cellsOf(grid, 'answer').filter((cell) => cell.place !== null);
  const places = digits.map((cell) => cell.place as number);
  let text = '';
  for (let at = Math.max(...places); at >= Math.min(...places); at -= 1) {
    text += digits.find((cell) => cell.place === at)?.value ?? '0';
    if (at === 0 && Math.min(...places) < 0) text += '.';
  }
  return showN(text);
}

/** What every grid must be, whatever the method: unique parts, a working order that visits each written cell once, nothing of the answer on show. */
function gridChecks(name: string, grid: Grid | null, options: { worked?: boolean }, answer: string): void {
  if (grid === null) {
    expect(`${name}: a grid`, grid, 'something');
    return;
  }
  expect(`${name}: every part is named once`, new Set(grid.cells.map((cell) => cell.part)).size, grid.cells.length);
  const written = grid.cells.map((cell, at) => ({ cell, at })).filter(({ cell }) => (cell.role === 'carry' || cell.role === 'answer' || cell.role === 'working') && cell.value !== '');
  expect(`${name}: the working order visits every written cell once`, [...grid.order].sort((a, b) => a - b), written.map(({ at }) => at));
  expect(`${name}: each cell knows its place in the order`, grid.order.every((at, index) => grid.cells[at]?.order === index), true);
  expect(`${name}: a cell nobody writes has no place in the order`, grid.cells.every((cell, at) => cell.order === null || grid.order.includes(at)), true);
  expect(`${name}: no two cells share a seat`, new Set(grid.cells.filter((cell) => cell.role !== 'rule').map((cell) => `${cell.row},${cell.col}`)).size, grid.cells.filter((cell) => cell.role !== 'rule').length);
  expect(`${name}: the answer cells say the answer`, answerNumber(grid), showN(answer));
  if (options.worked === true) {
    expect(`${name}: worked fills everything`, grid.cells.filter((cell) => cell.blank), []);
  } else {
    expect(`${name}: the answer cells are blank`, cellsOf(grid, 'answer').every((cell) => cell.blank), true);
    expect(`${name}: no given is blank`, cellsOf(grid, 'given').some((cell) => cell.blank), false);
    // no row on show reads as the answer, and no visible cell is an answer cell
    const answerDigits = grid.answer.replace('.', '');
    for (let row = 0; row < grid.rows; row += 1) {
      const shown = grid.cells.filter((cell) => cell.row === row && !cell.blank && cell.role !== 'sign' && cell.role !== 'rule' && cell.value !== '');
      const given = shown.every((cell) => cell.role === 'given');
      if (!given && shown.length > 1) expect(`${name}: row ${row} on show does not read as the answer`, shown.sort((a, b) => a.col - b.col).map((cell) => cell.value).join('') === answerDigits, false);
    }
    const topGiven = Math.max(...cellsOf(grid, 'given').map((cell) => cell.place ?? 0));
    expect(`${name}: no carry above the leading given digit is on show`, cellsOf(grid, 'carry').some((cell) => !cell.blank && cell.value !== '' && (cell.place as number) > topGiven), false);
    expect(`${name}: no exchange on show is an answer digit`, cellsOf(grid, 'working').some((cell) => !cell.blank && grid.cells.some((one) => one.role === 'answer' && one.place === cell.place && one.value === cell.value)), false);
    expect(`${name}: nothing blank is in the visible text of an answer cell`, cellsOf(grid, 'answer').some((cell) => !cell.blank && cell.value !== ''), false);
  }
}

/** The carry into place `at`, worked out another way: what the places below it come to, over the place. */
function carryInto(operands: readonly string[], at: number, low: number): number {
  const scaled = operands.map((operand) => {
    const dec = maths.readDec(operand) as maths.Dec;
    return dec.n * 10n ** BigInt(-low - dec.scale);
  });
  const unit = 10n ** BigInt(at - low);
  return Number(scaled.reduce((sum, n) => sum + (n % unit), 0n) / unit);
}

function addChecks(operands: readonly string[], options: { worked?: boolean; carry?: 'write' | 'shown' | 'none'; blank?: 'answer' | 'all' } = {}): void {
  const sum = operands.join(' + ');
  const name = `column ${sum} ${JSON.stringify(options)}`;
  const grid = gridOf('column', sum, options);
  const total = operands.map((operand) => maths.readDec(operand) as maths.Dec).reduce(maths.addDec);
  gridChecks(name, grid, options, maths.showDec(total));
  if (grid === null) return;
  operands.forEach((operand, at) => expect(`${name}: row ${at + 1} rebuilds`, rowNumber(grid, at + 1), showN(operand)));
  const low = Math.min(...operands.map((operand) => -(operand.split('.')[1] ?? '').length));
  const places = cellsOf(grid, 'answer').map((cell) => cell.place as number);
  expect(`${name}: the answer's places run right to left in the order`, grid.order.map((at) => grid.cells[at]).filter((cell) => cell?.role === 'answer').map((cell) => cell?.place), [...places].sort((a, b) => a - b));
  for (const cell of cellsOf(grid, 'carry')) expect(`${name}: carry into ${cell.part} agrees with the arithmetic`, Number(cell.value === '' ? '0' : cell.value), carryInto(operands, cell.place as number, low));
  // a carry that is not a cell is a carry of nothing
  for (const at of places.filter((place) => place > low)) {
    const want = carryInto(operands, at, low);
    const cell = grid.cells.find((one) => one.role === 'carry' && one.place === at);
    if (options.carry === 'none') expect(`${name}: no carry cells`, cell, undefined);
    else expect(`${name}: carry into place ${at} is a cell`, Number(cell?.value === '' ? '0' : (cell?.value ?? 'x')), want);
  }
  if (options.worked !== true && options.carry !== 'shown') expect(`${name}: carries are for the learner to write`, cellsOf(grid, 'carry').every((cell) => cell.value === '' || (cell.blank && cell.optional === (options.blank !== 'all'))), true);
  if (options.worked !== true && options.carry === 'shown') expect(`${name}: shown carries are shown, bar the one that is the answer's first digit`, cellsOf(grid, 'carry').every((cell) => !cell.blank || (cell.place as number) > Math.max(...operands.map((operand) => operand.split('.')[0]?.length ?? 1)) - 1), true);
  if (options.worked === true) expect(`${name}: worked shows its carries`, cellsOf(grid, 'carry').every((cell) => !cell.blank), true);
}

function subtractChecks(a: string, b: string, options: { worked?: boolean; carry?: 'write' | 'shown' | 'none'; blank?: 'answer' | 'all' } = {}): void {
  const name = `column ${a} - ${b} ${JSON.stringify(options)}`;
  const grid = gridOf('column', `${a} - ${b}`, options);
  const difference = maths.showDec(maths.subDec(maths.readDec(a) as maths.Dec, maths.readDec(b) as maths.Dec));
  gridChecks(name, grid, options, difference);
  if (grid === null) return;
  expect(`${name}: the top row rebuilds`, rowNumber(grid, 1), showN(a));
  expect(`${name}: the bottom row rebuilds`, rowNumber(grid, 2), showN(b));
  // the exchange keeps the value of the top number, and leaves each place enough to take its digit away
  if (options.carry !== 'none') {
    const top = new Map<number, number>();
    for (const cell of cellsOf(grid, 'given')) if (cell.part.startsWith('r1-') && cell.place !== null) top.set(cell.place, Number(cell.value));
    const bottom = new Map<number, number>();
    for (const cell of cellsOf(grid, 'given')) if (cell.part.startsWith('r2-') && cell.place !== null) bottom.set(cell.place, Number(cell.value));
    const was = [...top].reduce((sum, [place, digit]) => sum + BigInt(digit) * 10n ** BigInt(place + 3), 0n);
    for (const cell of cellsOf(grid, 'working')) top.set(cell.place as number, Number(cell.value));
    const now = [...top].reduce((sum, [place, digit]) => sum + BigInt(digit) * 10n ** BigInt(place + 3), 0n);
    expect(`${name}: the exchange keeps the value of the top number`, String(now), String(was));
    for (const cell of cellsOf(grid, 'answer')) expect(`${name}: ${cell.part} is what is left in its place`, (top.get(cell.place as number) ?? 0) - (bottom.get(cell.place as number) ?? 0), Number(cell.value));
    for (const cell of cellsOf(grid, 'working')) {
      const crossed = grid.cells.find((one) => one.role === 'given' && one.part === `r1-${maths.placeName(cell.place as number)}`);
      expect(`${name}: ${cell.part} sits over a crossed digit`, crossed?.crossed, true);
    }
    expect(`${name}: only an exchanged digit is crossed`, cellsOf(grid, 'given').filter((cell) => cell.crossed).length, cellsOf(grid, 'working').length);
  }
  if (options.carry === 'none') expect(`${name}: no exchange cells`, cellsOf(grid, 'working').length, 0);
}

function timesChecks(n: string, d: string, options: { worked?: boolean; carry?: 'write' | 'shown' | 'none'; blank?: 'answer' | 'all' } = {}): void {
  const name = `times ${n} × ${d} ${JSON.stringify(options)}`;
  const grid = gridOf('times', `${n} × ${d}`, options);
  gridChecks(name, grid, options, (BigInt(n) * BigInt(d)).toString());
  if (grid === null) return;
  expect(`${name}: the number rebuilds`, rowNumber(grid, 1), n);
  expect(`${name}: the digit rebuilds`, rowNumber(grid, 2), d);
  for (const cell of cellsOf(grid, 'carry')) {
    const at = cell.place as number;
    expect(`${name}: carry into ${cell.part} agrees with the arithmetic`, Number(cell.value === '' ? '0' : cell.value), Number((BigInt(n) % 10n ** BigInt(at)) * BigInt(d) / 10n ** BigInt(at)));
  }
  expect(`${name}: the answer's places run right to left`, grid.order.map((at) => grid.cells[at]).filter((cell) => cell?.role === 'answer').map((cell) => cell?.place), cellsOf(grid, 'answer').map((cell) => cell.place as number).sort((a, b) => a - b));
}

function splitChecks(n: string, options: { worked?: boolean } = {}): void {
  const name = `split ${n} ${JSON.stringify(options)}`;
  const grid = gridOf('split', n, options);
  if (grid === null) {
    expect(`${name}: a grid`, grid, 'something');
    return;
  }
  const parts = cellsOf(grid, 'answer');
  const total = parts.map((cell) => maths.readDec(cell.value) as maths.Dec).reduce(maths.addDec, { n: 0n, scale: 0 });
  expect(`${name}: the parts add up to the number`, maths.showDec(total), n);
  expect(`${name}: every part is one digit's value`, parts.every((cell) => /^[1-9]0*$|^0\.0*[1-9]$/.test(cell.value)), true);
  expect(`${name}: the order runs left to right`, grid.order.map((at) => grid.cells[at]?.place), parts.map((cell) => cell.place as number).sort((a, b) => b - a));
  expect(`${name}: the digits rebuild`, rowNumber(grid, 1), n);
  expect(`${name}: the parts are not on show`, options.worked === true ? 0 : parts.filter((cell) => !cell.blank).length, 0);
  if (options.worked === true) expect(`${name}: worked fills everything`, grid.cells.filter((cell) => cell.blank), []);
  expect(`${name}: the working order visits every part once`, [...grid.order].sort((a, b) => a - b), grid.cells.map((cell, at) => (cell.role === 'answer' ? at : -1)).filter((at) => at >= 0));
}

function bondChecks(sum: string, unknown: string, options: { worked?: boolean } = {}): void {
  const name = `bond ${sum} ${JSON.stringify(options)}`;
  const grid = gridOf('bond', sum, options);
  if (grid === null) {
    expect(`${name}: a grid`, grid, 'something');
    return;
  }
  const given = cellsOf(grid, 'given').map((cell) => cell.value);
  const answer = cellsOf(grid, 'answer');
  expect(`${name}: one number to find`, answer.map((cell) => cell.value), [unknown]);
  const at = (row: number, col: number): maths.Dec => maths.readDec(grid.cells.find((cell) => cell.row === row && cell.col === col)?.value ?? '0') as maths.Dec;
  expect(`${name}: the numbers make a bond`, maths.showDec(maths.addDec(at(1, 0), at(1, 2))), maths.showDec(at(0, 1)));
  expect(`${name}: the answer is not on show`, options.worked === true ? 0 : answer.filter((cell) => !cell.blank).length, 0);
  expect(`${name}: the other numbers are given`, given.length, 2);
  expect(`${name}: the order is the one cell`, grid.order.length, 1);
}

function writtenChecks(): void {
  // the contract: read, round-tripped, refused
  const lines = [
    'math m1 column | 12 + 12 + 12 + 12 + 12 + 12',
    'math m2 column worked blank=all carry=shown steps | 503 - 278',
    'math m3 times step=s1 | 47 × 6',
    'math m4 split | 347',
    'math m5 bond blank=answer carry=none | 10 = 4 + ?',
    'math m6 column | 3.4 + 12.75',
    'math m7 bar | 3/4',
    'math m8 groups | 12 ÷ 3',
    'math m9 array | 3 × 4',
    'math m10 line | 7 + 5',
    'set m1.carry-tens mark=box',
    'set m1.s2 mark=box',
    'hit m1.tens pulse',
    'fill m1 | 72',
    'fill m1.ans-ones | 2',
    'say - near=m1.r3:below | This row',
  ];
  for (const line of lines) {
    const read = parseLine(line);
    expect(`math: ${line} reads`, read.kind, 'line');
    if (read.kind === 'line') expect(`math: ${line} reads back as itself`, serializeLine(read.line), line);
  }
  const loose = parseLine('math m1 column | 12+12 + 12');
  expect('math: a loose sum is written in one form', loose.kind === 'line' ? serializeLine(loose.line) : null, 'math m1 column | 12 + 12 + 12');
  const timesSign = parseLine('math m1 times | 47 x 6');
  expect('math: x is a times sign', timesSign.kind === 'line' ? serializeLine(timesSign.line) : null, 'math m1 times | 47 × 6');
  for (const refused of ['math m1 column', 'math m1 column | 5 - 8', 'math m1 column | 12 × 3', 'math m1 times | 12 × 34', 'math m1 times | 1.5 × 3', 'math m1 divide | 12 ÷ 3', 'math m1 bond | 10 = 4 + 5', 'math m1 bond | 10 = ? + ?', 'math column | 1 + 1', 'math m1 column | 1 +', 'math m1 split | abc', 'math m1 column | 1 + 2 - 3']) {
    expect(`math: ${refused} is refused`, parseLine(refused).kind, 'reject');
  }
  expect('math: a part that is no part is no part', maths.isMathPart('m1'), false);
  expect('math: parts of a method', ['r3', 'r3-tens', 'tens', 'carry-tens', 'ans-ones', 'rule', 's2', 'ex-hundreds', 'sign', 'sign2'].map(maths.isMathPart), [true, true, true, true, true, true, true, true, true, true]);
  expect('math: row2 is a table\'s and not a method\'s', ['row2', 'cell2,3', 'carry', 'ans-', 'r0'].map(maths.isMathPart), [false, false, false, false, false]);
  const read = (method: 'column' | 'times' | 'split' | 'bond', text: string): string[] => {
    const sum = maths.readSum(method, text);
    return sum.ok ? [...maths.answerOf(sum.sum)] : ['unread'];
  };
  expect('math: the answer is worked out for the seal', [read('column', '12+12+12+12+12+12'), read('column', '503-278'), read('column', '3.4+12.75'), read('times', '47 x 6'), read('split', '347'), read('bond', '10 = 4 + ?'), read('bond', '? = 4 + 6')], [['72'], ['225'], ['16.15'], ['282'], ['300', '40', '7'], ['6'], ['10']]);
  expect('math: 0.1 + 0.2 is 0.3 and not a float', read('column', '0.1 + 0.2'), ['0.3']);
  expect('math: what the sum itself shows is no secret', read('column', '10 - 0'), []);

  // the seal: a say that states the answer is refused, a worked one is free to
  const guard = (lines: readonly string[]): string[] => {
    const normalizer = new LineNormalizer(() => 'x1');
    return lines.map((text) => {
      const parsed = parseLine(text);
      return parsed.kind === 'line' ? (normalizer.normalize(parsed.line).line === null ? 'refused' : 'ok') : 'unread';
    });
  };
  expect('math: a say that states the answer is refused', guard(['math m1 column | 12+12+12+12+12+12', 'say | Six twelves make 72', 'say | Start with the ones', 'say | There are 6 rows of 12']), ['ok', 'refused', 'ok', 'ok']);
  expect('math: a worked method seals nothing', guard(['math m1 column worked | 12+12+12+12+12+12', 'say | Six twelves make 72']), ['ok', 'ok']);
  expect('math: a new scene lifts the seal', guard(['math m1 column | 12+12', 'scene', 'say | Twenty four']), ['ok', 'ok', 'ok']);

  // the sums of the issue, as cells
  const twelves = gridOf('column', '12 + 12 + 12 + 12 + 12 + 12');
  expect('column: six 12s carry a 1 into the tens', twelves === null ? null : [twelves.answer, cellsOf(twelves, 'carry').filter((cell) => cell.value !== '').map((cell) => `${cell.part}=${cell.value}`)], ['72', ['carry-tens=1']]);
  const crossZero = gridOf('column', '503 - 278');
  expect('column: 503 - 278 exchanges across the zero', crossZero === null ? null : cellsOf(crossZero, 'working').map((cell) => `${cell.part}=${cell.value}`), ['ex-hundreds=4', 'ex-tens=9', 'ex-ones=13']);
  const fortySeven = gridOf('times', '47 × 6');
  expect('times: 47 × 6 carries a 4', fortySeven === null ? null : [fortySeven.answer, cellsOf(fortySeven, 'carry').map((cell) => `${cell.part}=${cell.value}`)], ['282', ['carry-tens=4', 'carry-hundreds=2']]);
  const newColumn = gridOf('column', '99 + 1');
  expect('column: a carry into a new column writes it as the answer digit', newColumn === null ? null : [newColumn.answer, newColumn.cols, cellsOf(newColumn, 'answer').map((cell) => cell.value)], ['100', 4, ['0', '0', '1']]);
  expect('column: the point is drawn between the ones and the tenths', gridOf('column', '3.4 + 12.75')?.pointAfter, 0);

  // ranges
  for (const options of [{}, { worked: true }, { carry: 'shown' as const }, { carry: 'none' as const }, { blank: 'all' as const }, { worked: true, carry: 'none' as const }]) {
    for (const operands of [['12', '12', '12', '12', '12', '12'], ['99', '1'], ['999', '1'], ['0', '0'], ['9', '9', '9', '9', '9', '9', '9', '9'], ['3.4', '12.75'], ['0.5', '0.5'], ['0.1', '0.2'], ['99.99', '0.01'], ['1000', '1'], ['7', '8', '9'], ['105', '95'], ['25', '75', '50']]) addChecks(operands, options);
    for (const [a, b] of [['503', '278'], ['100', '1'], ['5003', '2008'], ['1000', '999'], ['7000', '6999'], ['5.2', '1.75'], ['10', '0.01'], ['9', '9'], ['10', '0'], ['400', '399'], ['30', '7'], ['62', '47'], ['201', '99']]) subtractChecks(a as string, b as string, options);
    for (const [n, d] of [['47', '6'], ['9', '9'], ['99', '9'], ['100', '5'], ['305', '0'], ['47', '0'], ['47', '1'], ['999', '9'], ['12345', '8']]) timesChecks(n as string, d as string, options);
  }
  for (let a = 0; a <= 60; a += 1) for (let b = 0; b <= 60; b += 7) {
    addChecks([String(a), String(b)]);
    if (a >= b) subtractChecks(String(a), String(b));
  }
  // a lot of subtractions, across zeros and not
  let seed = 7;
  const next = (to: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % to;
  };
  for (let at = 0; at < 400; at += 1) {
    const a = next(100000);
    const b = next(a + 1);
    subtractChecks(String(a), String(b));
    addChecks([String(next(5000)), String(next(5000)), String(next(300))]);
    timesChecks(String(1 + next(99999)), String(next(10)));
    const fraction = (): string => `${next(300)}.${String(next(1000)).padStart(1 + next(3), '0')}`.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    addChecks([fraction(), fraction(), String(next(40))]);
    const x = fraction();
    const y = fraction();
    if ((maths.compareDec(maths.readDec(x) as maths.Dec, maths.readDec(y) as maths.Dec)) >= 0) subtractChecks(x, y);
    else subtractChecks(y, x);
  }
  for (const n of ['347', '503', '7', '10', '1000', '3.47', '0.5', '12.05', '999999999']) {
    splitChecks(n);
    splitChecks(n, { worked: true });
  }
  for (const [sum, unknown] of [['10 = 4 + ?', '6'], ['10 = ? + 4', '6'], ['? = 4 + 6', '10'], ['100 = 35 + ?', '65'], ['1 = 0.25 + ?', '0.75'], ['0 = 0 + ?', '0']] as const) {
    bondChecks(sum, unknown);
    bondChecks(sum, unknown, { worked: true });
  }
  const picture = maths.readSum('groups', '12 ÷ 3');
  expect('pictures have no grid', picture.ok ? maths.written(picture.sum) : 'unread', null);
}

/** Run by `pnpm timeline`. */
export function mathsChecks(): boolean {
  exactChecks();
  unitChecks();
  stepChecks();
  questionChecks();
  relationChecks();
  pieceChecks();
  lessonChecks();
  workingChecks();
  orderChecks();
  hardChecks();
  writtenChecks();
  process.stdout.write(`\nmaths checks: ${passed + failed} cases, ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}
