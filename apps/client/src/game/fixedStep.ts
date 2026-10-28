// Fixed-timestep accumulator. The loop asks how many ticks to run this frame;
// whatever is left over becomes the render interpolation alpha.

export interface FixedStep {
  acc: number;
}

/** Longest frame we try to catch up on (a tab switch or breakpoint shouldn't fast-forward). */
export const MAX_FRAME_DT = 0.25;
/** At most this many ticks per frame; beyond it the backlog is dropped. */
export const MAX_STEPS_PER_FRAME = 8;

export function planSteps(state: FixedStep, frameDt: number, tickDt: number, maxSteps = MAX_STEPS_PER_FRAME): number {
  state.acc += Math.min(Math.max(frameDt, 0), MAX_FRAME_DT);
  let steps = Math.floor(state.acc / tickDt + 1e-9);
  if (steps > maxSteps) {
    // keep the sub-tick phase, drop the rest
    state.acc = (state.acc % tickDt) + maxSteps * tickDt;
    steps = maxSteps;
  }
  state.acc = Math.max(0, state.acc - steps * tickDt);
  return steps;
}

export function stepAlpha(state: FixedStep, tickDt: number): number {
  return Math.min(1, state.acc / tickDt);
}
