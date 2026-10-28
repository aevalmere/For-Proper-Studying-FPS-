# Third-party notices

## SUCC (SurfsUp Character Controller)

- Source: https://github.com/bearlikelion/SUCC
- Docs: https://bearlikelion.github.io/SUCC/
- License: MIT (text below)

### What was ported

`packages/shared/src/movement/` is a TypeScript port of SUCC's movement model, with
values converted from metres to Quake units (SUCC's own factor, 39.37 units per metre):

- `addons/SUCC/scripts/succ.gd`: friction on horizontal speed, ground acceleration, air
  acceleration with the 30-unit wish cap, the jump impulse derived from jump height and
  gravity (with the half-step gravity decay on the jump tick), crouch speed scaling on
  the speed cap, the air-duck origin raise with its below-the-feet clearance check on
  unduck, snapping down onto ground when walking down steps (`_step_down`), stair view
  smoothing that only applies to flat treads, and the per-axis velocity clamp.
- `addons/SUCC/scripts/succ_config.gd`: the set of tunables and their meanings.
- `addons/SUCC/resources/goldsrc.tres`: the values behind the `goldsrc` preset
  (320 max speed, 800 gravity, 45-unit jump, 10 accelerate, 10 air accelerate, 4
  friction, 100 stop speed, 30 air wish cap, 18 step, 72/36 hulls, 32 width, 64/30 eye
  heights, 85/170 u/s crouch view speeds, 2000 per-axis velocity clamp).

Godot's `move_and_slide` was not ported. Collision response is written from the
published Quake / Half-Life SDK algorithms (`PM_FlyMove`, `PM_WalkMove`,
`PM_ClipVelocity`, `PM_CategorizePosition`, `PM_Duck`, `PM_PreventMegaBunnyJumping`) on
top of this project's own `traceBox`. No Quake or Half-Life source code was copied.

### License

The repository-root `LICENSE` file reads as follows. The copy shipped inside the addon
(`addons/SUCC/LICENSE`) is identical except that its copyright line reads
`Copyright (c) 2026 Mark Arneman <arneman.me>`.

```
MIT License

Copyright (c) 2026 Mark

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
