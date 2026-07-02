/** Finite state machine for the whole game flow. */
export enum GameState {
  BOOT = 'BOOT',
  MENU = 'MENU',
  RUN = 'RUN',
  BLOOM_TRANSITION = 'BLOOM_TRANSITION',
  DEATH = 'DEATH',
  GAMEOVER = 'GAMEOVER',
}

type Listener = (next: GameState, prev: GameState) => void;

export class StateMachine {
  state: GameState = GameState.BOOT;
  /** seconds spent in the current state */
  timeIn = 0;
  private listeners: Listener[] = [];

  set(next: GameState): void {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    this.timeIn = 0;
    for (const l of this.listeners) l(next, prev);
  }

  is(...states: GameState[]): boolean {
    return states.includes(this.state);
  }

  /** RUN and BLOOM_TRANSITION both simulate gameplay. */
  get playing(): boolean {
    return this.state === GameState.RUN || this.state === GameState.BLOOM_TRANSITION;
  }

  onChange(l: Listener): void {
    this.listeners.push(l);
  }

  tick(dt: number): void {
    this.timeIn += dt;
  }
}
