/**
 * Deterministic physics/scoring tests (acceptance §13: coyote time & input
 * buffer verifiably work; jump clears one ring; skim combo loop).
 * Run: npx esbuild scripts/physics.test.ts --bundle --format=esm \
 *        --outfile=/tmp/physics.test.mjs && node /tmp/physics.test.mjs
 */
import { TUNING } from '../src/game/difficulty';
import { Shard, type Input } from '../src/game/player';
import {
  foldAngle, fracDist, hashSeed, twistFold, RingField as RealRingField,
  SAMPLE_NONE, SAMPLE_PLATFORM, type RingField, type WorldGen,
} from '../src/game/rings';
import { generateDNA } from '../src/game/phases';
import { Scoring } from '../src/game/scoring';

const GEN: WorldGen = { gapScale: 1, hazardDensity: 1, tier: 0, layoutStyle: 'even-gaps' };

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

/** scripted input double */
class FakeInput {
  runDir = 1;
  jump = false;
  dash = false;
  jumpBuffered(): boolean { return this.jump; }
  consumeJump(): void { this.jump = false; }
  dashQueued(): boolean { return this.dash; }
  consumeDash(): void { this.dash = false; }
  clear(): void { this.jump = this.dash = false; }
}

/** field double: scripted support sampling */
function makeField(
  sampleFn: (k: number, theta: number) => number,
  grabFn: (k: number, theta: number) => number | null = () => null
): RingField {
  return {
    rings: new Map([[0, { omega: 0.3 }], [1, { omega: -0.3 }], [2, { omega: 0.3 }]]),
    dirFlip: 1,
    minDepth: -3,
    sample: (k: number, theta: number) => sampleFn(k, theta),
    grabEdge: (k: number, theta: number) => grabFn(k, theta),
    collectMotes: () => 0,
  } as unknown as RingField;
}

const WEDGE = Math.PI / 4;
const DT = 1 / 240;

function step(shard: Shard, input: FakeInput, field: RingField, seconds: number, ev: Parameters<Shard['update']>[5] = {}): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) shard.update(DT, input as unknown as Input, field, WEDGE, 1, ev);
}

// ---- 1. a plain jump clears one ring spacing ----
{
  const field = makeField(() => 1); // platforms everywhere
  const shard = new Shard();
  shard.reset();
  const input = new FakeInput();
  input.jump = true;
  let landed = -1;
  step(shard, input, field, 2, { onLand: (k) => (landed = k) });
  check('plain jump reaches the next inner ring', landed === 1);
  const apex = (TUNING.JUMP_IMPULSE * TUNING.JUMP_IMPULSE) / (2 * TUNING.GRAVITY_OUT);
  check('jump apex clears one ring spacing', apex > TUNING.RING_SPACING);
}

// ---- 2. coyote time: jump still works within 90ms of losing support ----
{
  let support = 1;
  const field = makeField((k) => (k === 0 ? support : 1));
  const shard = new Shard();
  shard.reset();
  const input = new FakeInput();
  step(shard, input, field, 0.1); // settle on ring 0
  support = 0; // ground vanishes
  step(shard, input, field, 0.06); // 60ms of falling (< 90ms coyote)
  input.jump = true;
  let jumped = false;
  step(shard, input, field, 0.05, { onJump: () => (jumped = true) });
  check('coyote jump within 90ms of losing support', jumped);
}
{
  let support = 1;
  const field = makeField((k) => (k === 0 ? support : 1));
  const shard = new Shard();
  shard.reset();
  const input = new FakeInput();
  step(shard, input, field, 0.1);
  support = 0;
  step(shard, input, field, 0.15); // 150ms > coyote window
  input.jump = true;
  let jumped = false;
  step(shard, input, field, 0.05, { onJump: () => (jumped = true) });
  check('no coyote jump after the 90ms window', !jumped);
}

// ---- 3. input buffer: jump pressed shortly before landing fires on land ----
{
  const field = makeField(() => 1);
  const shard = new Shard();
  shard.reset();
  const input = new FakeInput();
  input.jump = true;
  let lands = 0;
  let jumps = 0;
  const ev = { onLand: () => lands++, onJump: () => jumps++ };
  step(shard, input, field, 0.05, ev); // initial jump
  // wait until just before apex→fall→land; hold the buffered press near landing
  step(shard, input, field, 1.0, ev);
  check('first jump happened', jumps >= 1);
  input.jump = true; // buffered while airborne (equivalent to pressed <120ms early)
  step(shard, input, field, 1.5, ev);
  check('buffered jump fires on landing', jumps >= 2 && lands >= 1);
}

// ---- 4. skim combo loop ----
{
  const sc = new Scoring();
  sc.reset();
  sc.onLand(1);
  check('skim within 0.5s increments combo', sc.onLeave(0.3) && sc.combo === 2);
  sc.onLand(2);
  sc.onStanding(1.6); // stood too long
  check('standing >1.5s resets combo', sc.combo === 1);
  check('depth score is 10 per ring', sc.score === 20);
  sc.onMote(2);
  check('motes score 25 × combo', sc.score === 20 + 50);
}

// ---- 5. fold math: collision fold matches mirror reflection property ----
{
  const w = (2 * Math.PI) / 8;
  let ok = true;
  for (let i = 0; i < 1000; i++) {
    const th = (i / 1000) * 4 * Math.PI - 2 * Math.PI;
    const f = foldAngle(th, w);
    if (f < 0 || f > w + 1e-9) ok = false;
    // mirror symmetry: fold(2w - x) === fold(x)
    if (Math.abs(foldAngle(2 * w - th, w) - f) > 1e-9) ok = false;
  }
  check('foldAngle maps into [0,w] with mirror symmetry', ok);
  check('fracDist reflects at wedge boundaries', Math.abs(fracDist(0.05, 0.02) - 0.03) < 1e-9 && Math.abs(fracDist(0.98, 0.99) - 0.01) < 1e-9);
}

// ---- 6. falling past the window kills ----
{
  const field = makeField(() => 0); // no platforms anywhere
  const shard = new Shard();
  shard.reset();
  const input = new FakeInput();
  let died: string | null = null;
  step(shard, input, field, 4, { onDie: (c) => (died = c) });
  check('falling past the outermost ring is death', died === 'fall');
}

// ---- 7. ledge grab: a just-missed landing catches and pulls up ----
{
  // ring 1 has no platform under the climber, but a ledge within reach
  const field = makeField(
    (k) => (k === 0 ? SAMPLE_PLATFORM : SAMPLE_NONE),
    (k) => (k === 1 ? 0.06 : null)
  );
  const shard = new Shard();
  shard.reset();
  const input = new FakeInput();
  input.jump = true;
  let grabbed = -1;
  let landed = -1;
  step(shard, input, field, 2.5, {
    onGrab: (k) => (grabbed = k),
    onLand: (k) => (landed = k),
  });
  check('missed landing within grab range triggers a grab', grabbed === 1);
  check('grab pull-up completes into a landing on that ring', landed === 1);
}

// ---- 8. real RingField.grabEdge is self-consistent with sample() ----
// (also exercised with mirror twist: collision fold must match itself)
{
  for (const twist of [0, 0.08]) {
    const field = new RealRingField(hashSeed('grabtest'));
    field.ensureWindow(3, GEN, 1);
    const w = (2 * Math.PI) / 8;
    let found = 0;
    let consistent = true;
    for (let i = 0; i < 4000; i++) {
      const th = (i / 4000) * Math.PI * 2;
      for (let k = 1; k <= 5; k++) {
        if (field.sample(k, th, w, twist) !== SAMPLE_NONE) continue;
        const d = field.grabEdge(k, th, w, twist);
        if (d === null) continue;
        found++;
        if (field.sample(k, th + d, w, twist) !== SAMPLE_PLATFORM) consistent = false;
        if (Math.abs(d) > TUNING.GRAB_RANGE_ANG * 2.5 + 1e-9) consistent = false;
      }
    }
    check(`grabEdge targets standable with twist=${twist} (${found} grabs probed)`, found > 20 && consistent);
  }
}

// ---- 9. twistFold reduces to foldAngle at twist 0 and stays in range ----
{
  const w = (2 * Math.PI) / 10;
  let ok = true;
  for (let i = 0; i < 500; i++) {
    const th = (i / 500) * 4 * Math.PI - 2 * Math.PI;
    if (Math.abs(twistFold(th, w, 0) - foldAngle(th, w)) > 1e-12) ok = false;
    const f = twistFold(th, w, 0.12);
    if (f < -1e-9 || f > w + 1e-9) ok = false;
  }
  check('twistFold: identity at twist 0, always in [0, w]', ok);
}

// ---- 10. DNA generation: deterministic, sanitized, full-spectrum ----
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
