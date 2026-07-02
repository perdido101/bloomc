import { autoDetectRenderer, Container, RenderTexture } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import { TUNING } from './game/difficulty';
import { GameState, StateMachine } from './game/state';
import {
  PhaseManager, generateDNA, sanitize,
  type PhaseDNA,
} from './game/phases';
import { TrackField, hashSeed, type WorldGen } from './game/track';
import { Input, Runner, type CrashCause, type RunnerEvents } from './game/player';
import { Scoring, saveHighScore } from './game/scoring';
import { PaletteLut } from './render/palette';
import { getPhaseTextures, initTextures } from './render/textures';
import { CavePass } from './render/cave';
import { PostChain } from './render/post';
import { WorldLayer, project, type Cam, type Projected } from './render/world';
import { RunnerVisual, type RunnerPose } from './render/runnerVisual';
import { Particles } from './render/particles';
import { Hud } from './ui/hud';
import { Menus } from './ui/menus';
import { WordmarkFX } from './render/wordmark';
import { audio } from './audio/audio';

const TWO_PI = Math.PI * 2;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function randomSeed(): string {
  return Math.random().toString(36).slice(2, 8);
}

interface Pipeline {
  sceneRT: RenderTexture;
  cave: CavePass;
  post: PostChain;
  playerLayer: Container;
  destroy(): void;
}

class Game {
  private renderer!: Renderer;
  private pipeline!: Pipeline;
  private lut = new PaletteLut();
  private hud = new Hud();
  private menus = new Menus();
  private input!: Input;
  private fsm = new StateMachine();
  private pm: PhaseManager;
  private track!: TrackField;
  private runner = new Runner();
  private scoring = new Scoring();
  private worldLayer!: WorldLayer;
  private runnerVisual!: RunnerVisual;
  private particles!: Particles;

  private seedStr = randomSeed();
  private urlSeed: string | null = null;

  // layout (device px)
  private pw = 0;
  private ph = 0;
  private square = 0;
  private ox = 0;
  private oy = 0;
  private dpr = 1;

  // camera: behind the runner, chasing their lane
  private readonly cam: Cam = { x: 0, y: TUNING.CAM_H, z: -TUNING.CAM_Z0 };

  // fx state
  private time = 0;
  private beatPulse = 0;
  private caSpike = 0;
  private ripple = 0;
  private zoom = 0;
  private deathT = 0;
  private deathCx = 0.5;
  private deathCy = 0.5;
  private newBestPending = false;
  private readonly vigColor = new Float32Array(3);
  private hudColorRev = -1;
  private wmTintRev = -1;
  /** the cave dims to a whisper behind the main menu */
  private worldAlpha = 1;
  /** smoothed ink-mode amount (settings toggle, eased) */
  private inkAmt = 0;
  // escalation / DNA state
  private hueShift = 0;
  /** accumulated mandala rotation (DNA rotationDrift) */
  private spin = 0;
  private tierDipT = 0;
  private strobeFlip = false;
  private galleryEvery = 0; // >0 = gallery mode (?gallery), seconds per DNA
  private galleryTimer = 0;
  private galleryIdx = 0;
  private galleryHues: number[] = [];
  private readonly worldGen: WorldGen = {
    gapScale: 1, hazardDensity: 1, tier: 0, layoutStyle: 'even-gaps',
  };
  private wordmark!: WordmarkFX;
  private wordmarkEl: HTMLElement | null = null;
  private readonly proj: Projected = { px: 0, py: 0, k: 0, dz: 0 };

  // attract mode
  private attractZ = 0;

  // frame bookkeeping
  private lastNow = 0;
  private rafId = 0;
  private paused = false;
  private resizeTimer = 0;

  private readonly runnerEvents: RunnerEvents = {
    onLane: () => audio.playSfx('skim'),
    onJump: () => audio.playSfx('jump'),
    onRoll: () => audio.playSfx('grab'),
    onPass: (closeCall) => {
      const pts = this.scoring.onPass(closeCall);
      audio.playSfx('land');
      if (closeCall && pts > 0) {
        audio.playSfx('skim');
        const [x, y] = this.runnerClip();
        this.particles.burst(x, y, 14, 0.6, 0.5, 0.016, 1, 0.9, 0.6);
      }
    },
    onCoin: (n) => {
      this.scoring.onCoin(n);
      audio.playSfx('mote');
      const [x, y] = this.runnerClip();
      this.particles.burst(x, y - 0.12, 14, 0.5, 0.55, 0.016, 0.65, 1, 0.9);
    },
    onDie: (cause) => this.beginDeath(cause),
  };

  constructor() {
    this.pm = new PhaseManager({
      onBloomStart: (from, to) => {
        if (this.fsm.is(GameState.RUN)) this.fsm.set(GameState.BLOOM_TRANSITION);
        audio.playSfx('bloom');
        const cur = getPhaseTextures(from.texId);
        const nxt = getPhaseTextures(to.texId);
        this.pipeline.cave.setTextures(cur.sourceA, nxt.sourceA);
      },
      onBloomEnd: (blooms) => {
        if (this.fsm.is(GameState.BLOOM_TRANSITION)) this.fsm.set(GameState.RUN);
        if (this.runner.alive && this.fsm.playing) {
          this.scoring.onBloomSurvived(blooms);
        }
        audio.setPhase(this.pm.current.texId);
        audio.setMusicKey(this.pm.current.palette.baseHue, this.pm.tier, this.pm.current.lull);
        const tex = getPhaseTextures(this.pm.current.texId);
        this.pipeline.cave.setTextures(tex.sourceA, tex.sourceA);
      },
      onTierUp: (tier, name) => {
        if (!this.fsm.playing) return;
        this.menus.showTierNote(tier, name, this.lut.colorAt(0.85));
        this.ripple = 1;          // full-screen symmetric shockwave
        this.tierDipT = 0.5;      // brief 0.6× timescale dip
        this.scoring.addBonus(1000);
        audio.playSfx('tier');
      },
      onRuleBreaker: (type) => {
        this.ripple = Math.max(this.ripple, 0.8);
        this.caSpike = Math.max(this.caSpike, 0.4);
        console.log(`[rule-breaker] ${type}`);
      },
    });
  }

  async boot(): Promise<void> {
    const host = document.getElementById('app')!;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.renderer = (await autoDetectRenderer({
      preference: 'webgl',
      width: window.innerWidth,
      height: window.innerHeight,
      resolution: this.dpr,
      autoDensity: true,
      antialias: false,
      powerPreference: 'high-performance',
      background: 0x04060f,
    })) as Renderer;
    host.appendChild(this.renderer.canvas);

    await initTextures(this.renderer);

    this.computeLayout();
    this.buildPipeline();
    this.wordmark = new WordmarkFX('BLOOM');
    this.wordmarkEl = document.getElementById('splashWordmark');

    this.input = new Input(host);
    this.input.onPause = () => this.togglePause();
    this.input.onAnyInput = () => audio.init();

    this.urlSeed = new URLSearchParams(location.search).get('seed');

    this.menus.onStart = () => this.startRun();
    this.menus.onRestart = () => this.startRun();
    this.menus.onPause = () => this.togglePause();
    this.menus.onResume = () => this.togglePause();
    this.menus.onUiTap = () => audio.init();
    this.menus.onSettingsChange = (s) => {
      audio.enabled = s.sound;
      audio.musicEnabled = s.music;
    };
    audio.enabled = this.menus.settings.sound;
    audio.musicEnabled = this.menus.settings.music;

    audio.onBeat(() => {
      this.beatPulse = 1;
      this.strobeFlip = !this.strobeFlip;
    });

    window.addEventListener('resize', () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.onResize(), 200);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        cancelAnimationFrame(this.rafId);
        audio.suspend();
      } else {
        this.lastNow = performance.now();
        audio.resume();
        this.rafId = requestAnimationFrame(this.tick);
      }
    });

    // dev params: ?dna= forces a DNA for every Bloom; ?gallery[=secs]
    // auto-rolls a new DNA on an interval for art direction
    const params = new URLSearchParams(location.search);
    const dnaParam = params.get('dna');
    if (dnaParam) {
      try {
        const dna = JSON.parse(decodeURIComponent(dnaParam)) as PhaseDNA;
        sanitize(dna, dna.tier ?? 0, this.menus.settings.reduceFlash);
        this.pm.forcedDNA = dna;
        console.log('[dna] forced', dna);
      } catch (e) {
        console.warn('[dna] could not parse ?dna=', e);
      }
    }
    if (params.has('gallery')) {
      this.galleryEvery = Number(params.get('gallery')) || 8;
    }

    // attract-mode world behind the title
    this.track = new TrackField(hashSeed('attract'));
    this.pm.reduceFlash = this.menus.settings.reduceFlash;
    this.pm.reset(hashSeed('attract'));
    this.menus.hideBoot();
    if (this.galleryEvery > 0) this.menus.galleryMode();
    else this.menus.showSplash();
    this.fsm.set(GameState.MENU);

    this.lastNow = performance.now();
    this.rafId = requestAnimationFrame(this.tick);

    // testing/debug hook: stable object, fields updated per frame
    (window as unknown as { __vortika: object }).__vortika = this.debug;
  }

  private readonly debug: Record<string, unknown> = {
    // test hooks (no-ops unless invoked from the console/harness)
    warpToBloom: () => {
      if (this.fsm.playing) this.pm.warp();
    },
    kill: () => {
      if (this.fsm.playing && this.runner.alive) {
        this.runner.alive = false;
        this.beginDeath('gate');
      }
    },
  };

  private updateDebug(): void {
    const d = this.debug;
    d.state = this.fsm.state;
    d.score = this.scoring.score;
    d.combo = this.scoring.combo;
    d.lane = this.runner.lane;
    d.depth = this.runner.z;
    d.speed = this.runner.speed;
    d.alive = this.runner.alive;
    d.blooms = this.pm.bloomsDone;
    d.seed = this.seedStr;
    d.runTime = this.pm.runTime;
    d.tier = this.pm.tier;
    d.bloomIdx = this.pm.current?.index;
    d.visualLoad = this.pm.current?.visualLoad;
    d.hazContrast = this.lut.hazardContrast;
    d.baseHue = this.pm.current?.palette.baseHue;
    d.ruleBreaker = this.pm.ruleBreaker?.type ?? null;
    d.galleryHues = this.galleryHues;
    // runner position in CSS px (for the test harness)
    if (project(this.cam, this.square, this.runner.x, this.runner.y, this.runner.z, this.proj)) {
      d.px = (this.ox + this.proj.px) / this.dpr;
      d.py = (this.oy + this.proj.py) / this.dpr;
    }
    d.poseState = this.runnerPose();
  }

  private runnerPose(): RunnerPose {
    return this.runner.rolling ? 'roll' : this.runner.airborne ? 'jump' : 'run';
  }

  private computeLayout(): void {
    this.pw = Math.round(window.innerWidth * this.dpr);
    this.ph = Math.round(window.innerHeight * this.dpr);
    // the cave fills the WHOLE screen: the world square covers the larger
    // dimension and the sides crop naturally (portrait shows a tall slice)
    this.square = Math.min(Math.max(this.pw, this.ph), 1440);
    this.ox = (this.pw - this.square) / 2;
    this.oy = (this.ph - this.square) / 2;
    this.hud.layout(
      window.innerWidth / 2,
      window.innerHeight / 2,
      Math.min(this.pw, this.ph) / this.dpr
    );
  }

  private buildPipeline(): void {
    const S = this.square;
    const glacia = getPhaseTextures('GLACIA');
    const sceneRT = RenderTexture.create({ width: S, height: S });
    const cave = new CavePass(glacia.sourceA, this.lut.texture);
    const post = new PostChain(sceneRT, S);
    this.worldLayer = new WorldLayer();
    this.runnerVisual = new RunnerVisual();
    this.particles = new Particles();
    const playerLayer = new Container();
    // scene-graph content renders y-flipped into RenderTextures relative
    // to the raw clip-space passes — counter-flip the Graphics layers
    // (the particle mesh writes clip coords directly and needs none)
    const gfxLayer = new Container();
    gfxLayer.addChild(this.worldLayer.gfx, this.runnerVisual.root);
    gfxLayer.scale.y = -1;
    gfxLayer.position.y = S;
    playerLayer.addChild(gfxLayer, this.particles.mesh);
    this.pipeline = {
      sceneRT,
      cave,
      post,
      playerLayer,
      destroy() {
        playerLayer.destroy({ children: true });
        sceneRT.destroy(true);
      },
    };
    // restore current phase textures
    const tex = getPhaseTextures(this.pm.current?.texId ?? 'GLACIA');
    cave.setTextures(tex.sourceA, tex.sourceA);
  }

  private onResize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.renderer.resize(window.innerWidth, window.innerHeight, this.dpr);
    this.pipeline.destroy();
    this.computeLayout();
    this.buildPipeline();
  }

  private startRun(): void {
    audio.init();
    this.seedStr = this.urlSeed ?? randomSeed();
    this.track = new TrackField(hashSeed(this.seedStr));
    this.pm.reduceFlash = this.menus.settings.reduceFlash;
    this.pm.reset(hashSeed(this.seedStr));
    this.scoring.reset();
    this.runner.reset();
    this.hud.reset();
    this.particles.clear();
    this.runnerVisual.reset();
    this.zoom = 0;
    this.ripple = 0;
    this.newBestPending = false;
    this.hueShift = 0;
    this.input.clear();
    const tex = getPhaseTextures(this.pm.current.texId);
    this.pipeline.cave.setTextures(tex.sourceA, tex.sourceA);
    audio.setPhase(this.pm.current.texId);
    audio.setScene('game');
    audio.setMusicKey(this.pm.current.palette.baseHue, this.pm.tier, this.pm.current.lull);
    this.syncWorldGen();
    this.track.ensure(TUNING.HORIZON_Z, this.worldGen, this.pm.intensityGame);
    this.cam.x = 0;
    this.cam.y = TUNING.CAM_H;
    this.cam.z = -TUNING.CAM_Z0;
    this.menus.showRun();
    this.fsm.set(GameState.RUN);
  }

  /** gameplay knobs from the active DNA (gapScale inverts: DNA-hard = tight gaps) */
  private syncWorldGen(): void {
    const active = this.pm.active;
    this.worldGen.gapScale = 2 - active.gapScale;
    this.worldGen.hazardDensity = active.hazardDensity;
    this.worldGen.tier = active.tier;
    this.worldGen.layoutStyle = active.layoutStyle;
  }

  private togglePause(): void {
    if (!this.fsm.playing) return;
    this.paused = !this.paused;
    if (this.paused) {
      this.menus.showPause();
      this.input.clear();
    } else {
      this.menus.hidePause();
      this.lastNow = performance.now();
    }
  }

  private beginDeath(cause: CrashCause): void {
    audio.playSfx(cause === 'laser' ? 'hazard' : 'death');
    audio.playSfx('death');
    this.caSpike = 1;
    this.deathT = 0;
    const [x, y] = this.runnerClip();
    this.deathCx = x * 0.5 + 0.5;
    this.deathCy = y * 0.5 + 0.5;
    // the runner shatters into light
    this.particles.burst(x, y, 26, 0.8, 1.4, 0.02, 1, 0.95, 0.9);
    this.particles.burst(x, y, 18, 0.4, 1.8, 0.024, 0.9, 0.7, 1, 1.5);
    this.fsm.set(GameState.DEATH);
  }

  private finishDeath(): void {
    const rec = this.scoring.record(this.seedStr);
    const isBest = saveHighScore(rec);
    if (isBest) {
      this.newBestPending = true;
      audio.playSfx('newbest');
    }
    this.menus.showGameOver(rec, isBest);
    audio.setScene('menu');
    this.fsm.set(GameState.GAMEOVER);
  }

  private readonly clipPos = new Float32Array(2);

  /** runner position in square clip space (reuses a scratch array) */
  private runnerClip(): Float32Array {
    if (project(this.cam, this.square, this.runner.x, this.runner.y + 0.8, this.runner.z, this.proj)) {
      this.clipPos[0] = (this.proj.px / this.square) * 2 - 1;
      this.clipPos[1] = 1 - (this.proj.py / this.square) * 2;
    }
    return this.clipPos;
  }

  private readonly tick = (now: number): void => {
    this.rafId = requestAnimationFrame(this.tick);
    const dtRaw = Math.min(0.05, Math.max(0.0001, (now - this.lastNow) / 1000));
    this.lastNow = now;
    audio.update(now);

    // timescale: death slow-mo; pause keeps the world drifting at 10%
    let scale = 1;
    if (this.tierDipT > 0) scale = 0.6;
    if (this.fsm.is(GameState.DEATH)) scale = TUNING.DEATH_TIMESCALE;
    if (this.paused) scale = TUNING.PAUSE_TIMESCALE;
    const dt = dtRaw * scale;
    this.time += dt;
    this.fsm.tick(dtRaw);
    this.beatPulse *= Math.exp(-dt * 5);
    this.caSpike = Math.max(0, this.caSpike - dtRaw * (1000 / TUNING.CA_SPIKE_MS) * 0.001 * 5);
    this.ripple = Math.max(0, this.ripple - dtRaw * 1.6);
    if (this.tierDipT > 0) this.tierDipT -= dtRaw;

    const pm = this.pm;
    pm.depth = Math.floor(this.scoring.distance / 10);
    const cur = pm.current;
    const nxt = pm.next;
    const mix = pm.mix;

    // live palette: genome morph + hue drift (√intensity-scaled)
    const drift = lerp(cur.palette.hueDriftSpeed, nxt.palette.hueDriftSpeed, mix);
    this.hueShift = (this.hueShift + drift * Math.sqrt(pm.intensityVisual) * dt) % 360;
    this.lut.update(cur.palette, nxt.palette, mix, this.hueShift);

    this.syncWorldGen();

    // the cave dims behind the main menu (splash & gameplay show it full)
    const wantWorld =
      this.galleryEvery > 0 ||
      !this.fsm.is(GameState.MENU) ||
      this.menus.isSplashShown
        ? 1
        : 0.22;
    this.worldAlpha += (wantWorld - this.worldAlpha) * Math.min(1, dtRaw * 3);
    const wantInk = this.menus.settings.ink ? 1 : 0;
    this.inkAmt += (wantInk - this.inkAmt) * Math.min(1, dtRaw * 3);

    if (this.fsm.is(GameState.MENU, GameState.GAMEOVER)) {
      // attract mode: a slow, endless glide down the cave
      if (this.galleryEvery > 0) this.galleryTick(dtRaw);
      this.attractZ += dt * 3.5;
      this.cam.x = Math.sin(this.time * 0.23) * 0.8;
      this.cam.y = TUNING.CAM_H;
      this.cam.z = this.attractZ;
      this.track.ensure(this.attractZ + TUNING.HORIZON_Z, this.worldGen, 1);
      this.track.prune(this.attractZ - 5);
    } else if (this.fsm.playing || this.fsm.is(GameState.DEATH)) {
      if (!this.paused) {
        if (this.fsm.playing) pm.update(dt);
        this.track.ensure(this.runner.z + TUNING.HORIZON_Z, this.worldGen, pm.intensityGame);
        this.track.prune(this.runner.z - 12);
        if (this.fsm.playing) {
          // pace: gentle takeoff, then the Blooms push it
          const takeoff = Math.min(1, 0.35 + (pm.runTime / TUNING.TAKEOFF_S) * 0.65);
          const mult = takeoff * (0.8 + 0.2 * pm.speedMul);
          const beforeZ = this.runner.z;
          this.runner.update(dt, this.input, this.track, mult, this.runnerEvents);
          this.scoring.addDistance(this.runner.z - beforeZ);
        }
        // camera leans a little toward the runner's lane — most of the
        // lane change shows as the RUNNER moving across the screen
        this.cam.x += (this.runner.x * 0.3 - this.cam.x) * (1 - Math.exp(-9 * dt));
        this.cam.y = TUNING.CAM_H + this.runner.y * 0.22;
        this.cam.z = this.runner.z - TUNING.CAM_Z0;
      }

      if (this.fsm.is(GameState.DEATH)) {
        this.deathT += dtRaw;
        this.zoom = Math.min(1, this.deathT / TUNING.DEATH_SLOWMO_S) * 0.85;
        if (this.deathT >= TUNING.DEATH_SLOWMO_S) {
          this.zoom = 0;
          this.finishDeath();
        }
      }
    }

    if (this.newBestPending && this.fsm.is(GameState.GAMEOVER)) {
      this.newBestPending = false;
      this.ripple = 1; // full-screen symmetric shockwave
    }

    this.render(dtRaw, dt, mix, cur, nxt);
    this.updateDebug();
  };

  /** ?gallery mode: audition a fresh DNA every few seconds (wall time) */
  private galleryTick(dtRaw: number): void {
    this.galleryTimer -= dtRaw;
    if (this.galleryTimer > 0) return;
    this.galleryTimer = this.galleryEvery;
    this.galleryIdx++;
    const dna = generateDNA(
      hashSeed(`gallery:${this.galleryIdx}`),
      this.galleryIdx, // index drives the tier ramp: tier 4 by roll 8
      this.pm.current,
      this.menus.settings.reduceFlash
    );
    this.pm.current = dna;
    this.pm.next = dna;
    this.galleryHues.push(dna.palette.baseHue);
    const tex = getPhaseTextures(dna.texId);
    this.pipeline.cave.setTextures(tex.sourceA, tex.sourceA);
    console.log(
      `[gallery ${this.galleryIdx}] tier ${dna.tier} load ${dna.visualLoad} hue ${Math.round(dna.palette.baseHue)} hazContrast ${this.lut.hazardContrast} :: ${JSON.stringify(dna)}`
    );
  }

  private render(
    dtRaw: number,
    dt: number,
    mix: number,
    cur: PhaseDNA,
    nxt: PhaseDNA
  ): void {
    const p = this.pipeline;
    const r = this.renderer;
    const pm = this.pm;
    const active = pm.active;

    // mirror strobe rule-breaker: flick between the two folds on the beat
    let foldMix = mix;
    if (pm.ruleBreaker?.type === 'mirrorStrobe') {
      foldMix = this.strobeFlip ? 1 : 0;
    }

    // the mandala turns forever (DNA-signed), and corkscrews along z —
    // the endless spiral you run down
    this.spin += lerp(cur.rotationDrift, nxt.rotationDrift, mix) * 6 * dt;
    const spiralRate = 0.06 + lerp(cur.mirrorTwist, nxt.mirrorTwist, mix) * 0.8
      + lerp(cur.spiralFlow, nxt.spiralFlow, mix) * 0.04;

    p.cave.render(r, p.sceneRT, {
      camX: this.cam.x,
      camY: this.cam.y,
      camZ: this.cam.z,
      time: this.time,
      beat: this.beatPulse,
      wedgeA: TWO_PI / cur.mirrorN,
      wedgeB: TWO_PI / nxt.mirrorN,
      foldMix,
      texMix: mix,
      spin: this.spin,
      spiralRate,
      dim: this.worldAlpha,
      noiseScale: lerp(cur.noiseScale, nxt.noiseScale, mix),
      wobAmp: lerp(cur.wobble.amp, nxt.wobble.amp, mix),
      wobFreq: lerp(cur.wobble.freq, nxt.wobble.freq, mix),
    });

    // obstacles + coins + the runner + particles, projected on top
    this.worldLayer.update(
      this.track, this.cam, this.square, this.lut, this.time, this.beatPulse, active.mirrorN
    );
    this.worldLayer.gfx.alpha = this.worldAlpha;

    const showRunner = (this.fsm.playing && this.runner.alive) && !this.paused;
    if (this.lut.revision !== this.hudColorRev) {
      this.lut.colorFloatAt(0.8, this.runnerVisual.glowColor);
    }
    if (project(this.cam, this.square, this.runner.x, 0, this.runner.z, this.proj)) {
      const pose = this.runnerPose();
      this.runnerVisual.update(
        dtRaw,
        {
          px: this.proj.px,
          py: this.proj.py,
          k: this.proj.k,
          y: this.runner.y,
          lean: this.runner.lean,
          pose,
          stride: (this.runner.z * 0.55) % 1,
          rollP: 1 - this.runner.rollT / TUNING.ROLL_S,
          jumpP: 1 - this.runner.jumpT / TUNING.JUMP_S,
        },
        this.time,
        showRunner
      );
    }
    this.particles.update(dt);
    r.render({ container: p.playerLayer, target: p.sceneRT, clear: false });

    this.lut.colorFloatAt(0.3, this.vigColor);
    p.post.render(r, {
      screenW: this.pw,
      screenH: this.ph,
      squareX: this.ox,
      squareY: this.oy,
      squareSize: this.square,
      caSpike: this.caSpike,
      ripple: this.ripple,
      zoom: this.fsm.is(GameState.DEATH) ? this.zoom : 0,
      breathe: Math.sin((this.time * TWO_PI) / 6),
      zoomCx: this.deathCx,
      zoomCy: this.deathCy,
      vigColor: this.vigColor,
      reduceFlash: this.menus.settings.reduceFlash,
      caScale: pm.tier >= 3 ? 1.6 : 1,
      ink: this.inkAmt,
    });

    // animated wordmark over the splash (kaleidoscope unfurl)
    if (
      this.fsm.is(GameState.MENU) &&
      this.galleryEvery === 0 &&
      this.menus.isSplashShown &&
      this.wordmarkEl
    ) {
      if (this.lut.revision !== this.wmTintRev) {
        this.wmTintRev = this.lut.revision;
        this.lut.colorFloatAt(0.85, this.wordmark.tint);
      }
      const rect = this.wordmarkEl.getBoundingClientRect();
      this.wordmark.update(dtRaw, this.time, this.beatPulse, rect, window.innerWidth, window.innerHeight, this.inkAmt);
      r.render({ container: this.wordmark.mesh, clear: false });
    }

    // HUD on top (screen space)
    this.hud.root.visible = this.fsm.playing || this.fsm.is(GameState.DEATH);
    if (this.hud.root.visible) {
      if (this.lut.revision !== this.hudColorRev || this.inkAmt > 0.01) {
        this.hudColorRev = this.lut.revision;
        if (this.inkAmt > 0.5) {
          // HUD draws after the post chain: apply the same paper-minus-color
          // transform on the CPU so runes read as ink on paper
          this.lut.colorFloatAt(0.78, this.vigColor); // scratch reuse
          const rr = Math.round(Math.max(0, 0.965 - this.vigColor[0] * 0.88) * 255);
          const gg = Math.round(Math.max(0, 0.945 - this.vigColor[1] * 0.88) * 255);
          const bb = Math.round(Math.max(0, 0.9 - this.vigColor[2] * 0.88) * 255);
          this.hud.setColor(`rgb(${rr},${gg},${bb})`);
        } else {
          this.hud.setColor(this.lut.colorAt(0.78));
        }
      }
      this.hud.update(
        dt,
        this.scoring.score,
        this.scoring.combo,
        0,
        false,
        this.pm.countdown,
        this.pm.transitionT,
        this.time
      );
      r.render({ container: this.hud.root, clear: false });
    }
  }
}

const game = new Game();
game.boot().catch((err) => {
  console.error(err);
  const boot = document.getElementById('bootMsg');
  if (boot) boot.textContent = 'WEBGL2 REQUIRED';
});
