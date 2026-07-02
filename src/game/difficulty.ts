/**
 * BLOOM — every gameplay tuning constant lives here.
 * Subway-Surfers-style endless runner inside a kaleidoscope cave:
 * 3 lanes, swipe to change lane, jump low lasers, roll under high ones.
 * Slow start, telegraphed obstacles, always a fair path.
 */
export const TUNING = {
  // --- lanes & track ---
  LANE_X: 1.4,              // world units between lane centers
  RUN_SPEED0: 8.0,          // world units/s at the start
  RUN_SPEED_MAX: 21,
  RUN_ACCEL: 0.12,          // units/s gained per second (slow, fair ramp)
  LANE_TWEEN_S: 0.16,       // lane-change tween (snappy)
  JUMP_S: 0.62,             // jump airtime
  JUMP_H: 1.7,              // jump apex height (world units)
  ROLL_S: 0.55,             // roll duration
  RUNNER_H: 1.6,            // standing height (collision vs HIGH bars)
  ROLL_H: 0.75,             // rolling height (fits under HIGH bars)
  LOW_BAR_Y: 0.55,          // top of a LOW laser — jump above this to clear
  HIGH_BAR_Y: 1.15,         // bottom of a HIGH laser — roll below this
  COLLIDE_HALF_X: 0.62,     // lateral half-width for obstacle collision
  COIN_DZ: 0.8,
  COIN_HALF_X: 0.8,

  // --- obstacle generation (fair by construction) ---
  RUNWAY_Z: 26,             // obstacle-free opening stretch
  EVENT_GAP0: 22,           // world units between obstacle events at start
  EVENT_GAP_MIN: 12,
  EVENT_GAP_SHRINK: 0.12,   // gap lost per event
  HORIZON_Z: 65,            // spawn/draw distance
  COIN_ROW_CHANCE: 0.7,

  // --- camera / projection (pseudo-3D, one-point perspective) ---
  CAM_F: 1.1,               // focal length
  CAM_H: 2.8,               // camera height above the floor
  CAM_Z0: 5,                // the runner's fixed depth ahead of the camera
  VP_Y: 0.22,               // vanishing point height, clip units
  CAVE_HALF_W: 3.1,         // cave wall distance from center
  CAVE_H: 5.4,              // cave ceiling height

  // --- touch gestures (classic runner) ---
  SWIPE_MIN_PX: 32,
  SWIPE_MAX_MS: 400,
  TAP_SLOP_PX: 22,
  TAP_MAX_MS: 260,          // tap also jumps (one-thumb friendly)

  // --- Blooms ---
  BLOOM_TRANSITION_S: 3.0,
  BLOOM_COUNTDOWN_S: 5.0,

  // --- scoring ---
  DIST_SCORE: 0.5,          // points per world unit run
  COIN_SCORE: 25,
  CLOSE_CALL_SCORE: 15,     // skimming right past a blocked lane
  COMBO_MAX: 8,
  COMBO_RESET_S: 1.5,
  BLOOM_BONUS: 500,         // × blooms survived so far

  // --- death / flow ---
  DEATH_SLOWMO_S: 0.9,
  DEATH_TIMESCALE: 0.25,
  PAUSE_TIMESCALE: 0.10,    // world keeps flowing at 10% behind the veil
  TAKEOFF_S: 3.5,           // speed ramps in over the first seconds

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
