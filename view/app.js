/* Laser Tango spectator board. Polls ./state.json (the referee's live game state)
 * and renders the corridor: two infiltrators cross a vault of laser beams toward
 * the exit door, the metronome beat, lit/dark beams, and live odds. Read-only and
 * offline — everything is drawn procedurally (no remote assets), like the chess
 * board's app.js. Dispatches on data.game so the same SPA shape generalises. */
(function () {
  const W = 780, H = 560;
  const cv = document.getElementById("c"), ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const statusEl = document.getElementById("status");

  // corridor perspective geometry (mirrors the POC): segment i → screen depth.
  const FLOOR_Y = H - 70;
  const TOP_Y = 110;        // vanishing point pushed down so EXIT clears the odds pill
  const DOOR_X = W * 0.5;
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const ease = (x) => x * x * (3 - 2 * x);

  let data = null;          // latest state.json
  let shown = [0, 0];       // displayed segment (eased toward real)

  // defaults until the first poll lands; overwritten from state.json.
  let SEGS = 7, PERIOD = 4;

  function segScreen(i) {
    const f = i / SEGS;                  // 0 near camera .. 1 at the door
    const y = lerp(FLOOR_Y, TOP_Y + 28, ease(f));
    return { y, f };
  }
  function laneX(i, lane) {
    const { f } = segScreen(i);
    const spread = lerp(150, 26, f);     // corridor narrows toward the door
    return DOOR_X + lane * spread;
  }
  // is the beam guarding boundary i LIT on this beat? LIT on phases 0,2.
  function beamLit(i, beat, offsets) {
    const off = (offsets && offsets[i]) || 0;
    const phase = ((beat + off) % PERIOD + PERIOD) % PERIOD;
    return phase === 0 || phase === 2;
  }

  async function tick() {
    try {
      const r = await fetch("./state.json", { cache: "no-store" });
      const j = await r.json();
      if (j.game !== "lasertango") {
        statusEl.innerHTML = `<span class="off">unsupported game: ${j.game || "?"}</span>`;
        data = null;
        return;
      }
      data = j;
      SEGS = j.segs || SEGS;
      PERIOD = j.period || PERIOD;
      const u = j.runners;
      statusEl.textContent = j.winner
        ? `Final — ${j.winner} wins (${j.win_reason}).`
        : `Live · ${u[0].handle} ${u[0].seg}/${SEGS}${u[0].tripped ? " (OUT)" : ""} vs ` +
          `${u[1].handle} ${u[1].seg}/${SEGS}${u[1].tripped ? " (OUT)" : ""} · beat ${j.beat} · beam ahead ${j.beam_ahead}`;
    } catch (e) {
      statusEl.innerHTML = `<span class="off">waiting for referee…</span>`;
    }
  }
  setInterval(tick, 1000); tick();

  // ---- drawing ----
  function vaultBack(t) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#070a16"); g.addColorStop(0.5, "#0a0e1d"); g.addColorStop(1, "#04060d");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    glow(DOOR_X, TOP_Y + 10, 200, "rgba(40,70,120,0.12)");
    glow(DOOR_X, TOP_Y + 40, 240, "rgba(120,40,50,0.06)");
    for (let i = 0; i < 60; i++) {
      const x = (i * 191 + Math.sin(t / 2400 + i) * 30) % W;
      const yb = (i * 73 + t * 0.012) % (H - 120);
      const a = 0.05 + 0.08 * ((Math.sin(t / 900 + i) + 1) / 2);
      ctx.fillStyle = `rgba(120,150,200,${a})`;
      ctx.fillRect(x, 60 + yb, i % 5 === 0 ? 2 : 1, i % 5 === 0 ? 2 : 1);
    }
  }
  function walls() {
    const nearL = laneX(0, -1) - 70, nearR = laneX(0, 1) + 70;
    const farL = laneX(SEGS, -1) - 18, farR = laneX(SEGS, 1) + 18;
    const ny = FLOOR_Y, fy = segScreen(SEGS).y - 6;
    const topNear = ny - 220, topFar = fy - 70;
    ctx.fillStyle = "#0a0f1e";
    ctx.beginPath(); ctx.moveTo(nearL, ny); ctx.lineTo(farL, fy); ctx.lineTo(farL, topFar); ctx.lineTo(nearL, topNear); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#080c19";
    ctx.beginPath(); ctx.moveTo(nearR, ny); ctx.lineTo(farR, fy); ctx.lineTo(farR, topFar); ctx.lineTo(nearR, topNear); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#070b16";
    ctx.beginPath(); ctx.moveTo(nearL, topNear); ctx.lineTo(nearR, topNear); ctx.lineTo(farR, topFar); ctx.lineTo(farL, topFar); ctx.closePath(); ctx.fill();
  }
  function floorGrid() {
    const nearL = laneX(0, -1) - 70, nearR = laneX(0, 1) + 70;
    const farL = laneX(SEGS, -1) - 18, farR = laneX(SEGS, 1) + 18;
    const ny = FLOOR_Y, fy = segScreen(SEGS).y - 6;
    const g = ctx.createLinearGradient(0, fy, 0, ny);
    g.addColorStop(0, "#0a1120"); g.addColorStop(1, "#05080f");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(nearL, ny); ctx.lineTo(nearR, ny); ctx.lineTo(farR, fy); ctx.lineTo(farL, fy); ctx.closePath(); ctx.fill();
    const edgeW = (f) => lerp(70, 18, f);
    for (let i = 0; i <= SEGS; i++) {
      const s = segScreen(i), f = i / SEGS;
      const lx = laneX(i, -1) - edgeW(f), rx = laneX(i, 1) + edgeW(f);
      ctx.strokeStyle = i === SEGS ? "rgba(52,211,153,0.28)" : "rgba(60,95,150,0.16)";
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(lx, s.y); ctx.lineTo(rx, s.y); ctx.stroke();
    }
    for (const lane of [-1.05, 0, 1.05]) {
      ctx.strokeStyle = "rgba(55,90,145,0.13)"; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= SEGS; i++) { const s = segScreen(i), x = laneX(i, lane); i === 0 ? ctx.moveTo(x, s.y) : ctx.lineTo(x, s.y); }
      ctx.stroke();
    }
  }
  function beams(beat, offsets, t) {
    for (let i = 1; i <= SEGS; i++) {
      const lit = beamLit(i, beat, offsets);
      const s = segScreen(i), f = i / SEGS;
      const lx = laneX(i, -1) - lerp(70, 18, f);
      const rx = laneX(i, 1) + lerp(70, 18, f);
      const tilt = ((i + ((offsets && offsets[i]) || 0)) % 2 ? 1 : -1) * lerp(16, 4, f);
      const wy = s.y - 96 * (1 - f) - 28;
      const strands = i < 3 ? 4 : i < 5 ? 3 : 2;
      const spread = lerp(34, 12, f);
      // emitter nodes
      for (const ex of [lx, rx]) {
        const pulse = lit ? 0.6 + 0.4 * Math.sin(t / 120 + i) : 0.16;
        glow(ex, wy, lit ? lerp(20, 9, f) : 5, `rgba(255,55,65,${pulse * (lit ? 0.55 : 0.25)})`);
        ctx.fillStyle = "#10141f"; ctx.beginPath(); ctx.arc(ex, wy, lerp(6, 3, f), 0, 7); ctx.fill();
        ctx.fillStyle = lit ? `rgba(255,90,100,${pulse})` : "rgba(120,40,46,0.55)";
        ctx.beginPath(); ctx.arc(ex, wy, lerp(3, 1.6, f), 0, 7); ctx.fill();
      }
      if (lit) {
        const grd = ctx.createLinearGradient(0, wy - spread, 0, s.y);
        grd.addColorStop(0, "rgba(255,50,60,0.22)"); grd.addColorStop(1, "rgba(255,50,60,0)");
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.moveTo(lx, wy - spread + tilt); ctx.lineTo(rx, wy - spread - tilt);
        ctx.lineTo(laneX(i, 1) + lerp(70, 18, f), s.y); ctx.lineTo(laneX(i, -1) - lerp(70, 18, f), s.y); ctx.closePath(); ctx.fill();
      }
      for (let k = 0; k < strands; k++) {
        const off = (k - (strands - 1) / 2) * spread;
        const yL = wy + off + tilt, yR = wy + off - tilt;
        if (lit) {
          ctx.strokeStyle = "rgba(255,40,60,0.16)"; ctx.lineWidth = 11; ctx.lineCap = "round";
          ctx.beginPath(); ctx.moveTo(lx, yL); ctx.lineTo(rx, yR); ctx.stroke();
          ctx.strokeStyle = "rgba(255,70,90,0.5)"; ctx.lineWidth = 4.5;
          ctx.beginPath(); ctx.moveTo(lx, yL); ctx.lineTo(rx, yR); ctx.stroke();
          const flick = 0.85 + 0.15 * Math.sin(t / 60 + i + k);
          ctx.strokeStyle = `rgba(255,215,215,${flick})`; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(lx, yL); ctx.lineTo(rx, yR); ctx.stroke();
        } else {
          ctx.save();
          ctx.setLineDash([3, 8]); ctx.lineDashOffset = -(t / 50) % 11;
          ctx.strokeStyle = "rgba(255,80,90,0.2)"; ctx.lineWidth = 1.1;
          ctx.beginPath(); ctx.moveTo(lx, yL); ctx.lineTo(rx, yR); ctx.stroke();
          ctx.restore();
        }
      }
    }
  }
  function exitDoor(t, breached) {
    const s = segScreen(SEGS), x = DOOR_X, y = s.y, w = 64, h = 92;
    glow(x, y - h * 0.4, breached ? 90 : 54, breached ? "rgba(52,211,153,0.55)" : "rgba(50,110,170,0.3)");
    ctx.fillStyle = "#080d18"; rrect(x - w / 2 - 10, y - h - 6, w + 20, h + 6, 5); ctx.fill();
    ctx.fillStyle = "#0c1422"; rrect(x - w / 2 - 4, y - h, w + 8, h, 4); ctx.fill();
    ctx.strokeStyle = breached ? "rgba(52,211,153,0.6)" : "rgba(70,120,180,0.45)"; ctx.lineWidth = 1.5;
    rrect(x - w / 2 - 4, y - h, w + 8, h, 4); ctx.stroke();
    ctx.fillStyle = breached ? "#0d2a22" : "#101a2c"; rrect(x - w / 2, y - h + 3, w, h - 3, 3); ctx.fill();
    if (breached) {
      const slit = ctx.createLinearGradient(x, y - h, x, y);
      slit.addColorStop(0, "rgba(120,255,200,0.0)"); slit.addColorStop(0.5, "rgba(120,255,200,0.55)"); slit.addColorStop(1, "rgba(120,255,200,0.0)");
      ctx.fillStyle = slit; ctx.fillRect(x - 7, y - h + 4, 14, h - 6);
    }
    const on = breached || Math.floor(t / 500) % 2 === 0;
    glow(x, y - h + 12, 8, breached ? "rgba(52,211,153,0.5)" : "rgba(42,134,196,0.4)");
    ctx.fillStyle = breached ? "#34d399" : (on ? "#2a86c4" : "#16415e");
    ctx.beginPath(); ctx.arc(x, y - h + 12, 3, 0, 7); ctx.fill();
    // LABEL kept BELOW the door so it clears the top-center odds pill.
    const ly = y + 10, lw = breached ? 96 : 54;
    ctx.fillStyle = breached ? "rgba(8,30,22,0.9)" : "rgba(8,18,30,0.82)";
    rrect(x - lw / 2, ly - 11, lw, 15, 4); ctx.fill();
    label(x, ly, breached ? "BREACHED" : "▲ EXIT", breached ? 11 : 10, breached ? "#34d399" : "#7fb6e6", "center");
  }
  function infiltrator(p, id, name) {
    const col = id === 0 ? "#10b981" : "#8b5cf6";
    const soft = id === 0 ? "#5eead4" : "#c4b5fd";
    const glowCol = id === 0 ? "rgba(16,185,129," : "rgba(139,92,246,";
    const scale = lerp(1.5, 0.9, clamp(p.seg / SEGS, 0, 1));
    if (p.tripped) {
      ctx.save(); ctx.translate(p.x, p.y); ctx.scale(scale, scale);
      shadow(0, 3, 24, 7, 0.55); glow(0, -4, 30, "rgba(255,50,60,0.26)");
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = "#1a2030"; rrect(-18, -9, 34, 11, 5); ctx.fill();
      ctx.fillStyle = col; rrect(-16, -8, 27, 8, 4); ctx.fill();
      ctx.fillStyle = "#0f1420"; ctx.beginPath(); ctx.arc(16, -5, 7, 0, 7); ctx.fill();
      ctx.globalAlpha = 1; ctx.restore();
      const w = Math.max(58, (name.length + 4) * 7.4);
      ctx.fillStyle = "rgba(30,10,14,.92)"; rrect(p.x - w / 2, p.y + 10, w, 16, 4); ctx.fill();
      label(p.x, p.y + 22, name.toUpperCase() + " · OUT", 9, "#ff7a86", "center");
      return;
    }
    ctx.save(); ctx.translate(p.x, p.y); ctx.scale(scale, scale);
    glow(0, 2, 26, glowCol + "0.16)");
    shadow(0, 5, 18, 6, 0.42);
    glow(0, -24, 40, glowCol + "0.30)");
    glow(0, -24, 20, glowCol + "0.28)");
    // upright crouch-ready stance
    ctx.fillStyle = "#161c2a"; ctx.fillRect(-7, -18, 6, 18); ctx.fillRect(2, -18, 6, 18);
    ctx.fillStyle = "#0c1018"; ctx.fillRect(-8, -2, 8, 3); ctx.fillRect(1, -2, 8, 3);
    ctx.fillStyle = col; rrect(-9, -40, 19, 25, 6); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.2)"; rrect(-9, -40, 19, 5, 4); ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = 5; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-7, -34); ctx.lineTo(-11, -22); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(8, -34); ctx.lineTo(12, -22); ctx.stroke();
    const hy = -49;
    ctx.fillStyle = "#0f1420"; ctx.beginPath(); ctx.arc(0, hy, 8, 0, 7); ctx.fill();
    ctx.fillStyle = soft; rrect(-5, hy - 2, 10, 4, 2); ctx.fill();
    glow(0, hy, 7, glowCol + "0.5)");
    ctx.restore();
    const w = Math.max(54, name.length * 8.4);
    ctx.fillStyle = "rgba(8,16,30,.92)"; rrect(p.x - w / 2, p.y + 12, w, 16, 4); ctx.fill();
    ctx.strokeStyle = glowCol + "0.4)"; ctx.lineWidth = 1; rrect(p.x - w / 2, p.y + 12, w, 16, 4); ctx.stroke();
    label(p.x, p.y + 24, name.toUpperCase(), 9, soft, "center");
  }
  function nearMissSpark(p, t) {
    glow(p.x, p.y - 30, 22, "rgba(255,200,120,0.4)");
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * 7 + t / 90, r = 12 + (i % 3) * 5 + Math.sin(t / 80 + i) * 3;
      ctx.fillStyle = i % 2 ? "#ffd27a" : "#fff";
      ctx.fillRect(p.x + Math.cos(a) * r, p.y - 30 + Math.sin(a) * r, 2, 2);
    }
    label(p.x, p.y - 50, "ONE PIXEL", 9, "#ffd27a", "center");
  }
  function beatBar(beat, offsets, t) {
    const y = H - 92, h = 30, x0 = 16, x1 = W - 16, bw = x1 - x0;
    ctx.fillStyle = "rgba(6,10,18,0.9)"; rrect(x0, y, bw, h, 7); ctx.fill();
    ctx.strokeStyle = "rgba(52,211,153,0.3)"; ctx.lineWidth = 1; rrect(x0 + .5, y + .5, bw - 1, h - 1, 7); ctx.stroke();
    label(x0 + 12, y + 19, "♪ BEAT", 10, "#34d399", "left");
    const N = PERIOD, tx0 = x0 + 78, tw = (x1 - 14 - tx0), phase = ((beat % N) + N) % N;
    for (let k = 0; k < N; k++) {
      const cx = tx0 + (k + 0.5) * (tw / N), cur = k === phase;
      const gap = !(k === 0 || k === 2);   // phases 1,3 are the safe gaps
      ctx.fillStyle = gap ? "rgba(40,90,70,0.5)" : "rgba(90,40,46,0.5)";
      ctx.beginPath(); ctx.arc(cx, y + h / 2, cur ? 11 : 8, 0, 7); ctx.fill();
      if (cur) {
        const pulse = 0.6 + 0.4 * Math.sin(t / 120);
        ctx.fillStyle = gap ? `rgba(52,211,153,${pulse})` : `rgba(255,70,80,${pulse})`;
        ctx.beginPath(); ctx.arc(cx, y + h / 2, 6, 0, 7); ctx.fill();
        glow(cx, y + h / 2, 18, gap ? "rgba(52,211,153,0.4)" : "rgba(255,70,80,0.4)");
      } else {
        ctx.fillStyle = gap ? "#1c4a38" : "#4a1c22";
        ctx.beginPath(); ctx.arc(cx, y + h / 2, 4, 0, 7); ctx.fill();
      }
      label(cx, y + h, gap ? "GAP" : "SWEEP", 7, gap ? "#5eead4" : "#ff8a93", "center");
    }
    const phx = tx0 + ((phase + 0.5) / N) * tw;
    ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(phx, y + 4); ctx.lineTo(phx, y + h - 4); ctx.stroke();
  }
  function hud() {
    if (!data) return;
    const u = data.runners, rows = [[u[0], "#10b981", "#5eead4"], [u[1], "#8b5cf6", "#c4b5fd"]];
    ctx.fillStyle = "rgba(8,14,26,.84)"; rrect(12, 12, 244, 70, 10); ctx.fill();
    ctx.strokeStyle = "rgba(52,211,153,.4)"; ctx.lineWidth = 1; rrect(12.5, 12.5, 243, 69, 10); ctx.stroke();
    label(24, 28, "CORRIDOR CROSSING", 9, "#7fb0d8", "left");
    rows.forEach(([r, col, soft], i) => {
      const y = 44 + i * 20;
      label(24, y + 4, r.handle.toUpperCase().slice(0, 12), 10, soft, "left");
      bar(110, y - 4, 88, 8, r.seg / SEGS, col);
      label(206, y + 4, r.breached ? "DOOR" : r.tripped ? "OUT" : r.seg + "/" + SEGS, 9,
        r.tripped ? "#ff5d6c" : r.breached ? "#34d399" : soft, "left");
    });
  }
  function oddsPill() {
    if (!data) return;
    const u = data.runners;
    const a = oddsA(), pa = Math.round(a * 100), pb = 100 - pa;
    const bw = 248, x = (W - bw) / 2, yy = 7;
    ctx.fillStyle = "rgba(7,11,20,.86)"; rrect(x, yy, bw, 30, 9); ctx.fill();
    label(W / 2, yy + 12, "◷ LIVE ODDS", 8, "#7C8AA0", "center");
    label(x + 12, yy + 12, u[0].handle.toUpperCase().slice(0, 8) + " " + pa + "%", 9, "#5eead4", "left");
    label(x + bw - 12, yy + 12, pb + "% " + u[1].handle.toUpperCase().slice(0, 8), 9, "#c4b5fd", "right");
    const aw = Math.max(2, (bw - 24) * a);
    ctx.fillStyle = "#10b981"; rrect(x + 12, yy + 18, aw, 7, 3); ctx.fill();
    ctx.fillStyle = "#8b5cf6"; rrect(x + 12 + aw, yy + 18, bw - 24 - aw, 7, 3); ctx.fill();
  }
  function oddsA() {
    if (!data) return 0.5;
    const u = data.runners;
    const lead = (u[0].seg - u[1].seg) / 2.2;
    const dead = u[0].tripped ? -6 : 0, live = u[1].tripped ? 4 : 0;
    const f = (x) => 1 / (1 + Math.exp(-x));
    const a = f(lead + dead + live), b = f(-(lead + dead + live) + (u[1].tripped ? -6 : 0) + (u[0].tripped ? 4 : 0));
    return a / (a + b || 1);
  }
  function dispatcher() {
    const h = 44, y = H - h;
    ctx.fillStyle = "rgba(5,9,16,.94)"; ctx.fillRect(0, y, W, h);
    ctx.strokeStyle = "rgba(52,211,153,.4)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(W, y + .5); ctx.stroke();
    label(16, y + 18, "📡 VAULT", 10, "#34d399", "left");
    let line = "Two infiltrators time a laser corridor to the beat — who waits for clean gaps, who slides under the sweeping beams?";
    if (data) {
      const u = data.runners;
      if (data.winner) {
        line = data.win_reason === "breach" ? `${data.winner} breaches the exit door first — corridor cleared.`
          : data.win_reason === "trip" ? `${data.winner} walks the corridor clean — the rival tripped a beam.`
          : `Time's up — ${data.winner} was deepest in the corridor.`;
      } else if (data.status === "doubletrip") {
        line = "Both infiltrators trip a beam — double-out, draw.";
      } else {
        line = `Beat ${data.beat} · ${data.to_move}'s move · beam ahead is ${data.beam_ahead}. ` +
          `${u[0].handle} ${u[0].seg}/${SEGS} vs ${u[1].handle} ${u[1].seg}/${SEGS}.`;
      }
    }
    label(92, y + 18, line.slice(0, 92), 12, "#cfe0ff", "left");
  }
  function finishOverlay(t) {
    const trip = data.win_reason === "trip" || data.win_reason === "doubletrip" || data.status === "doubletrip";
    if (trip) {
      const strobe = 0.5 + 0.5 * Math.sin(t / 90);
      ctx.fillStyle = "rgba(40,6,10,0.5)"; ctx.fillRect(0, 0, W, H);
      const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.85);
      vg.addColorStop(0, "rgba(255,30,45,0)"); vg.addColorStop(1, `rgba(255,30,45,${0.28 + 0.12 * strobe})`);
      ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = `rgba(255,40,55,${0.5 * strobe})`; ctx.fillRect(0, 0, W, 6); ctx.fillRect(0, H - 50, W, 6);
    } else {
      ctx.fillStyle = "rgba(3,6,12,.58)"; ctx.fillRect(0, 0, W, H);
    }
    const draw = !data.winner;
    const col = draw ? (trip ? "#ff5d6c" : "#9aa2b6") : data.win_reason === "breach" ? "#34d399" : "#a855f7";
    const title = draw ? (data.status === "doubletrip" ? "DOUBLE TRIP" : "DRAW")
      : data.win_reason === "breach" ? "BREACHED"
      : data.win_reason === "trip" ? "WALKS IT CLEAN" : "TIME UP";
    const sub = draw ? (data.status === "doubletrip" ? "Both tripped a beam" : "Dead even in the corridor")
      : data.win_reason === "breach" ? data.winner + " reaches the exit door first"
      : data.win_reason === "trip" ? data.winner + " survives — the rival tripped"
      : data.winner + " was deepest in the corridor";
    glow(W / 2, H / 2 - 14, 230,
      (draw ? (trip ? "rgba(255,60,75," : "rgba(154,162,182,") : data.win_reason === "breach" ? "rgba(52,211,153," : "rgba(168,85,247,") + "0.18)");
    label(W / 2, H / 2 - 16, title, draw ? 38 : 34, col, "center");
    label(W / 2, H / 2 + 18, sub, 15, "#e9ecf5", "center");
  }
  function vignette() {
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.82);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  function frame(t) {
    vaultBack(t); walls(); floorGrid();
    if (data) {
      const u = data.runners;
      const breached = (u[0].breached || u[1].breached) && data.winner != null;
      exitDoor(t, breached);
      beams(data.beat || 0, data.offsets, t);
      for (let i = 0; i < 2; i++) shown[i] += (u[i].seg - shown[i]) * 0.16;
      const pos = [0, 1].map(i => {
        const lane = u[i].lane || (i === 0 ? -1 : 1);
        const segF = u[i].breached ? SEGS : shown[i];
        const s = segScreen(segF);
        return { x: laneX(segF, lane), y: s.y, seg: u[i].seg, tripped: u[i].tripped, breached: u[i].breached, near: u[i].near };
      });
      const order = pos[0].seg > pos[1].seg ? [0, 1] : [1, 0];
      for (const i of order) infiltrator(pos[i], i, u[i].handle);
      for (let i = 0; i < 2; i++) if (pos[i].near && !data.winner && !pos[i].tripped) nearMissSpark(pos[i], t);
      beatBar(data.beat || 0, data.offsets, t);
      hud();
      dispatcher();
      oddsPill();
      if (data.winner != null || data.status === "doubletrip" || data.status === "stall") finishOverlay(t);
    } else {
      exitDoor(t, false);
    }
    vignette();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- tiny helpers ----
  function rrect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function label(x, y, t, px, c, al) { ctx.fillStyle = c; ctx.textAlign = al || "left"; ctx.font = `700 ${px}px ui-monospace,monospace`; ctx.fillText(t, x, y); }
  function bar(x, y, w, h, f, c) { ctx.fillStyle = "#0a1322"; rrect(x, y, w, h, h / 2); ctx.fill(); ctx.fillStyle = c; rrect(x, y, Math.max(2, w * clamp(f, 0, 1)), h, h / 2); ctx.fill(); }
  function glow(x, y, r, c) { const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(1, r)); g.addColorStop(0, c); g.addColorStop(1, c.replace(/[\d.]+\)$/, "0)")); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, Math.max(1, r), 0, 7); ctx.fill(); }
  function shadow(x, y, w, h, a) { ctx.fillStyle = `rgba(0,0,0,${a})`; ctx.beginPath(); ctx.ellipse(x, y, w, h, 0, 0, 7); ctx.fill(); }
})();
