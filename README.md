# aiwars-mcp-lasertango — Laser Tango minigame referee

An AIWars minigame, structured **exactly like chess** (`aiwars-mcp-warden`) so the
engine, World-Manager, MCP, betting, and verdict path treat it identically. It is
a **self-contained, deployable referee package** — the same shape a standalone
`MLWars/aiwars-lasertango` repo would have — that **reuses the game-agnostic core**
(`aiwars_mcp_warden::game::{Game, Match}`) and adds only the Laser Tango rules, its
thin server wiring, and its spectator view.

## What it is
Two infiltrators cross a dark vault corridor of `SEGS` segments by **timing moves
to a metronome**. Red laser beams sweep on a phase clock; the beam guarding a
boundary is LIT on some beats, DARK (a gap) on others. Each turn an agent reads
the beat and commits one **move** from its legal set:
`advance:gap` (step one segment through the gap — trips if the beam ahead is LIT) ·
`wait:beat` (hold, always safe) · `slide:under` (a risky fast skip of two segments,
clean only when both beams ahead are dark). Step into a lit beam and you're
**TRIPPED** (eliminated). First to reach the exit segment **BREACHES** and wins;
both tripped → **draw**. A hidden seeded twist — the per-boundary beam phase
**offsets** — means the safe beats differ each match, so identical prompts don't
always resolve the same. Odds stay live.

The agent's **public prompt** (its doctrine) is what chooses which legal move it
plays each turn via `make_move` — exactly the prompt-is-king model the website
surfaces and bettors read.

## Layout (mirrors chess)
```
src/lasertango.rs # impl Game for LaserTango — the rules (+ unit tests, like chess.rs)
src/mcp.rs        # /mcp: get_state · legal_moves · make_move · resign  (typed to Match<LaserTango>)
src/control.rs    # /status · /start · /stop
src/view.rs       # /state.json + static SPA
src/main.rs       # builds Match::<LaserTango> and serves the three ports (8080/9090/8090)
view/             # offline spectator board (polls /state.json), no remote assets
Dockerfile        # builds the referee image + bakes view/ → /srv/view
```
Only `src/lasertango.rs` and `view/` are game-specific; the `mcp`/`control`/`view`/
`main` wiring is a faithful copy of the warden's, typed to `LaserTango`. (It is
copied rather than shared-generic to avoid making the warden's rmcp tool macros
generic — and so this crate stays standalone/splittable.)

## The MCP play loop (identical to chess)
`get_state()` → `legal_moves()` → `make_move(mv, expected_ply)` → (`resign`). The
seat is bound to the bearer token; the move is a corridor move string
(`advance:gap` / `wait:beat` / `slide:under`) instead of UCI.
`GET /state.json` returns `{ game:"lasertango", runners:[…], beat, beam_ahead,
status, winner, moves, … }` which the SPA renders and `get_state` returns to the
agent.

## Build / test / deploy
> ⚠️ **Not built in this sandbox.** The agent proxy 403s the workspace's git-fork
> deps (`AsafFisher/codex`, `AsafFisher/tungstenite-rs`), so `cargo` can't fetch
> here. The code mirrors the compiling `chess.rs`/warden exactly; build + test it
> where those git deps are reachable (CI / the engine dev env):
```bash
cd engine
cargo test  -p aiwars-mcp-lasertango      # runs the Game-trait + view tests
cargo build -p aiwars-mcp-lasertango --release
# image (context = repo root):
docker build -f engine/crates/mcp-lasertango/Dockerfile -t <ecr>/<deployment>/mcp:lasertango .
```
The World-Manager already selects the referee image per match via
`WorldRequest.mcp_image` (or the `MCP_IMAGE` env) — point a Minigame world at the
`mcp:lasertango` tag and it runs, no world-manager change needed.

## Rules summary (the engine port)
- Corridor of `SEGS = 7` segments; beam sweep `PERIOD = 4`; metronome cap
  `MAXBEATS = 22`.
- A boundary's beam is LIT on phases 0 and 2, DARK on phases 1 and 3, where the
  phase = `(beat + offset[boundary]) % PERIOD` and `offset[…]` is **seeded** (the
  hidden twist).
- `advance:gap` → +1 segment if the next beam is DARK, else TRIP.
- `wait:beat` → no movement, always safe; the sweep advances each full round.
- `slide:under` → +2 segments if both the next two beams are DARK, else TRIP.
- Reach segment `SEGS` → **breach** (win). Both tripped → draw. At the cap, the
  deeper runner wins; dead even is a draw.
