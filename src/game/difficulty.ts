/**
 * BLOOM — every gameplay tuning constant lives here.
 * Design intent: an endless runner with Subway-Surfers fluidity, flown
 * through a living kaleidoscope. You fly forward automatically; steering
 * rotates the tunnel around you. Difficulty comes from pace, ring rotation
 * and shrinking doorways + Bloom chaos, never from control complexity.
 */
export const TUNING = {
  FISHEYE_EXP: 0.62,        // screenRadius = pow(depthNorm, FISHEYE_EXP)
  RING_SPACING: 10,         // world units between ring planes
  BASE_RING_SPEED: 0.31,    // rad/s ring rotation at depth 0
  RING_SPEED_PER_DEPTH: 0.012,
  RING_SPEED_CAP: 1.4,
  HAZARD_CHANCE_START: 0.15,
  HAZARD_CHANCE_MAX: 0.55,
  HAZARD_CHANCE_PER_DEPTH: 0.004,
  PETAL_MIN_DEPTH: 22,      // razor petals only appear deeper than this
  SKIM_WINDOW_S: 0.5,
  COMBO_RESET_S: 1.5,
  COMBO_MAX: 8,
  // Bloom cadence escalates (phases.ts bloomPeriod: 45s shrinking to 18s)
  BLOOM_TRANSITION_S: 3.0,
  BLOOM_COUNTDOWN_S: 5.0,

  // --- the run: you fly forward through the rings (endless-runner core) ---
  FLY_SPEED_BASE: 12,       // world units/s forward at pace 1
  FLY_TAKEOFF_S: 6,         // seconds to reach full pace after DESCEND
  JUMP_WINDOW_S: 0.45,      // airborne window: passes over LOW rings
  JUMP_BUFFER_MS: 160,
  DASH_DUR_S: 0.55,         // dash: speed burst + smashes through one wall
  DASH_SPEED_MUL: 1.7,
  DASH_CD_S: 2.6,
  BRAKE_DUR_S: 0.8,         // brake (swipe down): brief slow to line up a door
  BRAKE_SPEED_MUL: 0.6,
  BRAKE_CD_S: 1.6,

  // --- steering (Subway-Surfers fluidity: world rotates, wisp stays put) ---
  STEER_KEY_SPEED: 2.7,     // rad/s while holding ←/→
  STEER_DAMP: 7.5,          // steering momentum damping
  DRAG_RAD_PER_PX: 0.008,   // finger drag → tunnel rotation
  HOP_IMPULSE: 6.0,         // quick flick = eased lane-hop impulse (rad/s)
  ASSIST_RANGE: 0.17,       // rad: aim-assist pull toward a nearby door
  ASSIST_RATE: 2.2,         // rad/s of assist pull near a crossing
  GRAZE_RAD: 0.06,          // passing this close to a door edge = graze bonus
  PLAYER_HALF_ANG: 0.045,   // player angular half-width (rad) for collisions

  // --- touch gestures ---
  TAP_SLOP_PX: 24,          // max movement for a touch to count as a tap (jump)
  TAP_MAX_MS: 300,
  FLICK_MIN_PX: 48,         // fast horizontal flick = lane hop
  FLICK_MAX_MS: 240,
  SWIPE_V_MIN_PX: 44,       // vertical swipe: up = dash, down = brake

  // --- the maze: rings are near-solid walls with 1-2 doorways ---
  DOOR_WIDTH_RAD: 0.5,      // base door opening, radians (shrinks with depth)
  DOOR_WIDTH_MIN_RAD: 0.26,
  DOOR_SHRINK_PER_DEPTH: 0.004,
  LOW_RING_CHANCE: 0.26,    // low walls you can jump over instead of steering

  // --- world window / camera ---
  RING_WINDOW: 3,           // rings kept at depth-3 .. depth+3
  DEPTH_MAP_A: 2.5,         // screen mapping: n=(A - ringOffset)/B, sN=n^FISHEYE_EXP
  DEPTH_MAP_B: 6.6,         //   (player ring ~55% radius; rings ~20% farther apart)
  // steering pins the wisp to the bottom of the screen; the camera depth
  // locks to the flight z, so no spring is needed
  RING_BAND_HALF: 1.2,      // radial half-thickness of a ring band, world units

  // --- pickups (motes ride the rings just ahead of their doorways) ---
  MOTE_RADIAL_TOL: 2.2,     // world units for mote collection
  MOTE_ANG_TOL: 0.09,       // pattern-frac tolerance for mote collection
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
