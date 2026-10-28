// One UserCmd is sampled per simulation tick. Offline the client feeds it straight
// into the sim; in step 4 the same struct is what clients send to the server.

export const Buttons = {
  JUMP: 1 << 0,
  CROUCH: 1 << 1,
  FIRE: 1 << 2,
  WALK: 1 << 3,
} as const;

export interface UserCmd {
  seq: number;
  /** -1..1, positive = forward */
  forward: number;
  /** -1..1, positive = right */
  side: number;
  /** radians, see view-angle convention in math.ts */
  yaw: number;
  pitch: number;
  /** bitmask of Buttons */
  buttons: number;
  /** index into the weapon loadout */
  weapon: number;
}

export function emptyCmd(): UserCmd {
  return { seq: 0, forward: 0, side: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0 };
}
