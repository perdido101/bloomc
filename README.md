# VORTIKA

A high-score endless platformer played inside a living kaleidoscope. You are
a glowing prism shard descending toward the eye of an ever-blooming mandala
vortex — the only asymmetric thing on screen.

## Play

```bash
npm install
npm run dev       # dev server
npm run build     # production build → dist/
npm test          # deterministic physics/scoring tests
```

### Controls — one thumb, no zones

You are a neon stickman climber who **runs along the rings by himself**.

| Action | Touch | Desktop |
| --- | --- | --- |
| Jump (inward) | tap anywhere | Space / W / ↑ |
| Flip run direction | swipe left / right | A/D or ←/→ |
| Flash-dash | swipe up | Shift |
| Pause | ◈ glyph, top right | Esc |

Gravity pulls **outward**. Jump inward, ring to ring. Land on the arcs;
gaps drop you toward the rim; falling off the outermost ring ends the run.
If a jump barely misses a platform, the climber **grabs the ledge** and
pulls himself up — edges are your friends.
Skim a ring (land and leave within 0.5 s) to build your combo (up to ×8).

The world **Blooms** on an accelerating schedule (45 s shrinking to 18 s):
every Bloom rolls a fresh procedural **PhaseDNA** — cosine-gradient
palette spanning the full color wheel (live hue drift, genomes morph
across transitions), mirror count 5–16 with spiral twist, noise type,
texture blend mode, platform/hazard shape language, ring layout rhythm.
No two Blooms ever look alike; a per-tier visual-load budget and a
contrast-verified hazard color keep it readable. Surviving one is worth
+500 × blooms survived. Every 2 Blooms unlocks a **surrealism tier**
(shockwave, +1000, whispered title) with new visual permissions, up to
DEEP VORTEX rule-breakers; every 3rd Bloom is a serene Lull breather.

Runs are seeded and replayable: the game-over screen shows the seed, and
`?seed=<seed>` in the URL replays that world. Visual DNA rolls from a
separate seeded stream, so layouts never change for a given seed.

Dev tools: `?gallery[=secs]` auditions a fresh DNA on an interval (art
direction mode; `node scripts/gallery.mjs` runs the acceptance sweep),
`?dna=<urlencoded json>` forces one DNA for tuning; every Bloom logs its
DNA as JSON.

## Architecture

- **PixiJS v8 / WebGL2**, TypeScript strict, Vite. All world rendering is
  shader-driven; there is no Canvas2D in the world pipeline.
- World space is polar. Screen mapping uses a fisheye curve
  (`radius ∝ depth^0.62`), so the center compresses and the rim stretches.
- `render/kaleidoscope.ts` renders **all** gameplay into a polar-unwrapped
  master-wedge render target from uniform arrays (rings, arcs, hazards,
  motes), then a mirror pass folds every screen pixel into the wedge with
  true alternating reflection. During a Bloom both the old and the new
  mirror counts are folded and dissolved. CPU collision in `game/rings.ts`
  applies the exact same fold math, so gameplay always matches the visuals.
- Post chain: bright-pass → two-level Gaussian bloom → composite with
  chromatic aberration, barrel distortion, breathing vignette, dash/death
  shockwaves, and letterbox margins filled with a darkened blurred copy of
  the scene (never black bars).
- Every gameplay constant lives in `src/game/difficulty.ts`; everything
  per-Bloom lives in `src/game/phases.ts` (PhaseDNA generation, the
  constraint sanitizer, visual-load budgets, escalation tiers,
  rule-breakers). Palettes are IQ cosine gradients evaluated to a LUT on
  the CPU each frame (`render/palette.ts`) with enforced luminance bounds
  and a ≥3:1 hazard/platform contrast invariant.
- The climber is a procedurally animated stick figure (run cycle, tuck,
  flail, hang-and-pull-up, dash stretch) drawn as layered capsules — dark
  silhouette under a white-hot core so he reads over every palette.

## Textures (placeholder system)

Shaders only sample phase textures through `render/textures.ts`. Drop real
`.jpg`/`.webp` files into `public/textures/` matching
`public/textures/manifest.json` and reload — the art upgrades with **zero
code changes**. Any missing file gets a procedural, seamlessly tileable
FBM flow-noise placeholder tinted with that phase's palette (logged as
`[textures] placeholder for …`).

## Audio

`src/audio/audio.ts` exposes `init()`, `setPhase(id)`, `onBeat(cb)` (92 BPM
internal clock) and `playSfx(name)`. Current sounds are soft WebAudio
sine/triangle placeholder blips; everything music-reactive reads from
`onBeat`, so a real track + analysis can replace the clock later.

## Settings

Reduce-flash (caps bloom, disables chromatic spikes) and sound on/off —
persisted, available on the title screen and the pause veil.
