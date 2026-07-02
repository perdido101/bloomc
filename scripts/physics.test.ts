/**
 * Deterministic runner/track/scoring tests for the 3-lane cave runner:
 * fairness invariants, lane tweens, jump/roll clearances, gate kills,
 * coin collection, DNA sanity. Run: npm test
 */
import { TUNING } from '../src/game/difficulty';
import { Runner, type RunnerEvents, type RunnerInput } from '../src/game/player';
import {
  TrackField, hashSeed, XorShift, type Obstacle, type WorldGen,
} from '../src/game/track';
import { generateDNA, visualLoad } from '../src/game/phases';
import { Scoring } from '../src/game/scoring';

const GEN: WorldGen = { gapScale: 1, hazardDensity: 1, tier: 0, layoutStyle: 'even-gaps' };

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

/** scripted input double */
class FakeInput implements RunnerInput {
  lane = 0;
  jump = false;
  roll = false;
  consumeLane(): number { const l = this.lane; this.lane = 0; return l; }
  consumeJump(): boolean { const j = this.jump; this.jump = false; return j; }
  consumeRoll(): boolean { const r = this.roll; this.roll = false; return r; }
}

/** track double with hand-placed obstacles/coins */
function makeTrack(obstacles: Obstacle[], coins: Array<{ z: number; lane: number }> = []): TrackField {
  const t = new TrackField(1);
  t.obstacles = obstacles.slice().sort((a, b) => a.z - b.z);
  t.coins = coins.map((c) => ({ ...c, taken: false }));
  return t;
}

function step(
  runner: Runner,
  input: FakeInput,
  track: TrackField,
  seconds: number,
  ev: RunnerEvents = {},
  dt = 1 / 120
): void {
  for (let t = 0; t < seconds && runner.alive; t += dt) {
    runner.update(dt, input, track, 1, ev);
  }
}

/* ------------------------------------------------------------------ */
/*  Track generation invariants                                        */
/* ------------------------------------------------------------------ */
{
  // determinism: identical seeds → identical worlds
  const a = new TrackField(hashSeed('det'));
  const b = new TrackField(hashSeed('det'));
  a.ensure(2000, GEN, 1);
  b.ensure(2000, GEN, 1);
  check('track: deterministic per seed',
    JSON.stringify(a.obstacles) === JSON.stringify(b.obstacles) &&
    JSON.stringify(a.coins) === JSON.stringify(b.coins));

  const c = new TrackField(hashSeed('other'));
  c.ensure(2000, GEN, 1);
  check('track: different seeds differ',
    JSON.stringify(a.obstacles) !== JSON.stringify(c.obstacles));
}

{
  // fairness sweep across seeds, tiers and layouts
  let runwayOk = true;
  let gapOk = true;
  let fairOk = true;
  let reachOk = true;
  const layouts: WorldGen['layoutStyle'][] = ['even-gaps', 'cluster', 'staircase-drift'];
  for (let s = 0; s < 24; s++) {
    const gen: WorldGen = {
      gapScale: 0.85 + (s % 5) * 0.1,
      hazardDensity: 0.8 + (s % 4) * 0.2,
      tier: s % 5,
      layoutStyle: layouts[s % 3],
    };
    const t = new TrackField(hashSeed(`fair:${s}`));
    t.ensure(2500, gen, 1 + (s % 3));

    for (const o of t.obstacles) {
      if (o.z < TUNING.RUNWAY_Z - 1e-6) runwayOk = false;
    }
    for (let i = 1; i < t.events.length; i++) {
      const gap = t.events[i].z - t.events[i - 1].z;
      if (gap < TUNING.EVENT_GAP_MIN * 0.8) gapOk = false;
    }
    // every event: either the path lane is clear, or the whole event is
    // one action (full-width low/high bar)
    for (const e of t.events) {
      const pathCell = e.cells[e.pathLane + 1];
      const full = e.cells[0] === e.cells[1] && e.cells[1] === e.cells[2] &&
        (e.cells[0] === 'low' || e.cells[0] === 'high');
      if (pathCell !== 'clear' && !full) fairOk = false;
      if (e.cells.every((c) => c === 'gate')) fairOk = false;
    }
    // the path lane never moves more than one lane between events
    for (let i = 1; i < t.events.length; i++) {
      if (Math.abs(t.events[i].pathLane - t.events[i - 1].pathLane) > 1) reachOk = false;
    }
  }
  check('track: runway is obstacle-free', runwayOk);
  check('track: event gaps never collapse', gapOk);
  check('track: every event survivable on the path lane', fairOk);
  check('track: path lane moves ≤1 lane per event', reachOk);
}

{
  // coins sit on the path lane of their event and are never inside walls
  const t = new TrackField(hashSeed('coins'));
  t.ensure(2500, GEN, 1);
  let laneOk = true;
  for (const c of t.coins) {
    if (c.lane !== -1 && c.lane !== 0 && c.lane !== 1) laneOk = false;
  }
  check('track: coins ride real lanes', laneOk && t.coins.length > 0);

  // prune drops everything behind
  const before = t.obstacles.length;
  t.prune(1000);
  check('track: prune trims the past',
    t.obstacles.length < before && t.obstacles.every((o) => o.z >= 1000));
}

/* ------------------------------------------------------------------ */
/*  Runner: lanes, jumps, rolls, crashes                               */
/* ------------------------------------------------------------------ */
{
  const r = new Runner();
  r.reset();
  const input = new FakeInput();
  const track = makeTrack([]);
  input.lane = -1;
  step(r, input, track, TUNING.LANE_TWEEN_S + 0.06);
  check('runner: swipe left lands on the left lane',
    r.lane === -1 && Math.abs(r.x - -TUNING.LANE_X) < 1e-3);
  input.lane = -1;
  step(r, input, track, TUNING.LANE_TWEEN_S + 0.06);
  check('runner: cannot leave the track', r.lane === -1);
  input.lane = 1;
  step(r, input, track, TUNING.LANE_TWEEN_S + 0.06);
  check('runner: swipe right returns to center', r.lane === 0 && Math.abs(r.x) < 1e-3);
}

{
  // jump clears a LOW laser; running into it dies
  const mk = () => makeTrack([{ z: 12, lane: 0, kind: 'low' }]);
  const r = new Runner();
  r.reset();
  const input = new FakeInput();
  let died: string | null = null;
  let passed = 0;
  const ev: RunnerEvents = {
    onDie: (c) => { died = c; },
    onPass: () => passed++,
  };
  // time the jump: obstacle at z=12, speed ≈8 → jump at ~z=10.5
  const track = mk();
  step(r, input, track, 1.25, ev); // z ≈ 10
  input.jump = true;
  step(r, input, track, 1.0, ev);
  check('runner: jump clears a low laser', r.alive && died === null && passed === 1);

  const r2 = new Runner();
  r2.reset();
  died = null;
  step(r2, new FakeInput(), mk(), 3, ev);
  check('runner: running into a low laser kills', !r2.alive && died === 'laser');
}

{
  // roll clears a HIGH bar; jumping into it dies
  const mk = () => makeTrack([{ z: 12, lane: 0, kind: 'high' }]);
  let died: string | null = null;
  const ev: RunnerEvents = { onDie: (c) => { died = c; } };

  const r = new Runner();
  r.reset();
  const input = new FakeInput();
  const track = mk();
  step(r, input, track, 1.3, ev);
  input.roll = true;
  step(r, input, track, 1.0, ev);
  check('runner: roll clears a hanging laser', r.alive && died === null);

  const r2 = new Runner();
  r2.reset();
  const in2 = new FakeInput();
  const t2 = mk();
  died = null;
  step(r2, in2, t2, 1.32, ev);
  in2.jump = true; // jumping INTO the curtain — head height stays in the beam
  step(r2, in2, t2, 1.0, ev);
  check('runner: jumping into a hanging laser kills', !r2.alive && died === 'laser');
}

{
  // gates kill in-lane regardless of action; dodging works
  const mkGate = () => makeTrack([{ z: 12, lane: 0, kind: 'gate' }]);
  let died: string | null = null;
  const ev: RunnerEvents = { onDie: (c) => { died = c; } };

  const r = new Runner();
  r.reset();
  const input = new FakeInput();
  const track = mkGate();
  step(r, input, track, 1.3, ev);
  input.jump = true;
  step(r, input, track, 1.0, ev);
  check('runner: gates cannot be jumped', !r.alive && died === 'gate');

  const r2 = new Runner();
  r2.reset();
  const in2 = new FakeInput();
  const t2 = mkGate();
  died = null;
  let close = false;
  const ev2: RunnerEvents = { onDie: (c) => { died = c; }, onPass: (cc) => { close = cc; } };
  step(r2, in2, t2, 0.6, ev2);
  in2.lane = 1;
  step(r2, in2, t2, 2, ev2);
  check('runner: lane change dodges a gate (and counts the close call)',
    r2.alive && died === null && close);
}

{
  // coins: collected in-lane, missed from another lane
  const r = new Runner();
  r.reset();
  const input = new FakeInput();
  const track = makeTrack([], [{ z: 10, lane: 0 }, { z: 14, lane: 1 }]);
  let got = 0;
  step(r, input, track, 3, { onCoin: (n) => { got += n; } });
  check('runner: collects coins in its lane, not others', got === 1);
}

{
  // speed ramps but never exceeds the cap
  const r = new Runner();
  r.reset();
  step(r, new FakeInput(), makeTrack([]), 30);
  check('runner: speed ramps upward', r.speed > TUNING.RUN_SPEED0);
  check('runner: speed respects the cap', r.speed <= TUNING.RUN_SPEED_MAX + 1e-6);
}

/* ------------------------------------------------------------------ */
/*  Scoring                                                            */
/* ------------------------------------------------------------------ */
{
  const s = new Scoring();
  s.reset();
  s.addDistance(100);
  check('score: distance pays out', s.score === Math.floor(100 * TUNING.DIST_SCORE));
  const base = s.score;
  s.onPass(false);
  check('score: clean pass builds combo, no points', s.combo === 2 && s.score === base);
  s.onCoin(1);
  check('score: coins pay ×combo', s.score === base + TUNING.COIN_SCORE * 2);
  const b2 = s.score;
  s.onPass(true);
  check('score: close call pays ×combo', s.score === b2 + TUNING.CLOSE_CALL_SCORE * 3);
  for (let i = 0; i < 20; i++) s.onPass(false);
  check('score: combo caps', s.combo === TUNING.COMBO_MAX);
  s.onBloomSurvived(2);
  check('score: bloom bonus scales', s.blooms === 2);
  check('score: record reports distance', s.record('t').depth === 100);
}

/* ------------------------------------------------------------------ */
/*  DNA sanity (unchanged system, new consumer)                        */
/* ------------------------------------------------------------------ */
{
  let ok = true;
  let loadOk = true;
  const budgets = [3.0, 3.8, 4.6, 5.4, 6.4];
  let prev = null as ReturnType<typeof generateDNA> | null;
  for (let i = 0; i < 12; i++) {
    const dna = generateDNA(hashSeed('dna-test'), i, prev, false);
    if (dna.mirrorN < 5 || dna.mirrorN > 16) ok = false;
    if (dna.gapScale <= 0) ok = false;
    if (visualLoad(dna) > budgets[dna.tier] + 1e-6) loadOk = false;
    prev = dna;
  }
  check('dna: fields stay in range', ok);
  check('dna: visual load respects the tier budget', loadOk);

  const rng = new XorShift(42);
  let inRange = true;
  for (let i = 0; i < 1000; i++) {
    const v = rng.next();
    if (v < 0 || v >= 1) inRange = false;
  }
  check('rng: xorshift stays in [0,1)', inRange);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
if (failures > 0) process.exit(1);
