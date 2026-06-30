//! `aiwars-mcp-lasertango` — the **referee** for the Laser Tango minigame.
//!
//! Structured exactly like `aiwars-mcp-warden` (chess): it reuses the
//! game-agnostic core from that crate — the [`aiwars_mcp_warden::game::Game`]
//! trait and [`aiwars_mcp_warden::game::Match`] lifecycle wrapper — and adds:
//!
//! - [`lasertango`] — the concrete [`lasertango::LaserTango`] `Game` impl (rules).
//! - [`mcp`] — the per-agent MCP server (`/mcp`, bearer-gated): the same four
//!   tools (`get_state`, `legal_moves`, `make_move`, `resign`), here typed to a
//!   `Match<LaserTango>`.
//! - [`control`] — the control REST API (`/status`, `/start`, `/stop`).
//! - [`view`] — the read-only spectator HTTP server (`/state.json` + static SPA).
//!
//! The thin server wiring is a faithful copy of the warden's (typed to
//! `LaserTango` instead of `Chess`) so this stays a self-contained, deployable
//! game package — the same shape a standalone `MLWars/aiwars-lasertango` repo has.

pub mod control;
pub mod lasertango;
pub mod mcp;
pub mod view;
