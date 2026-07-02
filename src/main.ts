import { autoDetectRenderer, Container, RenderTexture } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import { TUNING } from './game/difficulty';
import { GameState, StateMachine } from './game/state';
import { PHASES, PhaseManager } from './game/phases';
import { RingField, hashSeed } from './game/rings';
import { Input, Shard, type ShardEvents } from './game/player';
import { Scoring, saveHighScore } from './game/scoring';
import { PaletteLut, midColor } from './render/palette';
import { getPhaseTextures, initTextures } from './render/textures';
import { BackgroundPass } from './render/background';
import { MirrorPass, WedgePass } from './render/kaleidoscope';
import { PostChain } from './render/post';
import { ShardVisual } from './render/shard';
import { Particles } from './render/particles';
import { Hud } from './ui/hud';
import { Menus } from './ui/menus';
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
  private viewRotDir = 1;

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
  private vigStops: string[] | null = null;
  private readonly vigColor = new Float32Array(3);
  private hudColorRev = -1;
  private dashVisT = 0;
  private readonly climberPose = {
    x: 0, y: 0, posAngle: 0, omega: 0,
    state: 'run' as import('./render/shard').ClimberState,
    grabT: -1, size: 0.115,
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
    return Math.pow(n, TUNING.FISHEYE_EXP);
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
      onBloomStart: () => {
        if (this.fsm.is(GameState.RUN)) this.fsm.set(GameState.BLOOM_TRANSITION);
        audio.playSfx('bloom');
        const cur = getPhaseTextures(this.pm.current.id);
        const nxt = getPhaseTextures(this.pm.next.id);
        this.pipeline.wedge.setTextures(cur.sourceA, nxt.sourceA);
        this.pipeline.bg.setTextures(cur.sourceB, nxt.sourceB);
      },
      onBloomMid: () => {
        this.field.dirFlip = this.pm.dirFlip;
        this.viewRotDir = -this.viewRotDir;
        this.bgSeed = (this.bgSeed * 16807) % 97 + 1; // deterministic-ish reseed
      },
      onBloomEnd: (blooms) => {
        if (this.fsm.is(GameState.BLOOM_TRANSITION)) this.fsm.set(GameState.RUN);
        if (this.shard.alive && this.fsm.playing) {
          this.scoring.onBloomSurvived(blooms);
        }
        audio.setPhase(this.pm.current.id);
        const tex = getPhaseTextures(this.pm.current.id);
        this.pipeline.wedge.setTextures(tex.sourceA, tex.sourceA);
        this.pipeline.bg.setTextures(tex.sourceB, tex.sourceB);
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

    this.input = new Input(host);
    this.input.onPause = () => this.togglePause();
    this.input.onAnyInput = () => audio.init();

    this.urlSeed = new URLSearchParams(location.search).get('seed');

    this.menus.onStart = () => this.startRun();
    this.menus.onRestart = () => this.startRun();
    this.menus.onPause = () => this.togglePause();
    this.menus.onResume = () => this.togglePause();
    this.menus.onSettingsChange = (s) => {
      audio.enabled = s.sound;
    };
    audio.enabled = this.menus.settings.sound;

    audio.onBeat(() => {
      this.beatPulse = 1;
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

    // attract-mode world behind the title
    this.field = new RingField(hashSeed('attract'));
    this.menus.hideBoot();
    this.menus.showTitle();
    this.fsm.set(GameState.MENU);

    this.lastNow = performance.now();
    this.rafId = requestAnimationFrame(this.tick);

    // testing/debug hook: stable object, fields updated per frame
    (window as unknown as { __vortika: object }).__vortika = this.debug;
  }

  private readonly debug: Record<string, unknown> = {
    // test hooks (no-ops unless invoked from the console/harness)
    warpToBloom: () => {
      if (this.fsm.playing) {
        this.pm.runTime = TUNING.BLOOM_PERIOD_S * (this.pm.bloomsDone + 1) - 0.5;
      }
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
    const glacia = getPhaseTextures(PHASES[0].id);
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
    // restore current phase textures if not GLACIA
    const tex = getPhaseTextures(this.pm.current.id);
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
    this.pm.reset();
    this.scoring.reset();
    this.shard.reset();
    this.hud.reset();
    this.particles.clear();
    this.camDepth = 0;
    this.camVel = 0;
    this.zoom = 0;
    this.ripple = 0;
    this.newBestPending = false;
    this.field.dirFlip = 1;
    this.input.clear();
    const tex = getPhaseTextures(this.pm.current.id);
    this.pipeline.wedge.setTextures(tex.sourceA, tex.sourceA);
    this.pipeline.bg.setTextures(tex.sourceB, tex.sourceB);
    audio.setPhase(this.pm.current.id);
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
    const n = this.pm.collisionMirrorN;
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
    this.fsm.set(GameState.GAMEOVER);
  }

  private readonly shardPos = new Float32Array(2);

  /** shard position in square clip space (reuses a scratch array) */
  private shardClipPos(): Float32Array {
    const sN = this.mapDepth(this.shard.depth);
    const a = this.shard.theta + this.viewRot;
    this.shardPos[0] = sN * Math.cos(a);
    this.shardPos[1] = sN * Math.sin(a);
    return this.shardPos;
  }

  private readonly tick = (now: number): void => {
    this.rafId = requestAnimationFrame(this.tick);
    const dtRaw = Math.min(0.05, Math.max(0.0001, (now - this.lastNow) / 1000));
    this.lastNow = now;
    audio.update(now);

    // timescale: death slow-mo; pause keeps the world drifting at 10%
    let scale = 1;
    if (this.fsm.is(GameState.DEATH)) scale = TUNING.DEATH_TIMESCALE;
    if (this.paused) scale = TUNING.PAUSE_TIMESCALE;
    const dt = dtRaw * scale;
    this.time += dt;
    this.fsm.tick(dtRaw);
    this.beatPulse *= Math.exp(-dt * 5);
    this.caSpike = Math.max(0, this.caSpike - dtRaw * (1000 / TUNING.CA_SPIKE_MS) * 0.001 * 5);
    this.ripple = Math.max(0, this.ripple - dtRaw * 1.6);
    this.dashVisT = Math.max(0, this.dashVisT - dt);

    const phase = this.pm.current;
    const nextPhase = this.pm.next;
    const mix = this.pm.mix;
    const speedMul =
      lerp(phase.speedMul, nextPhase.speedMul, mix) *
      this.pm.intensity *
      this.pm.transitionSpeedBoost;
    const wedgeCol = TWO_PI / this.pm.collisionMirrorN;

    if (this.fsm.is(GameState.MENU, GameState.GAMEOVER)) {
      // attract mode: gentle GLACIA drift, endless descent
      this.attractDepth += dt * 4;
      this.camDepth = this.attractDepth;
      const center = Math.max(3, Math.round(this.attractDepth / TUNING.RING_SPACING));
      this.field.ensureWindow(center, PHASES[0], 1);
      this.field.update(dt, 0.7);
      this.viewRot += TUNING.VIEW_ROT_SPEED * 2 * dt;
      this.lut.setBlend(PHASES[0].stops, PHASES[0].stops, 0);
    } else if (this.fsm.playing || this.fsm.is(GameState.DEATH)) {
      if (!this.paused) {
        if (this.fsm.playing) this.pm.update(dt);
        this.field.update(dt, speedMul);
        const center = Math.max(TUNING.RING_WINDOW, this.shard.ringK);
        this.field.ensureWindow(
          center,
          this.pm.inTransition && this.pm.transitionT >= 0.5 ? nextPhase : phase,
          this.pm.intensity
        );
        if (this.fsm.playing) {
          this.shard.update(dt, this.input, this.field, wedgeCol, speedMul, this.shardEvents);
          if (this.shard.onRing) this.scoring.onStanding(this.shard.standTime);
        }
        // camera: critically damped spring to the current ring
        const target = this.shard.ringK * TUNING.RING_SPACING;
        const W = TUNING.CAM_OMEGA;
        const acc = W * W * (target - this.camDepth) - 2 * W * this.camVel;
        this.camVel += acc * dt;
        this.camDepth += this.camVel * dt;
        this.viewRot += TUNING.VIEW_ROT_SPEED * this.viewRotDir * dt;
      }
      this.lut.setBlend(phase.stops, nextPhase.stops, mix);

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

    this.render(dtRaw, dt, wedgeCol, mix, phase, nextPhase);
    this.updateDebug();
  };

  private render(
    dtRaw: number,
    dt: number,
    wedgeCol: number,
    mix: number,
    phase: (typeof PHASES)[number],
    nextPhase: (typeof PHASES)[number]
  ): void {
    const p = this.pipeline;
    const r = this.renderer;

    p.bg.render(r, this.time, this.bgSeed, mix);

    const centerK = this.fsm.is(GameState.MENU, GameState.GAMEOVER)
      ? Math.max(3, Math.round(this.attractDepth / TUNING.RING_SPACING))
      : Math.max(TUNING.RING_WINDOW, this.shard.ringK);
    p.wedge.updateWorld(
      this.field,
      centerK,
      this.mapDepth,
      wedgeCol,
      this.time,
      this.beatPulse,
      mix
    );
    p.wedge.render(r);

    p.mirror.render(
      r,
      p.sceneRT,
      TWO_PI / phase.mirrorN,
      TWO_PI / nextPhase.mirrorN,
      mix,
      this.viewRot
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

    const vigStops = mix < 0.5 ? phase.stops : nextPhase.stops;
    if (vigStops !== this.vigStops) {
      this.vigStops = vigStops;
      const c = midColor(vigStops);
      this.vigColor[0] = c[0];
      this.vigColor[1] = c[1];
      this.vigColor[2] = c[2];
    }
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
    });

    // HUD on top (screen space)
    this.hud.root.visible = this.fsm.playing || this.fsm.is(GameState.DEATH);
    if (this.hud.root.visible) {
      if (this.lut.revision !== this.hudColorRev) {
        this.hudColorRev = this.lut.revision;
        this.hud.setColor(this.lut.colorAt(0.78));
        this.lut.colorFloatAt(0.8, this.shardVisual.glowColor);
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
