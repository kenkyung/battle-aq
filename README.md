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
2. Start a server on this machine:

   ```bash
   tools/run_server.sh                    # dedicated + headless, de_aq_dust
   tools/run_server.sh --listen           # you also play here
   tools/run_server.sh --map de_aq_aztec  # pick a map
   ```

3. Join from another machine — it prints the addresses to use:

   ```bash
   godot --path . -- --connect <server-address> --port 24816
   ```

   Or launch the client with no arguments and use the in-game **Host** /
   **Join** menu.

**Full walkthrough, including playing from a MacBook and letting a remote
friend in over Tailscale: [`README-DEPLOY.md`](README-DEPLOY.md).**

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