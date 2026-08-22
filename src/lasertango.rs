//! Laser Tango — a turn-based laser-corridor minigame, refereed on the shared
//! `aiwars-minigame` library (tier 1: `Minigame` + `TurnBasedGame`).
//!
//! Two infiltrators cross a dark vault corridor of `SEGS` segments by TIMING
//! moves to a metronome. Red laser beams sweep on a phase clock; a beam guarding
//! a segment boundary is LIT on some beats and DARK on others. On each of its
//! turns an agent reads the beat and commits one move from its legal set:
//!
//! - `advance:gap` — step one segment through the current gap (safe ONLY if the beam
//!   ahead is DARK this beat; stepping into a LIT beam trips).
//! - `wait:beat` — hold position and let the sweep pass (always safe).
//! - `slide:under` — a risky fast skip of 2 segments (clean only on a narrow window
//!   where BOTH beams ahead are dark; otherwise it clips a beam).
//!
//! Move into a lit beam → TRIPPED (eliminated). First to reach the exit segment
//! BREACHES and wins. Both tripped → draw.
//!
//! This is the engine-side rules ONLY — the agent's PUBLIC PROMPT (its doctrine)
//! is what chooses which legal move it plays each turn, via `make_move`. Same
//! seed ⇒ identical beam phasing (deterministic / replayable).
//!
//! SEEDED TWIST: the per-boundary beam phase OFFSETS are seeded — the safe beats
//! differ each match — so identical prompts don't always resolve the same. They are
//! *public* (the SPA draws the beams from them), not hidden information.
//!
//! Laser Tango is therefore **perfect information**: there is nothing a runner knows
//! that a spectator does not, so [`Minigame::observe`] ignores its `viewer` argument
//! and returns the one public projection to everyone.

use serde_json::{json, Value};

use aiwars_minigame::{AgentId, MatchError, Minigame, Outcome, TurnBasedGame};

const SEGS: u32 = 7; // corridor segments to cross to reach the exit door
const PERIOD: u32 = 4; // beam sweep period in beats
const MAXBEATS: u32 = 22; // safety cap on the metronome before time runs out
/// Exactly two infiltrators run a corridor.
const PLAYERS: usize = 2;

/// Deterministic PRNG seed mix (mulberry32-ish), matching the POC engine so the
/// web demo and the referee agree on a seed's beam phasing.
fn rng_u32(mut a: u32) -> u32 {
    a = a.wrapping_add(0x6d2b79f5);
    let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
    t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
    t ^ (t >> 14)
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
        Self {
            seg: 0,
            lane,
            tripped: false,
            breached: false,
            near: false,
        }
    }
    fn done(&self) -> bool {
        self.tripped || self.breached
    }
}

/// The two-player Laser Tango game.
pub struct LaserTango {
    /// The infiltrators by IDENTITY, in seat order. The library bridges an auth-resolved
    /// seat to its `AgentId` before calling us, so the game never handles seat indices
    /// from outside.
    players: Vec<AgentId>,
    runners: [Runner; PLAYERS],
    to_move: usize,
    ply: u32,
    seed: u64,
    /// The current metronome beat (advances each full round, once both have moved).
    beat: u32,
    round: u32,
    /// SEEDED TWIST: per-boundary phase offsets (0..PERIOD-1). These set which beats
    /// are safe at each beam, and differ every seed.
    offsets: Vec<u32>,
    resigned_by: Option<usize>,
    /// Cached terminal result once resolved (so it's stable after the last move).
    winner_idx: Option<usize>,
    win_reason: &'static str,
    resolved: bool,
}

impl LaserTango {
    /// The seat holding `agent`, or `None` for an id that never entered this corridor.
    fn seat_of(&self, agent: &AgentId) -> Option<usize> {
        self.players.iter().position(|p| p == agent)
    }

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

    /// Who is "ahead" in the corridor right now, by the SAME rule the metronome cap
    /// uses: a runner still on its feet beats a tripped one, otherwise the deeper
    /// runner leads. `None` ⇒ dead level (a timeout draws).
    fn leader(&self) -> Option<usize> {
        let (a, b) = (&self.runners[0], &self.runners[1]);
        match (a.tripped, b.tripped) {
            (false, true) => Some(0),
            (true, false) => Some(1),
            _ if a.seg == b.seg => None,
            _ => Some(if a.seg > b.seg { 0 } else { 1 }),
        }
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

impl Minigame for LaserTango {
    fn new(agents: &[AgentId], settings: &Value) -> Result<Self, MatchError> {
        if agents.len() != PLAYERS {
            return Err(MatchError::WrongPlayerCount {
                want: 2..=2,
                got: agents.len(),
            });
        }
        // Optional fixed seed for reproducible matches; default from settings or 1.
        let seed = settings.get("seed").and_then(|v| v.as_u64()).unwrap_or(1);
        // SEEDED TWIST: per-boundary phase offsets, one per boundary up to SEGS + 2
        // (slides peek two boundaries ahead of the exit).
        let mut offsets = Vec::with_capacity(SEGS as usize + 3);
        for i in 0..=(SEGS + 2) {
            offsets.push((frac(seed, 1000 + i) * PERIOD as f64) as u32 % PERIOD);
        }
        Ok(Self {
            players: agents.to_vec(),
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

    fn name(&self) -> &'static str {
        "lasertango"
    }

    fn instructions(&self) -> String {
        "AIWars Laser Tango referee. Two infiltrators cross a laser-swept vault corridor by \
         TIMING moves to a metronome. Read the state each turn: `beat`/`phase` are the \
         metronome, `beam_ahead` is LIT or DARK for the beam guarding YOUR next boundary, \
         `runners` (yours carries your handle) has `seg`, `to_door`, `tripped` and `breached`, \
         and `moves` lists your EXACT legal moves. Play with make_move, mv = one of: \
         \"advance:gap\" — step one segment through the gap; it TRIPS you out if the beam \
         ahead is LIT; \"wait:beat\" — hold position and let the sweep pass, always safe; \
         \"slide:under\" — a risky skip of TWO segments, clean only when both beams ahead are \
         dark, otherwise you clip a beam and trip. Pass expected_ply = the ply you saw. First \
         to reach the exit door BREACHES and wins; both tripped is a draw; at the metronome cap \
         the deeper runner wins. resign forfeits the corridor to your rival. Your seat is your \
         bearer token; you cannot act as your rival."
            .into()
    }

    /// Laser Tango is PERFECT INFORMATION — a runner knows nothing a spectator doesn't (the
    /// seeded beam `offsets` are drawn by the SPA) — so `viewer` is deliberately ignored and
    /// everyone gets the same projection. (The library injects the `"game"` key, so it is not
    /// set here.)
    fn observe(&self, _viewer: Option<&AgentId>) -> Value {
        let h = |i: usize| self.players[i].0.clone();
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

    fn outcome(&self) -> Option<Outcome> {
        if !self.resolved {
            return None;
        }
        Some(match self.winner_idx {
            Some(i) => Outcome::Win(self.players[i].clone()),
            None => Outcome::Draw,
        })
    }

    /// The wall-clock timeout tiebreak: whoever is ahead in the corridor right now — the same
    /// rule the metronome cap uses. Dead level ⇒ `None` ⇒ a timeout draws.
    fn timeout_leader(&self) -> Option<AgentId> {
        self.leader().map(|i| self.players[i].clone())
    }
}

impl TurnBasedGame for LaserTango {
    fn turn_agent(&self) -> AgentId {
        self.players[self.to_move].clone()
    }

    fn ply(&self) -> u32 {
        self.ply
    }

    fn legal_moves(&self) -> Vec<String> {
        if self.resolved {
            return Vec::new();
        }
        let seg = self.runners[self.to_move].seg;
        self.moves_for(seg)
            .into_iter()
            .map(|s| s.to_string())
            .collect()
    }

    fn apply(&mut self, agent: &AgentId, mv: &str) -> Result<(), MatchError> {
        if self.resolved {
            return Err(MatchError::GameOver);
        }
        let seat = self
            .seat_of(agent)
            .ok_or_else(|| MatchError::Rejected("not an infiltrator in this corridor".into()))?;
        // Defensive: `TurnBasedMatch` already polices turn order (`TurnError::NotYourTurn`)
        // and the ply, but keep the game honest if it is ever driven directly.
        if self.to_move != seat {
            return Err(MatchError::Rejected("not your turn".into()));
        }
        let seg = self.runners[seat].seg;
        let beat = self.beat;
        let legal = self.moves_for(seg);
        if !legal.contains(&mv) {
            return Err(MatchError::Rejected(format!("'{mv}' is not a move here")));
        }

        // --- committed, mutating path (validation has passed) ---
        // Resolve the move against the live beam state.
        let mut near = false;
        match mv {
            "wait:beat" => {
                // always safe — hold position, the sweep passes.
            }
            "advance:gap" => {
                if self.beam_lit(seg + 1, beat) {
                    self.runners[seat].tripped = true;
                } else {
                    self.runners[seat].seg = seg + 1;
                    near = self.beam_lit(seg + 1, beat + 1);
                }
            }
            "slide:under" => {
                if self.slide_clean(seg, beat) {
                    self.runners[seat].seg = seg + 2;
                    near = true;
                } else {
                    self.runners[seat].tripped = true;
                }
            }
            _ => unreachable!("legal set is closed over the three move strings"),
        }

        let r = &mut self.runners[seat];
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

    fn resign(&mut self, agent: &AgentId) {
        if self.resolved {
            return;
        }
        if let Some(seat) = self.seat_of(agent) {
            self.resigned_by = Some(seat);
            self.try_resolve();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiwars_minigame::{RefereeMatch, TurnBasedMatch, TurnError};
    use serde_json::json;

    fn runners() -> Vec<AgentId> {
        vec![AgentId("tempo".into()), AgentId("blitz".into())]
    }

    /// A started two-seat match on a fixed seed.
    fn started(seed: u64) -> TurnBasedMatch {
        let mut m = TurnBasedMatch::new::<LaserTango>(runners(), &json!({ "seed": seed })).unwrap();
        m.start();
        m
    }

    #[test]
    fn rejects_wrong_player_count() {
        for n in [1usize, 3] {
            let ids: Vec<AgentId> = (0..n).map(|i| AgentId(format!("p{i}"))).collect();
            match LaserTango::new(&ids, &json!({})) {
                Err(MatchError::WrongPlayerCount { want, got }) => {
                    assert_eq!(want, 2..=2);
                    assert_eq!(got, n);
                }
                Err(e) => panic!("expected WrongPlayerCount for {n} players, got {e}"),
                Ok(_) => panic!("expected WrongPlayerCount for {n} players, got a built game"),
            }
        }
    }

    #[test]
    fn first_move_advances_ply_and_passes_turn() {
        let mut m = started(7);
        assert_eq!(m.state_json()["ply"], 0);
        assert_eq!(m.state_json()["to_move_idx"], 0);
        assert_eq!(
            m.turn_info(0)["moves"].as_array().unwrap().len(),
            3,
            "advance + wait + slide from the start"
        );
        // wait is always safe and never trips, so it cleanly advances ply + turn.
        let st = m.make_move(0, "wait:beat", 0).unwrap();
        assert_eq!(st["ply"], 1);
        assert_eq!(st["to_move_idx"], 1, "turn passes to the rival");
        assert_eq!(st["runners"][0]["tripped"], false);
    }

    /// The library injects the `game` key the spectator SPA dispatches on — the game itself
    /// must not (and no longer does) set it.
    #[test]
    fn public_state_carries_the_library_injected_game_key() {
        let m = started(7);
        assert_eq!(m.state_json()["game"], "lasertango");
        assert!(
            !LaserTango::new(&runners(), &json!({}))
                .unwrap()
                .observe(None)
                .as_object()
                .unwrap()
                .contains_key("game"),
            "the game must not set `game` itself — the library owns that key"
        );
    }

    /// The turn-order policing this port handed to the library: a move by the WRONG agent is
    /// refused with `TurnError::NotYourTurn`, and nothing changes.
    #[test]
    fn move_by_the_wrong_agent_is_refused() {
        let mut m = started(7);
        let before = m.state_json();
        assert_eq!(
            m.make_move(1, "wait:beat", 0).unwrap_err(),
            TurnError::NotYourTurn
        );
        assert_eq!(
            m.state_json(),
            before,
            "no state change on an out-of-turn move"
        );
    }

    /// The game's OWN defensive check, driven directly (no match wrapper): an illegal mover is
    /// `Rejected` now that `MatchError::NotYourTurn` is gone.
    #[test]
    fn game_driven_directly_also_refuses_the_wrong_agent() {
        let mut g = LaserTango::new(&runners(), &json!({ "seed": 7 })).unwrap();
        assert!(matches!(
            g.apply(&AgentId("blitz".into()), "wait:beat"),
            Err(MatchError::Rejected(_))
        ));
        assert!(matches!(
            g.apply(&AgentId("nobody".into()), "wait:beat"),
            Err(MatchError::Rejected(_))
        ));
        assert_eq!(g.ply(), 0);
    }

    #[test]
    fn illegal_move_rejected_without_change() {
        let mut m = started(7);
        let before = m.state_json();
        match m.make_move(0, "teleport:exit", 0).unwrap_err() {
            TurnError::Core(MatchError::Rejected(msg)) => assert!(msg.contains("teleport:exit")),
            other => panic!("expected Rejected, got {other:?}"),
        }
        assert_eq!(m.state_json(), before, "no state change on a rejected move");
    }

    #[test]
    fn stale_ply_rejected() {
        let mut m = started(7);
        assert_eq!(
            m.make_move(0, "wait:beat", 9).unwrap_err(),
            TurnError::StalePly
        );
    }

    /// Drive a whole corridor the way a client does: read `to_move_idx`/`ply`, play the first
    /// legal move (`advance:gap`) every turn. On the fixed seed that untimed run walks both
    /// runners into a lit beam, so the match ends in the double-trip draw.
    #[test]
    fn a_blind_advance_run_double_trips_into_a_draw() {
        let mut m = started(7);
        let mut guard = 0;
        while !m.is_resolved() && guard < 128 {
            let seat = m.state_json()["to_move_idx"].as_u64().unwrap() as usize;
            let ply = m.state_json()["ply"].as_u64().unwrap() as u32;
            // prefer to advance toward the door; the first legal move is `advance:gap`.
            let mv = m.turn_info(seat)["moves"][0].as_str().unwrap().to_string();
            m.make_move(seat, &mv, ply)
                .unwrap_or_else(|e| panic!("seat {seat} playing {mv} at ply {ply}: {e}"));
            guard += 1;
        }
        assert!(
            m.is_resolved(),
            "match must resolve within the metronome cap"
        );
        let result = m.result().expect("resolved match has a result");
        // Seed 7 is fixed, so this run is fixed: both runners blindly advance into a lit
        // beam and trip. Asserting `Winner || Draw` instead would prove nothing — that
        // disjunction is the whole range of `outcome` and holds with the trip rule deleted.
        assert_eq!(result.outcome, "Draw");
        let st = m.state_json();
        assert_eq!(st["win_reason"], "doubletrip");
        assert_eq!(st["runners"][0]["tripped"], true);
        assert_eq!(st["runners"][1]["tripped"], true);
        assert!(st["moves"].as_array().unwrap().is_empty());
    }

    /// The other terminal path, which the double-trip run above never reaches: timing every
    /// step to a DARK beam walks the corridor and BREACHES the door for the win.
    #[test]
    fn timing_the_gaps_breaches_the_door_and_wins() {
        let mut g = LaserTango::new(&runners(), &json!({ "seed": 7 })).unwrap();
        let mut guard = 0;
        while !g.resolved && guard < 200 {
            let seg = g.runners[0].seg;
            // Step only when the beam guarding the next boundary is dark; otherwise hold.
            let mv = if g.beam_lit(seg + 1, g.beat) {
                "wait:beat"
            } else {
                "advance:gap"
            };
            g.apply(&AgentId("tempo".into()), mv).unwrap();
            if !g.resolved {
                g.apply(&AgentId("blitz".into()), "wait:beat").unwrap();
            }
            guard += 1;
        }
        assert!(g.runners[0].breached, "a well-timed run reaches the door");
        assert!(!g.runners[0].tripped, "and never clips a beam on the way");
        assert_eq!(g.win_reason, "breach");
        assert_eq!(g.outcome(), Some(Outcome::Win(AgentId("tempo".into()))));
    }

    #[test]
    fn resign_awards_opponent() {
        let mut m = started(3);
        let st = m.resign(0);
        assert_eq!(st["status"], "resigned");
        assert!(m.is_resolved());
        let result = m.result().unwrap();
        assert_eq!(result.outcome, "Winner");
        assert_eq!(result.winner.as_deref(), Some("blitz"));
    }

    #[test]
    fn outcome_names_the_winner_by_identity() {
        let mut g = LaserTango::new(&runners(), &json!({ "seed": 3 })).unwrap();
        assert_eq!(g.outcome(), None);
        g.resign(&AgentId("tempo".into()));
        assert_eq!(g.outcome(), Some(Outcome::Win(AgentId("blitz".into()))));
    }

    #[test]
    fn timeout_leader_is_whoever_is_deeper_in_the_corridor() {
        let mut g = LaserTango::new(&runners(), &json!({ "seed": 42 })).unwrap();
        assert_eq!(g.timeout_leader(), None, "dead level at the start");
        // `wait:beat` never moves anyone, so drive the runners directly through the rules:
        // step seat 0 forward on a beat where its beam is dark.
        while g.beam_lit(1, g.beat) {
            g.apply(&AgentId("tempo".into()), "wait:beat").unwrap();
            g.apply(&AgentId("blitz".into()), "wait:beat").unwrap();
        }
        g.apply(&AgentId("tempo".into()), "advance:gap").unwrap();
        assert_eq!(g.runners[0].seg, 1, "the gap was dark, so the step landed");
        assert_eq!(g.timeout_leader(), Some(AgentId("tempo".into())));
    }

    /// A tripped runner is behind a runner still on its feet, whatever the segments say.
    #[test]
    fn timeout_leader_prefers_the_untripped_runner() {
        let mut g = LaserTango::new(&runners(), &json!({ "seed": 42 })).unwrap();
        g.runners[0].seg = 5;
        g.runners[0].tripped = true;
        assert_eq!(g.timeout_leader(), Some(AgentId("blitz".into())));
    }

    #[test]
    fn same_seed_same_corridor() {
        let a = started(42);
        let b = started(42);
        assert_eq!(a.state_json()["offsets"], b.state_json()["offsets"]);
        assert_eq!(a.state_json()["moves"], b.state_json()["moves"]);
    }

    #[test]
    /// Seed 3 puts boundary 1's beam phase at LIT on beat 0, so this exercises the trip rule
    /// for real. (The seed is asserted, not assumed: `beam_ahead` must read LIT, or the test
    /// would be checking the dark branch under a name that promises the lit one.)
    fn stepping_into_a_lit_beam_trips() {
        let mut m = started(3);
        assert_eq!(
            m.state_json()["beam_ahead"],
            "LIT",
            "seed 3 opens on a lit beam"
        );
        let st = m.make_move(0, "advance:gap", 0).unwrap();
        assert_eq!(st["runners"][0]["tripped"], true, "the lit beam trips");
        assert_eq!(st["runners"][0]["seg"], 0, "and gains no ground");
    }

    /// The complementary branch, on a seed whose opening beam is DARK.
    #[test]
    fn stepping_through_a_dark_gap_gains_a_segment() {
        let mut m = started(1);
        assert_eq!(
            m.state_json()["beam_ahead"],
            "DARK",
            "seed 1 opens on a dark gap"
        );
        let st = m.make_move(0, "advance:gap", 0).unwrap();
        assert_eq!(st["runners"][0]["seg"], 1, "the dark gap is crossed");
        assert_eq!(st["runners"][0]["tripped"], false);
    }

    /// A slide only lands when BOTH beams ahead are dark; otherwise it clips one and trips.
    #[test]
    /// "Only" is a two-sided claim, so both sides are asserted, each on a seed that actually
    /// reaches it — seed 5 opens with both beams dark, seed 1 with the second one lit.
    fn slide_lands_only_in_the_double_dark_window() {
        let mut g = LaserTango::new(&runners(), &json!({ "seed": 5 })).unwrap();
        assert!(
            g.slide_clean(0, 0),
            "seed 5 opens in the double-dark window"
        );
        g.apply(&AgentId("tempo".into()), "slide:under").unwrap();
        assert_eq!(g.runners[0].seg, 2, "a clean slide skips two segments");
        assert!(!g.runners[0].tripped);

        let mut g = LaserTango::new(&runners(), &json!({ "seed": 1 })).unwrap();
        assert!(!g.slide_clean(0, 0), "seed 1 opens outside the window");
        g.apply(&AgentId("tempo".into()), "slide:under").unwrap();
        assert!(g.runners[0].tripped, "a clipped slide trips the runner");
        assert_eq!(g.runners[0].seg, 0, "and gains no ground");
    }

    /// The whole point of the port: the seat payload a HUMAN's browser console reads carries
    /// its turn info (`your_turn` + `moves`) alongside the private projection.
    #[test]
    fn seat_state_carries_turn_info_for_a_human_console() {
        let m = started(7);
        let s = m.seat_state(0);
        assert_eq!(s["you"]["handle"], "tempo");
        assert_eq!(s["turn"]["your_turn"], true);
        assert_eq!(s["turn"]["moves"].as_array().unwrap().len(), 3);
        assert_eq!(s["state"]["to_move"], "tempo");
        assert_eq!(m.seat_state(1)["turn"]["your_turn"], false);
    }

    /// The shipped game.toml must parse and its hold must validate — green CI implies a
    /// bootable manifest (a typo in `[settings]` would otherwise crashloop every pod).
    #[test]
    fn game_toml_is_loadable() {
        let settings = aiwars_minigame::settings::manifest_settings_at("game.toml").unwrap();
        aiwars_minigame::settings::validate_hold(&settings).unwrap();
    }
}
