# Splatcademy

A browser paintball FPS for classrooms: students earn paint by answering study
questions, then spend it in a graybox arena. See `PLAN.md` for the design and
build order.

Current state: phase 0, an offline movement and shooting sandbox with infinite
ammo and a live tuning panel. No question loop or multiplayer yet.

## Run it

Requires Node 22+ with corepack (ships with Node).

```sh
corepack enable pnpm   # once; or use `corepack pnpm ...`
pnpm install
pnpm dev               # http://localhost:5173
```

`pnpm test` runs the unit tests, `pnpm typecheck` checks types.

## Controls

| Key | Action |
|---|---|
| Click | Play (locks the mouse) |
| WASD | Move |
| Space / mouse wheel | Jump (the wheel can be set to cycle markers) |
| C | Crouch (Ctrl also works in fullscreen) |
| Shift | Walk |
| Mouse 1 | Fire |
| 1 / 2 / 3 | Splatter / Lobber / Spritzer |
| R | Respawn at the selected teleport |
| F1 or ` | Toggle the tuning panel |
| Esc | Release the mouse |

Sensitivity uses the CS scale (0.022° per count), so your CS sensitivity carries
over. FOV is CS-style horizontal degrees at 4:3.

URL options: `?tp=N` start at teleport N (e.g. the target range), `?view=top` for an
overhead camera, `?panel=0` to hide the panel.

## Tuning

Every movement and marker value has a slider in the panel. Changes are saved in
your browser. "copy JSON" puts the current values on the clipboard to paste into
the presets in `packages/shared/src/movement/config.ts` or
`packages/shared/src/weapons.ts`. Values that differ from the preset are
highlighted.

## Deploy (Cloudflare)

```sh
pnpm --filter @splat/client exec wrangler login   # once
pnpm --filter @splat/client run deploy
```

The client is served as static assets by a Worker (`apps/client/wrangler.jsonc`).

## Layout

- `packages/shared`: simulation code shared by client and (later) server: math, input, collision, movement, weapons, map
- `apps/client`: Vite + Three.js client
- `apps/server`: game server (step 4, Cloudflare Durable Objects)

## Credits

Player movement is ported from [SUCC](https://github.com/bearlikelion/SUCC)
(MIT). See `THIRD_PARTY_NOTICES.md`.
