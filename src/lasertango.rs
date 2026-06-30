//! Laser Tango — a turn-based laser-corridor minigame refereed exactly like chess.
//!
//! Two infiltrators cross a dark vault corridor of `SEGS` segments by TIMING
//! moves to a metronome. Red laser beams sweep on a phase clock; a beam guarding
//! a segment boundary is LIT on some beats and DARK on others. On each of its
//! turns an agent reads the beat and commits one move from its legal set:
//!   - `advance:gap` — step one segment through the current gap (safe ONLY if the
//!                     beam ahead is DARK this beat; stepping into a LIT beam trips)
//!   - `wait:beat`   — hold position and let the sweep pass (always safe)
//!   - `slide:under` — a risky fast skip of 2 segments (clean only on a narrow
//!                     window where BOTH beams ahead are dark; otherwise clips a beam)
//! Move into a lit beam → TRIPPED (eliminated). First to reach the exit segment
//! BREACHES and wins. Both tripped → draw.
//!
//! This is the engine-side rules ONLY — the agent's PUBLIC PROMPT (its doctrine)
//! is what chooses which legal move it plays each turn, via `make_move`. Same
//! seed ⇒ identical beam phasing (deterministic / replayable), mirroring how
//! `chess.rs` derives everything from the authoritative position.
//!
//! HIDDEN TWIST: the per-boundary beam phase OFFSETS are seeded — the safe beats
//! differ each match — so identical prompts don't always resolve the same.

use serde_json::{json, Value};

use aiwars_mcp_warden::game::{Game, MatchError};

const SEGS: u32 = 7; // corridor segments to cross to reach the exit door
const PERIOD: u32 = 4; // beam sweep period in beats
const MAXBEATS: u32 = 22; // safety cap on the metronome before time runs out

/// Deterministic PRNG seed mix (mulberry32-ish), matching the POC engine so the
/// web demo and the referee agree on a seed's beam phasing.
fn rng_u32(mut a: u32) -> u32 {
    a = a.wrapping_add(0x6d2b79f5);
    let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
    t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
    (t ^ (t >> 14)) >> 0
}
/// A 0..1 float from a (seed, salt) tuple.
fn frac(seed: u64, salt: u32) -> f64 {
    let mixed = (seed as u32)
        .wrapping_mul(977)
        .wrapping_add(salt.wrapping_mul(131))
        .wrapping_add(7);
    (rng_u32(mixed) as f64) / (u32::MAX as f64)
}

/// Per-infiltrator state.
#[derive(Clone)]
struct Runner {
    seg: u32,
    lane: i8,
    tripped: bool,
    breached: bool,
    near: bool,
}
impl Runner {
    fn new(lane: i8) -> Self {
        Self { seg: 0, lane, tripped: false, breached: false, near: false }
    }
    fn done(&self) -> bool {
        self.tripped || self.breached
    }
}

/// The two-player Laser Tango game.
pub struct LaserTango {
    runners: [Runner; 2],
    to_move: usize,
    ply: u32,
    seed: u64,
    /// The current metronome beat (advances each full round, once both have moved).
    beat: u32,
    round: u32,
    /// HIDDEN TWIST: seeded per-boundary phase offsets (0..PERIOD-1). These set
    /// which beats are safe at each beam, and differ every seed.
    offsets: Vec<u32>,
    resigned_by: Option<usize>,
    /// Cached terminal result once resolved (so it's stable after the last move).
    winner_idx: Option<usize>,
    win_reason: &'static str,
    resolved: bool,
}

impl LaserTango {
    /// Is the beam guarding entry into boundary `i` LIT on `beat`? LIT (deadly) on
    /// phases 0 and 2 (sweeping); DARK (a gap) on phases 1 and 3.
    fn beam_lit(&self, i: u32, beat: u32) -> bool {
        let off = self.offsets.get(i as usize).copied().unwrap_or(0);
        let phase = (beat + off) % PERIOD;
        phase == 0 || phase == 2
    }

    /// The slide window: a 2-seg skip from `seg` lands cleanly only when BOTH the
    /// next boundary and the one after are dark this beat (a rare alignment).
    fn slide_clean(&self, seg: u32, beat: u32) -> bool {
        !self.beam_lit(seg + 1, beat) && (seg + 2 > SEGS || !self.beam_lit(seg + 2, beat))
    }

    /// Legal move strings for the runner currently to move.
    fn moves_for(&self, seg: u32) -> Vec<&'static str> {
        // legal set always includes advance + wait; slide only if ground remains.
        let mut legal = vec!["advance:gap", "wait:beat"];
        if seg + 2 <= SEGS {
            legal.push("slide:under");
        }
        legal
    }

    /// Advance `to_move` to the next runner still in the corridor; when a round
    /// completes (both have had a turn), tick the metronome forward one beat.
    fn advance_turn(&mut self) {
        let other = 1 - self.to_move;
        if self.to_move == 1 || self.runners[other].done() {
            // a full round (both moved, or the rival is already finished) elapsed:
            // the sweep advances one beat.
            self.beat = (self.beat + 1) % 1000;
            self.round += 1;
        }
        if !self.runners[other].done() {
            self.to_move = other;
        }
        // else: keep to_move on the still-running runner to take its remaining turns.
    }

    /// Resolve the match if a terminal condition is met (idempotent).
    fn try_resolve(&mut self) {
        if self.resolved {
            return;
        }
        if let Some(r) = self.resigned_by {
            self.winner_idx = Some(1 - r);
            self.win_reason = "resign";
            self.resolved = true;
            return;
        }
        let (a, b) = (&self.runners[0], &self.runners[1]);
        // Breach wins immediately.
        if a.breached && !b.breached {
            self.winner_idx = Some(0);
            self.win_reason = "breach";
            self.resolved = true;
            return;
        }
        if b.breached && !a.breached {
            self.winner_idx = Some(1);
            self.win_reason = "breach";
            self.resolved = true;
            return;
        }
        // Both tripped → draw.
        if a.tripped && b.tripped {
            self.winner_idx = None;
            self.win_reason = "doubletrip";
            self.resolved = true;
            return;
        }
        // One tripped, the other still running → let the runner finish UNLESS both
        // are finished or the metronome cap is hit.
        let both_finished = a.done() && b.done();
        let cap = self.round >= MAXBEATS;
        if both_finished || cap {
            if a.tripped && !b.tripped {
                self.winner_idx = Some(1);
                self.win_reason = "trip";
            } else if b.tripped && !a.tripped {
                self.winner_idx = Some(0);
                self.win_reason = "trip";
            } else if a.seg == b.seg {
                self.winner_idx = None;
                self.win_reason = "stall";
            } else {
                self.winner_idx = Some(if a.seg > b.seg { 0 } else { 1 });
                self.win_reason = "closer";
            }
            self.resolved = true;
        }
    }

    fn status_str(&self) -> &'static str {
        if self.resigned_by.is_some() {
            "resigned"
        } else if self.resolved {
            self.win_reason
        } else {
            "playing"
        }
    }
}

impl Game for LaserTango {
    fn new(players: usize, settings: &Value) -> Result<Self, MatchError> {
        if players != 2 {
            return Err(MatchError::WrongPlayerCount { want: 2..=2, got: players });
        }
        // Optional fixed seed for reproducible matches; default from settings or 1.
        let seed = settings.get("seed").and_then(|v| v.as_u64()).unwrap_or(1);
        // HIDDEN TWIST: seeded per-boundary phase offsets, one per boundary up to
        // SEGS + 2 (slides peek two boundaries ahead of the exit).
        let mut offsets = Vec::with_capacity(SEGS as usize + 3);
        for i in 0..=(SEGS + 2) {
            offsets.push((frac(seed, 1000 + i) * PERIOD as f64) as u32 % PERIOD);
        }
        Ok(Self {
            runners: [Runner::new(-1), Runner::new(1)],
            to_move: 0,
            ply: 0,
            seed,
            beat: 0,
            round: 0,
            offsets,
            resigned_by: None,
            winner_idx: None,
            win_reason: "playing",
            resolved: false,
        })
    }

    fn turn_agent(&self) -> usize {
        self.to_move
    }

    fn ply(&self) -> u32 {
        self.ply
    }

    fn legal_moves(&self) -> Vec<String> {
        if self.resolved {
            return Vec::new();
        }
        let seg = self.runners[self.to_move].seg;
        self.moves_for(seg).into_iter().map(|s| s.to_string()).collect()
    }

    fn apply(&mut self, agent: usize, mv: &str) -> Result<(), MatchError> {
        if self.resolved {
            return Err(MatchError::GameOver);
        }
        if self.to_move != agent {
            return Err(MatchError::NotYourTurn);
        }
        let seg = self.runners[agent].seg;
        let beat = self.beat;
        let legal = self.moves_for(seg);
        if !legal.iter().any(|m| *m == mv) {
            return Err(MatchError::IllegalMove(format!("'{mv}' is not a move here")));
        }

        // Resolve the move against the live beam state.
        let mut near = false;
        match mv {
            "wait:beat" => {
                // always safe — hold position, the sweep passes.
            }
            "advance:gap" => {
                if self.beam_lit(seg + 1, beat) {
                    self.runners[agent].tripped = true;
                } else {
                    self.runners[agent].seg = seg + 1;
                    near = self.beam_lit(seg + 1, beat + 1);
                }
            }
            "slide:under" => {
                if self.slide_clean(seg, beat) {
                    self.runners[agent].seg = seg + 2;
                    near = true;
                } else {
                    self.runners[agent].tripped = true;
                }
            }
            _ => unreachable!("legal set is closed over the three move strings"),
        }

        let r = &mut self.runners[agent];
        if r.seg >= SEGS && !r.tripped {
            r.seg = SEGS;
            r.breached = true;
        }
        r.near = near && !r.tripped && !r.breached;

        self.ply += 1;
        self.advance_turn();
        self.try_resolve();
        Ok(())
    }

    fn is_over(&self) -> bool {
        self.resolved
    }

    fn winner(&self) -> Option<usize> {
        self.winner_idx
    }

    fn resign(&mut self, agent: usize) {
        if !self.resolved {
            self.resigned_by = Some(agent);
            self.try_resolve();
        }
    }

    fn state(&self, handles: &[String]) -> Value {
        let h = |i: usize| handles.get(i).cloned().unwrap_or_default();
        let winner = self
            .winner_idx
            .filter(|_| self.resolved)
            .map(h)
            .map(Value::String)
            .unwrap_or(Value::Null);
        let mover_seg = self.runners[self.to_move].seg;
        let runner_json = |i: usize| {
            let r = &self.runners[i];
            json!({
                "handle": h(i),
                "seg": r.seg,
                "to_door": SEGS.saturating_sub(r.seg),
                "lane": r.lane,
                "tripped": r.tripped,
                "breached": r.breached,
                "near": r.near,
            })
        };
        json!({
            "game": "lasertango",
            "segs": SEGS,
            "period": PERIOD,
            "seed": self.seed,
            "beat": self.beat,
            "phase": self.beat % PERIOD,
            // the beam guarding the mover's NEXT boundary this beat (what it observes).
            "beam_ahead": if !self.resolved && self.beam_lit(mover_seg + 1, self.beat) {
                "LIT"
            } else {
                "DARK"
            },
            "offsets": self.offsets,
            "to_move": h(self.to_move),
            "to_move_idx": self.to_move,
            "ply": self.ply,
            "status": self.status_str(),
            "winner": winner,
            "win_reason": if self.resolved { self.win_reason } else { "" },
            "moves": self.legal_moves(),
            "runners": [runner_json(0), runner_json(1)],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiwars_mcp_warden::game::Match;
    use serde_json::json;

    fn handles() -> Vec<String> {
        vec!["tempo".to_string(), "blitz".to_string()]
    }

    #[test]
    fn rejects_wrong_player_count() {
        for n in [1usize, 3] {
            let hs: Vec<String> = (0..n).map(|i| format!("p{i}")).collect();
            match Match::<LaserTango>::new(hs, &json!({})) {
                Err(MatchError::WrongPlayerCount { want, got }) => {
                    assert_eq!(want, 2..=2);
                    assert_eq!(got, n);
                }
                _ => panic!("expected WrongPlayerCount for {n} players"),
            }
        }
    }

    #[test]
    fn first_move_advances_ply_and_passes_turn() {
        let mut m = Match::<LaserTango>::new(handles(), &json!({ "seed": 7 })).unwrap();
        m.start();
        assert_eq!(m.state_json()["ply"], 0);
        assert_eq!(m.state_json()["to_move_idx"], 0);
        let legal = m.turn_info(0)["moves"].as_array().unwrap().len();
        assert_eq!(legal, 3, "advance + wait + slide from the start");
        // wait is always safe and never trips, so it cleanly advances ply + turn.
        let st = m.make_move(0, "wait:beat", 0).unwrap();
        assert_eq!(st["ply"], 1);
        assert_eq!(st["to_move_idx"], 1, "turn passes to the rival");
        assert_eq!(st["runners"][0]["tripped"], false);
    }

    #[test]
    fn illegal_and_out_of_turn_rejected_without_change() {
        let mut m = Match::<LaserTango>::new(handles(), &json!({ "seed": 7 })).unwrap();
        m.start();
        let before = m.state_json();
        // wrong agent
        assert_eq!(m.make_move(1, "wait:beat", 0).unwrap_err(), MatchError::NotYourTurn);
        // bogus move
        assert!(matches!(
            m.make_move(0, "teleport:exit", 0).unwrap_err(),
            MatchError::IllegalMove(_)
        ));
        assert_eq!(m.state_json(), before, "no state change on a rejected move");
    }

    #[test]
    fn stale_ply_rejected() {
        let mut m = Match::<LaserTango>::new(handles(), &json!({ "seed": 7 })).unwrap();
        m.start();
        assert_eq!(m.make_move(0, "wait:beat", 9).unwrap_err(), MatchError::StalePly);
    }

    #[test]
    fn a_full_game_resolves_to_winner_or_draw() {
        // Both infiltrators greedily advance: a decisive result must emerge (a breach
        // or a trip) with a concrete winner or a draw, within the metronome cap.
        let mut m = Match::<LaserTango>::new(handles(), &json!({ "seed": 7 })).unwrap();
        m.start();
        let mut guard = 0;
        while !m.is_resolved() && guard < 128 {
            let seat = m.state_json()["to_move_idx"].as_u64().unwrap() as usize;
            let ply = m.state_json()["ply"].as_u64().unwrap() as u32;
            // prefer to advance toward the door; fall back to wait if no advance.
            let moves = m.turn_info(seat)["moves"].clone();
            let mv = moves[0].as_str().unwrap().to_string();
            let _ = m.make_move(seat, &mv, ply);
            guard += 1;
        }
        assert!(m.is_resolved(), "match must resolve within the metronome cap");
        let result = m.result().expect("resolved match has a result");
        assert!(result.outcome == "Winner" || result.outcome == "Draw");
    }

    #[test]
    fn resign_awards_opponent() {
        let mut m = Match::<LaserTango>::new(handles(), &json!({ "seed": 3 })).unwrap();
        m.start();
        let st = m.resign(0);
        assert_eq!(st["status"], "resigned");
        assert!(m.is_resolved());
        let result = m.result().unwrap();
        assert_eq!(result.outcome, "Winner");
        assert_eq!(result.winner.as_deref(), Some("blitz"));
    }

    #[test]
    fn same_seed_same_corridor() {
        let a = Match::<LaserTango>::new(handles(), &json!({ "seed": 42 })).unwrap();
        let b = Match::<LaserTango>::new(handles(), &json!({ "seed": 42 })).unwrap();
        assert_eq!(a.state_json()["offsets"], b.state_json()["offsets"]);
        assert_eq!(a.state_json()["moves"], b.state_json()["moves"]);
    }

    #[test]
    fn stepping_into_a_lit_beam_trips() {
        // Find a seed/position where the beam ahead is LIT on beat 0, then advance
        // into it and confirm the runner is eliminated.
        let m = Match::<LaserTango>::new(handles(), &json!({ "seed": 1 })).unwrap();
        // boundary 1 phase = (0 + offsets[1]) % 4; LIT iff phase is 0 or 2.
        let lit = m.state_json()["beam_ahead"] == "LIT";
        let mut m = m;
        m.start();
        if lit {
            let st = m.make_move(0, "advance:gap", 0).unwrap();
            assert_eq!(st["runners"][0]["tripped"], true, "advancing into a lit beam trips");
        } else {
            let st = m.make_move(0, "advance:gap", 0).unwrap();
            assert_eq!(st["runners"][0]["seg"], 1, "advancing through a dark gap gains a segment");
        }
    }
}
