# BLOOM

A high-score endless runner flown through a living kaleidoscope. You are a
luminous moth drawn to the light at the heart of an ever-blooming mandala
vortex. Rings rush at you, each a rotating wall with one or two doorways —
steer around the tunnel to thread them as the pace climbs and the world
Blooms into new patterns around you.

## Play

```bash
npm install
npm run dev       # dev server
npm run build     # production build → dist/
npm test          # deterministic physics/scoring tests
```

### Controls — Subway-Surfers fluid, one thumb

You fly forward on your own; steering rotates the tunnel around you (the
moth stays pinned at the bottom of the screen, so left/right always means
left/right).

| Action | Touch | Desktop |
| --- | --- | --- |
| Steer | drag left / right | hold ←/→ or A/D |
| Lane hop | quick flick | — |
| Jump (clears THIN walls) | tap | Space / W |
| Dash (smashes one wall, cooldown) | swipe up | Shift |
| Brake (line up a door) | swipe down | S / ↓ |
| Pause | ◈ glyph, top right | Esc |

Each ring is a near-solid wall with 1–2 doorways (mirrored by the
kaleidoscope): fly through a door or crash. THIN walls can be jumped;
spike guards narrow some doorways; razor petals patrol deeper rings. An
aim assist eases you into doors that are almost lined up. Passing doors
builds your combo (up to ×8); grazing a door's edge pays style points;
glowing motes ride the rings marking their doorways — collect for
25 × combo.

The world **Blooms** on an accelerating schedule (45 s shrinking to 18 s):
every Bloom rolls a fresh procedural **PhaseDNA** — cosine-gradient
palette spanning the full color wheel, mirror count 5–16 with spiral
twist, noise type, texture blend mode, wall shapes, ring rhythm — and the
pace climbs. Surviving one is worth +500 × blooms. Every 2 Blooms unlocks
a **surrealism tier** (shockwave, +1000, whispered title), up to DEEP
VORTEX rule-breakers; every 3rd Bloom is a serene Lull breather.

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
- The moth avatar is layered light shapes (dark silhouette, palette wing
  glows, white body + hot core): wings beat faster with speed, fold back
  on dashes, flare on jumps; the hue-shifting ribbon trails as wing dust.

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
