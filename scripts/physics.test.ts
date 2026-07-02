/**
 * Deterministic runner/track/scoring tests for the kaleidoscope-ring
 * flight: fairness invariants (a reachable gap always exists), lane/tier
 * tweens, gap passes vs pattern crashes, coins, DNA sanity. Run: npm test
 */
import { TUNING } from '../src/game/difficulty';
import { Runner, type RunnerEvents, type RunnerInput } from '../src/game/player';
import {
  CELLS, TrackField, cellDist, cellIndex, cellX, cellY, hashSeed, XorShift,
  type WorldGen,
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
  vert = 0;
  flip = false;
  consumeLane(): number { const l = this.lane; this.lane = 0; return l; }
  consumeVert(): number { const v = this.vert; this.vert = 0; return v; }
  consumeFlip(): boolean { const f = this.flip; this.flip = false; return f; }
}

/** track double with hand-placed rings/coins */
function makeTrack(
  rings: Array<{ z: number; openCells: number[] }>,
  coins: Array<{ z: number; cell: number }> = []
): TrackField {
  const t = new TrackField(1);
  t.events = rings
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((r) => {
      const open = new Array<boolean>(CELLS).fill(false);
      for (const c of r.openCells) open[c] = true;
      return { z: r.z, open, pathCell: r.openCells[0] ?? 1 };
    });
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
/*  Grid helpers                                                       */
/* ------------------------------------------------------------------ */
{
  check('grid: cell round-trips', cellIndex(-1, 0) === 0 && cellIndex(1, 1) === 5);
  check('grid: cellX/Y place the six cells',
    cellX(0) === -TUNING.LANE_X && cellY(0) === TUNING.TIER_Y0 &&
    cellX(5) === TUNING.LANE_X && cellY(5) === TUNING.TIER_Y1);
  check('grid: one move = lane step or tier flip',
    cellDist(1, 2) === 1 && cellDist(1, 4) === 1 && cellDist(0, 5) === 3);
}

/* ------------------------------------------------------------------ */
/*  Track generation invariants                                       */
/* ------------------------------------------------------------------ */
{
  // determinism: identical seeds → identical worlds
  const a = new TrackField(hashSeed('det'));
  const b = new TrackField(hashSeed('det'));
  a.ensure(2000, GEN, 1);
  b.ensure(2000, GEN, 1);
  check('track: deterministic per seed',
    JSON.stringify(a.events) === JSON.stringify(b.events) &&
    JSON.stringify(a.coins) === JSON.stringify(b.coins));

  const c = new TrackField(hashSeed('other'));
  c.ensure(2000, GEN, 1);
  check('track: different seeds differ',
    JSON.stringify(a.events) !== JSON.stringify(c.events));
}

{
  // fairness sweep across seeds, tiers and layouts
  let runwayOk = true;
  let gapOk = true;
  let openOk = true;
  let reachOk = true;
  let easyStartOk = true;
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

    if (t.events[0].z < TUNING.RUNWAY_Z - 1e-6) runwayOk = false;
    for (let i = 1; i < t.events.length; i++) {
      if (t.events[i].z - t.events[i - 1].z < TUNING.EVENT_GAP_MIN * 0.999) gapOk = false;
    }
    for (const e of t.events) {
      if (!e.open.some(Boolean)) openOk = false;
      if (!e.open[e.pathCell]) openOk = false;
    }
    // the path gap never needs more than one move per ring
    for (let i = 1; i < t.events.length; i++) {
      if (cellDist(t.events[i].pathCell, t.events[i - 1].pathCell) > 1) reachOk = false;
    }
    // opening rings are generous
    for (let i = 0; i < 3 && i < t.events.length; i++) {
      if (t.events[i].open.filter(Boolean).length < 3) easyStartOk = false;
    }
  }
  check('track: runway is ring-free', runwayOk);
  check('track: ring gaps never collapse', gapOk);
  check('track: every ring keeps an open path gap', openOk);
  check('track: path gap moves ≤1 move per ring', reachOk);
  check('track: opening rings are generous', easyStartOk);
}

{
  // coins ride real cells; prune trims the past
  const t = new TrackField(hashSeed('coins'));
  t.ensure(2500, GEN, 1);
  let cellOk = true;
  for (const c of t.coins) {
    if (c.cell < 0 || c.cell >= CELLS) cellOk = false;
  }
  check('track: coins ride real cells', cellOk && t.coins.length > 0);
  const before = t.events.length;
  t.prune(1000);
  check('track: prune trims the past',
    t.events.length < before && t.events.every((e) => e.z >= 1000));
}

/* ------------------------------------------------------------------ */
/*  Runner: lanes, tiers, gap passes, crashes                          */
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
  check('runner: cannot leave the grid', r.lane === -1);
  input.lane = 2;
  step(r, input, track, TUNING.LANE_TWEEN_S + 0.06);
  check('runner: double swipe crosses two lanes', r.lane === 1);

  input.vert = 1;
  step(r, input, track, TUNING.TIER_TWEEN_S + 0.06);
  check('runner: swipe up floats to the high tier',
    r.tier === 1 && Math.abs(r.y - TUNING.TIER_Y1) < 1e-3);
  input.flip = true;
  step(r, input, track, TUNING.TIER_TWEEN_S + 0.06);
  check('runner: tap flips back down',
    r.tier === 0 && Math.abs(r.y - TUNING.TIER_Y0) < 1e-3);
}

{
  // pass through an open gap; crash into the pattern
  let died = false;
  let passed = 0;
  const ev: RunnerEvents = { onDie: () => { died = true; }, onPass: () => passed++ };

  const r = new Runner();
  r.reset(); // center-low = cell 1
  step(r, new FakeInput(), makeTrack([{ z: 12, openCells: [1] }]), 3, ev);
  check('runner: flies through an open gap', r.alive && !died && passed === 1);

  const r2 = new Runner();
  r2.reset();
  step(r2, new FakeInput(), makeTrack([{ z: 12, openCells: [0, 5] }]), 3, ev);
  check('runner: hits the sealed pattern and shatters', !r2.alive && died);
}

{
  // dodging: move to the gap in time (lane, then tier)
  let died = false;
  const ev: RunnerEvents = { onDie: () => { died = true; } };
  const r = new Runner();
  r.reset();
  const input = new FakeInput();
  const track = makeTrack([{ z: 12, openCells: [2] }]); // right-low
  step(r, input, track, 0.6, ev);
  input.lane = 1;
  step(r, input, track, 2, ev);
  check('runner: lane swipe reaches the gap', r.alive && !died);

  const r2 = new Runner();
  r2.reset();
  const in2 = new FakeInput();
  const t2 = makeTrack([{ z: 12, openCells: [4] }]); // center-high
  step(r2, in2, t2, 0.6, ev);
  in2.vert = 1;
  step(r2, in2, t2, 2, ev);
  check('runner: float up reaches the high gap', r2.alive && !died);
}

{
  // mid-tween between cells is NOT safe (commit to a gap)
  let died = false;
  const r = new Runner();
  r.reset();
  const input = new FakeInput();
  // gap at right-low; swipe way too late — the tween is mid-flight
  const track = makeTrack([{ z: 10, openCells: [2] }]);
  step(r, input, track, 10 / TUNING.RUN_SPEED0 - 0.05, { onDie: () => { died = true; } });
  input.lane = 1;
  step(r, input, track, 0.5, { onDie: () => { died = true; } });
  check('runner: swiping too late still crashes', !r.alive && died);
}

{
  // coins: collected in the flight cell, missed elsewhere
  const r = new Runner();
  r.reset();
  const input = new FakeInput();
  const track = makeTrack([], [{ z: 10, cell: 1 }, { z: 14, cell: 5 }]);
  let got = 0;
  step(r, input, track, 3, { onCoin: (n) => { got += n; } });
  check('runner: collects coins in its cell, not others', got === 1);
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
