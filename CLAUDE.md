# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Splatcademy: a browser paintball FPS for classrooms where students earn paint (ammo) by
answering study questions. `PLAN.md` has the locked decisions, workstream file
ownership, and build order (steps 1–6). Work is currently in phase 0 (offline movement
and shooting sandbox with infinite ammo).

## Commands

Run from the repo root. pnpm comes from corepack (`packageManager` in `package.json`).

- `pnpm dev`: runs every package's `dev` script (client is Vite on http://localhost:5173; the server joins in step 4)
- `pnpm test`: Vitest over `packages/**/src/**/*.test.ts` and `apps/**/src/**/*.test.ts` (root `vitest.config.ts`)
- `pnpm vitest run packages/shared/src/world/collision.test.ts`: a single test file
- `pnpm vitest run -t "counter-strafe"`: tests matching a name
- `pnpm typecheck`: `tsc` per package (TypeScript 7, `noEmit`)
- `pnpm --filter @splat/client build`: production client bundle
- `pnpm --filter @splat/client run deploy`: build and deploy the client to Cloudflare (`apps/client/wrangler.jsonc`; needs `wrangler login`). After a build, `pnpm --filter @splat/client exec wrangler deploy --dry-run` validates the config without deploying.
- `node apps/client/bench/run.mjs --throttle 4,6 --repeat 3`: headless perf benchmark against `apps/client/dist` (build first; uses a system Playwright install). Results are noisy on laptops, so compare medians of repeats. In a browser, `?bench=1` runs the same scripted route and prints JSON.
- New dependencies with install scripts are blocked by pnpm until approved: `pnpm approve-builds <pkg>` (records them under `allowBuilds` in `pnpm-workspace.yaml`).

There is no linter yet.

## Architecture

- `packages/shared` (`@splat/shared`) is imported as TypeScript source (its `exports` points at `src/index.ts`; no build step). Anything the client predicts and the server will later simulate authoritatively lives here: math, `UserCmd`, map and collision, movement, weapons/spray/projectiles.
- `apps/client` is Vite + Three.js with a DOM HUD. `src/game/` owns the loop and `GameContext`; features such as `src/shooting/` plug in as `ClientSystem`s (contract in `src/game/types.ts`).
- `apps/server` is a placeholder until step 4. It will be a Cloudflare Durable Object per game room, not Colyseus (see "Hosting" in `PLAN.md`); Supabase comes later for teacher accounts and stored data.
- Deploy target is Cloudflare: the client is a static Vite build served as Workers static assets. `packages/shared` must not use Node built-ins or DOM APIs, because the same code runs in the browser and in Workers.

Conventions that span files:

- **Units and axes:** Quake units (1 u ≈ 1 inch), Y-up. Quake/SUCC formulas are Z-up, so swap Z for Y when porting. Player `pos` is the feet (center-bottom of the hull).
- **View angles:** radians; yaw 0 looks down −Z, +yaw turns left, +pitch looks up. Use `viewForward`/`yawForward`/`yawRight` from `shared/src/math.ts` rather than re-deriving.
- **Fixed tick:** simulation runs at 64 Hz (`TICK_DT`). Sim code must be deterministic: no `Math.random`, `Date`, or `performance.now`. Randomness comes from a seeded PRNG passed in, so the server can replay the same `UserCmd`s.
- **Sim state is plain data** (numbers, booleans, `{x,y,z}` objects) so it can be network-synced. Vector helpers write into an `out` argument to avoid per-tick allocation.
- **Collision:** the map is convex brushes (`box`, `ramp`) compiled to planes. `traceBox` follows Quake 3's `CM_TraceThroughBrush` (planes pushed out by the box extents); `traceRay` is the zero-size case.
- **Hitboxes:** players move with an AABB hull against the world, but projectiles hit players and dummies as vertical capsules (`HitCapsule` in `shared/src/projectile.ts`), swept over the target's motion during the tick. Balls hit the world as rays (their center) and hit targets as spheres. Rendered ball size equals hit radius, and dummy meshes are built from the same capsule numbers. Keep visuals and hit volumes generated from one source.
- **Performance:** frame time on low-end hardware is dominated by per-draw-call cost in `renderer.render`, so prefer merged or instanced meshes over extra objects. Keep per-tick and per-frame paths allocation-free, and write DOM HUD values only when they change.
- **Client loop:** each tick samples a `UserCmd`, then runs `stepPlayer`, then `system.fixedUpdate`. Each frame applies mouse look directly (not interpolated), interpolates the camera position between the previous and current tick, adds `viewPunch`, then runs `system.render(alpha)`.
- **Tuning:** tunables are top-level number/boolean fields with a matching `*_META` range table. `addTunables` (`apps/client/src/dev/tuning.ts`) builds lil-gui controls, persists to localStorage under `splat.*` keys, and offers "copy JSON" for pasting values back into presets. Saved localStorage values override code defaults, so use "reset to default" after changing a preset in code.

## Rules

- Paintball theme only: paint, splats, "splatted"; no blood, realistic guns, or violent wording. It ships to schools.
- Answer checking will be server-only; the client must never receive a correct answer before the student submits.
- Movement is ported from SUCC (MIT). Keep its credit in `THIRD_PARTY_NOTICES.md` and the README. node-cs2 has no license: never copy its code.
