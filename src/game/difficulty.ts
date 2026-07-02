/**
 * VORTIKA — every gameplay tuning constant lives here.
 * Design intent (§8): one-thumb playable; difficulty comes from ring
 * counter-rotation speed + shrinking platforms + Bloom chaos, never from
 * control complexity. First death ~60–120s for a new player; a good player
 * reaches 3+ Blooms.
 */
export const TUNING = {
  FISHEYE_EXP: 0.62,        // screenRadius = pow(depthNorm, FISHEYE_EXP)
  GRAVITY_OUT: 42,          // world units/s² outward (away from center)
  JUMP_IMPULSE: 32,         // inward. Tuned up from spec's 26 so a plain jump
                            // clears one RING_SPACING (needs > sqrt(2*42*10)≈29)
                            // per the §8 intent that jump-only is playable.
  DASH_IMPULSE: 18,         // inward burst, refreshes on landing
  DASH_INTANGIBLE_S: 0.08,  // 80ms of intangibility on dash
  RING_SPACING: 10,         // world units between ring planes
  BASE_RING_SPEED: 0.35,    // rad/s at depth 0
  RING_SPEED_PER_DEPTH: 0.012,
  RING_SPEED_CAP: 1.4,
  PLATFORM_COVERAGE_START: 0.70, // fraction of a wedge that is platform
  PLATFORM_COVERAGE_MIN: 0.40,
  COVERAGE_DECAY_PER_DEPTH: 0.004,
  HAZARD_CHANCE_START: 0.15,
  HAZARD_CHANCE_MAX: 0.55,
  HAZARD_CHANCE_PER_DEPTH: 0.004,
  PETAL_MIN_DEPTH: 22,      // razor petals only appear deeper than this
  COYOTE_MS: 90,
  BUFFER_MS: 120,
  SKIM_WINDOW_S: 0.5,       // land->leave within this = combo up
  COMBO_RESET_S: 1.5,       // standing longer than this resets combo
  COMBO_MAX: 8,
  // Bloom cadence now escalates (phases.ts bloomPeriod: 45s shrinking to a
  // floor of 18s); transition/countdown timing still lives here.
  BLOOM_TRANSITION_S: 3.0,
  BLOOM_COUNTDOWN_S: 5.0,

  // --- movement feel (auto-run: the climber always runs, one-thumb play) ---
  RUN_SPEED_MIN: 0.34,      // rad/s floor for the auto-run, so rings feel alive
  RUN_SPEED_REL: 0.85,      // auto-run speed = max(MIN, 0.85× |ring speed|)
  MOVE_EASE_S: 0.12,        // ease when flipping run direction
  AIR_DRIFT: 0.35,          // rad/s of gentle drift toward run dir while airborne
  PLAYER_HALF_ANG: 0.045,   // player angular half-width (rad) for collisions

  // --- ledge grab (climber forgiveness) ---
  GRAB_RANGE_ANG: 0.11,     // rad: how far past a platform edge a grab still catches
  GRAB_PULL_S: 0.22,        // pull-up animation duration
  GRAB_INSET_FRAC: 0.015,   // how far inside the arc the pull-up lands (frac units)

  // --- touch gestures ---
  TAP_SLOP_PX: 26,          // max movement for a touch to count as a tap (jump)
  TAP_MAX_MS: 350,
  SWIPE_MIN_PX: 34,         // min movement to count as a swipe (turn / dash)

  // --- world window / camera ---
  RING_WINDOW: 3,           // rings kept at depth-3 .. depth+3
  DEPTH_MAP_A: 3.0,         // screen mapping: n=(A - ringOffset)/B, sN=n^FISHEYE_EXP
  DEPTH_MAP_B: 7.9,         //   (chosen so the player's ring sits at ~55% radius)
  CAM_OMEGA: 12,            // critically damped camera spring (~0.35s settle)
  // global view rotation is now per-Bloom DNA (rotationDrift, ±0.008–0.028)
  RING_BAND_HALF: 1.2,      // radial half-thickness of a ring band, world units

  // --- pickups ---
  MOTE_RADIAL_TOL: 1.8,     // world units for mote collection
  MOTE_ANG_TOL: 0.07,       // wedge-frac tolerance for mote collection
  MOTE_SCORE: 25,           // × combo

  // --- scoring ---
  DEPTH_SCORE: 10,          // per ring descended
  BLOOM_BONUS: 500,         // × blooms survived so far

  // --- death / flow ---
  DEATH_SLOWMO_S: 0.9,
  DEATH_TIMESCALE: 0.25,
  PAUSE_TIMESCALE: 0.10,    // world keeps rotating at 10% behind the veil

  // --- render ---
  BLOOM_THRESHOLD: 0.72,
  BARREL_K: 0.06,
  CA_BASE: 0.0025,
  CA_RADIAL: 0.004,
  CA_SPIKE_MS: 200,
  PARTICLE_CAP: 600,
  TRAIL_SEGMENTS: 24,
  BEAT_BPM: 92,
} as const;
