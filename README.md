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

### Controls

| Action | Desktop | Touch |
| --- | --- | --- |
| Jump (inward) | Space / W / ↑ | tap the center 40% of the screen |
| Move | A/D or ←/→ | hold left / right side |
| Flash-dash | Shift, or double-tap jump | double-tap the center |
| Pause | Esc | ◈ glyph, top right |

Gravity pulls **outward**. Jump inward, ring to ring. Land on the arcs;
gaps drop you toward the rim; falling off the outermost ring ends the run.
Skim a ring (land and leave within 0.5 s) to build your combo (up to ×8).
Every ~40 s the world **Blooms** — palette, mirror count and rotation all
shift while you play. Surviving one is worth +500 × blooms survived.

Runs are seeded and replayable: the game-over screen shows the seed, and
`?seed=<seed>` in the URL replays that world.

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
- Every gameplay constant lives in `src/game/difficulty.ts`.

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

Reduce-flash (caps bloom, disables chromatic spikes), sound on/off, and
left-handed mode (swaps the touch move zones) — persisted, available on the
title screen and the pause veil.
