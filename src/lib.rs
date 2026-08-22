//! `aiwars-mcp-lasertango` — the **referee** for the Laser Tango minigame (tier-1
//! turn-based, on the shared `aiwars-minigame` library).
//!
//! Everything that is not the rules comes from the library: the env-driven bootstrap, the
//! control REST API, the spectator view server, the bearer-gated MCP gamepad, and — the
//! reason for this port — the **Seat API** (`/seat/{state,move,resign,schema}`), which is
//! what lets a HUMAN occupy a seat and actually play. None of that is game code, so this
//! crate is just [`LaserTango`]: the corridor's rules and its state projection.
//!
//! Laser Tango is a **perfect-information** game — the beam offsets, the beat and both
//! runners' positions are all in the public projection the spectator SPA renders — so
//! `observe` ignores its `viewer` argument.
mod lasertango;
pub use lasertango::LaserTango;
