import { autoDetectRenderer, Container, RenderTexture } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import { TUNING } from './game/difficulty';
import { GameState, StateMachine } from './game/state';
import {
  PhaseManager, generateDNA, sanitize,
  type PhaseDNA, type RuleBreakerType,
} from './game/phases';
import { RingField, hashSeed, type WorldGen } from './game/rings';
import { Input, Shard, type ShardEvents } from './game/player';
import { Scoring, saveHighScore } from './game/scoring';
import { PaletteLut } from './render/palette';
import { getPhaseTextures, initTextures } from './render/textures';
import { BackgroundPass } from './render/background';
import { MirrorPass, WedgePass } from './render/kaleidoscope';
import { PostChain } from './render/post';
import { ShardVisual } from './render/shard';
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
  bg: BackgroundPass;
  wedge: WedgePass;
  mirror: MirrorPass;
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
  private field!: RingField;
  private shard = new Shard();
  private scoring = new Scoring();
  private shardVisual!: ShardVisual;
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

  // camera + view
  private camDepth = 0;
  private camVel = 0;
  private viewRot = 0;

  // fx state
  private time = 0;
  private beatPulse = 0;
  private caSpike = 0;
  private ripple = 0;
  private zoom = 0;
  private bgSeed = 7.3;
  private deathT = 0;
  private deathCx = 0.5;
  private deathCy = 0.5;
  private newBestPending = false;
  private readonly vigColor = new Float32Array(3);
  private hudColorRev = -1;
  private wmTintRev = -1;
  private dashVisT = 0;
  /** rings fade out behind the main menu (subtle background only) */
  private worldAlpha = 1;
  /** smoothed ink-mode amount (settings toggle, eased) */
  private inkAmt = 0;
  /** render-only smoothed radial position (softens landing snaps) */
  private visDepth = 0;
  private visDepthVel = 0;
  // escalation / DNA state
  private hueShift = 0;
  private fisheyeExp: number = TUNING.FISHEYE_EXP;
  private tierDipT = 0;
  private strobeFlip = false;
  private galleryEvery = 0; // >0 = gallery mode (?gallery), seconds per DNA
  private galleryTimer = 0;
  private galleryIdx = 0;
  private galleryHues: number[] = [];
  private readonly worldGen: WorldGen = {
    gapScale: 1, hazardDensity: 1, tier: 0, layoutStyle: 'even-gaps',
    wedge: Math.PI / 4,
  };
  private readonly bgParams = {
    time: 0, seed: 7.3, phaseMix: 0, noiseType: 0, noiseScale: 3,
    warp: 0.6, blendMode: 0, drift: 1, feedback: 0, nestedFold: 0,
  };
  private readonly wedgeOpts = {
    wedge: Math.PI / 4, time: 0, beat: 0, texMix: 0, platStyle: 0,
    hazStyle: 0, hazColor: new Float32Array(3), wobbleAmp: 0,
    wobbleFreq: 1, spiralFlow: 0,
  };
  private wordmark!: WordmarkFX;
  private wordmarkEl: HTMLElement | null = null;
  private readonly climberPose = {
    x: 0, y: 0, posAngle: 0, omega: 0,
    state: 'run' as import('./render/shard').ClimberState,
    grabT: -1, size: 0.055,
  };

  // attract mode
  private attractDepth = 30;

  // frame bookkeeping
  private lastNow = 0;
  private rafId = 0;
  private paused = false;
  private resizeTimer = 0;

  private readonly mapDepth = (d: number): number => {
    const o = (d - this.camDepth) / TUNING.RING_SPACING;
    const n = Math.min(1, Math.max(0, (TUNING.DEPTH_MAP_A - o) / TUNING.DEPTH_MAP_B));
    return Math.pow(n, this.fisheyeExp);
  };

  private readonly shardEvents: ShardEvents = {
    onJump: () => audio.playSfx('jump'),
    onDash: () => {
      audio.playSfx('dash');
      this.dashVisT = 0.25;
      this.caSpike = 1;
      this.ripple = Math.max(this.ripple, 0.55);
      const sp = this.shardClipPos();
      this.particles.burst(sp[0], sp[1], 26, 0.9, 0.5, 0.02, 0.7, 0.9, 1);
    },
    onLand: (k) => {
      const gained = this.scoring.onLand(k);
      audio.playSfx('land');
      const sp = this.shardClipPos();
      this.particles.burst(sp[0], sp[1], gained > 0 ? 14 : 8, 0.4, 0.45, 0.016, 0.85, 0.95, 1);
      this.shardVisual.flash = 0.7;
      this.shardVisual.squash = 1;
    },
    onLeave: (dur) => {
      if (this.scoring.onLeave(dur)) {
        audio.playSfx('skim');
        const sp = this.shardClipPos();
        this.particles.burst(sp[0], sp[1], 18, 0.7, 0.55, 0.018, 1, 0.9, 0.6);
      }
    },
    onMote: (n) => {
      this.scoring.onMote(n);
      audio.playSfx('mote');
      const sp = this.shardClipPos();
      this.particles.burst(sp[0], sp[1], 16, 0.5, 0.6, 0.017, 0.65, 1, 0.9);
    },
    onBounce: () => {
      audio.playSfx('bounce');
      this.shardVisual.squash = 0.8;
      const sp = this.shardClipPos();
      this.particles.burst(sp[0], sp[1], 8, 0.35, 0.35, 0.014, 0.7, 0.8, 1);
    },
    onGrab: () => {
      audio.playSfx('grab');
      const sp = this.shardClipPos();
      this.particles.burst(sp[0], sp[1], 10, 0.3, 0.4, 0.014, 0.9, 0.95, 1);
      this.shardVisual.flash = 0.5;
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
        this.pipeline.wedge.setTextures(cur.sourceA, nxt.sourceA);
        this.pipeline.bg.setTextures(cur.sourceB, nxt.sourceB);
      },
      onBloomMid: () => {
        this.field.dirFlip = this.pm.dirFlip;
        this.bgSeed = (this.bgSeed * 16807) % 97 + 1; // flow field reseeds
      },
      onBloomEnd: (blooms) => {
        if (this.fsm.is(GameState.BLOOM_TRANSITION)) this.fsm.set(GameState.RUN);
        if (this.shard.alive && this.fsm.playing) {
          this.scoring.onBloomSurvived(blooms);
        }
        audio.setPhase(this.pm.current.texId);
        audio.setMusicKey(this.pm.current.palette.baseHue, this.pm.tier, this.pm.current.lull);
        const tex = getPhaseTextures(this.pm.current.texId);
        this.pipeline.wedge.setTextures(tex.sourceA, tex.sourceA);
        this.pipeline.bg.setTextures(tex.sourceB, tex.sourceB);
      },
      onTierUp: (tier, name) => {
        if (!this.fsm.playing) return;
        this.menus.showTierNote(tier, name, this.lut.colorAt(0.85));
        this.ripple = 1;          // full-screen symmetric shockwave
        this.tierDipT = 0.5;      // brief 0.6× timescale dip
        this.scoring.addBonus(1000);
        audio.playSfx('tier');
      },
      onRuleBreaker: (type: RuleBreakerType) => {
        // telegraphed by a golden ring flash
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
    this.field = new RingField(hashSeed('attract'));
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
      if (this.fsm.playing && this.shard.alive) {
        this.shard.alive = false;
        this.beginDeath('fall');
      }
    },
  };

  private updateDebug(): void {
    const d = this.debug;
    d.state = this.fsm.state;
    d.score = this.scoring.score;
    d.combo = this.scoring.combo;
    d.ringK = this.shard.ringK;
    d.depth = this.shard.depth;
    d.onRing = this.shard.onRing;
    d.alive = this.shard.alive;
    d.blooms = this.pm.bloomsDone;
    d.seed = this.seedStr;
    d.runTime = this.pm.runTime;
    d.grabbing = this.shard.grabbing;
    d.tier = this.pm.tier;
    d.bloomIdx = this.pm.current?.index;
    d.visualLoad = this.pm.current?.visualLoad;
    d.hazContrast = this.lut.hazardContrast;
    d.baseHue = this.pm.current?.palette.baseHue;
    d.ruleBreaker = this.pm.ruleBreaker?.type ?? null;
    d.galleryHues = this.galleryHues;
    // climber position in CSS px (for the test harness)
    d.px = (this.ox + (this.climberPose.x * 0.5 + 0.5) * this.square) / this.dpr;
    d.py = (this.oy + (-this.climberPose.y * 0.5 + 0.5) * this.square) / this.dpr;
    d.poseState = this.climberPose.state;
  }

  private computeLayout(): void {
    this.pw = Math.round(window.innerWidth * this.dpr);
    this.ph = Math.round(window.innerHeight * this.dpr);
    this.square = Math.min(this.pw, this.ph, 1440);
    this.ox = (this.pw - this.square) / 2;
    this.oy = (this.ph - this.square) / 2;
    this.hud.layout(
      window.innerWidth / 2,
      window.innerHeight / 2,
      this.square / this.dpr
    );
  }

  private buildPipeline(): void {
    const S = this.square;
    const glacia = getPhaseTextures('GLACIA');
    const sceneRT = RenderTexture.create({ width: S, height: S });
    const bg = new BackgroundPass(S >> 1, glacia.sourceB, this.lut.texture);
    const wedge = new WedgePass(S, glacia.sourceA, this.lut.texture);
    const mirror = new MirrorPass(wedge.rt, bg.rt);
    const post = new PostChain(sceneRT, S);
    this.shardVisual = new ShardVisual();
    this.particles = new Particles();
    const playerLayer = new Container();
    playerLayer.addChild(this.particles.mesh, this.shardVisual.root);
    this.pipeline = {
      sceneRT,
      bg,
      wedge,
      mirror,
      post,
      playerLayer,
      destroy() {
        playerLayer.destroy({ children: true });
        sceneRT.destroy(true);
      },
    };
    // restore current phase textures
    const tex = getPhaseTextures(this.pm.current?.texId ?? 'GLACIA');
    wedge.setTextures(tex.sourceA, tex.sourceA);
    bg.setTextures(tex.sourceB, tex.sourceB);
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
    this.field = new RingField(hashSeed(this.seedStr));
    this.pm.reduceFlash = this.menus.settings.reduceFlash;
    this.pm.reset(hashSeed(this.seedStr));
    this.scoring.reset();
    this.shard.reset();
    this.hud.reset();
    this.particles.clear();
    this.camDepth = 0;
    this.camVel = 0;
    this.visDepth = 0;
    this.visDepthVel = 0;
    this.zoom = 0;
    this.ripple = 0;
    this.newBestPending = false;
    this.field.dirFlip = 1;
    this.hueShift = 0;
    this.input.clear();
    const tex = getPhaseTextures(this.pm.current.texId);
    this.pipeline.wedge.setTextures(tex.sourceA, tex.sourceA);
    this.pipeline.bg.setTextures(tex.sourceB, tex.sourceB);
    audio.setPhase(this.pm.current.texId);
    audio.setScene('game');
    audio.setMusicKey(this.pm.current.palette.baseHue, this.pm.tier, this.pm.current.lull);
    // build the opening window now and spawn standing on solid floor,
    // not over a doorway
    const cur = this.pm.current;
    this.worldGen.gapScale = cur.gapScale;
    this.worldGen.hazardDensity = cur.hazardDensity;
    this.worldGen.tier = cur.tier;
    this.worldGen.layoutStyle = cur.layoutStyle;
    this.worldGen.wedge = TWO_PI / cur.mirrorN;
    this.field.ensureWindow(TUNING.RING_WINDOW, this.worldGen, this.pm.intensityGame);
    this.shard.theta = this.field.findSolid(0, this.worldGen.wedge, cur.mirrorTwist);
    const [x, y] = this.shardClipPos();
    this.shardVisual.reset(x, y);
    this.menus.showRun();
    this.fsm.set(GameState.RUN);
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

  private beginDeath(cause: 'fall' | 'hazard'): void {
    audio.playSfx(cause === 'hazard' ? 'hazard' : 'death');
    audio.playSfx('death');
    this.caSpike = 1;
    this.deathT = 0;
    const sp = this.shardClipPos();
    const x = sp[0];
    const y = sp[1];
    this.deathCx = x * 0.5 + 0.5;
    this.deathCy = y * 0.5 + 0.5;
    // shatter into mirrored fragments, absorbed into the mandala
    const n = this.pm.active.mirrorN;
    const r = Math.hypot(x, y);
    const baseA = Math.atan2(y, x);
    for (let m = 0; m < n; m++) {
      const a = baseA + (m * TWO_PI) / n;
      const fx = Math.cos(a) * r;
      const fy = Math.sin(a) * r;
      this.particles.burst(fx, fy, 10, 0.6, 1.6, 0.022, 1, 0.95, 0.9, 2.2);
    }
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

  private readonly shardPos = new Float32Array(2);

  /** shard position in square clip space (reuses a scratch array).
   *  Uses the render-smoothed depth so landings settle instead of snapping. */
  private shardClipPos(): Float32Array {
    const sN = this.mapDepth(this.visDepth);
    const a = this.shard.theta + this.viewRot;
    this.shardPos[0] = sN * Math.cos(a);
    this.shardPos[1] = sN * Math.sin(a);
    return this.shardPos;
  }

  private updateVisDepth(dt: number): void {
    const diff = this.shard.depth - this.visDepth;
    if (Math.abs(diff) > 4 || dt <= 0) {
      // teleports (reset) snap instantly
      this.visDepth = this.shard.depth;
      this.visDepthVel = 0;
      return;
    }
    // stiff critically-damped spring: ~70ms settle, invisible in the air,
    // takes the harsh edge off landings and grab pull-ups
    const W = 30;
    const acc = W * W * diff - 2 * W * this.visDepthVel;
    this.visDepthVel += acc * dt;
    this.visDepth += this.visDepthVel * dt;
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
    this.dashVisT = Math.max(0, this.dashVisT - dt);

    // tier-up timescale dip (0.6× for 0.5s)
    if (this.tierDipT > 0) {
      this.tierDipT -= dtRaw;
      // (scale was computed above; apply the dip to this frame's dt)
    }

    const pm = this.pm;
    pm.depth = this.scoring.deepestRing;
    const cur = pm.current;
    const nxt = pm.next;
    const mix = pm.mix;
    const active = pm.active;
    const wedgeCol = TWO_PI / active.mirrorN;
    const twistCol = active.mirrorTwist;
    const speedMul = pm.speedMul;

    // live palette: genome morph + hue drift (√intensity-scaled)
    const drift = lerp(cur.palette.hueDriftSpeed, nxt.palette.hueDriftSpeed, mix);
    this.hueShift = (this.hueShift + drift * Math.sqrt(pm.intensityVisual) * dt) % 360;
    this.lut.update(cur.palette, nxt.palette, mix, this.hueShift);

    // fisheye breathing (tier 2+) and the inverted-fisheye rule-breaker
    let fx = TUNING.FISHEYE_EXP;
    if (pm.tier >= 2) fx += 0.05 * Math.sin((this.time * TWO_PI) / 9);
    if (pm.ruleBreaker?.type === 'fisheyeInvert') {
      fx += Math.sin((Math.PI * pm.ruleBreaker.t) / pm.ruleBreaker.dur) * 0.45;
    }
    this.fisheyeExp = fx;

    // gameplay knobs from the active DNA
    this.worldGen.gapScale = active.gapScale;
    this.worldGen.hazardDensity = active.hazardDensity;
    this.worldGen.tier = active.tier;
    this.worldGen.layoutStyle = active.layoutStyle;
    this.worldGen.wedge = wedgeCol;
    this.shard.jumpBoost = pm.jumpBoost;
    this.shard.coyoteMs = pm.coyoteMs;

    // rings fade away behind the main menu (splash & gameplay show them)
    const wantWorld =
      this.galleryEvery > 0 ||
      !this.fsm.is(GameState.MENU) ||
      this.menus.isSplashShown
        ? 1
        : 0.06;
    this.worldAlpha += (wantWorld - this.worldAlpha) * Math.min(1, dtRaw * 3);
    const wantInk = this.menus.settings.ink ? 1 : 0;
    this.inkAmt += (wantInk - this.inkAmt) * Math.min(1, dtRaw * 3);

    if (this.fsm.is(GameState.MENU, GameState.GAMEOVER)) {
      // attract mode: endless gentle descent (gallery rolls DNA here too)
      if (this.galleryEvery > 0) this.galleryTick(dtRaw);
      this.attractDepth += dt * 4;
      this.camDepth = this.attractDepth;
      const center = Math.max(3, Math.round(this.attractDepth / TUNING.RING_SPACING));
      this.field.ensureWindow(center, this.worldGen, 1);
      this.field.update(dt, 0.7);
      this.viewRot += cur.rotationDrift * 1.5 * dt;
    } else if (this.fsm.playing || this.fsm.is(GameState.DEATH)) {
      if (!this.paused) {
        if (this.fsm.playing) pm.update(dt);
        this.field.update(dt, speedMul);
        const center = Math.max(TUNING.RING_WINDOW, this.shard.ringK);
        this.field.ensureWindow(center, this.worldGen, pm.intensityGame);
        if (this.fsm.playing) {
          this.shard.update(
            dt, this.input, this.field, wedgeCol, speedMul, this.shardEvents, twistCol
          );
          if (this.shard.onRing) this.scoring.onStanding(this.shard.standTime);
        }
        // camera: critically damped spring to the current ring
        const target = this.shard.ringK * TUNING.RING_SPACING;
        const W = TUNING.CAM_OMEGA;
        const acc = W * W * (target - this.camDepth) - 2 * W * this.camVel;
        this.camVel += acc * dt;
        this.camDepth += this.camVel * dt;
        const rot = lerp(cur.rotationDrift, nxt.rotationDrift, mix);
        this.viewRot += rot * Math.sqrt(pm.intensityVisual) * dt;
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

    this.updateVisDepth(dt);
    this.render(dtRaw, dt, wedgeCol, mix, cur, nxt);
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
    this.bgSeed = (this.bgSeed * 16807) % 97 + 1;
    const tex = getPhaseTextures(dna.texId);
    this.pipeline.wedge.setTextures(tex.sourceA, tex.sourceA);
    this.pipeline.bg.setTextures(tex.sourceB, tex.sourceB);
    console.log(
      `[gallery ${this.galleryIdx}] tier ${dna.tier} load ${dna.visualLoad} hue ${Math.round(dna.palette.baseHue)} hazContrast ${this.lut.hazardContrast} :: ${JSON.stringify(dna)}`
    );
  }

  private render(
    dtRaw: number,
    dt: number,
    wedgeCol: number,
    mix: number,
    cur: PhaseDNA,
    nxt: PhaseDNA
  ): void {
    const p = this.pipeline;
    const r = this.renderer;
    const pm = this.pm;
    const active = pm.active;
    const NOISE_IDX = { fbm: 0, ridged: 1, curl: 2, voronoiFlow: 3, domainWarp2x: 4 } as const;
    const BLEND_IDX = { mix: 0, screen: 1, overlay: 2, difference: 3 } as const;
    const PLAT_IDX = { crystal: 0, petal: 1, wave: 2, filament: 3 } as const;
    const HAZ_IDX = { spike: 0, thorn: 1, razorPetal: 2, ember: 3 } as const;

    // background driven by the active DNA
    const bp = this.bgParams;
    bp.time = this.time;
    bp.seed = this.bgSeed;
    bp.phaseMix = mix;
    bp.noiseType = NOISE_IDX[active.noiseType];
    bp.noiseScale = lerp(cur.noiseScale, nxt.noiseScale, mix);
    bp.warp = lerp(cur.warpStrength, nxt.warpStrength, mix);
    bp.blendMode =
      pm.ruleBreaker?.type === 'diffBlend' ? 3 : BLEND_IDX[active.texBlendMode];
    bp.drift = lerp(cur.texDriftSpeed, nxt.texDriftSpeed, mix);
    bp.feedback = lerp(cur.flowFeedback, nxt.flowFeedback, mix);
    bp.nestedFold = active.nestedKaleido ? TWO_PI / Math.max(2, active.mirrorN / 2) : 0;
    p.bg.render(r, bp);

    const centerK = this.fsm.is(GameState.MENU, GameState.GAMEOVER)
      ? Math.max(3, Math.round(this.attractDepth / TUNING.RING_SPACING))
      : Math.max(TUNING.RING_WINDOW, this.shard.ringK);
    const wo = this.wedgeOpts;
    wo.wedge = wedgeCol;
    wo.time = this.time;
    wo.beat = this.beatPulse;
    wo.texMix = mix;
    wo.platStyle = PLAT_IDX[active.platformStyle];
    wo.hazStyle = HAZ_IDX[active.hazardStyle];
    wo.hazColor.set(this.lut.hazardColor);
    wo.wobbleAmp = lerp(cur.wobble.amp, nxt.wobble.amp, mix);
    wo.wobbleFreq = lerp(cur.wobble.freq, nxt.wobble.freq, mix);
    wo.spiralFlow = lerp(cur.spiralFlow, nxt.spiralFlow, mix);
    p.wedge.updateWorld(this.field, centerK, this.mapDepth, wo);
    p.wedge.render(r);

    // mirror strobe rule-breaker: flick between the two folds on the beat
    let mirrorMix = mix;
    if (pm.ruleBreaker?.type === 'mirrorStrobe') {
      mirrorMix = this.strobeFlip ? 1 : 0;
    }
    p.mirror.setSources(p.wedge.rt, p.bg.rt); // bg ping-pongs each frame
    p.mirror.render(
      r,
      p.sceneRT,
      TWO_PI / cur.mirrorN,
      TWO_PI / nxt.mirrorN,
      cur.mirrorTwist,
      nxt.mirrorTwist,
      mirrorMix,
      this.viewRot,
      this.worldAlpha
    );

    // player pass: climber + trail + particles, unmirrored, on top
    const showShard = (this.fsm.playing && this.shard.alive) && !this.paused;
    const sp = this.shardClipPos();
    const pose = this.climberPose;
    pose.x = sp[0];
    pose.y = sp[1];
    pose.posAngle = this.shard.theta + this.viewRot;
    pose.grabT = this.shard.grabT;
    if (this.shard.grabbing) {
      pose.state = 'grab';
      pose.omega = this.shard.tangentOmega;
    } else if (this.shard.onRing) {
      pose.state = 'run';
      pose.omega = this.shard.moveVel; // run animation is relative to the ring
    } else {
      pose.state = this.dashVisT > 0 ? 'dash' : this.shard.vel > 3 ? 'rise' : 'fall';
      pose.omega = this.shard.moveVel;
    }
    this.shardVisual.update(dtRaw, pose, this.time, showShard);
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
        this.lut.colorFloatAt(0.8, this.shardVisual.glowColor);
        if (this.inkAmt > 0.5) {
          // HUD draws after the post chain: apply the same paper-minus-color
          // transform on the CPU so runes read as ink on paper
          this.lut.colorFloatAt(0.78, this.vigColor); // scratch reuse
          const r = Math.round(Math.max(0, 0.965 - this.vigColor[0] * 0.88) * 255);
          const g = Math.round(Math.max(0, 0.945 - this.vigColor[1] * 0.88) * 255);
          const b = Math.round(Math.max(0, 0.9 - this.vigColor[2] * 0.88) * 255);
          this.hud.setColor(`rgb(${r},${g},${b})`);
        } else {
          this.hud.setColor(this.lut.colorAt(0.78));
        }
      }
      this.hud.update(
        dt,
        this.scoring.score,
        this.scoring.combo,
        this.shard.standTime,
        this.shard.onRing,
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
