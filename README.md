# Battle-AQ

A lightweight online multiplayer first-person shooter inspired by Counter-Strike.

Built on **Godot 4.x** with the **GL Compatibility** renderer so it runs on modest
hardware — integrated GPUs, Steam Deck, low-end laptops, and mobile. Networking
is built-in **ENetMultiplayerPeer** (peer-to-peer with optional dedicated host),
state replication uses `MultiplayerSpawner` / `MultiplayerSynchronizer`.

## Goals

- Round-based FPS in the CS lineage: buy menu, weapon archetypes, plant/defuse or
  team deathmatch, buy-time + round-time, economy.
- Server-authoritative hits: clients send `fire` intent, server raycasts and
  broadcasts damage events. Prevents wallhacks + speedhacks by construction.
- Cross-platform from day one (Linux, Windows, macOS, Android, HTML5 export).
- Tiny binary, instant startup, no engine forks.

## Layout

```
scenes/         .tscn files (Main, Player, Weapon, Map, HUD)
scripts/        .gd gameplay code
assets/         materials, sounds, maps, icons
```

## Running locally

1. Install Godot 4.3+ (standard, not Mono).
2. `godot --path . --headless` for a server, or `godot --path .` to launch the
   client. The Main menu has **Host** / **Join** / **LAN Browser** buttons.

## Network model

- Peer-to-peer with one peer acting as authoritative server (default port
  `24816`). Host runs physics + scoring.
- State replication: `MultiplayerSynchronizer` on Player (position, rotation,
  health, ammo, current weapon) and on Projectile (linear motion).
- RPC channels: `fire_weapon`, `apply_damage`, `chat_message`,
  `round_start`, `round_end`, `buy_item`.

## Roadmap

- [ ] M1 — movement, shooting, raycast hits, HP, respawn
- [ ] M2 — buy menu, weapon archetypes, ammo + reload, economy
- [ ] M3 — round system, scoreboard, two-team spawns
- [ ] M4 — first proper map (`de_dust`‑style arena blockout)
- [ ] M5 — dedicated server build + matchmaking stub
- [ ] M6 — Linux / Windows / Android exports

See `ROADMAP.md` for the ticket-sized backlog.

## Contributing

Open an issue with a label (`bug`, `feature`, `map`, `art`, `net`). PRs:
one ticket per PR, run `godot --headless --check-only` before pushing.

## License

MIT (see `LICENSE`).