/**
 * Deterministic physics/scoring tests (acceptance §13: coyote time & input
 * buffer verifiably work; jump clears one ring; skim combo loop).
 * Run: npx esbuild scripts/physics.test.ts --bundle --format=esm \
 *        --outfile=/tmp/physics.test.mjs && node /tmp/physics.test.mjs
 */
import { TUNING } from '../src/game/difficulty';
import { Shard, type Input } from '../src/game/player';
import { foldAngle, fracDist, type RingField } from '../src/game/rings';
import { Scoring } from '../src/game/scoring';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

/** scripted input double */
class FakeInput {
  axis = 0;
  jump = false;
  dash = false;
  leftHanded = false;
  jumpBuffered(): boolean { return this.jump; }
  consumeJump(): void { this.jump = false; }
  dashQueued(): boolean { return this.dash; }
  consumeDash(): void { this.dash = false; }
  clear(): void { this.jump = this.dash = false; }
}

/** field double: scripted support sampling */
function makeField(sampleFn: (k: number, theta: number) => number): RingField {
  return {
    rings: new Map([[0, { omega: 0.3 }], [1, { omega: -0.3 }], [2, { omega: 0.3 }]]),
    dirFlip: 1,
    minDepth: -3,
    sample: (k: number, theta: number) => sampleFn(k, theta),
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
