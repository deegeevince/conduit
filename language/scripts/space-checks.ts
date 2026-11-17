// Depth as pure geometry (PLAN-depth.md, D1): lifting, turning, projecting, resampling, cutting at the limb and ordering, with no browser and no drawing.
// Run by `pnpm timeline`. The hand's solver (handle.ts) has its own file; `spaceChecks` runs it after these so the one line in timeline.ts covers both.
import { clipFront, depthOf, lift, project, resampleOnSphere, turn } from '../src/space';
import type { P3, SpaceFrame, SpaceView } from '../src/space';
import { handleChecks, seeded } from './handle-checks';

const RAD = Math.PI / 180;
const sphere = (r: number): SpaceFrame => ({ kind: 'sphere', r });
const FLAT: SpaceFrame = { kind: 'flat' };

/** The turn written out the long way, with plain matrices in radians: yaw about the vertical, then pitch about the horizontal, then roll about the line of sight. */
function turnByMatrices(p: P3, view: SpaceView): P3 {
  const [cy, sy] = [Math.cos(view.yaw * RAD), Math.sin(view.yaw * RAD)];
  const [cp, sp] = [Math.cos(view.pitch * RAD), Math.sin(view.pitch * RAD)];
  const [cr, sr] = [Math.cos(view.roll * RAD), Math.sin(view.roll * RAD)];
  const afterYaw = { x: cy * p.x + sy * p.z, y: p.y, z: -sy * p.x + cy * p.z };
  const afterPitch = { x: afterYaw.x, y: cp * afterYaw.y + sp * afterYaw.z, z: -sp * afterYaw.y + cp * afterYaw.z };
  return { x: cr * afterPitch.x - sr * afterPitch.y, y: sr * afterPitch.x + cr * afterPitch.y, z: afterPitch.z };
}

/** The area a polygon covers on the screen (its x and y, shoelace). */
function areaOf(points: readonly P3[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a !== undefined && b !== undefined) twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

/** The signed version: its sign says which way round a polygon goes on the screen. */
function windingOf(points: readonly P3[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a !== undefined && b !== undefined) twice += a.x * b.y - b.x * a.y;
  }
  return twice;
}

export function spaceChecks(): boolean {
  let ok = true;
  const expect = (what: string, got: unknown, want: unknown): void => {
    if (got !== want) {
      ok = false;
      process.stdout.write(`  SPACE CHECK FAILED: ${what} (got ${String(got)}, wanted ${String(want)})\n`);
    }
  };
  const within = (what: string, got: number, want: number, tolerance: number): void => {
    if (!(Math.abs(got - want) <= tolerance)) {
      ok = false;
      process.stdout.write(`  SPACE CHECK FAILED: ${what} (got ${got}, wanted ${want}, to ${tolerance})\n`);
    }
  };
  const at = (what: string, got: P3, want: P3, tolerance = 0): void => {
    const off = Math.max(Math.abs(got.x - want.x), Math.abs(got.y - want.y), Math.abs(got.z - want.z));
    if (!(off <= tolerance)) {
      ok = false;
      process.stdout.write(`  SPACE CHECK FAILED: ${what} (got ${got.x},${got.y},${got.z}, wanted ${want.x},${want.y},${want.z}${tolerance > 0 ? `, to ${tolerance}` : ', exactly'})\n`);
    }
  };

  // Lifting: a flat point is itself with z = 0 unless said; a sphere point is lat,lon (north and east positive) with an optional height.
  {
    at('flat: two numbers, z is 0', lift({ x: 3, y: 4 }, FLAT), { x: 3, y: 4, z: 0 });
    at('flat: three numbers', lift({ x: 3, y: 4, z: 5 }, FLAT), { x: 3, y: 4, z: 5 });
    const ball = sphere(10);
    at('sphere: 0,0 is the centre of the disk, facing you', lift({ x: 0, y: 0 }, ball), { x: 0, y: 0, z: 10 });
    at('sphere: the north pole is the top', lift({ x: 90, y: 0 }, ball), { x: 0, y: -10, z: 0 });
    at('sphere: the south pole is the bottom', lift({ x: -90, y: 0 }, ball), { x: 0, y: 10, z: 0 });
    at('sphere: east is to the right', lift({ x: 0, y: 90 }, ball), { x: 10, y: 0, z: 0 });
    at('sphere: west is to the left', lift({ x: 0, y: -90 }, ball), { x: -10, y: 0, z: 0 });
    at('sphere: the far side is behind', lift({ x: 0, y: 180 }, ball), { x: 0, y: 0, z: -10 });
    at('sphere: a height lifts off the surface', lift({ x: 0, y: 0, z: 5 }, ball), { x: 0, y: 0, z: 15 });
    expect('sphere: north is up the screen (y falls)', lift({ x: 30, y: 0 }, ball).y < 0, true);
    expect('sphere: east is right (x rises)', lift({ x: 0, y: 30 }, ball).x > 0, true);
    let worst = 0;
    for (let lat = -90; lat <= 90; lat += 15) {
      for (let lon = -180; lon <= 180; lon += 15) {
        for (const height of [0, 3]) {
          const radius = 10 + height;
          const want = { x: radius * Math.cos(lat * RAD) * Math.sin(lon * RAD), y: -radius * Math.sin(lat * RAD), z: radius * Math.cos(lat * RAD) * Math.cos(lon * RAD) };
          const got = lift({ x: lat, y: lon, z: height }, ball);
          worst = Math.max(worst, Math.abs(got.x - want.x), Math.abs(got.y - want.y), Math.abs(got.z - want.z), Math.abs(Math.hypot(got.x, got.y, got.z) - radius));
        }
      }
    }
    within('sphere: 13 x 25 points at two heights agree with the formula', worst, 0, 1e-9);
  }

  // Turning: whole turns are the identity, quarter turns are exact, and the order and signs are yaw, pitch, roll as the plan says.
  {
    const next = seeded(1);
    const point = (): P3 => ({ x: (next() - 0.5) * 200, y: (next() - 0.5) * 200, z: (next() - 0.5) * 200 });
    for (let i = 0; i < 50; i += 1) {
      const p = point();
      const turns = [{ yaw: 360, pitch: 0, roll: 0 }, { yaw: 0, pitch: 360, roll: 0 }, { yaw: 0, pitch: 0, roll: 360 }, { yaw: 720, pitch: -360, roll: 1080 }];
      for (const view of turns) {
        const got = turn(p, view);
        if (got.x !== p.x || got.y !== p.y || got.z !== p.z) expect(`a whole turn is the identity (${JSON.stringify(view)})`, JSON.stringify(got), JSON.stringify(p));
      }
    }
    const quarter: readonly [string, P3, SpaceView, P3][] = [
      ['yaw 90: the near side goes right', { x: 0, y: 0, z: 10 }, { yaw: 90, pitch: 0, roll: 0 }, { x: 10, y: 0, z: 0 }],
      ['yaw 90: the right goes to the back', { x: 10, y: 0, z: 0 }, { yaw: 90, pitch: 0, roll: 0 }, { x: 0, y: 0, z: -10 }],
      ['yaw 180: the front is the back', { x: 0, y: 0, z: 10 }, { yaw: 180, pitch: 0, roll: 0 }, { x: 0, y: 0, z: -10 }],
      ['yaw 270: the near side goes left', { x: 0, y: 0, z: 10 }, { yaw: 270, pitch: 0, roll: 0 }, { x: -10, y: 0, z: 0 }],
      ['yaw -90 is yaw 270', { x: 0, y: 0, z: 10 }, { yaw: -90, pitch: 0, roll: 0 }, { x: -10, y: 0, z: 0 }],
      ['yaw 450 is yaw 90', { x: 0, y: 0, z: 10 }, { yaw: 450, pitch: 0, roll: 0 }, { x: 10, y: 0, z: 0 }],
      ['pitch 90: the top comes to the viewer', { x: 0, y: -10, z: 0 }, { yaw: 0, pitch: 90, roll: 0 }, { x: 0, y: 0, z: 10 }],
      ['pitch 90: the front goes down', { x: 0, y: 0, z: 10 }, { yaw: 0, pitch: 90, roll: 0 }, { x: 0, y: 10, z: 0 }],
      ['roll 90: clockwise on the screen, as turnAbout is', { x: 10, y: 0, z: 0 }, { yaw: 0, pitch: 0, roll: 90 }, { x: 0, y: 10, z: 0 }],
      ['roll 90: down goes left', { x: 0, y: 10, z: 0 }, { yaw: 0, pitch: 0, roll: 90 }, { x: -10, y: 0, z: 0 }],
      ['roll leaves depth alone', { x: 3, y: 4, z: 7 }, { yaw: 0, pitch: 0, roll: 90 }, { x: -4, y: 3, z: 7 }],
    ];
    for (const [what, p, view, want] of quarter) at(`quarter turns are exact: ${what}`, turn(p, view), want);
    // any mix of quarter turns keeps a point on the axes, with nothing a hair off
    const mixes = [-270, -180, -90, 0, 90, 180, 270, 360, 450];
    let fuzz = 0;
    for (const yaw of mixes) {
      for (const pitch of mixes) {
        for (const roll of mixes) {
          for (const p of [{ x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }, { x: 0, y: 0, z: 10 }]) {
            const got = turn(p, { yaw, pitch, roll });
            for (const value of [got.x, got.y, got.z]) if (value !== 0 && Math.abs(value) !== 10) fuzz += 1;
          }
        }
      }
    }
    expect('quarter turns in any mix leave only 0 and +-10, exactly', fuzz, 0);

    // yaw 90 puts longitude -90 at the centre: the Earth turns as it does, west to east
    at('yaw 90 puts lon -90 at the centre', turn(lift({ x: 0, y: -90 }, sphere(10)), { yaw: 90, pitch: 0, roll: 0 }), { x: 0, y: 0, z: 10 });
    const lat30 = turn(lift({ x: 30, y: -90 }, sphere(10)), { yaw: 90, pitch: 0, roll: 0 });
    expect('yaw 90 brings lon -90 to x = 0 at any latitude', lat30.x, 0);
    expect('and it faces you', lat30.z > 8, true);
    expect('a positive yaw moves the near side to the right', turn({ x: 0, y: 0, z: 10 }, { yaw: 10, pitch: 0, roll: 0 }).x > 0, true);
    at('yaw 180 brings lon 180 to the centre', turn(lift({ x: 0, y: 180 }, sphere(10)), { yaw: 180, pitch: 0, roll: 0 }), { x: 0, y: 0, z: 10 });
    // pitch 90 puts the north pole at the centre; a small pitch tips it towards you
    at('pitch 90 puts the north pole at the centre', turn(lift({ x: 90, y: 0 }, sphere(10)), { yaw: 0, pitch: 90, roll: 0 }), { x: 0, y: 0, z: 10 });
    const tipped = turn(lift({ x: 90, y: 0 }, sphere(10)), { yaw: 0, pitch: 20, roll: 0 });
    within('pitch 20 tips the north pole 20 degrees towards you: z = r sin 20', tipped.z, 10 * Math.sin(20 * RAD), 1e-9);
    within('and it stands at y = -r cos 20', tipped.y, -10 * Math.cos(20 * RAD), 1e-9);

    // the order: yaw first, then pitch, then roll
    at('order: yaw 90 then pitch 90 takes the front to the right (pitch first would take it down)', turn({ x: 0, y: 0, z: 10 }, { yaw: 90, pitch: 90, roll: 0 }), { x: 10, y: 0, z: 0 });
    at('order: pitch 90 then roll 90 takes the right to down (roll first would take it to the back)', turn({ x: 10, y: 0, z: 0 }, { yaw: 0, pitch: 90, roll: 90 }), { x: 0, y: 10, z: 0 });
    let worst = 0;
    for (let i = 0; i < 300; i += 1) {
      const p = point();
      const view = { yaw: (next() - 0.5) * 720, pitch: (next() - 0.5) * 720, roll: (next() - 0.5) * 720 };
      const a = turn(p, view);
      const b = turnByMatrices(p, view);
      worst = Math.max(worst, Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
    }
    within('300 random turns agree with the matrices applied yaw, pitch, roll', worst, 0, 1e-9);
    // a turn keeps length
    let drift = 0;
    for (let i = 0; i < 100; i += 1) {
      const p = point();
      const t = turn(p, { yaw: (next() - 0.5) * 720, pitch: (next() - 0.5) * 720, roll: (next() - 0.5) * 720 });
      drift = Math.max(drift, Math.abs(Math.hypot(t.x, t.y, t.z) - Math.hypot(p.x, p.y, p.z)));
    }
    within('a turn keeps a point its distance from the centre', drift, 0, 1e-9);
  }

  // Projection is orthographic: depth changes nothing about where a point lands.
  {
    const a = project({ x: 3, y: -4, z: 99 });
    const b = project({ x: 3, y: -4, z: -99 });
    expect('orthographic: x and y are the screen', `${a.x},${a.y}`, '3,-4');
    expect('orthographic: depth does not move a point', `${b.x},${b.y}`, '3,-4');
    expect('no negative zero on the screen', Object.is(project({ x: -0, y: -0, z: 0 }).x, 0), true);
  }

  // Resampling: segments of at most 5 degrees of arc, every written point kept, and an atlas's way between two points.
  {
    const equator = resampleOnSphere({ points: [{ x: 0, y: -180 }, { x: 0, y: 180 }], closed: false });
    expect('an equator is 72 segments', equator.points.length - 1, 72);
    expect('and its ends are the written ones', `${equator.points[0]?.y},${equator.points[72]?.y}`, '-180,180');
    expect('and every step is 5 degrees of longitude', equator.points.every((p, i) => i === 0 || Math.abs(p.y - (equator.points[i - 1]?.y ?? 0) - 5) < 1e-9 && p.x === 0), true);
    expect('a coarser limit gives fewer segments', resampleOnSphere({ points: [{ x: 0, y: -180 }, { x: 0, y: 180 }], closed: false }, 10).points.length - 1, 36);
    expect('a meridian from pole to pole is 36 segments', resampleOnSphere({ points: [{ x: -90, y: 0 }, { x: 90, y: 0 }], closed: false }).points.length - 1, 36);
    expect('a parallel at 60 degrees is half as far in arc: 36 segments', resampleOnSphere({ points: [{ x: 60, y: -180 }, { x: 60, y: 180 }], closed: false }).points.length - 1, 36);
    expect('a short line is one segment', resampleOnSphere({ points: [{ x: 10, y: 10 }, { x: 12, y: 13 }], closed: false }).points.length, 2);
    const square = resampleOnSphere({ points: [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }], closed: true });
    expect('a closed square of 10 degrees is 8 stretches of 5, and stays closed', `${square.points.length},${square.closed}`, '8,true');
    expect('every written corner is kept', [[0, 0], [0, 10], [10, 10], [10, 0]].every(([x, y]) => square.points.some((p) => p.x === x && p.y === y)), true);
    expect('one point has nothing to resample', resampleOnSphere({ points: [{ x: 1, y: 2 }], closed: false }).points.length, 1);
    // no step is more than the limit, on the ball, over random lines
    const next = seeded(7);
    let longest = 0;
    for (let i = 0; i < 200; i += 1) {
      const line = { closed: next() < 0.3, points: [0, 1, 2].map(() => ({ x: (next() - 0.5) * 170, y: (next() - 0.5) * 400 })) };
      const lifted = resampleOnSphere(line).points.map((p) => lift(p, sphere(1)));
      for (let k = 1; k < lifted.length; k += 1) {
        const a = lifted[k - 1];
        const b = lifted[k];
        if (a === undefined || b === undefined) continue;
        const dot = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
        longest = Math.max(longest, Math.acos(dot) / RAD);
      }
    }
    expect(`no step is more than 5 degrees of arc over 200 random lines (longest ${longest.toFixed(3)})`, longest <= 5 + 1e-6, true);
  }

  // The limb: a polygon that straddles it is cut at z = 0 and closed along the limb's arc.
  {
    const R = 100;
    const view: SpaceView = { yaw: 0, pitch: 0, roll: 0 };
    const patch = (lat0: number, lat1: number, lon0: number, lon1: number, yaw = 0): P3[] =>
      resampleOnSphere({ closed: true, points: [{ x: lat0, y: lon0 }, { x: lat0, y: lon1 }, { x: lat1, y: lon1 }, { x: lat1, y: lon0 }] }).points.map((p) => turn(lift(p, sphere(R)), { ...view, yaw }));
    const sane = (what: string, outlines: readonly (readonly P3[])[]): void => {
      let behind = 0;
      let offLimb = 0;
      for (const outline of outlines) {
        for (const p of outline) {
          if (p.z < -1e-9) behind += 1;
          if (Math.abs(p.z) < 1e-12 && Math.abs(Math.hypot(p.x, p.y) - R) > 1e-9) offLimb += 1;
        }
      }
      expect(`${what}: nothing of it is behind the limb`, behind, 0);
      expect(`${what}: what lies on the limb lies on the circle of radius r`, offLimb, 0);
    };

    // half the area: a patch of lat -30..30 and lon 60..120 is cut in two by the limb at lon 90; the half in front covers r^2 x (pi/6 + sin(60)/2) x (1 - sin 60) on the screen
    const half = clipFront(patch(-30, 30, 60, 120), true, R);
    const wantHalf = R * R * (Math.PI / 6 + Math.sin(60 * RAD) / 2) * (1 - Math.sin(60 * RAD));
    expect('a patch across the limb is one outline', half.length, 1);
    within('half the patch: the part in front covers its share of the screen, to 2%', areaOf(half[0] ?? []) / wantHalf, 1, 0.02);
    sane('a patch across the limb', half);
    const mirrored = clipFront(patch(-30, 30, 60, 120, 180).map((p) => ({ ...p })), true, R);
    // the same patch seen from the other side (yaw 180) shows the other half, which covers the same on the screen
    within('and the half behind, seen from the other side, covers the same', areaOf(mirrored[0] ?? []) / areaOf(half[0] ?? []), 1, 0.02);
    expect('the cut is closed along the arc, not straight across: more than 8 points lie on the limb', (half[0] ?? []).filter((p) => p.z === 0).length > 8, true);

    // a round patch: a cap of 25 degrees centred on the limb at the right; the front half covers r^2 (rho - sin(2 rho)/2) on the screen
    const rho = 25 * RAD;
    const cap: P3[] = [];
    for (let k = 0; k < 144; k += 1) {
      const bearing = (k * 2.5 * Math.PI) / 180;
      cap.push({ x: R * Math.cos(rho), y: -R * Math.sin(rho) * Math.cos(bearing), z: R * Math.sin(rho) * Math.sin(bearing) });
    }
    const capped = clipFront(cap, true, R);
    expect('a cap across the limb is one outline', capped.length, 1);
    within('the front half of a round cap, to 2%', areaOf(capped[0] ?? []) / (R * R * (rho - Math.sin(2 * rho) / 2)), 1, 0.02);
    sane('a cap across the limb', capped);
    expect('the same cap written the other way round gives the same patch (its smaller side)', Math.round(areaOf(clipFront([...cap].reverse(), true, R)[0] ?? [])), Math.round(areaOf(capped[0] ?? [])));
    // a cap whose centre is 10 degrees in front of the limb, so more than half of it faces you: the area on the screen is integrated over its surface
    {
      const rho2 = 30 * RAD;
      const c = { x: Math.cos(10 * RAD), y: 0, z: Math.sin(10 * RAD) };
      const e1 = { x: 0, y: -1, z: 0 };
      const e2 = { x: c.y * e1.z - c.z * e1.y, y: c.z * e1.x - c.x * e1.z, z: c.x * e1.y - c.y * e1.x };
      const onCap = (rho: number, bearing: number): P3 => ({
        x: R * (Math.cos(rho) * c.x + Math.sin(rho) * (Math.cos(bearing) * e1.x + Math.sin(bearing) * e2.x)),
        y: R * (Math.cos(rho) * c.y + Math.sin(rho) * (Math.cos(bearing) * e1.y + Math.sin(bearing) * e2.y)),
        z: R * (Math.cos(rho) * c.z + Math.sin(rho) * (Math.cos(bearing) * e1.z + Math.sin(bearing) * e2.z)),
      });
      const ring: P3[] = [];
      for (let k = 0; k < 144; k += 1) ring.push(onCap(rho2, (k * 2.5 * Math.PI) / 180));
      let want = 0;
      const rings = 500;
      const spokes = 500;
      for (let i = 0; i < rings; i += 1) {
        const rho = ((i + 0.5) * rho2) / rings;
        for (let j = 0; j < spokes; j += 1) {
          const p = onCap(rho, ((j + 0.5) * 2 * Math.PI) / spokes);
          if (p.z > 0) want += (p.z / R) * R * R * Math.sin(rho) * (rho2 / rings) * ((2 * Math.PI) / spokes);
        }
      }
      const tilted = clipFront(ring, true, R);
      expect('a cap mostly in front is one outline', tilted.length, 1);
      within('and it covers its share of the screen, to 2%', areaOf(tilted[0] ?? []) / want, 1, 0.02);
      sane('a cap mostly in front', tilted);
    }

    // empty behind, kept in front
    expect('a polygon wholly behind is nothing', clipFront(patch(-10, 10, 160, 200), true, R).length, 0);
    expect('a line wholly behind is nothing', clipFront(patch(-10, 10, 160, 200), false, R).length, 0);
    expect('nothing is nothing', clipFront([], true, R).length, 0);
    const front = patch(-10, 10, -20, 20);
    const kept = clipFront(front, true, R);
    expect('a polygon wholly in front is kept: one outline', kept.length, 1);
    expect('with every point it had, as it had them', JSON.stringify(kept[0]), JSON.stringify(front));
    const keptLine = clipFront(front, false, R);
    expect('a line wholly in front is kept the same way', JSON.stringify(keptLine[0]), JSON.stringify(front));

    // a band that goes behind at both ends is one patch, cut at both limbs
    const band = clipFront(patch(0, 10, -100, 100), true, R);
    expect('a band round both limbs is one outline', band.length, 1);
    sane('a band round both limbs', band);
    const wantBand = R * R * (10 * RAD / 2 + Math.sin(20 * RAD) / 4) * (2 * Math.sin(90 * RAD));
    within('and it covers what the formula says, to 2%', areaOf(band[0] ?? []) / wantBand, 1, 0.02);
    // a band behind the globe whose two ends come round both limbs is two separate patches
    const strip = clipFront(patch(0, 10, 70, 290), true, R);
    expect('a band behind the globe, its ends round both limbs, is two outlines', strip.length, 2);
    sane('the two ends of a band', strip);
    const wantEnd = R * R * (10 * RAD / 2 + Math.sin(20 * RAD) / 4) * (1 - Math.sin(70 * RAD));
    for (const [i, outline] of strip.entries()) within(`and end ${i + 1} covers what the formula says, to 3%`, areaOf(outline) / wantEnd, 1, 0.03);
    // a horseshoe: an arc of land whose two tips go behind is one outline with both tips cut off along the limb
    const shoe = clipFront(
      resampleOnSphere({ closed: true, points: [{ x: -20, y: 30 }, { x: -20, y: 110 }, { x: -10, y: 110 }, { x: -10, y: 40 }, { x: 10, y: 40 }, { x: 10, y: 110 }, { x: 20, y: 110 }, { x: 20, y: 30 }] }).points.map((p) => lift(p, sphere(R))),
      true,
      R,
    );
    expect('a horseshoe with both tips behind the limb is one outline', shoe.length, 1);
    sane('a horseshoe', shoe);

    // lines
    const equator = resampleOnSphere({ closed: false, points: [{ x: 0, y: -180 }, { x: 0, y: 180 }] }).points.map((p) => lift(p, sphere(R)));
    const seen = clipFront(equator, false, R);
    expect('the equator cut at the limb is one line', seen.length, 1);
    expect('of the 37 points from lon -90 to 90, the two on the limb exact', `${seen[0]?.length},${seen[0]?.[0]?.x},${seen[0]?.[0]?.z},${seen[0]?.[36]?.x},${seen[0]?.[36]?.z}`, '37,-100,0,100,0');
    const across = clipFront([{ x: 0, y: 0, z: 10 }, { x: 10, y: 0, z: -10 }], false, R);
    expect('a line that goes round the limb ends on it', JSON.stringify(across), JSON.stringify([[{ x: 0, y: 0, z: 10 }, { x: 5, y: 0, z: 0 }]]));
    const arch = clipFront([{ x: -10, y: 0, z: -5 }, { x: 0, y: 0, z: 5 }, { x: 10, y: 0, z: -5 }], false, R);
    expect('a line that comes round one limb and goes behind the other keeps the middle', JSON.stringify(arch), JSON.stringify([[{ x: -5, y: 0, z: 0 }, { x: 0, y: 0, z: 5 }, { x: 5, y: 0, z: 0 }]]));
    const twice = clipFront([{ x: 0, y: 0, z: 5 }, { x: 10, y: 0, z: -5 }, { x: 20, y: 0, z: 5 }], false, R);
    expect('a line that goes behind and comes back is two lines', twice.length, 2);
    // the winding of a polygon does not change what is seen of it
    const there = clipFront(patch(-30, 30, 60, 120), true, R);
    const back = clipFront([...patch(-30, 30, 60, 120)].reverse(), true, R);
    within('a polygon written the other way round shows the same patch', areaOf(back[0] ?? []) / areaOf(there[0] ?? []), 1, 1e-9);
  }

  // Order: parts are drawn back to front by mean depth, so what faces you is drawn last.
  {
    expect('depth is the mean z', depthOf([{ x: 0, y: 0, z: 2 }, { x: 5, y: 5, z: 6 }]), 4);
    expect('no points, no depth', depthOf([]), 0);
    // methane: a carbon and four hydrogens, bonds between. Turn it half way round about the vertical and every rank reverses.
    const tetra: readonly P3[] = [{ x: 1, y: 1, z: 1 }, { x: 1, y: -1, z: -1 }, { x: -1, y: 1, z: -1 }, { x: -1, y: -1, z: 1 }].map((p) => turn({ x: p.x * 10, y: p.y * 10, z: p.z * 10 }, { yaw: 25, pitch: 0, roll: 0 }));
    const carbon: P3 = { x: 0, y: 0, z: 0 };
    const parts: P3[][] = [[carbon], ...tetra.map((h) => [h]), ...tetra.map((h) => [carbon, h])];
    const ranks = (view: SpaceView): number[] =>
      parts
        .map((points, id) => ({ id, depth: depthOf(points.map((p) => turn(p, view))) }))
        .sort((a, b) => a.depth - b.depth)
        .map((part) => part.id);
    for (const roll of [0, 33, -80]) {
      const front = ranks({ yaw: 0, pitch: 0, roll });
      const behind = ranks({ yaw: 180, pitch: 0, roll });
      expect(`methane: the ranks at yaw 180 are the ranks at yaw 0 reversed (roll ${roll})`, behind.join(), [...front].reverse().join());
    }
    expect('methane: the carbon is in the middle both ways', ranks({ yaw: 0, pitch: 0, roll: 0 }).indexOf(0), 4);

    // a cube: whatever the view, what faces you is drawn after what faces away
    const s = 10;
    const faces: P3[][] = [];
    const axes = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }];
    for (const [i, normal] of axes.entries()) {
      const u = axes[(i + 1) % 3] ?? normal;
      const v = axes[(i + 2) % 3] ?? normal;
      for (const sign of [1, -1]) {
        const corner = (a: number, b: number): P3 => ({ x: s * (sign * normal.x + a * u.x + b * v.x), y: s * (sign * normal.y + a * u.y + b * v.y), z: s * (sign * normal.z + a * u.z + b * v.z) });
        const face = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
        // wound so that, seen from outside, they all go the same way: the area vector points out
        const e1 = { x: (face[1]?.x ?? 0) - (face[0]?.x ?? 0), y: (face[1]?.y ?? 0) - (face[0]?.y ?? 0), z: (face[1]?.z ?? 0) - (face[0]?.z ?? 0) };
        const e2 = { x: (face[2]?.x ?? 0) - (face[1]?.x ?? 0), y: (face[2]?.y ?? 0) - (face[1]?.y ?? 0), z: (face[2]?.z ?? 0) - (face[1]?.z ?? 0) };
        const normalOf = { x: e1.y * e2.z - e1.z * e2.y, y: e1.z * e2.x - e1.x * e2.z, z: e1.x * e2.y - e1.y * e2.x };
        const outward = normalOf.x * normal.x * sign + normalOf.y * normal.y * sign + normalOf.z * normal.z * sign;
        faces.push(outward > 0 ? face : [...face].reverse());
      }
    }
    // which way round a face goes on the screen tells whether it faces you, without using z: the winding of the one that faces you at rest is the sign
    const frontSign = Math.sign(windingOf((faces.find((f) => f.every((p) => p.z === s)) ?? []).map((p) => turn(p, { yaw: 0, pitch: 0, roll: 0 }))));
    const next = seeded(42);
    let wrong = 0;
    let measured = 0;
    for (let view = 0; view < 100; view += 1) {
      const camera = { yaw: (next() - 0.5) * 360, pitch: (next() - 0.5) * 180, roll: (next() - 0.5) * 360 };
      const turned = faces.map((face) => face.map((p) => turn(p, camera)));
      const edgeOn = turned.some((face) => Math.abs(windingOf(face)) < 1e-6 * s * s);
      if (edgeOn) continue;
      measured += 1;
      const order = turned.map((face, id) => ({ id, depth: depthOf(face), faces: Math.sign(windingOf(face)) === frontSign })).sort((a, b) => a.depth - b.depth);
      const lastBack = order.map((part) => part.faces).lastIndexOf(false);
      const firstFront = order.findIndex((part) => part.faces);
      if (lastBack > firstFront) wrong += 1;
    }
    expect(`a cube: the faces towards you are drawn last, in 100 seeded views (${measured} measured)`, wrong, 0);
    expect('and all but a few of the 100 were measured', measured >= 95, true);
  }

  if (!handleChecks()) ok = false;
  return ok;
}
