# aiwars-mcp-lasertango — Laser Tango minigame referee

An AIWars minigame built on the shared **`aiwars-minigame`** library (tier 1:
turn-based), exactly like `MLWars/aiwars-poker`. The library owns everything that
isn't the rules — the env-driven bootstrap, the control REST API, the spectator
view server, the bearer-gated MCP gamepad, the scripted demo bot, and the
**Seat API** that lets a HUMAN occupy a seat and play. This repo supplies only the
Laser Tango rules (`src/lasertango.rs`) and its spectator SPA (`view/`).

## What it is
Two infiltrators cross a dark vault corridor of `SEGS` segments by **timing moves
to a metronome**. Red laser beams sweep on a phase clock; the beam guarding a
boundary is LIT on some beats, DARK (a gap) on others. Each turn an agent reads
the beat and commits one **move** from its legal set:
`advance:gap` (step one segment through the gap — trips if the beam ahead is LIT) ·
`wait:beat` (hold, always safe) · `slide:under` (a risky fast skip of two segments,
clean only when both beams ahead are dark). Step into a lit beam and you're
**TRIPPED** (eliminated). First to reach the exit segment **BREACHES** and wins;
both tripped → **draw**. A seeded twist — the per-boundary beam phase **offsets** —
means the safe beats differ each match, so identical prompts don't always resolve
the same. Odds stay live.

The agent's **public prompt** (its doctrine) is what chooses which legal move it
plays each turn via `make_move` — exactly the prompt-is-king model the website
surfaces and bettors read.

Laser Tango is **perfect information**: the beat, the beam offsets and both
runners' positions are all public (the SPA draws the beams from them), so
`Minigame::observe` ignores its `viewer` argument and everyone — runner and
spectator alike — reads the same projection.

## Layout
```
src/lasertango.rs # impl Minigame + TurnBasedGame for LaserTango — the rules (+ unit tests)
src/lib.rs        # re-exports LaserTango
src/main.rs       # fn main() { aiwars_minigame::run::run_turn_based::<LaserTango>() }
view/             # offline spectator board (polls /state.json), no remote assets
game.toml         # the manifest: bin/name/category + [demo] enabled (the human-play gate)
Dockerfile        # generic referee image — builds game.toml's `bin`, bakes view/ → /srv/view
```

## Move vocabulary
`advance:gap` · `wait:beat` · `slide:under`

- **advance:gap** — +1 segment if the beam guarding the next boundary is DARK this
  beat; step into a LIT beam and you TRIP out.
- **wait:beat** — no movement, always safe; the sweep advances one beat each full round.
- **slide:under** — +2 segments if BOTH of the next two beams are DARK, else you clip
  one and TRIP.

## The two consoles
Both are library code, both authenticate the same way (`sha256(bearer)` → seat)
and both drive the same validation path:

- **Champions (MCP, port 9090)** — `get_state()` → `legal_moves()` →
  `make_move(mv, expected_ply)` → (`resign`).
- **Humans (Seat API, on the view port 8090)** — `GET /seat/schema`,
  `GET /seat/state[?wait_ms&since_ply]`, `POST /seat/move`, `POST /seat/resign`.
  Served only because `game.toml` declares `[demo] enabled = true`; the referee
  reads that from the `/game.toml` baked into its image at boot.

`GET /state.json` (anonymous) returns `{ game:"lasertango", runners:[…], beat,
beam_ahead, offsets, status, winner, moves, … }` — the SPA renders it. The `game`
key is injected by the library, not by the game.

## Build / test
```bash
cargo build --locked
cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```
`aiwars-minigame` is a git dep on the PRIVATE `AsafFisher/AIWars` repo; CI and the
Dockerfile authenticate with the `AIWARS_DEP_TOKEN` secret (a `git insteadOf`
rewrite). Locally, configure the same rewrite. **`Cargo.lock` is committed and
load-bearing**: an unlocked resolve floats `rmcp-macros` to 1.8.0 against `rmcp`
1.7.0 and the build fails with `E0425`.

### Run the referee locally
```bash
export AIWARS_MATCH='{"settings":{"seed":7},"agents":[
  {"handle":"tempo","token_hash":"<sha256 of the seat token>","kind":"human"},
  {"handle":"blitz","token_hash":"<sha256 of the seat token>","kind":"bot"}]}'
cargo run --release            # control 8080 · MCP 9090 · view 8090
curl -X POST localhost:8080/start
curl -H "Authorization: Bearer <seat token>" localhost:8090/seat/state
```

## Deploy
The World-Manager selects the referee image per match via
`WorldRequest.mcp_image` (or the `MCP_IMAGE` env) — point a Minigame world at the
`mcp:lasertango` tag and it runs, no world-manager change needed. The site reads
`[demo] enabled` from an **OCI label on the published image**, so a change here
only reaches players once the image is rebuilt and republished.

## Rules summary (the engine port)
- Corridor of `SEGS = 7` segments; beam sweep `PERIOD = 4`; metronome cap
  `MAXBEATS = 22`.
- A boundary's beam is LIT on phases 0 and 2, DARK on phases 1 and 3, where the
  phase = `(beat + offset[boundary]) % PERIOD` and `offset[…]` is **seeded** (the
  twist).
- `advance:gap` → +1 segment if the next beam is DARK, else TRIP.
- `wait:beat` → no movement, always safe; the sweep advances each full round.
- `slide:under` → +2 segments if both the next two beams are DARK, else TRIP.
- Reach segment `SEGS` → **breach** (win). Both tripped → draw. At the cap, the
  deeper runner wins; dead even is a draw. A wall-clock timeout is awarded by
  `timeout_leader()`, which uses the same rule (untripped beats tripped, then
  deeper wins).
