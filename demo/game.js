/* Laser Tango — a Mission-Impossible laser corridor crossed to a beat.
 *
 * Two infiltrators (Champions) cross a dark vault corridor of N segments by
 * TIMING moves to a metronome. Red laser beams sweep on a phase clock; a beam
 * is LIT on some beats and DARK on others. Each turn an agent reads the beat,
 * lists legal moves, and commits one:
 *   advance:gap   — step one segment through the current gap (safe only if the
 *                   beam ahead is DARK this beat)
 *   wait:beat     — hold position, let the sweep pass (always safe)
 *   slide:under   — a risky fast skip of 2 segments (covers more ground but is
 *                   only clean on a narrow window; otherwise you clip a beam)
 * Move into a LIT beam → TRIPPED (out). First to the far exit door BREACHES and
 * wins. Both tripped → draw.
 *
 * PROMPT-IS-KING: the public prompt is a tempo doctrine. patient/wait/rhythm/
 * time/careful → a metronome that waits for clean gaps. fast/aggressive/rush/
 * slide/blitz → a rusher that slides under beams to gain ground.
 *
 * HIDDEN TWIST: the beam phase OFFSET is seeded — the safe beats differ each
 * match — so identical prompts don't always resolve the same. Odds stay live.
 *
 * Faithful to the engine Game-trait model: turn-based, opaque move-strings, the
 * agent plays via get_state → legal_moves → make_move(mv, ply) → resign.
 */
(function () {
  const A = window.AW;
  const W = 780, H = 560;
  const SEGS = 7;          // corridor segments to cross to reach the door
  const PERIOD = 4;        // beam sweep period in beats
  const MAXBEATS = 22;     // safety cap on the metronome before time runs out

  // corridor perspective geometry: segment i maps to a screen depth.
  const FLOOR_Y = H - 70;
  const TOP_Y = 110;       // push the vanishing point down so the EXIT door clears the odds pill
  const DOOR_X = W * 0.5;
  // a segment's centre on screen (vanishing-point perspective toward the door)
  function segScreen(i) {
    const f = i / SEGS;                 // 0 near camera .. 1 at the door
    const y = A.lerp(FLOOR_Y, TOP_Y + 28, A.ease(f));
    return { y, f };
  }
  // each champion has a lane offset so they don't overlap
  function laneX(i, lane) {
    const { f } = segScreen(i);
    const spread = A.lerp(150, 26, f);  // corridor narrows toward the door
    return DOOR_X + lane * spread;
  }

  // ---- doctrine: parse the public prompt into a tempo policy ----------------
  const KW = {
    patient: ["patient", "wait", "rhythm", "time", "timing", "careful", "metronome", "tempo", "steady", "clean", "safe", "count"],
    fast:    ["fast", "aggressive", "rush", "slide", "blitz", "quick", "speed", "sprint", "risk", "bold", "dash", "charge"],
  };
  function doctrine(prompt) {
    const p = (prompt || "").toLowerCase();
    let pat = 0, fa = 0;
    for (const k of KW.patient) if (p.includes(k)) pat++;
    for (const k of KW.fast) if (p.includes(k)) fa++;
    if (pat === 0 && fa === 0) return { kind: "balanced", tag: "even tempo", risk: 0.5 };
    if (fa > pat) return { kind: "fast", tag: "blitz rusher", risk: 0.85 };
    if (pat > fa) return { kind: "patient", tag: "metronome", risk: 0.12 };
    return { kind: "balanced", tag: "even tempo", risk: 0.5 };
  }
  function highlight(prompt) {
    let h = (prompt || "").replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));
    for (const k of [...KW.patient, ...KW.fast]) {
      h = h.replace(new RegExp("\\b(" + k + ")\\b", "ig"), "<b>$1</b>");
    }
    return h;
  }

  const DEF_A = "Patient. I keep the rhythm — count the sweep, wait for a clean gap, then time one careful step through. Tempo over speed.";
  const DEF_B = "Aggressive. I rush the corridor and slide under the beams. Speed wins — I'll blitz two segments while they're still counting.";

  // ---- beam model: is the beam guarding the gap INTO segment `i` LIT on beat?
  // Each segment boundary has its own phase, shifted by the seeded offset so the
  // safe beats differ per match. Returns true if LIT (deadly to move into).
  function beamLit(i, beat, offsets) {
    const phase = (beat + offsets[i]) % PERIOD;
    // LIT on phases 0 and 2 (sweeping), DARK on 1 and 3 (the gaps).
    return phase === 0 || phase === 2;
  }
  // the slide window: a 2-seg skip lands cleanly only when BOTH the next and the
  // segment after are dark this beat (a rare alignment).
  function slideClean(i, beat, offsets) {
    return !beamLit(i + 1, beat, offsets) && (i + 2 > SEGS || !beamLit(i + 2, beat, offsets));
  }

  // ---- the deterministic engine --------------------------------------------
  function build(seed, opts) {
    const rng = A.rng(seed);
    const prompts = {
      A: (opts.prompts && opts.prompts.A) || DEF_A,
      B: (opts.prompts && opts.prompts.B) || DEF_B,
    };
    const doc = { A: doctrine(prompts.A), B: doctrine(prompts.B) };

    // HIDDEN TWIST: seeded per-boundary phase offsets (0..PERIOD-1). These set
    // which beats are safe at each beam, and differ every seed.
    const offsets = [];
    for (let i = 0; i <= SEGS + 2; i++) offsets[i] = Math.floor(rng() * PERIOD);
    // a touch more jitter in how each agent reads risk (keeps twins live)
    const nerveA = 0.85 + rng() * 0.3;
    const nerveB = 0.85 + rng() * 0.3;

    const st = {
      A: { seg: 0, lane: -1, out: false, breached: false, near: false },
      B: { seg: 0, lane: +1, out: false, breached: false, near: false },
    };
    const beats = [];
    const oddsHist = [];
    let ply = 1, beat = 0, winner = undefined, winReason = "closer", done = false;

    function snapOdds() {
      const f = (me, op) => {
        const lead = (st[me].seg - st[op].seg) / 2.2;
        const dead = st[me].out ? -6 : 0;
        const live = st[op].out ? 4 : 0;
        return 1 / (1 + Math.exp(-(lead + dead + live)));
      };
      let a = f("A", "B"), b = f("B", "A");
      const s = a + b || 1; return { A: (a / s) * 100, B: (b / s) * 100 };
    }
    oddsHist.push(snapOdds());

    // policy: given my doctrine + the live beam state, which legal move?
    function decide(id, beat) {
      const me = st[id];
      const i = me.seg;                       // boundary i guards entry to seg i+1
      const nextLit = beamLit(i + 1, beat, offsets);
      const clean = slideClean(i, beat, offsets);
      const d = doc[id];
      const nerve = id === "A" ? nerveA : nerveB;
      // legal set always includes wait + advance; slide only if ground remains
      const canSlide = me.seg + 2 <= SEGS;
      const legal = ["advance:gap", "wait:beat"];
      if (canSlide) legal.push("slide:under");

      let move;
      if (d.kind === "patient") {
        // metronome: only step when the next beam is DARK; otherwise wait.
        move = nextLit ? "wait:beat" : "advance:gap";
      } else if (d.kind === "fast") {
        // rusher: greedy for ground but not suicidal. Slide when the window is
        // clean; otherwise punch through a dark gap; only gamble a risky slide
        // occasionally (seeded nerve) so the blitz stays live, not an instant trip.
        if (canSlide && clean) move = "slide:under";
        else if (canSlide && rng() < 0.5 * nerve) move = "slide:under"; // bold gamble — sometimes trips
        else if (!nextLit) move = "advance:gap";
        else move = "wait:beat";                                         // bank a beat
      } else {
        // balanced: slide if clean, advance if dark, else wait.
        if (canSlide && clean) move = "slide:under";
        else if (!nextLit) move = "advance:gap";
        else move = "wait:beat";
      }
      return { move, legal, nextLit, clean, i };
    }

    // resolve a move against the live beam state → {ok, dmove, result, near}
    function apply(id, dec, beat) {
      const me = st[id];
      let ok = true, near = false, result, breached = false, out = false, gained = 0;
      if (dec.move === "wait:beat") {
        result = "ok · held — sweep passes";
      } else if (dec.move === "advance:gap") {
        if (dec.nextLit) { out = true; ok = false; result = "TRIPPED · stepped into a lit beam"; }
        else {
          gained = 1; me.seg += 1; near = beamLit(dec.i + 1, beat + 1, offsets);
          result = "ok · +1 segment through the gap";
        }
      } else { // slide:under
        if (dec.clean) {
          gained = 2; me.seg += 2; near = true;
          result = "ok · +2 — slid clean under the beams";
        } else {
          out = true; ok = false; result = "TRIPPED · clipped a beam mid-slide";
        }
      }
      if (me.seg >= SEGS && !out) { me.seg = SEGS; breached = true; result = "BREACHED · reached the exit door"; }
      me.out = out; me.breached = breached; me.near = near;
      return { ok, near, result, breached, out, gained };
    }

    function nameOf(id) { return id === "A" ? "Tempo" : "Blitz"; }

    // interleave turns, advancing the metronome each full round.
    outer:
    for (let round = 0; round < MAXBEATS && !done; round++) {
      for (const id of ["A", "B"]) {
        if (done) break;
        const me = st[id], op = st[id === "A" ? "B" : "A"];
        if (me.out || me.breached) continue;
        const fromSeg = me.seg;
        const dec = decide(id, beat);
        const res = apply(id, dec, beat);

        const thought = doc[id].kind === "patient"
          ? (dec.nextLit ? "Beam's lit — hold the count, wait for the gap." : "Gap's open — one clean step. Now.")
          : doc[id].kind === "fast"
          ? (dec.move === "slide:under" ? "No time to count — slide under and steal two." : "Rush the gap, keep the pressure on.")
          : (dec.move === "slide:under" ? "Window's clean — take two." : dec.nextLit ? "Lit ahead — wait it out." : "Dark gap — step.");

        beats.push({
          ply: ply++, agent: id,
          thought,
          observe: {
            seg: fromSeg + "/" + SEGS,
            beat: beat,
            beam_ahead: dec.nextLit ? "LIT" : "DARK",
            to_door: SEGS - fromSeg,
          },
          legal: dec.legal,
          move: dec.move, ok: res.ok, result: res.result,
          state: {
            A: { ...st.A }, B: { ...st.B }, mover: id, beat,
            fromSeg, toSeg: me.seg, moveKind: dec.move, near: res.near,
            tripped: res.out, breached: res.breached, offsets,
          },
          events: [
            `${nameOf(id)} ${
              res.out ? "TRIPS a beam — out!" :
              res.breached ? "BREACHES the exit door!" :
              dec.move === "wait:beat" ? "freezes — the sweep glides past" :
              dec.move === "slide:under" ? `slides under — +2 to segment ${me.seg}` :
              `slips through the gap — +1 to segment ${me.seg}`
            }${res.near && !res.out && !res.breached ? " · one pixel from the beam" : ""}`,
          ],
        });
        oddsHist.push(snapOdds());

        if (res.breached) { winner = id; winReason = "breach"; done = true; break outer; }
        if (st.A.out && st.B.out) { winner = null; winReason = "doubletrip"; done = true; break outer; }
        if (res.out) {
          // a trip hands it to a rival who's already breached; else play on
          if (op.breached) { winner = id === "A" ? "B" : "A"; winReason = "breach"; done = true; break outer; }
        }
      }
      beat = (beat + 1) % 1000; // advance the metronome each round
    }

    // resolve no-breach end
    if (winner === undefined) {
      if (st.A.out && !st.B.out) { winner = "B"; winReason = "trip"; }
      else if (st.B.out && !st.A.out) { winner = "A"; winReason = "trip"; }
      else if (st.A.out && st.B.out) { winner = null; winReason = "doubletrip"; }
      else { winner = st.A.seg === st.B.seg ? null : st.A.seg > st.B.seg ? "A" : "B"; winReason = winner == null ? "stall" : "closer"; }
    }

    function finalLine() {
      if (winner == null) return winReason === "doubletrip" ? "Both infiltrators trip a beam — double-out, draw." : "Time's up dead even — draw.";
      const loser = winner === "A" ? "B" : "A";
      if (winReason === "breach") return `${nameOf(winner)} breaches the exit door first — corridor cleared.`;
      if (winReason === "trip") return `${nameOf(loser)} tripped a beam — ${nameOf(winner)} walks the corridor clean.`;
      return `Time's up — ${nameOf(winner)} was deepest into the corridor.`;
    }

    beats.push({
      ply: ply++, agent: "ref", move: "resolve", legal: null,
      observe: { winner: winner == null ? "draw" : nameOf(winner), reason: winReason },
      result: winner == null ? "draw — " + winReason : nameOf(winner) + " wins · " + winReason,
      events: [finalLine()],
      state: { A: { ...st.A }, B: { ...st.B }, mover: null, beat, offsets, final: true },
    });

    return {
      seed, beats, winner, winReason,
      names: { A: nameOf("A"), B: nameOf("B") },
      promptOf: (id) => highlight(prompts[id]),
      tagOf: (id) => doc[id].tag,
      oddsAt: (b) => oddsHist[Math.min(b, oddsHist.length - 1)] || { A: 50, B: 50 },
      _doc: doc, _offsets: offsets,
    };
  }

  // ====== RENDER =============================================================
  // interpolate each champion between its previous and current segment.
  function spritePos(res, beat, beatT) {
    const out = { A: null, B: null };
    for (const id of ["A", "B"]) {
      let cur = null;
      for (let k = 0; k <= beat; k++) {
        const bt = res.beats[k];
        if (bt.agent === id && bt.state) cur = bt;
      }
      const lane = id === "A" ? -1 : +1;
      if (!cur) { const s = segScreen(0); out[id] = { x: laneX(0, lane), y: s.y, seg: 0, kind: "idle", jump: 0 }; continue; }
      const fromSeg = cur.state.fromSeg, toSeg = cur.state.toSeg;
      const active = res.beats[beat] && res.beats[beat].agent === id && res.beats[beat].state && !res.beats[beat].state.final;
      const tt = active ? A.easeOut(beatT) : 1;
      const segF = A.lerp(fromSeg, toSeg, tt);
      const sFrom = segScreen(fromSeg), sTo = segScreen(toSeg);
      const x = A.lerp(laneX(fromSeg, lane), laneX(toSeg, lane), tt);
      const y = A.lerp(sFrom.y, sTo.y, tt);
      const moveKind = cur.state.moveKind;
      // a hop arc on advance/slide; freeze (no arc) on wait
      let jump = 0;
      if (active && moveKind !== "wait:beat" && toSeg !== fromSeg) jump = Math.sin(tt * Math.PI) * (moveKind === "slide:under" ? 8 : 16);
      out[id] = {
        x, y: y - jump, seg: segF, kind: moveKind, jump,
        tripped: cur.state.tripped && active, near: cur.state.near && active && beatT > 0.6,
        breached: cur.state.breached,
        out: !!(cur.state[id] && cur.state[id].out), // persistent downed flag
      };
    }
    return out;
  }

  function draw(ctx, v) {
    const t = v.t, res = v.result, beat = v.beat, bt = res.beats[beat];
    const stt = bt && bt.state ? bt.state : { A: { seg: 0 }, B: { seg: 0 }, beat: 0, offsets: res._offsets };
    const offsets = stt.offsets || res._offsets;
    const liveBeat = stt.beat || 0;

    // ambient vault background
    ctx.fillStyle = "#05070e"; ctx.fillRect(0, 0, W, H);
    vaultBack(ctx, t);
    corridor(ctx, res.seed, t);
    floorGrid(ctx, t);
    exitDoor(ctx, t, res.winner != null && v.over, stt);

    // beam sweep phase: while a beat plays, beams animate toward the NEXT beat
    // state in the back third so the sweep reads as motion, but the gate logic
    // uses the integer beat for correctness.
    emitters(ctx, offsets, liveBeat, v.beatT, t);
    beams(ctx, offsets, liveBeat, v.beatT, t);

    const pos = spritePos(res, beat, v.beatT);
    // draw the deeper (further) champion first
    const order = (pos.A && pos.B && pos.A.seg > pos.B.seg) ? ["A", "B"] : ["B", "A"];
    for (const id of order) if (pos[id]) infiltrator(ctx, pos[id], id, res.names[id], t);

    // near-miss spark
    for (const id of ["A", "B"]) if (pos[id] && pos[id].near && !v.over) nearMissSpark(ctx, pos[id], t);

    beatBar(ctx, liveBeat, offsets, v.beatT, t, res);
    hud(ctx, res, stt, t);
    dispatcher(ctx, res, bt, v);

    if (v.over) finishOverlay(ctx, res, t);
    else for (const id of ["A", "B"]) if (pos[id] && pos[id].tripped) tripFlash(ctx, pos[id], v.beatT, t);

    vignette(ctx);
    scanlines(ctx);
  }

  // --- scene pieces ----------------------------------------------------------
  function vaultBack(ctx, t) {
    // deep vault gradient toward a glowing far wall behind the door
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#070a16"); g.addColorStop(0.5, "#0a0e1d"); g.addColorStop(1, "#04060d");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // far-wall ambient glow at the vanishing point
    A.glow(ctx, DOOR_X, TOP_Y + 10, 200, "rgba(40,70,120,0.12)");
    // faint red alarm wash bleeding from the corridor depths
    A.glow(ctx, DOOR_X, TOP_Y + 40, 240, "rgba(120,40,50,0.06)");
    // floating dust motes (denser)
    if (!A.reduced) for (let i = 0; i < 70; i++) {
      const x = (i * 191 + Math.sin(t / 2400 + i) * 30) % W;
      const yb = (i * 73 + t * 0.012) % (H - 120);
      const a = 0.05 + 0.08 * ((Math.sin(t / 900 + i) + 1) / 2);
      ctx.fillStyle = `rgba(120,150,200,${a})`;
      const sz = i % 5 === 0 ? 2 : 1;
      ctx.fillRect(x, 60 + yb, sz, sz);
    }
    // horizontal scanline haze sweeping down the corridor (security-cam feel)
    if (!A.reduced) {
      ctx.save();
      const sy = (t * 0.05) % (H + 60) - 30;
      const g = ctx.createLinearGradient(0, sy - 40, 0, sy + 40);
      g.addColorStop(0, "rgba(80,140,200,0)"); g.addColorStop(0.5, "rgba(90,150,210,0.05)"); g.addColorStop(1, "rgba(80,140,200,0)");
      ctx.fillStyle = g; ctx.fillRect(0, sy - 40, W, 80);
      ctx.restore();
    }
  }
  // thin CRT scanlines over the whole frame for a surveillance-grade texture
  function scanlines(ctx) {
    if (A.reduced) return;
    ctx.save();
    ctx.globalAlpha = 0.05; ctx.fillStyle = "#000";
    for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
    ctx.restore();
  }
  function corridor(ctx, seed, t) {
    // perspective side walls: two trapezoids closing toward the door
    const nearL = laneX(0, -1) - 70, nearR = laneX(0, 1) + 70;
    const farL = laneX(SEGS, -1) - 18, farR = laneX(SEGS, 1) + 18;
    const ny = FLOOR_Y, fy = segScreen(SEGS).y - 6;
    // left wall
    wall(ctx, nearL, ny, farL, fy, seed * 3 + 1, t, -1);
    wall(ctx, nearR, ny, farR, fy, seed * 7 + 5, t, +1);
    // ceiling band
    ctx.fillStyle = "#070b16";
    ctx.beginPath();
    ctx.moveTo(nearL, ny - 220); ctx.lineTo(nearR, ny - 220);
    ctx.lineTo(farR, fy - 70); ctx.lineTo(farL, fy - 70); ctx.closePath(); ctx.fill();
    // ceiling rails with faint lights
    for (let i = 1; i < SEGS; i++) {
      const s = segScreen(i); const lx = laneX(i, -1.05), rx = laneX(i, 1.05);
      ctx.strokeStyle = "rgba(60,90,140,0.10)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(lx, s.y - 150 + i * 8); ctx.lineTo(rx, s.y - 150 + i * 8); ctx.stroke();
    }
  }
  function wall(ctx, nx, ny, fx, fy, seed, t, side) {
    const topNear = ny - 220, topFar = fy - 70;
    ctx.fillStyle = side < 0 ? "#0a0f1e" : "#080c19";
    ctx.beginPath();
    ctx.moveTo(nx, ny); ctx.lineTo(fx, fy); ctx.lineTo(fx, topFar); ctx.lineTo(nx, topNear); ctx.closePath(); ctx.fill();
    // panel seams + recessed light strips for depth
    const r = A.rng(seed);
    for (let k = 1; k <= 6; k++) {
      const f = k / 7;
      const x = A.lerp(nx, fx, f), yb = A.lerp(ny, fy, f), yt = A.lerp(topNear, topFar, f);
      ctx.strokeStyle = "rgba(40,60,100,0.16)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, yb); ctx.lineTo(x, yt); ctx.stroke();
      // small wall light
      if (r() < 0.6) {
        const ly = A.lerp(yt, yb, 0.32);
        const on = ((k * 5 + Math.floor(t / 1300)) % 5) < 4;
        ctx.fillStyle = on ? "rgba(90,150,210,0.5)" : "rgba(30,50,90,0.4)";
        ctx.fillRect(x - 1, ly, 2, 8);
      }
    }
  }
  function floorGrid(ctx, t) {
    // glossy dark floor with perspective grid lines per segment
    ctx.save();
    const nearL = laneX(0, -1) - 70, nearR = laneX(0, 1) + 70;
    const farL = laneX(SEGS, -1) - 18, farR = laneX(SEGS, 1) + 18;
    const ny = FLOOR_Y, fy = segScreen(SEGS).y - 6;
    const g = ctx.createLinearGradient(0, fy, 0, ny);
    g.addColorStop(0, "#0a1120"); g.addColorStop(1, "#05080f");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(nearL, ny); ctx.lineTo(nearR, ny); ctx.lineTo(farR, fy); ctx.lineTo(farL, fy); ctx.closePath(); ctx.fill();
    // dense segment cross-lines: a major line per segment + 2 minor sub-lines.
    const edgeW = (f) => A.lerp(70, 18, f);
    for (let i = 0; i <= SEGS; i++) {
      for (let sub = 0; sub < (i < SEGS ? 3 : 1); sub++) {
        const fi = i + sub / 3;
        if (fi > SEGS) break;
        const s = segScreen(fi);
        const f = fi / SEGS;
        const lx = laneX(fi, -1) - edgeW(f);
        const rx = laneX(fi, 1) + edgeW(f);
        const major = sub === 0;
        ctx.strokeStyle = i === SEGS ? "rgba(52,211,153,0.28)" : major ? "rgba(60,95,150,0.16)" : "rgba(50,80,130,0.06)";
        ctx.lineWidth = major ? 1.2 : 1;
        ctx.beginPath(); ctx.moveTo(lx, s.y); ctx.lineTo(rx, s.y); ctx.stroke();
      }
    }
    // lane longitudinal lines (incl. quarter lanes for density)
    for (const lane of [-1.05, -0.5, 0, 0.5, 1.05]) {
      const main = lane === -1.05 || lane === 0 || lane === 1.05;
      ctx.strokeStyle = main ? "rgba(55,90,145,0.13)" : "rgba(50,80,130,0.06)"; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= SEGS; i++) { const s = segScreen(i); const x = laneX(i, lane); i === 0 ? ctx.moveTo(x, s.y) : ctx.lineTo(x, s.y); }
      ctx.stroke();
    }
    // glossy floor sheen running up the centre
    const sheen = ctx.createLinearGradient(DOOR_X, fy, DOOR_X, ny);
    sheen.addColorStop(0, "rgba(60,110,170,0.0)"); sheen.addColorStop(0.6, "rgba(50,90,150,0.05)"); sheen.addColorStop(1, "rgba(40,70,120,0.10)");
    ctx.fillStyle = sheen;
    ctx.beginPath(); ctx.moveTo(laneX(0, -0.5), ny); ctx.lineTo(laneX(0, 0.5), ny); ctx.lineTo(laneX(SEGS, 0.4), fy); ctx.lineTo(laneX(SEGS, -0.4), fy); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  function emitters(ctx, offsets, beat, beatT, t) {
    // wall emitter nodes at each beam boundary; bloom red when their beam is lit.
    for (let i = 1; i <= SEGS; i++) {
      const lit = beamLit(i, beat, offsets);
      const s = segScreen(i);
      const f = i / SEGS;
      const lx = laneX(i, -1) - A.lerp(70, 18, f);
      const rx = laneX(i, 1) + A.lerp(70, 18, f);
      const wy = s.y - 96 * (1 - f) - 28;
      const nodeR = A.lerp(6, 3, f);
      for (const [ex, ey] of [[lx, wy - 18], [lx, wy + 18], [rx, wy - 18], [rx, wy + 18]]) {
        const pulse = lit ? (0.6 + 0.4 * Math.sin(t / 120 + i)) : 0.16;
        // animated bloom halo on the wall behind the node
        A.glow(ctx, ex, ey, lit ? A.lerp(24, 10, f) : 5, `rgba(255,55,65,${pulse * (lit ? 0.55 : 0.25)})`);
        // emitter housing
        ctx.fillStyle = "#10141f"; ctx.beginPath(); ctx.arc(ex, ey, nodeR + 1, 0, 7); ctx.fill();
        ctx.strokeStyle = lit ? "rgba(255,90,100,0.6)" : "rgba(90,40,46,0.5)"; ctx.lineWidth = 1; ctx.stroke();
        // lens
        ctx.fillStyle = lit ? `rgba(255,90,100,${pulse})` : "rgba(120,40,46,0.55)";
        ctx.beginPath(); ctx.arc(ex, ey, nodeR * 0.55, 0, 7); ctx.fill();
        if (lit) { ctx.fillStyle = `rgba(255,220,220,${pulse})`; ctx.beginPath(); ctx.arc(ex, ey, nodeR * 0.25, 0, 7); ctx.fill(); }
      }
    }
  }
  function beams(ctx, offsets, beat, beatT, t) {
    // Each boundary is a FAN of stacked laser strands across the corridor. Lit
    // boundaries blaze with bloom; dark ones show a faint armed track so the
    // corridor always reads as full of hardware.
    for (let i = 1; i <= SEGS; i++) {
      const lit = beamLit(i, beat, offsets);
      const s = segScreen(i);
      const f = i / SEGS;
      const lx = laneX(i, -1) - A.lerp(70, 18, f);
      const rx = laneX(i, 1) + A.lerp(70, 18, f);
      // a slight diagonal tilt that alternates per segment for variety
      const tilt = ((i + offsets[i]) % 2 ? 1 : -1) * A.lerp(16, 4, f);
      const wy = s.y - 96 * (1 - f) - 28;
      // number of strands shrinks with depth so far beams don't smear
      const strands = i < 3 ? 4 : i < 5 ? 3 : 2;
      const spread = A.lerp(34, 12, f);
      const fy = s.y;
      if (lit) {
        // a translucent "lit plane" sheet down to the floor under the whole fan
        const grd = ctx.createLinearGradient(0, wy - spread, 0, fy);
        grd.addColorStop(0, "rgba(255,50,60,0.22)"); grd.addColorStop(1, "rgba(255,50,60,0)");
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.moveTo(lx, wy - spread + tilt); ctx.lineTo(rx, wy - spread - tilt);
        ctx.lineTo(laneX(i, 1) + A.lerp(70, 18, f), fy);
        ctx.lineTo(laneX(i, -1) - A.lerp(70, 18, f), fy); ctx.closePath(); ctx.fill();
      }
      for (let k = 0; k < strands; k++) {
        const off = (k - (strands - 1) / 2) * spread;
        const yL = wy + off + tilt, yR = wy + off - tilt;
        if (lit) {
          ctx.save();
          ctx.strokeStyle = `rgba(255,40,60,0.16)`; ctx.lineWidth = 11; ctx.lineCap = "round";
          ctx.beginPath(); ctx.moveTo(lx, yL); ctx.lineTo(rx, yR); ctx.stroke();
          ctx.strokeStyle = `rgba(255,70,90,0.5)`; ctx.lineWidth = 4.5;
          ctx.beginPath(); ctx.moveTo(lx, yL); ctx.lineTo(rx, yR); ctx.stroke();
          const flick = 0.85 + 0.15 * Math.sin(t / 60 + i + k);
          ctx.strokeStyle = `rgba(255,215,215,${flick})`; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(lx, yL); ctx.lineTo(rx, yR); ctx.stroke();
          ctx.restore();
        } else {
          // armed but dark: a clearer dotted track so the gap reads as "safe now"
          ctx.save();
          ctx.setLineDash([3, 8]); ctx.lineDashOffset = -(t / 50) % 11;
          ctx.strokeStyle = "rgba(255,80,90,0.2)"; ctx.lineWidth = 1.1;
          ctx.beginPath(); ctx.moveTo(lx, yL); ctx.lineTo(rx, yR); ctx.stroke();
          ctx.restore();
        }
      }
    }
  }
  function exitDoor(ctx, t, breached, stt) {
    const s = segScreen(SEGS);
    const x = DOOR_X, y = s.y;
    const w = 64, h = 92;
    A.glow(ctx, x, y - h * 0.4, breached ? 90 : 54, breached ? "rgba(52,211,153,0.55)" : "rgba(50,110,170,0.3)");
    // recessed door alcove (gives the far wall depth)
    ctx.fillStyle = "#080d18"; A.rrect(ctx, x - w / 2 - 10, y - h - 6, w + 20, h + 6, 5); ctx.fill();
    // door frame
    ctx.fillStyle = "#0c1422"; A.rrect(ctx, x - w / 2 - 4, y - h, w + 8, h, 4); ctx.fill();
    ctx.strokeStyle = breached ? "rgba(52,211,153,0.6)" : "rgba(70,120,180,0.45)"; ctx.lineWidth = 1.5;
    A.rrect(ctx, x - w / 2 - 4, y - h, w + 8, h, 4); ctx.stroke();
    // door leaf with vertical light slit when breaching
    ctx.fillStyle = breached ? "#0d2a22" : "#101a2c"; A.rrect(ctx, x - w / 2, y - h + 3, w, h - 3, 3); ctx.fill();
    if (breached) {
      const slit = ctx.createLinearGradient(x, y - h, x, y);
      slit.addColorStop(0, "rgba(120,255,200,0.0)"); slit.addColorStop(0.5, "rgba(120,255,200,0.55)"); slit.addColorStop(1, "rgba(120,255,200,0.0)");
      ctx.fillStyle = slit; ctx.fillRect(x - 7, y - h + 4, 14, h - 6);
    }
    // panel detail rivets
    ctx.fillStyle = breached ? "rgba(52,211,153,0.35)" : "rgba(70,110,170,0.3)";
    for (const ry of [0.2, 0.5, 0.8]) { ctx.beginPath(); ctx.arc(x - w / 2 + 6, y - h + h * ry, 1.6, 0, 7); ctx.fill(); ctx.beginPath(); ctx.arc(x + w / 2 - 6, y - h + h * ry, 1.6, 0, 7); ctx.fill(); }
    // seam + status light
    ctx.strokeStyle = "rgba(80,120,180,0.3)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y - h + 6); ctx.lineTo(x, y - 4); ctx.stroke();
    const on = breached || Math.floor(t / 500) % 2 === 0;
    ctx.fillStyle = breached ? "#34d399" : (on ? "#2a86c4" : "#16415e");
    A.glow(ctx, x, y - h + 12, 8, breached ? "rgba(52,211,153,0.5)" : "rgba(42,134,196,0.4)");
    ctx.beginPath(); ctx.arc(x, y - h + 12, 3, 0, 7); ctx.fill();
    // LABEL: kept BELOW the door (clear of the top-center odds pill at y<40).
    const ly = y + 10;
    const lw = breached ? 96 : 54;
    ctx.fillStyle = breached ? "rgba(8,30,22,0.9)" : "rgba(8,18,30,0.82)";
    A.rrect(ctx, x - lw / 2, ly - 11, lw, 15, 4); ctx.fill();
    A.label(ctx, x, ly, breached ? "BREACHED" : "▲ EXIT", breached ? 11 : 10, breached ? "#34d399" : "#7fb6e6", "center");
  }
  function infiltrator(ctx, p, id, name, t) {
    const col = id === "A" ? "#10b981" : "#8b5cf6";
    const soft = id === "A" ? "#5eead4" : "#c4b5fd";
    const glowCol = id === "A" ? "rgba(16,185,129," : "rgba(139,92,246,";
    // bump base scale + enforce a minimum on-screen size so depth stays legible.
    const scale = A.lerp(1.55, 0.92, A.clamp(p.seg / SEGS, 0, 1));
    // DOWNED: a tripped infiltrator slumps on the floor, dimmed, with a red alarm.
    if (p.out) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(scale, scale);
      A.shadow(ctx, 0, 3, 24, 7, 0.55);
      A.glow(ctx, 0, -4, 30, "rgba(255,50,60,0.26)");
      ctx.globalAlpha = 0.6;
      // slumped body lying down
      ctx.fillStyle = "#1a2030"; A.rrect(ctx, -18, -9, 34, 11, 5); ctx.fill();
      ctx.fillStyle = col; A.rrect(ctx, -16, -8, 27, 8, 4); ctx.fill();
      ctx.fillStyle = "#0f1420"; ctx.beginPath(); ctx.arc(16, -5, 7, 0, 7); ctx.fill(); // head fallen forward
      ctx.fillStyle = "#ff6b76"; ctx.fillRect(11, -6, 8, 2.4);
      ctx.globalAlpha = 1;
      ctx.restore();
      const w = Math.max(58, (name.length + 4) * 7.4);
      ctx.fillStyle = "rgba(30,10,14,.92)"; A.rrect(ctx, p.x - w / 2, p.y + 10, w, 16, 4); ctx.fill();
      A.label(ctx, p.x, p.y + 22, name.toUpperCase() + " · OUT", 9, "#ff7a86", "center");
      return;
    }
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(scale, scale);
    // grounded floor halo so the figure pops off the dark corridor
    A.glow(ctx, 0, 2, 26, glowCol + "0.16)");
    // shadow on floor (below jump)
    A.shadow(ctx, 0, 5 + p.jump * 0.6, 18, 6, 0.42);
    // STRONG body glow (two layers) for legibility at depth
    A.glow(ctx, 0, -24, 40, glowCol + "0.30)");
    A.glow(ctx, 0, -24, 20, glowCol + "0.28)");
    const leaning = p.kind === "slide:under";
    const moving = p.kind && p.kind !== "wait:beat" && p.jump > 0.3;
    if (leaning) {
      // CROUCH/SLIDE pose: low, forward-leaning, arms back, motion streaks.
      if (!A.reduced) {
        ctx.strokeStyle = glowCol + "0.4)"; ctx.lineWidth = 2.5;
        for (let s = 0; s < 3; s++) { ctx.beginPath(); ctx.moveTo(-20 - s * 6, -10 - s * 4); ctx.lineTo(-30 - s * 8, -10 - s * 4); ctx.stroke(); }
      }
      // trailing leg + lead leg, low to the floor
      ctx.fillStyle = "#161c2a";
      ctx.beginPath(); ctx.moveTo(-12, -4); ctx.lineTo(2, -10); ctx.lineTo(4, -4); ctx.lineTo(-10, 0); ctx.closePath(); ctx.fill();
      ctx.fillRect(4, -12, 10, 6);
      // crouched torso (a low forward wedge)
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(-14, -10); ctx.lineTo(8, -26); ctx.lineTo(18, -20); ctx.lineTo(-2, -6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.2)";
      ctx.beginPath(); ctx.moveTo(-14, -10); ctx.lineTo(8, -26); ctx.lineTo(11, -23); ctx.lineTo(-11, -7); ctx.closePath(); ctx.fill();
      // trailing arm
      ctx.strokeStyle = col; ctx.lineWidth = 5; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(-4, -16); ctx.lineTo(-18, -8); ctx.stroke();
      // head + visor, thrust forward
      const hx = 16, hy = -28;
      ctx.fillStyle = "#0f1420"; ctx.beginPath(); ctx.arc(hx, hy, 8, 0, 7); ctx.fill();
      ctx.fillStyle = soft; A.rrect(ctx, hx - 1, hy - 3, 9, 4, 2); ctx.fill();
      A.glow(ctx, hx + 3, hy - 1, 7, glowCol + "0.5)");
    } else {
      // upright CROUCH-READY stance: legs apart, torso tall, alert.
      ctx.fillStyle = "#161c2a";
      const step = moving && !A.reduced ? Math.sin(t / 90) * 2 : 0;
      ctx.fillRect(-7, -18, 6, 18 + step); ctx.fillRect(2, -18, 6, 18 - step);
      // boots
      ctx.fillStyle = "#0c1018"; ctx.fillRect(-8, -2 + step, 8, 3); ctx.fillRect(1, -2 - step, 8, 3);
      // torso
      ctx.fillStyle = col; A.rrect(ctx, -9, -40, 19, 25, 6); ctx.fill();
      // chest highlight + tactical strap
      ctx.fillStyle = "rgba(255,255,255,0.2)"; A.rrect(ctx, -9, -40, 19, 5, 4); ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-7, -38); ctx.lineTo(8, -20); ctx.stroke();
      // arms tucked
      ctx.strokeStyle = col; ctx.lineWidth = 5; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(-7, -34); ctx.lineTo(-11, -22); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(8, -34); ctx.lineTo(12, -22); ctx.stroke();
      // head + visor
      const hy = -49;
      ctx.fillStyle = "#0f1420"; ctx.beginPath(); ctx.arc(0, hy, 8, 0, 7); ctx.fill();
      ctx.fillStyle = soft; A.rrect(ctx, -5, hy - 2, 10, 4, 2); ctx.fill();
      A.glow(ctx, 0, hy, 7, glowCol + "0.5)");
    }
    ctx.restore();

    // name tag (unscaled, below)
    const w = Math.max(54, name.length * 8.4);
    ctx.fillStyle = "rgba(8,16,30,.92)";
    A.rrect(ctx, p.x - w / 2, p.y + 12, w, 16, 4); ctx.fill();
    ctx.strokeStyle = glowCol + "0.4)"; ctx.lineWidth = 1; A.rrect(ctx, p.x - w / 2, p.y + 12, w, 16, 4); ctx.stroke();
    A.label(ctx, p.x, p.y + 24, name.toUpperCase(), 9, soft, "center");
  }
  function nearMissSpark(ctx, p, t) {
    A.glow(ctx, p.x, p.y - 30, 22, "rgba(255,200,120,0.4)");
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * 7 + t / 90;
      const r = 12 + (i % 3) * 5 + Math.sin(t / 80 + i) * 3;
      ctx.fillStyle = i % 2 ? "#ffd27a" : "#fff";
      ctx.fillRect(p.x + Math.cos(a) * r, p.y - 30 + Math.sin(a) * r, 2, 2);
    }
    A.label(ctx, p.x, p.y - 50, "ONE PIXEL", 9, "#ffd27a", "center");
  }
  function beatBar(ctx, beat, offsets, beatT, t, res) {
    // ticking metronome bar across the bottom (above dispatcher)
    const y = H - 92, h = 30, x0 = 16, x1 = W - 16, bw = x1 - x0;
    ctx.fillStyle = "rgba(6,10,18,0.9)"; A.rrect(ctx, x0, y, bw, h, 7); ctx.fill();
    ctx.strokeStyle = "rgba(52,211,153,0.3)"; ctx.lineWidth = 1; A.rrect(ctx, x0 + .5, y + .5, bw - 1, h - 1, 7); ctx.stroke();
    A.label(ctx, x0 + 12, y + 19, "♪ BEAT", 10, "#34d399", "left");
    // PERIOD ticks; highlight the current phase, mark which phases are gaps
    const N = PERIOD; const tx0 = x0 + 78, tw = (x1 - 14 - tx0);
    const phase = beat % N;
    for (let k = 0; k < N; k++) {
      const cx = tx0 + (k + 0.5) * (tw / N);
      const cur = k === phase;
      // phases 1,3 are the safe gaps (dark beams)
      const gap = (k === 1 || k === 3);
      const rOuter = cur ? 11 : 8;
      ctx.fillStyle = gap ? "rgba(40,90,70,0.5)" : "rgba(90,40,46,0.5)";
      ctx.beginPath(); ctx.arc(cx, y + h / 2, rOuter, 0, 7); ctx.fill();
      if (cur) {
        const pulse = 0.6 + 0.4 * Math.sin(t / 120);
        ctx.fillStyle = gap ? `rgba(52,211,153,${pulse})` : `rgba(255,70,80,${pulse})`;
        ctx.beginPath(); ctx.arc(cx, y + h / 2, 6, 0, 7); ctx.fill();
        A.glow(ctx, cx, y + h / 2, 18, gap ? "rgba(52,211,153,0.4)" : "rgba(255,70,80,0.4)");
      } else {
        ctx.fillStyle = gap ? "#1c4a38" : "#4a1c22";
        ctx.beginPath(); ctx.arc(cx, y + h / 2, 4, 0, 7); ctx.fill();
      }
      A.label(ctx, cx, y + h + 0, gap ? "GAP" : "SWEEP", 7, gap ? "#5eead4" : "#ff8a93", "center");
    }
    // a sweeping playhead across the bar
    const phx = tx0 + ((phase + (A.reduced ? 0 : beatT)) / N) * tw;
    ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(phx, y + 4); ctx.lineTo(phx, y + h - 4); ctx.stroke();
  }
  function hud(ctx, res, stt, t) {
    const rows = [["A", res.names.A, "#10b981", "#5eead4"], ["B", res.names.B, "#8b5cf6", "#c4b5fd"]];
    ctx.fillStyle = "rgba(8,14,26,.84)"; A.rrect(ctx, 12, 12, 244, 70, 10); ctx.fill();
    ctx.strokeStyle = "rgba(52,211,153,.4)"; ctx.lineWidth = 1; A.rrect(ctx, 12.5, 12.5, 243, 69, 10); ctx.stroke();
    A.label(ctx, 24, 28, "CORRIDOR CROSSING", 9, "#7fb0d8", "left");
    rows.forEach(([id, nm, col, soft], i) => {
      const y = 44 + i * 20; const s = stt[id] || { seg: 0, out: false, breached: false };
      A.label(ctx, 24, y + 4, nm.toUpperCase(), 10, soft, "left");
      bar(ctx, 86, y - 4, 110, 8, s.seg / SEGS, col, "#0a1322");
      // seg pips
      A.label(ctx, 204, y + 4, s.breached ? "DOOR" : s.out ? "OUT" : s.seg + "/" + SEGS, 9,
        s.out ? "#ff5d6c" : s.breached ? "#34d399" : soft, "left");
    });
  }
  function bar(ctx, x, y, w, h, frac, col, bg) {
    ctx.fillStyle = bg; A.rrect(ctx, x, y, w, h, h / 2); ctx.fill();
    ctx.fillStyle = col; A.rrect(ctx, x, y, Math.max(2, w * A.clamp(frac, 0, 1)), h, h / 2); ctx.fill();
  }
  function dispatcher(ctx, res, bt, v) {
    const h = 44, y = H - h;
    ctx.fillStyle = "rgba(5,9,16,.94)"; ctx.fillRect(0, y, W, h);
    ctx.strokeStyle = "rgba(52,211,153,.4)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(W, y + .5); ctx.stroke();
    A.label(ctx, 16, y + 18, "📡 VAULT", 10, "#34d399", "left");
    let line = "Two infiltrators time a laser corridor to the beat. Read each prompt — who waits for clean gaps, who slides under the beams?";
    if (bt && bt.events && bt.events[0]) line = bt.events[0];
    if (v.over && res.beats.length) line = res.beats[res.beats.length - 1].events[0];
    A.wrap(ctx, line, 92, y + 18, W - 110, 14, 12, "#cfe0ff", "ui-monospace,monospace");
  }
  function tripFlash(ctx, p, beatT, t) {
    // CINEMATIC loss state — as big as BREACHED. Full-screen red alarm strobe,
    // a corner-to-corner alarm tint, a TRIPPED stamp, and a burst of sparks.
    const env = Math.sin(beatT * Math.PI);            // 0→1→0 over the beat
    const strobe = 0.5 + 0.5 * Math.sin(t / 70);      // fast alarm flicker
    const a = env;
    // full-screen alarm flash
    ctx.fillStyle = `rgba(255,40,55,${a * 0.42 * (0.5 + 0.5 * strobe)})`; ctx.fillRect(0, 0, W, H);
    // red vignette pulsing in from the edges
    const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.85);
    vg.addColorStop(0, "rgba(255,30,45,0)"); vg.addColorStop(1, `rgba(255,30,45,${a * 0.5})`);
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    // alarm bars top & bottom
    ctx.fillStyle = `rgba(255,40,55,${a * 0.7 * strobe})`;
    ctx.fillRect(0, 0, W, 6); ctx.fillRect(0, H - 50, W, 6);
    if (p) {
      // converging alarm laser flare around the trip point
      A.glow(ctx, p.x, p.y - 22, 60 * a, `rgba(255,60,70,${a * 0.5})`);
      for (let i = 0; i < 16; i++) {
        const ang = (i / 16) * 7 + t / 400;
        const r = 20 + env * 46 + Math.sin(t / 60 + i) * 6;
        ctx.strokeStyle = `rgba(255,${70 + (i % 2) * 100},80,${a})`; ctx.lineWidth = i % 2 ? 2.5 : 1.4;
        ctx.beginPath(); ctx.moveTo(p.x, p.y - 22); ctx.lineTo(p.x + Math.cos(ang) * r, p.y - 22 + Math.sin(ang) * r * 0.85); ctx.stroke();
      }
      // sparks scattering from the trip
      if (!A.reduced) for (let i = 0; i < 22; i++) {
        const ang = (i * 2.39 + t / 120);
        const r = (12 + (i % 4) * 10) * (0.4 + env);
        const sx = p.x + Math.cos(ang) * r, sy = p.y - 22 + Math.sin(ang) * r - env * 8;
        ctx.fillStyle = i % 3 === 0 ? "#fff" : i % 3 === 1 ? "#ffd27a" : "#ff5d6c";
        ctx.fillRect(sx, sy, 2.4, 2.4);
      }
      // TRIPPED stamp with a slab plate so it reads on any background
      const stamp = "TRIPPED";
      ctx.font = `700 30px ui-monospace,"DejaVu Sans Mono",monospace`;
      const tw = ctx.measureText(stamp).width;
      const sx = A.clamp(p.x, tw / 2 + 30, W - tw / 2 - 30), sy = A.clamp(p.y - 70, 130, H - 120);
      ctx.fillStyle = `rgba(40,4,8,${0.55 + 0.3 * a})`; A.rrect(ctx, sx - tw / 2 - 16, sy - 28, tw + 32, 42, 7); ctx.fill();
      ctx.strokeStyle = `rgba(255,60,75,${0.6 + 0.4 * strobe})`; ctx.lineWidth = 2; A.rrect(ctx, sx - tw / 2 - 16, sy - 28, tw + 32, 42, 7); ctx.stroke();
      A.glow(ctx, sx, sy - 6, 70, `rgba(255,50,60,${a * 0.4})`);
      A.label(ctx, sx, sy, stamp, 30, "#ff3b53", "center", "ui-monospace,monospace");
      A.label(ctx, sx, sy + 16, "LASER TRIPPED · ALARM", 9, "#ffb0b8", "center");
    }
  }
  function finishOverlay(ctx, res, t) {
    const trip = res.winReason === "trip" || res.winReason === "doubletrip";
    // a trip-ending match keeps the red alarm wash so the loss reads cinematic
    if (trip) {
      const strobe = 0.5 + 0.5 * Math.sin(t / 90);
      ctx.fillStyle = `rgba(40,6,10,0.5)`; ctx.fillRect(0, 0, W, H);
      const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.85);
      vg.addColorStop(0, "rgba(255,30,45,0)"); vg.addColorStop(1, `rgba(255,30,45,${0.28 + 0.12 * strobe})`);
      ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = `rgba(255,40,55,${0.5 * strobe})`; ctx.fillRect(0, 0, W, 6); ctx.fillRect(0, H - 50, W, 6);
    } else {
      ctx.fillStyle = "rgba(3,6,12,.58)"; ctx.fillRect(0, 0, W, H);
    }
    const draw = res.winner == null;
    const col = draw ? (trip ? "#ff5d6c" : "#9aa2b6") : res.winner === "A" ? "#34d399" : "#a855f7";
    A.glow(ctx, W / 2, H / 2 - 14, 230,
      (draw ? (trip ? "rgba(255,60,75," : "rgba(154,162,182,") : res.winner === "A" ? "rgba(52,211,153," : "rgba(168,85,247,") + "0.18)");
    const loser = res.winner === "A" ? "B" : "A";
    const title = draw ? (res.winReason === "doubletrip" ? "DOUBLE TRIP" : "DRAW")
      : res.winReason === "breach" ? "BREACHED"
      : res.winReason === "trip" ? "TRIPPED" : "TIME UP";
    const sub = draw ? (res.winReason === "doubletrip" ? "Both tripped a beam" : "Dead even in the corridor")
      : res.winReason === "breach" ? res.names[res.winner] + " reaches the exit door first"
      : res.winReason === "trip" ? res.names[loser] + " tripped — " + res.names[res.winner] + " walks it clean"
      : res.names[res.winner] + " was deepest in the corridor";
    const titleCol = res.winReason === "trip" ? "#ff3b53" : col;
    A.label(ctx, W / 2, H / 2 - 16, title, draw ? 40 : 36, titleCol, "center", "ui-monospace,monospace");
    A.label(ctx, W / 2, H / 2 + 18, sub, 15, "#e9ecf5", "center");
    // winner confetti (breach/closer); trip-loss gets red alarm sparks instead.
    if (!draw && !A.reduced && !trip) for (let i = 0; i < 44; i++) {
      const a = (i / 44) * 7 + t / 600; const r = 64 + (i % 5) * 26 + Math.sin(t / 300 + i) * 10;
      ctx.fillStyle = i % 2 ? col : "#fff";
      ctx.fillRect(W / 2 + Math.cos(a) * r, H / 2 - 14 + Math.sin(a) * r * 0.6, 3, 3);
    }
    if (trip && !A.reduced) for (let i = 0; i < 36; i++) {
      const a = (i * 2.39) + t / 400; const r = 70 + (i % 6) * 22 + Math.sin(t / 200 + i) * 8;
      ctx.fillStyle = i % 3 === 0 ? "#fff" : i % 3 === 1 ? "#ffd27a" : "#ff5d6c";
      ctx.fillRect(W / 2 + Math.cos(a) * r, H / 2 - 14 + Math.sin(a) * r * 0.55, 3, 3);
    }
  }
  function vignette(ctx) {
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.82);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  window.LASERTANGO = {
    id: "lasertango", name: "Laser Tango", W, H,
    tag: "Two infiltrators cross a Mission-Impossible laser corridor by timing moves to a beat. Wait for clean gaps or slide under the sweeping beams — step into a lit laser and you're TRIPPED. First to breach the exit door wins.",
    champions: [{ id: "A", name: "Tempo", color: "#10b981" }, { id: "B", name: "Blitz", color: "#8b5cf6" }],
    prompts: { A: DEF_A, B: DEF_B },
    mcp: {
      kickoff: "You are an infiltrator crossing a refereed laser corridor, played entirely through your tools. Each turn: get_state to read the beat and whether the beam ahead is LIT, legal_moves for your options, then make_move with the current ply. Step into a lit beam and you TRIP out. Reach the exit door first to win.",
      tools: [
        { name: "get_state", args: "", ret: "{seg, beat, beam_ahead, to_door}", desc: "Read the corridor: your segment, the current beat, whether the beam ahead is LIT or DARK, distance to the door." },
        { name: "legal_moves", args: "", ret: "[move, …], ply", desc: "Your options from here: advance through the gap, wait out the sweep, or slide under two segments." },
        { name: "make_move", args: "move, expected_ply", desc: "Commit a move on this beat. Advancing into a lit beam — or slipping a slide — trips the lasers.", ret: "new state | error" },
        { name: "resign", args: "", ret: "forfeit", desc: "Abort the crossing." },
      ],
      vocab: "advance:gap · wait:beat · slide:under",
    },
    build, draw,
  };
})();
