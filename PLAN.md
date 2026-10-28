# Splatcademy plan

A classroom paintball FPS: students earn paint (ammo) and power-ups by answering study
questions, then spend it in a graybox arena. Learning is the economy; the FPS is the
reward loop. The full product brief is the original spec; this file records decisions,
ownership, and the build order.

## Locked decisions

| Area | Decision | Why |
|---|---|---|
| Repo | pnpm monorepo: `apps/client`, `apps/server`, `packages/shared`. Shared is consumed as TS source (no build step). | One copy of sim code for client prediction and server authority. |
| Units | Quake units (1 u ≈ 1 inch), **Y-up**. | Lets the SUCC/Quake port keep its numbers (320 u/s, 800 gravity). Quake is Z-up, so ported formulas swap Z for Y. |
| Angles | Radians. Yaw 0 looks down −Z, +yaw turns left, +pitch looks up (matches a Three.js camera with Euler order `YXZ`). | Same convention in sim, camera, projectiles. Helpers in `shared/src/math.ts`. |
| Tick | Fixed 64 Hz (`TICK_DT`), render decoupled with interpolation. | Spec; matches CS-style feel and the server tick. |
| Collision | Convex brushes (`box`, `ramp`) compiled to planes, swept with a Quake 3 style `traceBox`. A zero-size box is a ray. | Ramps need sloped planes, which AABB-only collision can't do; no physics engine needed. |
| Determinism | Sim code takes all randomness from a seeded PRNG and never reads clocks. | Server replays the client's `UserCmd`s; prediction must match. |
| Input packet | `UserCmd` (`shared/src/input.ts`) is sampled per tick. Offline it feeds the local sim; in step 4 it's what the client sends. | No rewrite when networking lands. |
| Tuning | Every tunable is a top-level number/boolean with a `*_META` range entry. The dev panel (lil-gui) builds sliders automatically, persists to localStorage, and copies JSON to paste back into presets. | You tune by feel in the browser, then lock values into code. |
| Recoil | Written from scratch; node-cs2 has no license and is only an idea source. | Licensing. |
| Hosting | Cloudflare. Client = static Vite build served as Workers static assets. Game rooms = one Durable Object per join code (replaces Colyseus, see "Hosting" below). Supabase later for teacher accounts and stored data. | User requirement. Colyseus needs a long-running Node server, which Workers can't host. |
| Runtime-neutral shared code | `packages/shared` uses no Node built-ins and no DOM, so the same sim runs in the browser and inside a Durable Object. | Hosting. |

## Phase 0, now: FPS feel sandbox (build steps 1 and 2)

Goal: an offline build where you can move, shoot, and tune everything live, with
**infinite ammo** and no question loop yet.

Three parallel workstreams with disjoint file ownership:

| Workstream | Owns | Delivers |
|---|---|---|
| **A. Movement** | `packages/shared/src/movement/**`, fixes to `world/collision.ts`, `THIRD_PARTY_NOTICES.md` | SUCC → TypeScript port: ground accel/friction, air accel + strafing, bhop, counter-strafe, crouch, crouch-jump, step-up, ramps. `goldsrc` and `classroom` presets. Unit tests. |
| **B. Shooting** | `packages/shared/src/{weapons,spray,projectile}.ts`, `apps/client/src/shooting/**` | Splatter / Lobber / Spritzer, spray patterns with 450 ms reset, movement-based spread, ballistic paintballs, splat decals (capped), target range dummies with paint meters, view punch, ∞ ammo toggle, spray debug overlay. Unit tests. |
| **C. Client core** | `apps/client/**` except `shooting/`, `packages/shared/src/map/**` | Three.js graybox renderer, the arena map, pointer lock + raw mouse (CS-style sensitivity), 64 Hz loop with interpolation, speedometer + HUD, dev tuning panel, settings (sens, FOV, quality). |

Contracts the workstreams code against (written before they started):

- `shared/src/world/{types,collision}.ts`: `MapDef`, brushes, `traceBox`, `traceRay`
- `shared/src/movement/pmove.ts`: `PlayerState`, `stepPlayer(s, cmd, cfg, world, dt, mods)`, `getHull`, `getEyePosition`
- `shared/src/movement/config.ts`: `MovementConfig`, `MOVEMENT_PRESETS`, `MOVEMENT_CONFIG_META`
- `apps/client/src/game/types.ts`: `GameContext`, `ClientSystem`, `SystemFactory`
- `apps/client/src/dev/tuning.ts`: `addTunables(gui, title, target, meta, opts)`

**Playtest checklist for phase 0**
- Speedometer reads ~320 running and ~166 holding Shift (walk = 0.52 × max); counter-strafe stops you almost instantly
- Air strafe gains speed; bhop chains hold speed on `goldsrc`, cap on `classroom`
- Crouch-jump reaches the ledge a normal jump can't; small steps don't stop you
- Splatter spray is learnable (pull down, then follow the drift); the first shot standing still lands on the crosshair
- Shooting while moving or airborne is visibly worse
- Lobber arcs; Spritzer is useless past mid range
- Splats stick to walls/floors and old ones disappear past the cap
- Stays at 60 fps on the "low" quality setting

## Build order after phase 0

**Step 3: study loop (offline).**
`shared/src/questionSet.ts` (zod schema: `{ id, title, subject, questions: [{ id, prompt, type, options, answer, explanation?, imageUrl?, difficulty? }] }`), CSV → JSON converter, 3 sample sets in different subjects. `Q` opens the question overlay: slow movement, no shooting. Correct answers give paint and Power Bar fill (streak bonus); wrong answers give a 3 s cooldown and show the correct answer. In-session spaced repetition (missed questions return sooner). Ammo becomes finite. Log time-in-panel vs time-in-arena so the 40–50% answering target can be tuned. The answer checker is a pure function with the same interface the server will use.
*Playtest:* the answer/fight rhythm, whether ammo runs out at the right pace, whether wrong answers feel fair.

**Step 4: networking.**
One Durable Object per game, addressed by its 6-digit join code. It runs `stepPlayer` + projectiles + economy at 64 Hz from client `UserCmd`s over WebSockets. Client prediction with reconciliation (replay unacked cmds), interpolation for remote players, lag-compensated projectile spawn (rewind the shooter's eye position to cmd time). Correct answers never leave the server before a submission. A compact binary snapshot protocol in `shared/src/protocol.ts` replaces Colyseus schema sync.
*Playtest:* two browsers plus a throttled one (Chrome devtools 150 ms); prediction errors and rubber-banding.

**Step 5: host flow.**
Host page (set, mode, time limit, teams) → join code + QR. Lobby with kick, nickname filter, auto-generated names option. Live dashboard (class accuracy, per-question accuracy, leaderboard). End report with hardest questions, per-student accuracy, CSV download.

**Step 6: power-ups, modes, polish.**
Power Bar picks 1 of 3 (Rapid Hopper, Big Splat, Paint Shield, Speed Boots, Radar Ping). Team Splat and Free-for-All. Study-only mode (shooting off). Touch controls. Colorblind-safe palette audit. Chromebook performance pass (draw calls, decal cap, pixel ratio).

## Hosting: Cloudflare now, Supabase later

**Client (deployable from phase 0).** `vite build` gives a static bundle; `apps/client/wrangler.jsonc` serves it as Workers static assets. Deploy with `pnpm --filter @splat/client run deploy` after `wrangler login`.

**Game server (step 4): Durable Objects instead of Colyseus.** The spec named Colyseus, but it needs a long-running Node process, which Workers can't host. A Durable Object fits a game room: single-threaded, one instance per join code (`idFromName(code)`), WebSockets end on it, and it can run a 64 Hz loop while players are connected. The shared sim imports unchanged because it's plain TS. Scaling is per-room automatically, so the spec's "Colyseus presence with Redis" item goes away. Costs: the room is billed for wall-clock time while a match runs (fine for class-length games), and we write our own small protocol instead of Colyseus schema sync. The fallback, if Durable Objects disappoint in step 4, is Colyseus in Cloudflare Containers or on a Node host, with the client still on Cloudflare.

**Supabase (step 5 and later).**
- Teacher accounts: Supabase Auth. Students stay anonymous (join code + nickname).
- Question sets: stored as `jsonb`, validated with the zod schema on write.
- Game reports: per-student accuracy and per-question stats.
- Question images: Supabase Storage.
- Access rules: the Durable Object talks to Supabase with the service-role key, held as a Worker secret. Row-level security keeps question sets readable only by their owner. Students' browsers never query Supabase for questions, so answers can't leak to the client.
- Until then, the spec's "no database for v1" holds: sets load from bundled JSON or teacher uploads.

## Risks to watch

- **Spray + projectiles.** With travel time and drop, CS-style spray control feels different from hitscan. Everything is tunable; expect several tuning passes.
- **40 players × 64 Hz** in one Durable Object (single-threaded): movement sim is cheap, but projectile vs player tests scale with balls in flight. Measure CPU per tick in step 4 before optimizing.
- **Chromebooks:** keep the map as a few merged meshes and decals instanced, and start the "low" preset at pixel ratio 1.
- **Economy tuning** (40–50% time answering) needs the step 3 telemetry; don't guess the numbers.
