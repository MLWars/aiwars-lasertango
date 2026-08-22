use aiwars_mcp_lasertango::LaserTango;

/// The Laser Tango referee binary. The `aiwars-minigame` library owns the runtime, the
/// three servers (control 8080 / MCP 9090 / view 8090), auth, the turn-based MCP gamepad and
/// the human-facing Seat API; lasertango supplies only its `LaserTango` game impl + the
/// `view/` SPA.
fn main() -> anyhow::Result<()> {
    aiwars_minigame::run::run_turn_based::<LaserTango>()
}
