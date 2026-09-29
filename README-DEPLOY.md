# Battle-AQ — test deployment runbook

How to get a server running on your Omarchy box, play from your MacBook on the
same WiFi, and let a friend in from anywhere over Tailscale.

This describes the **run-from-source** path, which needs no export templates and
worked end-to-end on 2026-09-29. Standalone `.app` / `.exe` builds are covered at
the end.

---

## 1. Topology

```
                 Tailscale tailnet (encrypted, no port forwarding)
   friend's PC  ────────────────────────────────────────────────┐
   (Windows)                                                     │
                                                                 ▼
   your MacBook ──── your LAN / WiFi ────────────────────►  Omarchy box
   (same house)          192.168.1.113:24816                 runs the server
                                                             UDP 24816
```

The server binds `0.0.0.0:24816`, so it answers on **both** interfaces at once:

| Who | Address | Why |
|---|---|---|
| Your MacBook | `192.168.1.113:24816` | same LAN, no tunnel needed |
| Your friend | `100.104.64.0:24816` | Tailscale tailnet address |

Both addresses are printed by the server on startup, so you never have to look
them up.

---

## 2. Start the server

```bash
cd ~/Projects/battle-aq
tools/run_server.sh                        # dedicated, headless, de_aq_dust
tools/run_server.sh --map de_aq_aztec      # pick a map
tools/run_server.sh --listen               # you also play on this machine
```

On startup it prints a block like:

```
[net] ----------------------------------------------------------
[net] Battle-AQ server listening on UDP 24816
[net]   remote players (Tailscale):  100.104.64.0:24816
[net]   LAN players:                192.168.1.113:24816
[net] ----------------------------------------------------------
```

That block is the thing to copy addresses from.

If Godot is not on `PATH`, point the script at it:

```bash
GODOT=/path/to/Godot_v4.3-stable_linux.x86_64 tools/run_server.sh
```

Available maps: `de_aq_dust`, `de_aq_inferno`, `de_aq_aztec`.

---

## 3. Join from your MacBook (same LAN)

1. Install **Godot 4.3 or newer, standard build** (not the .NET/Mono build) from
   <https://godotengine.org/download/macos/>. Drop it in `/Applications`.
2. Get the project onto the Mac — either clone it, or copy the folder across:
   ```bash
   git clone https://github.com/kenkyung/battle-aq.git
   cd battle-aq
   ```
3. Run the client, pointing at the LAN address the server printed:
   ```bash
   /Applications/Godot.app/Contents/MacOS/Godot --path . \
       -- --connect 192.168.1.113 --port 24816
   ```

Or launch Godot with no arguments, open the project, and use the in-game menu:
type the address in the box and press **Join**.

macOS will complain that Godot is from an unidentified developer the first time.
Right-click → **Open**, then **Open** again in the dialog. After that it launches
normally.

---

## 4. Join from your friend's Windows PC (remote)

Your friend needs to be **on your tailnet** first:

1. You invite them: <https://login.tailscale.com/admin/users> → *Invite external
   users*, or have them install Tailscale and share the machine with you.
2. They install Tailscale from <https://tailscale.com/download/windows> and sign
   in. `tailscale status` on your box should then list their machine.

Then:

1. They install Godot 4.3+ standard build from
   <https://godotengine.org/download/windows/> and unzip it.
2. They get the project (clone it, or you send them a zip of the folder).
3. They run, from inside the project folder:

   ```powershell
   Godot_v4.3-stable_win64.exe --path . -- --connect 100.104.64.0 --port 24816
   ```

   (PowerShell needs `.\` in front: `.\Godot_v4.3-stable_win64.exe ...`)

4. Confirm the tunnel works before blaming the game:
   ```powershell
   ping 100.104.64.0
   ```

### If you would rather not use Tailscale for them

Forward **UDP 24816** on your router to `192.168.1.113` and have them connect to
your public IP. UDP port forwarding is less reliable than Tailscale and exposes
the port to the internet; Tailscale is the supported path here.

---

## 5. Firewall

`ufw` is active on the server. Two rules were added on 2026-09-29:

```
24816/udp on tailscale0     ALLOW IN    Anywhere          # battle-aq tailnet
24816/udp                   ALLOW IN    192.168.1.0/24    # battle-aq LAN
```

Re-add them after a firewall reset:

```bash
sudo ufw allow in on tailscale0 to any port 24816 proto udp comment 'battle-aq tailnet'
sudo ufw allow from 192.168.1.0/24 to any port 24816 proto udp comment 'battle-aq LAN'
```

---

## 6. What to expect (and what is not built yet)

Working today:

- Server hosts any of the three maps; clients join and load the **right map**
- Every player sees every other player, and **their movement replicates**
- Mouse look, WASD movement, jumping, crouch-speed
- HUD: crosshair, HP bar, ammo counter, round timer, score strip, kill feed

**Not** working yet — do not be surprised:

- **Damage is not visible to the client that took it.** HP and ammo are
  server-owned but only synced *into* the server's copy. A client's own HP bar
  will not drop when it is shot. Fixing this needs a server→client state
  channel and is the next networking task (see `ROADMAP.md`, M2).
- **No buy menu, no economy, no round win conditions.** `GameState` runs the
  timer and the phase labels, but rounds do not end on kills.
- **No lag compensation.** Hits resolve at the victim's current server-side
  position. Fine on LAN and Tailscale; noticeable on a bad connection.
- **No weapons on screen.** Firing works mechanically, but there is no viewmodel.
- **No custom maps or art.** Everything is blockout geometry.

So a good first test is: *can we both load in, walk around, and see each other
move?* That part is solid. Shooting each other will look like it does nothing
because the HP readout on the victim does not update yet.

---

## 7. Troubleshooting

**`Failed to host on UDP 24816`** — something already holds the port:

```bash
ss -lnup | grep 24816
pgrep -af '[G]odot_v4'
pkill -f '[G]odot_v4'
```

**Client hangs on "Connecting..."** — check, in order:

```bash
ss -lnup | grep 24816          # is the server actually listening?
sudo ufw status | grep 24816   # are the rules still there?
ping 192.168.1.113             # from the Mac, over LAN
ping 100.104.64.0              # from the friend's PC, over Tailscale
```

**Client connects but the world is empty** — check the *server's* log for
`pushing map` and `reports map-ready`. If the handshake stops after
`Peer connected`, the client never answered; that is a firewall or tunnel
problem, not the game.

**Everyone is invisible to each other** — this was a real bug (a
`MultiplayerSpawner` replicating before the client had loaded the map). It is
fixed and guarded by the smoke test. If it reappears:

```bash
godot --headless --script scripts/smoke_test.gd --path .
```

and read the `has no MultiplayerSpawner (explicit spawning)` lines.

---

## 8. Standalone builds (optional, later)

Run-from-source is enough to play, and it is what has been verified. For
double-clickable builds you need the Godot **export templates** once (~1 GB, all
platforms in one download):

> Editor → *Editor* menu → **Manage Export Templates** → *Download and Install*

Then *Project → Export*:

| Target | Platform preset | Notes |
|---|---|---|
| Linux server | Linux/X11 | tick *Dedicated Server*; that is your `run_server.sh` replacement |
| macOS | macOS | unsigned; recipient right-click → Open |
| Windows | Windows Desktop | ship the `.exe` plus the `.pck` beside it |

Export presets are **not** committed yet — they have never been exercised, and a
hand-written `export_presets.cfg` that nobody has run is worse than none. Do the
first export in the editor, then commit the generated file.

---

## 9. Quick reference

```bash
# server (this box)
cd ~/Projects/battle-aq && tools/run_server.sh --map de_aq_dust

# MacBook on the LAN
/Applications/Godot.app/Contents/MacOS/Godot --path . -- --connect 192.168.1.113 --port 24816

# friend on Windows, over Tailscale
.\Godot_v4.3-stable_win64.exe --path . -- --connect 100.104.64.0 --port 24816

# verify the project still holds together after any change
godot --headless --script scripts/smoke_test.gd --path .
```
