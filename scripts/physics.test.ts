/**
 * Deterministic runner/scoring tests: door passes, wall crashes, jumps over
 * low rings, dash smashes, aim-assist helpers, maze generation invariants.
 * Run: npm test
 */
import { TUNING } from '../src/game/difficulty';
import { Runner, type Input } from '../src/game/player';
import {
  foldAngle, fracDist, hashSeed, twistFold, RingField as RealRingField,
  SAMPLE_NONE, SAMPLE_PLATFORM, type RingField, type WorldGen,
} from '../src/game/rings';
import { generateDNA } from '../src/game/phases';
import { Scoring } from '../src/game/scoring';

const GEN: WorldGen = { gapScale: 1, hazardDensity: 1, tier: 0, layoutStyle: 'even-gaps', wedge: Math.PI / 4 };

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

/** scripted input double */
class FakeInput {
  steerAxis = 0;
  jump = false;
  dash = false;
  brake = false;
  consumeDragPx(): number { return 0; }
  consumeHop(): number { return 0; }
  jumpBuffered(): boolean { return this.jump; }
  consumeJump(): void { this.jump = false; }
  dashQueued(): boolean { return this.dash; }
  consumeDash(): void { this.dash = false; }
  brakeQueued(): boolean { return this.brake; }
  consumeBrake(): void { this.brake = false; }
  clear(): void { this.jump = this.dash = this.brake = false; }
}

/** field double: scripted sampling per ring */
function makeField(
  sampleFn: (k: number, theta: number) => number,
  opts: { low?: Set<number> } = {}
): RingField {
  const rings = new Map<number, unknown>();
  for (let k = 1; k <= 8; k++) {
    rings.set(k, { omega: 0.3, phi: 0, arcs: [], petals: [], motes: [], low: opts.low?.has(k) ?? false });
  }
  return {
    rings,
    dirFlip: 1,
    minDepth: -3,
    sample: (k: number, theta: number) => sampleFn(k, theta),
    doorDelta: () => null,
    doorEdgeDist: () => 0.5,
    collectMotes: () => 0,
  } as unknown as RingField;
}

const WEDGE = Math.PI / 4;
const DT = 1 / 240;
const V = 12;

function fly(runner: Runner, input: FakeInput, field: RingField, seconds: number, ev: Parameters<Runner['update']>[5] = {}): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) runner.update(DT, input as unknown as Input, field, WEDGE, V, ev);
}

// ---- 1. flying through open doorways passes rings cleanly ----
{
  const field = makeField(() => SAMPLE_NONE); // everything open
  const runner = new Runner();
  runner.reset();
  const input = new FakeInput();
  const passed: number[] = [];
  fly(runner, input, field, 3, { onPass: (k, viaDoor) => { if (viaDoor) passed.push(k); } });
  check('open doorways pass cleanly ring after ring', passed.length >= 3 && passed[0] === 1 && passed[1] === 2);
}

// ---- 2. a solid wall kills ----
{
  const field = makeField((k) => (k === 2 ? SAMPLE_PLATFORM : SAMPLE_NONE));
  const runner = new Runner();
  runner.reset();
  const input = new FakeInput();
  let died: string | null = null;
  let lastPass = 0;
  fly(runner, input, field, 4, {
    onPass: (k) => (lastPass = k),
    onDie: (c) => (died = c),
  });
  check('crashing into a solid wall is death', died === 'wall' && lastPass === 1);
}

// ---- 3. tap-jump clears a LOW wall ----
{
  const field = makeField((k) => (k === 2 ? SAMPLE_PLATFORM : SAMPLE_NONE), { low: new Set([2]) });
  const runner = new Runner();
  runner.reset();
  const input = new FakeInput();
  let died: string | null = null;
  let jumped = 0;
  const ev = {
    onJump: () => jumped++,
    onDie: (c: 'wall' | 'hazard') => (died = c as string),
  };
  // fly until just before ring 2, then jump
  while (runner.z < 2 * TUNING.RING_SPACING - V * 0.2 && runner.alive) {
    runner.update(DT, input as unknown as Input, field, WEDGE, V, ev);
  }
  input.jump = true;
  fly(runner, input, field, 0.5, ev);
  check('tap-jump leaps over a LOW wall', died === null && jumped === 1 && runner.ringK >= 2);
}

// ---- 3b. without the jump, the LOW wall still kills ----
{
  const field = makeField((k) => (k === 2 ? SAMPLE_PLATFORM : SAMPLE_NONE), { low: new Set([2]) });
  const runner = new Runner();
  runner.reset();
  const input = new FakeInput();
  let died: string | null = null;
  fly(runner, input, field, 4, { onDie: (c) => (died = c) });
  check('a LOW wall without jumping is still death', died === 'wall');
}

// ---- 4. dash smashes through exactly one wall ----
{
  const field = makeField((k) => (k === 2 || k === 3 ? SAMPLE_PLATFORM : SAMPLE_NONE));
  const runner = new Runner();
  runner.reset();
  const input = new FakeInput();
  let died: string | null = null;
  let smashed = 0;
  const ev = {
    onPass: (_k: number, viaDoor: boolean) => { if (!viaDoor) smashed++; },
    onDie: (c: 'wall' | 'hazard') => (died = c as string),
  };
  while (runner.z < 2 * TUNING.RING_SPACING - V * 0.25 && runner.alive) {
    runner.update(DT, input as unknown as Input, field, WEDGE, V, ev);
  }
  input.dash = true;
  fly(runner, input, field, 3, ev);
  check('dash smashes through one wall, the next one kills', smashed === 1 && died === 'wall');
}

// ---- 5. scoring: passes, combo, graze, motes ----
{
  const sc = new Scoring();
  sc.reset();
  sc.onPass(1, true);
  sc.onPass(2, true);
  check('door passes score and build combo', sc.score === 20 && sc.combo === 3);
  sc.onPass(3, false);
  check('jump/dash passes score but freeze the combo', sc.score === 30 && sc.combo === 3);
  const g = sc.onGraze();
  check('graze pays 15 × combo', g === 45 && sc.score === 75);
  sc.onMote(2);
  check('motes score 25 × combo', sc.score === 75 + 150);
}

// ---- 6. fold math invariants ----
{
  const w = (2 * Math.PI) / 8;
  let ok = true;
  for (let i = 0; i < 1000; i++) {
    const th = (i / 1000) * 4 * Math.PI - 2 * Math.PI;
    const f = foldAngle(th, w);
    if (f < 0 || f > w + 1e-9) ok = false;
    if (Math.abs(foldAngle(2 * w - th, w) - f) > 1e-9) ok = false;
  }
  check('foldAngle maps into [0,w] with mirror symmetry', ok);
  check('fracDist reflects at wedge boundaries', Math.abs(fracDist(0.05, 0.02) - 0.03) < 1e-9 && Math.abs(fracDist(0.98, 0.99) - 0.01) < 1e-9);
  let tOk = true;
  for (let i = 0; i < 500; i++) {
    const th = (i / 500) * 4 * Math.PI - 2 * Math.PI;
    if (Math.abs(twistFold(th, w, 0) - foldAngle(th, w)) > 1e-12) tOk = false;
    const f = twistFold(th, w, 0.12);
    if (f < -1e-9 || f > w + 1e-9) tOk = false;
  }
  check('twistFold: identity at twist 0, always in [0, w]', tOk);
}

// ---- 7. real field: doorDelta aims at real openings ----
{
  const field = new RealRingField(hashSeed('assist'));
  field.ensureWindow(6, GEN, 1);
  let checked = 0;
  let ok = true;
  for (let i = 0; i < 2000; i++) {
    const th = (i / 2000) * Math.PI * 2;
    for (let k = 3; k <= 9; k++) {
      if (field.sample(k, th, GEN.wedge) === SAMPLE_NONE) continue;
      const d = field.doorDelta(k, th, GEN.wedge);
      if (d === null || Math.abs(d) > 0.6) continue;
      checked++;
      if (field.sample(k, th + d, GEN.wedge) !== SAMPLE_NONE) ok = false;
    }
  }
  check(`doorDelta targets land in open doorways (${checked} probes)`, checked > 100 && ok);
}

// ---- 8. DNA generation invariants (unchanged) ----
{
  const a = generateDNA(1234, 5, null, false);
  const b = generateDNA(1234, 5, null, false);
  check('DNA generation is deterministic per (seed, index)', JSON.stringify(a) === JSON.stringify(b));
  const hues: number[] = [];
  let loadsOk = true;
  let lullsOk = true;
  const budgets = [3.0, 3.8, 4.6, 5.4, 6.4];
  let prev: ReturnType<typeof generateDNA> | null = null;
  for (let i = 0; i < 40; i++) {
    const dna = generateDNA(777, i, prev, false);
    prev = dna;
    hues.push(dna.palette.baseHue);
    if (dna.visualLoad > budgets[dna.tier] + 1e-6) loadsOk = false;
    if (i > 0 && i % 3 === 0 && !dna.lull) lullsOk = false;
  }
  hues.sort((x, y) => x - y);
  let maxGap = hues[0] + 360 - hues[hues.length - 1];
  for (let i = 1; i < hues.length; i++) maxGap = Math.max(maxGap, hues[i] - hues[i - 1]);
  check('base hues span ≥300° of the wheel over 40 Blooms', 360 - maxGap >= 300);
  check('visual load stays under the per-tier budget (40 Blooms)', loadsOk);
  check('every 3rd Bloom is a Lull', lullsOk);
}

// ---- 9. maze generation: solid walls, and a door ALWAYS exists ----
{
  const field = new RealRingField(hashSeed('mazetest'));
  field.ensureWindow(10, GEN, 1);
  const w = GEN.wedge;
  let solidOk = true;
  let doorAlways = true;
  for (const [k, ring] of field.rings) {
    if (k === 0) continue;
    let avgSolid = 0;
    for (let rot = 0; rot < 8; rot++) {
      ring.phi = (rot / 8) * 2 * w;
      let solid = 0;
      let open = 0;
      for (let i = 1; i <= 360; i++) {
        const th = (i / 360) * 2 * Math.PI;
        if (field.sample(k, th, w) !== SAMPLE_NONE) solid++;
        else open++;
      }
      avgSolid += solid / 360;
      if (open === 0) doorAlways = false;
    }
    avgSolid /= 8;
    if (avgSolid < 0.4 || avgSolid > 0.99) solidOk = false;
  }
  check('maze rings stay mostly solid (avg over rotations)', solidOk);
  check('an open doorway exists at every rotation (no soft-locks)', doorAlways);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
