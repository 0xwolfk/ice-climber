// AUTOCLIMB — an original vertical climbing game, inspired by 1985-era climbing
// arcade games. All code, art and audio are generated here; no external assets.
//
// Three climbers share one mountain:
//   RUSHER   — aggressive AI: attacks readily, barely hesitates before jumping.
//   SENTINEL — cautious AI: predicts threats further ahead, prefers to wait.
//   YOU      — human-controlled. Idle too long and RUSHER or SENTINEL (whichever
//              is closer) carries you in a basket until you press a key again.

(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const hudEl = document.querySelector('.hud');
  const footEl = document.querySelector('.foot');

  // Render at the real screen resolution (device-pixel-ratio aware) instead of
  // a small fixed buffer stretched via CSS — stretching a tiny canvas both
  // distorts the aspect ratio and blurs everything, text included. W/H below
  // are CSS-pixel logical coordinates, floored at 1280x720 so the game world
  // never gets cramped on a small window (the canvas just downscales to fit,
  // which stays sharp — it's upscaling that causes blur); on anything bigger
  // it renders at the device's real resolution. The backing buffer is DPR
  // times bigger and ctx is pre-scaled, so every draw call below uses W/H as-is.
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.max(1280, window.innerWidth);
  const H = Math.max(720, window.innerHeight);
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.scale(DPR, DPR);

  // A resize changes almost every derived constant below (row layout, physics
  // scale, HUD clearance) — reloading is the simplest way to keep all of it
  // consistent rather than trying to rescale live state in place.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => location.reload(), 300);
  });

  const speedBtn = document.getElementById('speed-btn');
  const hud = {
    p1s: document.getElementById('p1-summits'), p1f: document.getElementById('p1-falls'),
    p2s: document.getElementById('p2-summits'), p2f: document.getElementById('p2-falls'),
    p3s: document.getElementById('p3-summits'), p3f: document.getElementById('p3-falls'),
    p3live: document.getElementById('p3-live'),
  };

  // ---- scale ---------------------------------------------------------------
  // Every spatial/velocity constant below was tuned and playtested against a
  // 420px-tall reference viewport. K uniformly rescales all of them (distance
  // AND velocity AND acceleration together) so jump arcs, row spacing and
  // timing feel identical on any real screen size — nothing here is stretched,
  // the world itself is just bigger or smaller.
  const K = H / 420;
  const ROW_H = 56 * K;
  const PLATFORM_T = 8 * K;
  const CEIL_T = 8 * K;
  const PLAYER_W = 21 * K, PLAYER_H = 27 * K; // 1.5x the original sprite, at this screen's scale
  const GRAVITY = 900 * K;
  const JUMP_VY = -340 * K;
  const MOVE_SPEED = 140 * K;
  const AIR_MOVE_SPEED = 122 * K;
  const MELEE_RANGE = 20 * K;
  const THREAT_RADIUS = 78 * K;
  const PAD = 20 * K; // edge margin for enemies/holes — players wrap instead of clamping
  const STUN_TIME = 0.5;
  const INVULN_TIME = 0.9;
  const BONUS_TIME = 6.5;
  const SUMMIT_BANNER_TIME = 1.4;
  const MAX_ROUND_TIME = 45;
  const PRESSURE_DELAY = 20;
  const PRESSURE_SPEED = 16 * K;
  const IDLE_TIMEOUT_MS = 11000;
  const INTERACT_RANGE = 30 * K;
  const MAX_AVOID_TIME = 1.4; // patience cutoff — force a jump rather than dodge forever

  // row count adapts to whatever vertical room is actually left after the
  // HUD/footer overlays and the summit's bonus-platform zone (measured live,
  // not guessed, so it stays correct if the overlay text/size ever changes)
  const HUD_CLEARANCE = (hudEl ? hudEl.offsetHeight : 50 * K) + 10 * K;
  const FOOTER_CLEARANCE = (footEl ? footEl.offsetHeight : 30 * K) + 10 * K;
  const BONUS_ZONE = 82 * K; // headroom above the summit row for the condor bonus stage
  const TOP_ROW = Math.max(3, Math.floor((H - HUD_CLEARANCE - FOOTER_CLEARANCE - BONUS_ZONE) / ROW_H));
  const START_Y = H - FOOTER_CLEARANCE;

  const SPEED_STEPS = [1, 2, 4, 8, 16];
  let speedIndex = 0;

  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);

  const C = {
    sky1: '#0b1024', sky2: '#232b5c', sky3: '#171c40',
    starFar: '#4a5590', starNear: '#c8d2f5',
    ledge: '#dfe9ff', ledgeShade: '#a9b8e6', ledgeEdge: '#6f82c2', holeEdge: '#0b1024',
    ceil: '#7fd7ff', ceilCrack: '#2c6f8f', ceilShade: '#4fa8d6',
    topi: '#7bffc4', topiDark: '#1f7a56', enemyEye: '#0b1024',
    nit: '#ffb37b', nitDark: '#a5581f',
    veg: '#ffd166', vegLeaf: '#7bffc4',
    condor: '#eef3ff', condorAccent: '#ffd166',
    bear: '#f4f7ff', bearShade: '#c3cdea',
    basket: '#b98a4b', basketDark: '#7a5a2f',
    dim: '#8fa0c9', ink: '#eef3ff'
  };

  const PERSONALITIES = {
    // predictSeconds: how far ahead each personality projects enemy movement
    // before deciding to dodge — short = reactive/instinctive, long = anticipates
    // the patrol swing like a chess player reading an opponent's next move.
    NAYKILLA: { attackChance: 0.82, dangerDist: 24 * K, holeMargin: 8 * K,  jumpHesitation: 0.05, predictSeconds: 0.18, impatience: 0.05 },
    USHER:    { attackChance: 0.18, dangerDist: 40 * K, holeMargin: 20 * K, jumpHesitation: 0.35, predictSeconds: 0.85, impatience: 0.01 },
  };

  const COLORS = {
    NAYKILLA: { body: '#ff6bcb', dark: '#a83f8a', accent: '#ffe66d', skin: '#ffd8b0', accessory: 'spike' },
    USHER:    { body: '#4d8dff', dark: '#1f4fb8', accent: '#eef3ff', skin: '#ffd8b0', accessory: 'visor' },
    ADAM:     { body: '#c8ff6b', dark: '#7fae2f', accent: '#ffe66d', skin: '#ffd8b0', accessory: 'cap' },
  };

  // ---- cel animation ---------------------------------------------------------
  // NES-style animation: a small fixed set of frames, each held for its own
  // duration (not smoothly interpolated), driven by a per-entity countdown
  // timer. Variable hold time — not frame count — is what gives poses weight.
  const CELS = {
    idle: [0.45, 0.45],
    walk: [0.09, 0.09],
    attack: [0.05, 0.11],
    topi: [0.16, 0.16],
    nit: [0.08, 0.08],
    condor: [0.26, 0.34],
    bear: [0.55, 0.55],
  };
  function tickCel(a, table, dt) {
    a.t -= dt;
    if (a.t <= 0) { a.f = (a.f + 1) % table.length; a.t = table[a.f]; }
    return a.f;
  }
  function setCelMode(a, table) {
    if (a.mode !== table) { a.mode = table; a.f = 0; a.t = table[0]; }
  }

  // ---- audio (procedural, no assets) --------------------------------------
  const SFX = (() => {
    let actx = null;
    function ensure() {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      return actx;
    }
    function beep(freq, dur, type, vol, slideTo) {
      try {
        const c = ensure();
        const osc = c.createOscillator(), gain = c.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, c.currentTime);
        if (slideTo) osc.frequency.linearRampToValueAtTime(slideTo, c.currentTime + dur);
        gain.gain.setValueAtTime(vol, c.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
        osc.connect(gain); gain.connect(c.destination);
        osc.start(); osc.stop(c.currentTime + dur);
      } catch (e) { /* audio unavailable, ignore */ }
    }
    return {
      unlock: ensure,
      jump: () => beep(520, 0.05, 'square', 0.035),
      breakBlock: (hpLeft) => beep(hpLeft > 0 ? 260 : 200, 0.09, 'square', 0.05, hpLeft > 0 ? 200 : 120),
      hit: () => beep(150, 0.13, 'sawtooth', 0.05, 380),
      knock: () => beep(90, 0.15, 'sawtooth', 0.05, 50),
      veg: () => { beep(660, 0.05, 'square', 0.035); setTimeout(() => beep(880, 0.06, 'square', 0.035), 55); },
      bear: () => beep(70, 0.6, 'sawtooth', 0.06, 40),
      summit: (first) => {
        beep(523, 0.08, 'square', 0.045);
        setTimeout(() => beep(659, 0.08, 'square', 0.045), 90);
        setTimeout(() => beep(first ? 988 : 784, 0.14, 'square', 0.05), 180);
      },
    };
  })();

  // ---- input ---------------------------------------------------------------
  const keys = { left: false, right: false, up: false, attack: false };
  let lastHumanInput = -Infinity; // no input yet — start carried, not "just active"
  let interactQueued = false; // edge-triggered: E hops in/out of a basket, not held

  const KEYMAP = {
    ArrowLeft: 'left', a: 'left', A: 'left',
    ArrowRight: 'right', d: 'right', D: 'right',
    ArrowUp: 'up', w: 'up', W: 'up', ' ': 'up',
    x: 'attack', X: 'attack',
    e: 'interact', E: 'interact',
  };

  window.addEventListener('keydown', (e) => {
    const k = KEYMAP[e.key];
    if (!k) return;
    e.preventDefault();
    if (k === 'interact') {
      if (!e.repeat) interactQueued = true; // explicit toggle only — doesn't count as "moving"
    } else {
      keys[k] = true;
      lastHumanInput = performance.now();
    }
    SFX.unlock();
  });
  window.addEventListener('keyup', (e) => {
    const k = KEYMAP[e.key];
    if (!k || k === 'interact') return;
    e.preventDefault();
    keys[k] = false;
  });

  // mouse-driven parallax on the starfield only — hard pixel steps, no easing/blur,
  // so it reads as classic layered scrolling rather than a smooth modern effect.
  const parallax = { x: 0, y: 0 };
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width - 0.5;
    const ny = (e.clientY - rect.top) / rect.height - 0.5;
    parallax.x = Math.round(nx * 12);
    parallax.y = Math.round(ny * 8);
  });
  canvas.addEventListener('mouseleave', () => { parallax.x = 0; parallax.y = 0; });
  const wrap = (v, m) => ((v % m) + m) % m;
  // shortest signed distance from b to a around a wrapped track of length m —
  // used anywhere two x-positions are compared, so nothing breaks at the seam.
  const wrapDelta = (a, b, m) => { let d = wrap(a - b, m); if (d > m / 2) d -= m; return d; };

  // ---- world generation ------------------------------------------------------
  // difficulty ramps with every mountain cleared: wider/more/drifting holes,
  // tougher ice, more and faster enemies — "moving floorboards" appear from
  // difficulty 3 onward (a hole that slides back and forth instead of sitting still).
  function buildMountain(difficulty) {
    difficulty = difficulty || 0;
    const midRows = []; // climbable rows strictly between the start ledge and the summit
    for (let i = 1; i < TOP_ROW; i++) midRows.push(i);

    const holeChance = clamp(0.5 + difficulty * 0.025, 0.5, 0.85);
    const ceilingHp = 2 + (difficulty >= 4 ? 1 : 0) + (difficulty >= 9 ? 1 : 0);
    const driftChance = difficulty >= 3 ? clamp((difficulty - 2) * 0.08, 0, 0.5) : 0;

    const rows = [];
    for (let i = 0; i <= TOP_ROW; i++) {
      const y = START_Y - i * ROW_H;
      let hole = null;
      if (midRows.includes(i) && Math.random() < holeChance) {
        const w = clamp(rnd(40, 70) + difficulty * 1.5, 40, 100) * K;
        hole = { x: rnd(PAD, W - PAD - w), w };
        if (Math.random() < driftChance) {
          hole.drift = { speed: rnd(18, 34) * K, dir: Math.random() < 0.5 ? -1 : 1 };
        }
      }
      const ceilingAbove = i < TOP_ROW ? { hp: ceilingHp, maxHp: ceilingHp, alive: true } : null;
      rows.push({ y, hole, ceilingAbove });
    }

    const enemies = [];
    const topiCount = clamp(2 + Math.floor(difficulty / 3), 2, midRows.length);
    const topiRows = [...midRows].sort(() => Math.random() - 0.5).slice(0, topiCount);
    const speedScale = 1 + Math.min(0.55, difficulty * 0.04);
    for (const r of topiRows) {
      enemies.push({
        type: 'topi', row: r, x: rnd(PAD + 10, W - PAD - 10),
        dir: Math.random() < 0.5 ? -1 : 1, speed: rnd(34, 50) * speedScale * K,
        fillTimer: rnd(5, 9), alive: true, respawnTimer: 0,
        anim: { f: 0, t: CELS.topi[0] },
      });
    }
    const nitCount = difficulty >= 6 ? 2 : 1;
    const nitRowChoices = midRows.filter(r => r >= 2);
    for (let n = 0; n < nitCount; n++) {
      const nitBaseRow = nitRowChoices.length ? nitRowChoices[Math.floor(Math.random() * nitRowChoices.length)] : Math.min(2, TOP_ROW - 1);
      enemies.push({
        type: 'nitpicker', baseRow: nitBaseRow, x: rnd(PAD + 10, W - PAD - 10),
        y: rows[nitBaseRow].y - ROW_H * 0.5, phase: rnd(0, Math.PI * 2),
        dir: Math.random() < 0.5 ? -1 : 1, speed: rnd(40, 58) * speedScale * K,
        alive: true, respawnTimer: 0,
        anim: { f: 0, t: CELS.nit[0] },
      });
    }

    const topY = rows[TOP_ROW].y;
    const platW1 = 34 * K, platW2 = 30 * K;
    const bonusPlatforms = [
      { x: rnd(PAD, W - PAD - platW1), y: topY - 26 * K, w: platW1, dir: Math.random() < 0.5 ? -1 : 1, speed: rnd(28, 40) * K },
      { x: rnd(PAD, W - PAD - platW2), y: topY - 52 * K, w: platW2, dir: Math.random() < 0.5 ? -1 : 1, speed: rnd(28, 40) * K },
    ];
    const condor = { x: W / 2, y: topY - BONUS_ZONE };

    return { rows, enemies, bonusPlatforms, condor };
  }

  function resetPlayerToStart(p, xOffset) {
    p.x = clamp(W / 2 + xOffset, PAD, W - PAD);
    p.y = START_Y - PLAYER_H;
    p.vx = 0; p.vy = 0;
    p.grounded = true; p.groundedRow = 0; p.groundedPlat = null;
    p.facing = 1;
    p.stun = 0; p.invuln = 0; p.attackTimer = 0; p.safeTimer = 0; p.avoidTimer = 0;
    p.bonusPhase = false; p.bonusStage = 0; p.bonusTimeLeft = BONUS_TIME;
    p.doneThisRound = false;
    p.airTargetX = p.x;
    if (!p.anim) p.anim = { mode: CELS.idle, f: 0, t: CELS.idle[0] };
  }

  function makePlayer(id, name, personality, human) {
    return {
      id, name, personality, human: !!human,
      colors: COLORS[name],
      carried: false, carrierId: null,
      summits: 0, falls: 0, score: 0,
      animT: 0,
    };
  }

  function newGame() {
    const mountain = buildMountain();
    const p1 = makePlayer(0, 'NAYKILLA', PERSONALITIES.NAYKILLA, false);
    const p2 = makePlayer(1, 'USHER', PERSONALITIES.USHER, false);
    const p3 = makePlayer(2, 'ADAM', null, true);
    resetPlayerToStart(p1, -22);
    resetPlayerToStart(p2, 22);
    resetPlayerToStart(p3, 0);
    p3.carried = true;
    p3.carrierId = p1.id;

    return {
      rows: mountain.rows, enemies: mountain.enemies,
      bonusPlatforms: mountain.bonusPlatforms, condor: mountain.condor,
      condorClaimedBy: null,
      veggies: [], vegTimer: rnd(3, 5),
      particles: [], popups: [], speech: [],
      players: [p1, p2, p3],
      roundComplete: false, bannerTimer: 0, roundTime: 0,
      pressureY: H + 40, bearActive: false,
      clock: 0, hitStop: 0, roundIndex: 0,
      condorAnim: { f: 0, t: CELS.condor[0] }, bearAnim: { f: 0, t: CELS.bear[0] },
    };
  }

  function regenerateMountain(state) {
    state.roundIndex += 1;
    const mountain = buildMountain(state.roundIndex);
    state.rows = mountain.rows;
    state.enemies = mountain.enemies;
    state.bonusPlatforms = mountain.bonusPlatforms;
    state.condor = mountain.condor;
    state.condorClaimedBy = null;
    state.veggies = [];
    state.roundTime = 0;
    state.pressureY = H + 40;
    state.bearActive = false;

    const [p1, p2, p3] = state.players;
    resetPlayerToStart(p1, -22);
    resetPlayerToStart(p2, 22);
    if (!p3.carried) resetPlayerToStart(p3, 0);
    else p3.doneThisRound = false;
  }

  // ---- perception -----------------------------------------------------------
  // forward-simulate a bouncing patrol (topi or nitpicker) over `t` seconds —
  // this is what lets USHER dodge where a threat is *heading*, not just where
  // it stands right now.
  function predictBounceX(x, dir, speed, t, lo, hi, row) {
    const steps = 6, sdt = t / steps;
    for (let i = 0; i < steps; i++) {
      x += dir * speed * sdt;
      if (row && row.hole && x > row.hole.x - 8 && x < row.hole.x + row.hole.w + 8) {
        x = x < row.hole.x + row.hole.w / 2 ? row.hole.x - 8 : row.hole.x + row.hole.w + 8;
        dir *= -1;
      }
      if (x < lo) { x = lo; dir = 1; }
      if (x > hi) { x = hi; dir = -1; }
    }
    return x;
  }

  function gatherThreats(state, p, predictT) {
    predictT = predictT || 0;
    const threats = [];
    for (const e of state.enemies) {
      if (!e.alive) continue;
      let ex, ey;
      if (e.type === 'topi') {
        if (e.row !== p.groundedRow) continue;
        const row = state.rows[e.row];
        ex = predictT > 0 ? predictBounceX(e.x, e.dir, e.speed, predictT, PAD + 8, W - PAD - 8, row) : e.x;
        ey = row.y - 8 * K;
      } else {
        ex = predictT > 0 ? predictBounceX(e.x, e.dir, e.speed, predictT, PAD + 8, W - PAD - 8, null) : e.x;
        if (predictT > 0) {
          const centerY = state.rows[e.baseRow].y - ROW_H * 0.5;
          ey = centerY + Math.sin(e.phase + 1.6 * predictT) * ROW_H * 0.6;
        } else ey = e.y;
      }
      const d = Math.hypot(wrapDelta(ex, p.x, W), ey - (p.y + PLAYER_H / 2));
      if (d < THREAT_RADIUS) threats.push({ e, d, x: ex, y: ey });
    }
    return threats;
  }

  function humanInput(state, p) {
    if (!p.grounded) return { left: keys.left, right: keys.right, jump: false, attack: false };
    if (keys.attack) {
      const threats = gatherThreats(state, p).sort((a, b) => a.d - b.d);
      if (threats[0] && threats[0].d < MELEE_RANGE) {
        return { left: false, right: false, jump: false, attack: true, attackTarget: threats[0].e };
      }
    }
    return { left: keys.left, right: keys.right, jump: keys.up, attack: false };
  }

  function decideBonus(state, p) {
    const target = p.bonusStage >= 2 ? state.condor : state.bonusPlatforms[p.bonusStage];
    if (p.human) return { left: keys.left, right: keys.right, jump: keys.up, attack: false };
    if (!p.grounded) {
      const dx = target.x - p.x;
      return { left: dx < -3, right: dx > 3, jump: false, attack: false };
    }
    const cx = target.x + (target.w || 0) / 2 * (p.bonusStage >= 2 ? 0 : 1);
    const dx = cx - p.x;
    const input = { left: dx < -4, right: dx > 4, jump: false, attack: false };
    if (Math.abs(dx) < 10) input.jump = true;
    return input;
  }

  function decide(state, p, dt) {
    if (p.human) {
      if (p.bonusPhase) return decideBonus(state, p);
      return humanInput(state, p);
    }
    if (p.bonusPhase) return decideBonus(state, p);
    if (p.doneThisRound || p.stun > 0) return { left: false, right: false, jump: false, attack: false };
    if (!p.grounded) {
      const dx = wrapDelta(p.airTargetX, p.x, W);
      return { left: dx < -3, right: dx > 3, jump: false, attack: false };
    }

    const perc = p.personality;
    // melee decision uses real current positions — you swing at what's actually there
    const nowThreats = gatherThreats(state, p).sort((a, b) => a.d - b.d);
    const nearest = nowThreats[0];
    if (nearest && nearest.d < MELEE_RANGE && Math.random() < perc.attackChance) {
      return { left: false, right: false, jump: false, attack: true, attackTarget: nearest.e };
    }
    // avoidance uses projected positions — react to where the threat is heading
    const threats = gatherThreats(state, p, perc.predictSeconds);
    const danger = threats.filter(t => t.d < perc.dangerDist);
    if (danger.length) {
      p.avoidTimer += dt;
      // a little unpredictability: sometimes patience runs out early rather
      // than always dodging on a perfectly consistent, robotic timer
      if (p.avoidTimer < MAX_AVOID_TIME && Math.random() > perc.impatience) {
        let push = 0;
        for (const t of danger) push += wrapDelta(p.x, t.x, W) / Math.max(8, t.d);
        const dir = push === 0 ? (Math.random() < 0.5 ? -1 : 1) : sign(push);
        return { left: dir < 0, right: dir > 0, jump: false, attack: false };
      }
      // patience exhausted — stop dodging and just go, rather than get stuck forever
    } else {
      p.avoidTimer = 0;
    }

    const row = state.rows[p.groundedRow];
    if (row.hole) {
      const hc = row.hole.x + row.hole.w / 2;
      const margin = perc.holeMargin + row.hole.w / 2;
      const hdx = wrapDelta(p.x, hc, W);
      if (Math.abs(hdx) < margin) {
        const dir = hdx < 0 ? -1 : 1;
        return { left: dir < 0, right: dir > 0, jump: false, attack: false };
      }
    }

    for (const other of state.players) {
      if (other === p || other.carried) continue;
      const odx = wrapDelta(other.x, p.x, W);
      if (other.groundedRow === p.groundedRow && other.grounded && Math.abs(odx) < 14) {
        const dir = odx > 0 ? -1 : 1;
        return { left: dir < 0, right: dir > 0, jump: false, attack: false };
      }
    }

    p.safeTimer += dt;
    if (p.safeTimer > perc.jumpHesitation) {
      p.safeTimer = 0;
      p.airTargetX = p.x;
      return { left: false, right: false, jump: true, attack: false };
    }
    return { left: false, right: false, jump: false, attack: false };
  }

  // ---- dialogue ---------------------------------------------------------------
  const DIALOGUE = {
    summit: ['MADE IT!', 'TOP OF THE WORLD!', 'YES!!', 'SUMMIT SECURED.', 'TOO EASY.', 'WHO\'S NEXT?'],
    encourage: ['NICE ONE!', 'GO GO GO!', 'SHOW OFF.', 'MY TURN NEXT!', 'GG!', 'GUESS I\'M SLOW...'],
    fall: ['OH SHOOT!', 'OUCH!', 'NOT AGAIN...', 'WHOA!', 'OOF.', 'RUDE.'],
  };
  function say(state, p, pool) {
    if (state.speech.some(s => s.ownerId === p.id && s.life > 0)) return; // one bubble at a time
    const lines = DIALOGUE[pool];
    const text = lines[Math.floor(Math.random() * lines.length)];
    state.speech.push({ x: p.x, y: p.y, text, life: 2.2, color: p.colors.body, ownerId: p.id });
  }
  function sayEncourage(state, aboutId) {
    const other = state.players.find(pl => pl.id !== aboutId && !pl.carried && !pl.doneThisRound);
    if (other) say(state, other, 'encourage');
  }

  // ---- combat ----------------------------------------------------------------
  function defeatEnemy(state, enemy, attacker) {
    enemy.alive = false;
    enemy.respawnTimer = rnd(4, 7);
    attacker.score += 40;
    spawnParticles(state, enemy.x, enemy.y || state.rows[enemy.row].y - 8, C.topi);
    SFX.hit();
    state.hitStop = Math.max(state.hitStop, 0.06);
  }

  function respawnEnemy(state, e) {
    if (e.type === 'topi') {
      e.row = 1 + Math.floor(Math.random() * (TOP_ROW - 1));
      e.x = rnd(PAD + 10, W - PAD - 10);
      e.dir = Math.random() < 0.5 ? -1 : 1;
      e.fillTimer = rnd(5, 9);
    } else {
      const lo = Math.min(2, TOP_ROW - 1);
      e.baseRow = lo + Math.floor(Math.random() * Math.max(1, TOP_ROW - lo));
      e.x = rnd(PAD + 10, W - PAD - 10);
      e.phase = rnd(0, Math.PI * 2);
    }
    e.alive = true;
  }

  function updateHoles(state, dt) {
    for (const row of state.rows) {
      const h = row.hole;
      if (!h || !h.drift) continue;
      h.x += h.drift.speed * h.drift.dir * dt;
      if (h.x < PAD) { h.x = PAD; h.drift.dir = 1; }
      if (h.x > W - PAD - h.w) { h.x = W - PAD - h.w; h.drift.dir = -1; }
    }
  }

  function updateEnemies(state, dt) {
    for (const e of state.enemies) {
      if (!e.alive) {
        e.respawnTimer -= dt;
        if (e.respawnTimer <= 0) respawnEnemy(state, e);
        continue;
      }
      if (e.type === 'topi') {
        tickCel(e.anim, CELS.topi, dt);
        const row = state.rows[e.row];
        e.x += e.dir * e.speed * dt;
        if (row.hole && e.x > row.hole.x - 8 && e.x < row.hole.x + row.hole.w + 8) {
          e.x = e.x < row.hole.x + row.hole.w / 2 ? row.hole.x - 8 : row.hole.x + row.hole.w + 8;
          e.dir *= -1;
        }
        if (e.x < PAD + 8) { e.x = PAD + 8; e.dir = 1; }
        if (e.x > W - PAD - 8) { e.x = W - PAD - 8; e.dir = -1; }
        e.fillTimer -= dt;
        if (e.fillTimer <= 0) {
          e.fillTimer = rnd(5, 9);
          if (row.hole && Math.abs(e.x - (row.hole.x + row.hole.w / 2)) < 34) {
            row.hole.w -= 18;
            row.hole.x += 9;
            if (row.hole.w < 10) row.hole = null;
            row.hole && (row.hole.x = clamp(row.hole.x, 12, W - 12 - row.hole.w));
          }
        }
      } else {
        tickCel(e.anim, CELS.nit, dt);
        e.x += e.dir * e.speed * dt;
        if (e.x < PAD + 8) { e.x = PAD + 8; e.dir = 1; }
        if (e.x > W - PAD - 8) { e.x = W - PAD - 8; e.dir = -1; }
        e.phase += dt * 1.6;
        const centerY = state.rows[e.baseRow].y - ROW_H * 0.5;
        e.y = centerY + Math.sin(e.phase) * ROW_H * 0.6;
      }
    }
  }

  // ---- player physics ----------------------------------------------------------
  function stepPlayer(state, p, dt) {
    if (p.doneThisRound) return;
    if (p.stun > 0) p.stun = Math.max(0, p.stun - dt);
    if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
    p.animT += dt;
    setCelMode(p.anim, p.attackTimer > 0 ? CELS.attack : (p.grounded && p.vx !== 0 ? CELS.walk : CELS.idle));
    tickCel(p.anim, p.anim.mode, dt);
    if (p.attackTimer > 0) { p.attackTimer = Math.max(0, p.attackTimer - dt); return; }

    const input = decide(state, p, dt);
    if (input.attack) {
      p.attackTimer = 0.15;
      defeatEnemy(state, input.attackTarget, p);
      return;
    }

    const moveSpeed = p.grounded ? MOVE_SPEED : AIR_MOVE_SPEED;
    p.vx = 0;
    if (p.stun <= 0) {
      if (input.left) { p.vx = -moveSpeed; p.facing = -1; }
      if (input.right) { p.vx = moveSpeed; p.facing = 1; }
      if (input.jump && p.grounded) {
        p.vy = JUMP_VY; p.grounded = false; SFX.jump();
      }
    }
    p.vy += GRAVITY * dt;
    if (p.bonusPhase) p.x = clamp(p.x + p.vx * dt, PAD, W - PAD); // small contained zone
    else p.x = wrap(p.x + p.vx * dt, W); // main field: walk off one edge, appear on the other

    const prevBottom = p.y + PLAYER_H;
    p.y += p.vy * dt;
    let bottom = p.y + PLAYER_H;
    let top = p.y;

    if (!p.bonusPhase) {
      if (p.grounded) {
        const row = state.rows[p.groundedRow];
        if (row.hole && p.x > row.hole.x && p.x < row.hole.x + row.hole.w) p.grounded = false;
      }
      if (p.vy < 0 && p.groundedRow < TOP_ROW) {
        const ceiling = state.rows[p.groundedRow].ceilingAbove;
        if (ceiling && ceiling.alive) {
          const bandTop = state.rows[p.groundedRow + 1].y;
          const bandBottom = bandTop + CEIL_T;
          if (top <= bandBottom && bottom >= bandTop) {
            ceiling.hp -= 1;
            SFX.breakBlock(ceiling.hp);
            if (ceiling.hp <= 0) {
              ceiling.alive = false; // broken through — keep rising, carried by this same jump
              spawnParticles(state, p.x, bandTop, C.ceil, 14); // big satisfying burst on the break
              spawnParticles(state, p.x, bandTop, C.ceilShade, 8);
            } else {
              spawnParticles(state, p.x, bandTop, C.ceil, 6);
              p.vy = 140; // still solid — bounce back for another attempt
              top = bandBottom - 0.1; p.y = top; bottom = p.y + PLAYER_H;
            }
          }
        }
      }
      let landedRow = false;
      if (p.vy >= 0) {
        for (let i = 0; i <= TOP_ROW; i++) {
          const row = state.rows[i];
          if (row.hole && p.x > row.hole.x && p.x < row.hole.x + row.hole.w) continue;
          if (prevBottom <= row.y && bottom >= row.y) {
            p.y = row.y - PLAYER_H; p.vy = 0; p.grounded = true; p.groundedRow = i;
            bottom = p.y + PLAYER_H;
            landedRow = true;
            if (i === TOP_ROW && !p.bonusPhase && !p.doneThisRound) {
              p.bonusPhase = true; p.bonusStage = 0; p.bonusTimeLeft = BONUS_TIME;
            }
            break;
          }
        }
      }
      if (p.vy < 0) p.grounded = false;
      if (p.vy > 0 && !landedRow) p.grounded = false; // safety: never stay "grounded" mid-fall

      if (p.invuln <= 0) {
        for (const e of state.enemies) {
          if (!e.alive) continue;
          let ex, ey;
          if (e.type === 'topi') {
            if (e.row !== p.groundedRow || !p.grounded) continue;
            ex = e.x; ey = state.rows[e.row].y - 8 * K;
          } else { ex = e.x; ey = e.y; }
          const ddx = wrapDelta(p.x, ex, W);
          const dx = Math.abs(ddx), dy = Math.abs((p.y + PLAYER_H / 2) - ey);
          if (dx < 15 * K && dy < 15 * K) {
            p.stun = STUN_TIME; p.invuln = INVULN_TIME;
            p.vy = 220; p.vx = (ddx < 0 ? -1 : 1) * 70; p.grounded = false;
            p.falls++;
            spawnParticles(state, p.x, p.y, p.colors.body);
            SFX.knock();
            state.hitStop = Math.max(state.hitStop, 0.08);
            say(state, p, 'fall');
            break;
          }
        }
      }
    } else {
      let landed = false;
      if (p.vy >= 0) {
        for (let k = 0; k < state.bonusPlatforms.length; k++) {
          const plat = state.bonusPlatforms[k];
          if (p.x > plat.x && p.x < plat.x + plat.w && prevBottom <= plat.y && bottom >= plat.y) {
            p.y = plat.y - PLAYER_H; p.vy = 0; p.grounded = true; p.groundedPlat = k;
            p.x = clamp(p.x + plat.dir * plat.speed * dt, PAD, W - PAD);
            if (p.bonusStage === k) p.bonusStage = k + 1;
            landed = true; break;
          }
        }
        if (!landed) {
          const topRowY = state.rows[TOP_ROW].y;
          if (prevBottom <= topRowY && bottom >= topRowY) {
            p.y = topRowY - PLAYER_H; p.vy = 0; p.grounded = true; p.groundedPlat = null;
            landed = true;
          }
        }
      }
      if (p.vy < 0) p.grounded = false;
      if (p.vy > 0 && !landed) p.grounded = false; // safety: never stay "grounded" mid-fall

      const cdx = Math.abs(p.x - state.condor.x), cdy = Math.abs((p.y + PLAYER_H / 2) - state.condor.y);
      if (cdx < 18 * K && cdy < 18 * K && !p.doneThisRound) {
        p.doneThisRound = true;
        const first = state.condorClaimedBy === null;
        if (first) state.condorClaimedBy = p.id;
        const timeFrac = clamp(p.bonusTimeLeft / BONUS_TIME, 0, 1);
        const bonus = Math.round((first ? 220 : 90) * (0.5 + 0.5 * timeFrac));
        p.score += bonus; p.summits++;
        spawnParticles(state, p.x, p.y, C.condorAccent);
        state.popups.push({ x: p.x, y: p.y - 10, text: '+' + bonus, life: 1.1, color: first ? C.condorAccent : C.condor });
        SFX.summit(first);
        say(state, p, 'summit');
        sayEncourage(state, p.id);
      }
      p.bonusTimeLeft -= dt;
      if (p.bonusTimeLeft <= 0 && !p.doneThisRound) {
        p.doneThisRound = true; p.summits++;
        state.popups.push({ x: p.x, y: p.y - 10, text: 'time up', life: 1.0, color: C.dim });
      }
    }
  }

  // ---- world tick -------------------------------------------------------------
  function stepPhysics(state, dt) {
    state.clock += dt; // sim-time clock driving all cel animation — scales correctly with speed
    tickCel(state.condorAnim, CELS.condor, dt);
    tickCel(state.bearAnim, CELS.bear, dt);

    if (state.hitStop > 0) { state.hitStop -= dt; return; } // brief freeze-frame on impacts

    if (state.roundComplete) {
      state.bannerTimer -= dt;
      if (state.bannerTimer <= 0) { regenerateMountain(state); state.roundComplete = false; }
      return;
    }
    state.roundTime += dt;

    const p3 = state.players[2];

    const hopOut = () => {
      const carrier = state.players.find(pl => pl.id === p3.carrierId) || state.players[0];
      p3.carried = false;
      p3.x = carrier.x; p3.y = carrier.y; p3.vx = 0; p3.vy = 0;
      p3.grounded = carrier.grounded; p3.groundedRow = carrier.groundedRow;
      p3.bonusPhase = carrier.bonusPhase; p3.bonusStage = carrier.bonusStage || 0;
      p3.bonusTimeLeft = BONUS_TIME; p3.doneThisRound = false; p3.invuln = INVULN_TIME;
    };
    const nearestCompanion = () => {
      let nearest = null, bestD = Infinity;
      for (const pl of state.players) {
        if (pl === p3 || pl.human) continue;
        const d = Math.abs(pl.x - p3.x) + Math.abs(pl.y - p3.y);
        if (d < bestD) { bestD = d; nearest = pl; }
      }
      return { nearest, bestD };
    };

    // E: explicit toggle — hop out on demand, or hop in early when standing near a
    // companion. Each direction also resets the activity clock to match what was
    // just chosen, so the automatic rule below (which runs right after) agrees
    // with the explicit choice instead of immediately reversing it.
    if (interactQueued) {
      interactQueued = false;
      if (p3.carried) {
        hopOut();
        lastHumanInput = performance.now(); // just chose to play — fresh grace window
      } else {
        const { nearest, bestD } = nearestCompanion();
        if (nearest && bestD < INTERACT_RANGE) {
          p3.carried = true; p3.carrierId = nearest.id;
          lastHumanInput = -Infinity; // just chose to rest — don't immediately reclaim control
        }
      }
    }

    // automatic: moving/attacking hops you out; going quiet for IDLE_TIMEOUT_MS gets you carried
    const humanActive = (performance.now() - lastHumanInput) < IDLE_TIMEOUT_MS;
    if (p3.carried && humanActive) {
      hopOut();
    } else if (!p3.carried && !humanActive) {
      const { nearest } = nearestCompanion();
      p3.carried = true; p3.carrierId = (nearest || state.players[0]).id;
    }

    if (!state.bearActive && state.roundTime > PRESSURE_DELAY) { state.bearActive = true; SFX.bear(); }
    if (state.bearActive) {
      state.pressureY -= PRESSURE_SPEED * dt;
      for (const p of state.players) {
        if (p.carried || p.doneThisRound || p.bonusPhase || p.invuln > 0) continue;
        if ((p.y + PLAYER_H) > state.pressureY) {
          p.falls++;
          say(state, p, 'fall');
          let target = 0;
          for (let i = 0; i <= TOP_ROW; i++) if (state.rows[i].y <= state.pressureY) target = i;
          p.groundedRow = target;
          p.y = state.rows[target].y - PLAYER_H; p.vx = 0; p.vy = 0; p.grounded = true;
          p.invuln = INVULN_TIME; p.stun = 0.2;
          spawnParticles(state, p.x, p.y, C.bear);
        }
      }
    }

    updateHoles(state, dt);
    updateEnemies(state, dt);

    for (const p of state.players) {
      if (p.carried) {
        const carrier = state.players.find(pl => pl.id === p.carrierId);
        if (carrier) {
          p.x = wrap(carrier.x + (carrier.facing > 0 ? -PLAYER_W * 0.5 : PLAYER_W * 0.5), W);
          p.y = carrier.y - PLAYER_H * 0.1;
          p.groundedRow = carrier.groundedRow;
          p.doneThisRound = carrier.doneThisRound;
          p.facing = carrier.facing;
        }
        continue;
      }
      stepPlayer(state, p, dt);
    }

    state.vegTimer -= dt;
    if (state.vegTimer <= 0) {
      state.vegTimer = rnd(3.5, 6);
      state.veggies.push({ x: rnd(20, W - 20), y: 20, vy: 42 });
    }
    for (let i = state.veggies.length - 1; i >= 0; i--) {
      const v = state.veggies[i];
      v.y += v.vy * dt;
      let caught = false;
      for (const p of state.players) {
        if (p.carried || p.doneThisRound) continue;
        if (Math.abs(wrapDelta(v.x, p.x, W)) < 15 * K && Math.abs(v.y - (p.y + PLAYER_H / 2)) < 16 * K) {
          p.score += 30; spawnParticles(state, v.x, v.y, C.veg); SFX.veg(); caught = true; break;
        }
      }
      if (caught) { state.veggies.splice(i, 1); continue; }
      if (v.y > H + 10) state.veggies.splice(i, 1);
    }

    for (let i = state.particles.length - 1; i >= 0; i--) {
      const pt = state.particles[i];
      pt.life -= dt; pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.vy += 400 * dt;
      if (pt.life <= 0) state.particles.splice(i, 1);
    }
    for (let i = state.popups.length - 1; i >= 0; i--) {
      const pop = state.popups[i];
      pop.life -= dt; pop.y -= 14 * dt;
      if (pop.life <= 0) state.popups.splice(i, 1);
    }
    for (let i = state.speech.length - 1; i >= 0; i--) {
      const s = state.speech[i];
      s.life -= dt;
      const owner = state.players.find(pl => pl.id === s.ownerId);
      if (owner) { s.x = owner.x; s.y = owner.y - PLAYER_H - 10; }
      if (s.life <= 0) state.speech.splice(i, 1);
    }

    const relevant = state.players.filter(p => !p.carried);
    if (relevant.length && relevant.every(p => p.doneThisRound)) {
      state.roundComplete = true; state.bannerTimer = SUMMIT_BANNER_TIME;
    } else if (state.roundTime > MAX_ROUND_TIME) {
      state.roundComplete = true; state.bannerTimer = SUMMIT_BANNER_TIME * 0.6;
    }
  }

  function spawnParticles(state, x, y, color, count) {
    for (let i = 0; i < (count || 6); i++) {
      state.particles.push({ x, y, vx: rnd(-90, 90), vy: rnd(-110, -20), life: rnd(0.25, 0.55), color });
    }
  }

  // dithered checkerboard fill — the NES had no alpha blending, so any
  // "translucent" effect on real hardware was faked with a pixel pattern.
  const ditherCache = {};
  function ditherPattern(color) {
    if (ditherCache[color]) return ditherCache[color];
    const tile = document.createElement('canvas');
    tile.width = 2; tile.height = 2;
    const tctx = tile.getContext('2d');
    tctx.fillStyle = color;
    tctx.fillRect(0, 0, 1, 1);
    tctx.fillRect(1, 1, 1, 1);
    return (ditherCache[color] = ctx.createPattern(tile, 'repeat'));
  }
  function drawDither(x, y, w, h, color) {
    if (h <= 0 || w <= 0) return;
    ctx.fillStyle = ditherPattern(color);
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  }

  // ---- rendering ----------------------------------------------------------------
  function draw(state) {
    // flat banded sky, not a smooth gradient — real NES hardware had no
    // interpolated blends, only flat tile colors (palette swapped per band).
    const bandH = H / 3;
    ctx.fillStyle = C.sky1; ctx.fillRect(0, 0, W, bandH);
    ctx.fillStyle = C.sky3; ctx.fillRect(0, bandH, W, bandH);
    ctx.fillStyle = C.sky2; ctx.fillRect(0, bandH * 2, W, H - bandH * 2);

    ctx.fillStyle = C.starFar;
    for (let i = 0; i < 16; i++) {
      const x = wrap(i * 61.3 - parallax.x * 0.4, W);
      const y = wrap(i * 97.1, H);
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
    ctx.fillStyle = C.starNear;
    for (let i = 0; i < 14; i++) {
      const x = wrap(i * 53.7 - parallax.x, W);
      const y = wrap(i * 91.3 - parallax.y * 0.6, H);
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    }

    const rows = state.rows;
    for (let i = 0; i < TOP_ROW; i++) {
      const ceiling = rows[i].ceilingAbove;
      const bandTop = rows[i + 1].y;
      if (ceiling && ceiling.alive) {
        // solid, breakable ice — a visible crack texture from the very first
        // frame marks it as "this can be broken", not just a plain wall
        ctx.fillStyle = C.ceil;
        ctx.fillRect(0, bandTop, W, CEIL_T);
        ctx.fillStyle = C.ceilShade;
        ctx.fillRect(0, bandTop + CEIL_T - 2, W, 2);
        ctx.fillStyle = C.ceilCrack;
        const hitsTaken = ceiling.maxHp - ceiling.hp;
        const slots = ceiling.maxHp + 1;
        for (let c = 0; c < slots; c++) {
          const cx = Math.round((c + 0.5) * (W / slots));
          const h = c < hitsTaken ? CEIL_T - 2 : CEIL_T - 5; // deeper cracks the more it's been hit
          ctx.fillRect(cx, bandTop + 1, 2, h);
        }
      } else {
        // broken through — leave visible shattered icicle stubs so the open
        // path reads as "cleared", not just empty space that was never there
        ctx.fillStyle = C.ceilShade;
        for (let c = 0; c < 5; c++) {
          const cx = Math.round((c + 0.5) * (W / 5));
          ctx.fillRect(cx - 1, bandTop, 2, 4);
        }
      }
    }

    for (let i = 0; i <= TOP_ROW; i++) {
      const row = rows[i], y = row.y;
      if (row.hole) {
        ctx.fillStyle = C.ledgeEdge; ctx.fillRect(0, y, row.hole.x, PLATFORM_T);
        ctx.fillStyle = C.ledge; ctx.fillRect(0, y, row.hole.x, PLATFORM_T - 3);
        ctx.fillStyle = C.ledgeEdge; ctx.fillRect(row.hole.x + row.hole.w, y, W - (row.hole.x + row.hole.w), PLATFORM_T);
        ctx.fillStyle = C.ledge; ctx.fillRect(row.hole.x + row.hole.w, y, W - (row.hole.x + row.hole.w), PLATFORM_T - 3);
        ctx.fillStyle = C.holeEdge; ctx.fillRect(row.hole.x, y, row.hole.w, PLATFORM_T);
      } else {
        ctx.fillStyle = C.ledgeEdge; ctx.fillRect(0, y, W, PLATFORM_T);
        ctx.fillStyle = C.ledge; ctx.fillRect(0, y, W, PLATFORM_T - 3);
      }
      ctx.fillStyle = C.ledgeShade;
      for (let x = 0; x < W; x += 16 * K) ctx.fillRect(x, y, 6 * K, 2 * K);
    }

    for (const plat of state.bonusPlatforms) {
      const px = Math.round(plat.x), py = Math.round(plat.y);
      ctx.fillStyle = C.ceil; ctx.fillRect(px, py, plat.w, 6);
      ctx.fillStyle = C.ceilShade; ctx.fillRect(px, py + 4, plat.w, 2);
    }
    drawCondor(state.condor.x, state.condor.y, state.condorAnim.f);

    for (const v of state.veggies) {
      const vx = Math.round(v.x), vy = Math.round(v.y);
      ctx.fillStyle = C.vegLeaf; ctx.fillRect(vx - 2 * K, vy - 6 * K, 4 * K, 3 * K);
      ctx.fillStyle = C.veg; ctx.fillRect(vx - 4 * K, vy - 3 * K, 8 * K, 7 * K);
    }

    for (const e of state.enemies) {
      if (!e.alive) continue;
      if (e.type === 'topi') drawTopi(e, rows[e.row].y);
      else drawNitpicker(e);
    }

    if (state.bearActive) {
      const lineY = Math.round(state.pressureY);
      drawDither(0, lineY, W, Math.max(0, H - lineY), C.bear);
      ctx.fillStyle = C.bearShade;
      ctx.fillRect(0, lineY - 2, W, 3);
      const sway = state.bearAnim.f === 0 ? -26 : 26; // stepped lumbering sway, no smooth sweep
      drawBear(W / 2 + sway, lineY - 10);
    }

    for (const p of state.players) {
      if (p.carried) continue;
      const rider = state.players[2];
      const carrying = rider.carried && rider.carrierId === p.id;
      if (carrying) drawBasketBack(p, rider);
      drawPlayer(p);
      if (carrying) { drawPlayer(rider); drawBasketFront(p, rider); }
    }

    // no alpha fades — NES sprites are on or off, never translucent. particles
    // just hard-cut when their life runs out; popups hard-flicker in their last beat.
    for (const pt of state.particles) {
      ctx.fillStyle = pt.color;
      ctx.fillRect(Math.round(pt.x), Math.round(pt.y), 2 * K, 2 * K);
    }
    for (const pop of state.popups) {
      if (pop.life < 0.3 && Math.floor(pop.life * 16) % 2 === 0) continue;
      ctx.fillStyle = pop.color;
      ctx.font = `${Math.round(11 * K)}px "Press Start 2P", monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(pop.text, Math.round(pop.x), Math.round(pop.y));
      ctx.textAlign = 'left';
    }
    for (const s of state.speech) {
      if (s.life < 0.35 && Math.floor(s.life * 16) % 2 === 0) continue; // flicker out, not fade
      ctx.font = `${Math.round(14 * K)}px "VT323", monospace`;
      const textW = ctx.measureText(s.text).width;
      const pad = 6 * K, boxH = 20 * K;
      const bx = Math.round(clamp(s.x - textW / 2 - pad, 2, W - textW - pad * 2));
      const by = Math.round(s.y - 16 * K);
      ctx.fillStyle = C.sky1;
      ctx.fillRect(bx, by, textW + pad * 2, boxH);
      ctx.fillStyle = s.color;
      ctx.fillRect(bx, by, textW + pad * 2, 2 * K);
      ctx.fillStyle = C.ink;
      ctx.fillText(s.text, bx + pad, by + boxH * 0.75);
    }

    if (state.roundComplete) {
      ctx.fillStyle = 'rgba(11,16,36,0.6)';
      ctx.fillRect(0, H / 2 - 40 * K, W, 80 * K);
      ctx.fillStyle = C.condorAccent;
      ctx.font = `bold ${Math.round(20 * K)}px "Press Start 2P", monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('PEAK CLEARED', W / 2, H / 2 - 4 * K);
      ctx.font = `${Math.round(15 * K)}px "VT323", monospace`;
      ctx.fillStyle = C.condor;
      ctx.fillText('new mountain incoming', W / 2, H / 2 + 22 * K);
      ctx.textAlign = 'left';
    }
  }

  // draw* helpers below are authored at a fixed small-number scale, then
  // stamped via translate+scale(K) so every decoration grows/shrinks with
  // the rest of the world instead of staying a fixed pixel size.
  function drawCondor(x, y, frame) {
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y));
    ctx.scale(K, K);
    const flap = frame === 0 ? -3 : 3; // discrete 2-cel wingbeat, no interpolation
    ctx.fillStyle = C.condor;
    ctx.fillRect(-10, 0, 20, 5);
    ctx.fillRect(-16, flap, 8, 3);
    ctx.fillRect(8, flap, 8, 3);
    ctx.fillStyle = C.condorAccent;
    ctx.fillRect(-2, -3, 4, 4);
    ctx.restore();
  }

  function drawTopi(e, rowY) {
    const bob = e.anim.f === 0 ? 0 : -2; // discrete 2-cel bob
    ctx.save();
    ctx.translate(Math.round(e.x), Math.round(rowY + bob * K));
    ctx.scale(K, K);
    ctx.fillStyle = C.topi; ctx.fillRect(-8, -12, 16, 10); ctx.fillRect(-6, -15, 12, 4);
    ctx.fillStyle = C.topiDark; ctx.fillRect(-8, -4, 4, 3); ctx.fillRect(4, -4, 4, 3);
    ctx.fillStyle = C.enemyEye;
    ctx.fillRect(e.dir > 0 ? -2 : -6, -13, 2, 2);
    ctx.restore();
  }

  function drawNitpicker(e) {
    const flap = e.anim.f === 0 ? -4 : 4; // discrete 2-cel wingbeat
    ctx.save();
    ctx.translate(Math.round(e.x), Math.round(e.y));
    ctx.scale(K, K);
    ctx.fillStyle = C.nit;
    ctx.fillRect(-5, -3, 10, 6);
    ctx.fillRect(-12, flap, 8, 3);
    ctx.fillRect(4, flap, 8, 3);
    ctx.fillStyle = C.nitDark;
    ctx.fillRect(e.dir > 0 ? 3 : -5, -5, 3, 3);
    ctx.restore();
  }

  function drawBear(x, y) {
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y));
    ctx.scale(K, K);
    ctx.fillStyle = C.bear;
    ctx.fillRect(-12, -8, 24, 10);
    ctx.fillRect(-14, -12, 8, 6);
    ctx.fillStyle = C.enemyEye;
    ctx.fillRect(-11, -10, 2, 2);
    ctx.restore();
  }

  // A carried rider draws at full scale (same as any active climber — never
  // shrunk), but sits visibly INSIDE a basket container: a back wall goes in
  // behind them first, then after they're drawn a front rim overlaps their
  // lower half, so they read as contained rather than just standing alongside
  // the carrier at the same size.
  function drawBasketBack(carrier, rider) {
    const bw = PLAYER_W * 0.95, bh = PLAYER_H * 0.6;
    const bx = Math.round(rider.x - bw / 2);
    const topY = Math.round(rider.y + PLAYER_H * 0.32);
    ctx.fillStyle = C.basketDark;
    ctx.fillRect(bx, topY, bw, bh);
    // strap running back to the carrier's shoulder
    const strapX1 = carrier.x + (carrier.facing > 0 ? -PLAYER_W * 0.3 : PLAYER_W * 0.3);
    ctx.strokeStyle = C.basketDark;
    ctx.lineWidth = 2 * K;
    ctx.beginPath();
    ctx.moveTo(Math.round(strapX1), Math.round(carrier.y + PLAYER_H * 0.3));
    ctx.lineTo(bx + bw / 2, topY + 2 * K);
    ctx.stroke();
  }

  function drawBasketFront(carrier, rider) {
    const bw = PLAYER_W * 0.95, bh = PLAYER_H * 0.6;
    const bx = Math.round(rider.x - bw / 2);
    const topY = Math.round(rider.y + PLAYER_H * 0.32);
    const rimH = PLAYER_H * 0.22;
    ctx.fillStyle = C.basket;
    ctx.fillRect(bx, topY, bw, rimH);
    ctx.fillStyle = C.basketDark;
    for (let i = 0; i < bw; i += 5 * K) ctx.fillRect(bx + i, topY + rimH, 2 * K, bh - rimH);
  }

  function drawPlayer(p) {
    const bob = (p.grounded && p.anim.mode === CELS.walk && p.anim.f === 1) ? 3 : 0; // discrete 2-cel walk bob
    const x = Math.round(p.x - PLAYER_W / 2);
    const y = Math.round(p.y - bob);
    const swinging = p.attackTimer > 0;
    // authentic invincibility flicker: sprite is fully drawn or fully skipped,
    // never translucent — matches how NES hardware actually did it.
    if (p.invuln > 0 && Math.floor(p.animT * 20) % 2 === 0) return;

    const headH = Math.round(PLAYER_H * 0.34);
    const legH = 5 * K;
    const eyeS = 3 * K;

    // modular block stack: legs -> body -> head, plus a per-character accessory
    // block for silhouette identity (readable even without color).
    ctx.fillStyle = p.colors.dark;
    ctx.fillRect(x + 2 * K, y + PLAYER_H - legH, PLAYER_W - 4 * K, legH);
    ctx.fillStyle = p.colors.body;
    ctx.fillRect(x, y + headH, PLAYER_W, PLAYER_H - headH - legH + 2 * K);
    ctx.fillStyle = p.colors.accent;
    ctx.fillRect(x, y + headH, PLAYER_W, 3 * K);
    ctx.fillStyle = p.colors.skin;
    ctx.fillRect(x + 3 * K, y, PLAYER_W - 6 * K, headH);
    ctx.fillStyle = p.colors.dark;
    const eyeX = p.facing > 0 ? x + PLAYER_W - 7 * K : x + 4 * K;
    ctx.fillRect(eyeX, y + headH - 5 * K, eyeS, eyeS);

    drawAccessory(p, x, y, headH);

    if (swinging) {
      // 2-cel swing: raised windup, then the strike held longer (weight on impact)
      ctx.fillStyle = p.colors.accent;
      const struck = p.anim.f === 1;
      const hx = p.facing > 0 ? x + PLAYER_W : x - 8 * K;
      const hy = struck ? y + headH + 2 * K : y - 3 * K;
      ctx.fillRect(hx, hy, 8 * K, 4 * K);
    }
  }

  function drawAccessory(p, x, y, headH) {
    ctx.fillStyle = p.colors.dark;
    switch (p.colors.accessory) {
      case 'spike':
        ctx.fillRect(x + PLAYER_W / 2 - 4 * K, y - 5 * K, 8 * K, 4 * K);
        ctx.fillRect(x + PLAYER_W / 2 - 2 * K, y - 8 * K, 4 * K, 4 * K);
        break;
      case 'visor':
        ctx.fillRect(x + 2 * K, y + 2 * K, PLAYER_W - 4 * K, 3 * K);
        ctx.fillStyle = p.colors.accent;
        ctx.fillRect(x + 3 * K, y + 2 * K, PLAYER_W - 6 * K, 1 * K);
        break;
      case 'cap':
        ctx.fillRect(x + 1 * K, y - 3 * K, PLAYER_W - 2 * K, 4 * K);
        ctx.fillRect(p.facing > 0 ? x + PLAYER_W - 3 * K : x - 3 * K, y, 5 * K, 2 * K);
        break;
    }
  }

  // ---- main loop ------------------------------------------------------------
  const FIXED_DT = 1 / 60;
  let acc = 0;
  let last = performance.now();
  let g = null;

  function frame(now) {
    let delta = (now - last) / 1000;
    last = now;
    delta = Math.min(delta, 0.05);

    const substeps = SPEED_STEPS[speedIndex];
    acc += delta * substeps;
    let steps = 0;
    while (acc >= FIXED_DT && steps < substeps * 4) {
      stepPhysics(g, FIXED_DT);
      acc -= FIXED_DT;
      steps++;
    }

    draw(g);

    const [p1, p2, p3] = g.players;
    hud.p1s.textContent = p1.summits; hud.p1f.textContent = p1.falls;
    hud.p2s.textContent = p2.summits; hud.p2f.textContent = p2.falls;
    hud.p3s.textContent = p3.summits; hud.p3f.textContent = p3.falls;
    hud.p3live.hidden = p3.carried;

    requestAnimationFrame(frame);
  }

  speedBtn.addEventListener('click', () => {
    SFX.unlock();
    speedIndex = (speedIndex + 1) % SPEED_STEPS.length;
    speedBtn.textContent = SPEED_STEPS[speedIndex] + 'x';
  });

  g = newGame();
  window.__autoclimb = g;
  window.__autoclimbTick = (dt) => stepPhysics(g, dt ?? FIXED_DT); // debug hook, bypasses rAF throttling
  window.__autoclimbDraw = () => draw(g); // debug hook, force a repaint without waiting on rAF
  requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
})();
