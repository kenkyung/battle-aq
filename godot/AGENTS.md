# AGENTS.md — battle-aq

This file is auto-loaded by Claude Code, Codex, OpenCode, and similar coding
agents when working in this directory. It restates the non-negotiable rules
from `ARCHITECTURE.md` in a form agents respect at runtime.

## Read first

Read `ARCHITECTURE.md` before touching any file. The performance budget,
module layout, and RPC surface there are the contract.

## Hard rules

1. **All gameplay code lives under `scripts/`.** New files must follow the
   naming in ARCHITECTURE §2. No file in repo root except configs.
2. **All RPCs go through `scripts/network_codec.gd`.** No raw `rpc()` /
   `rpc_id()` calls outside that file. The CI grep gate enforces this.
3. **The renderer is GL Compatibility.** No MSAA, no SSAO, no SDFGI, no
   volumetric fog in default preset. If you think the game needs it, propose
   it in ARCHITECTURE §9, do not enable it.
4. **No per-pixel transparency on default materials.** It kills GL Compat
   perf on iGPUs. Use alpha-test or discard-based transparency only.
5. **Multiplayer is server-authoritative.** Clients send `intent_*` RPCs;
   the server mutates HP/ammo/objective and broadcasts via synchronizer.
6. **One ticket per PR.** Reference a ROADMAP.md milestone item in the
   commit body.
7. **Conventional Commits.** `feat:`, `fix:`, `refactor:`, `perf:`, `test:`,
   `docs:`, `build:`. Lowercase. No emoji.

## Performance budget

- 16.6 ms/frame on Intel UHD 620
- ≤ 4 000 verts for player worldmodel, ≤ 2 000 for viewmodel
- MultiplayerSynchronizer rate ≤ 20 Hz
- Network sync budget ≤ 1 ms/frame

## Before declaring done

- `godot --headless --check-only --path .` passes (or note that the env
  has no Godot binary, in which case list every file you touched and the
  exact lines you verified).
- If you added a new RPC, edit `network_codec.gd` AND append a row to
  ARCHITECTURE §3 authority table.
- If you added a new asset class, append a row to ARCHITECTURE §4 budgets.
- If you changed the RPC surface or module layout, edit ARCHITECTURE.md
  in the same PR.

## What not to do

- Don't add new dependencies. Godot 4 stdlib + ENet is the budget.
- Don't fork the engine. Use Godot 4.3+ stock.
- Don't introduce Unity/Unreal-style patterns. This is GDScript + Godot scenes.
- Don't write tests that require Godot runtime. The engine's headless
  check is the smoke test.
- Don't commit `.godot/` or `*.import` files (gitignored).