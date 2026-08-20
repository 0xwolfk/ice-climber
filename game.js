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
  const PLAYER_W = 21 * K, PLAYER_H = 27 * K; // 1.5x the original sprite, at this screen's scale
  const GRAVITY = 900 * K;
  // Mario-style variable-height jump: light gravity while rising with the
  // button held (a full hold reaches the same tuned apex as before — JUMP_VY
  // is scaled down to compensate for the lighter ascent), heavy gravity the
  // moment you release early or start falling, so it never feels floaty.
  const ASCEND_MULT = 0.6, DESCEND_MULT = 1.75;
  const JUMP_VY = -340 * K * Math.sqrt(ASCEND_MULT);
  // full-hold time-of-flight to clear one ROW_H of climb — velocity and both
  // gravity phases all carry the same K factor, so this comes out in real
  // seconds regardless of screen size; used to project a moving platform's
  // future position at the moment a jump aimed at it will actually land
  const JUMP_AIRTIME = 0.56;
  const MOVE_SPEED = 140 * K;
  const AIR_MOVE_SPEED = 122 * K;
  const MELEE_RANGE = 20 * K;
  const THREAT_RADIUS = 78 * K;
  const PAD = 20 * K; // edge margin for enemies/holes — players wrap instead of clamping
  const STUN_TIME = 0.5;
  const INVULN_TIME = 1.3; // dense continuous durian waves mean back-to-back hits chain fast without more grace here
  const BONUS_TIME = 6.5;
  const SUMMIT_BANNER_TIME = 1.4;
  const MAX_ROUND_TIME = 130; // raised to absorb the extra hazard density from icicles + multi-ledge rows
  const PRESSURE_DELAY = 35;
  const PRESSURE_SPEED = 16 * K;
  const IDLE_TIMEOUT_MS = 11000;
  const INTERACT_RANGE = 30 * K;
  const MAX_AVOID_TIME = 1.4; // patience cutoff — force a jump rather than dodge forever

  // row count adapts to whatever vertical room is actually left after the
  // HUD/footer overlays and the summit's bonus-platform zone (measured live,
  // not guessed, so it stays correct if the overlay text/size ever changes)
  const HUD_CLEARANCE = (hudEl ? hudEl.offsetHeight : 50 * K) + 10 * K;
  const FOOTER_CLEARANCE = (footEl ? footEl.offsetHeight : 30 * K) + 10 * K;
  const BONUS_ZONE = 100 * K; // headroom above the summit row for the condor bonus stage
  // the mountain is much taller than one screen — a real climb, not a single
  // static view — the camera (state.cameraY) follows the lead climber upward
  // to reveal it rather than the canvas growing or scrolling the page.
  const TOP_ROW = 13;
  const CAMERA_ANCHOR = 0.6; // the lead climber sits ~60% down the visible window
  const START_Y = H - FOOTER_CLEARANCE;

  const SPEED_STEPS = [1, 2, 4, 8, 16];
  let speedIndex = 0;

  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);

  const C = {
    sky1: '#0b1024', sky2: '#232b5c', sky3: '#171c40',
    skyWarn1: '#241206', skyWarn3: '#4a2410', skyWarn2: '#6b3418',
    skyDanger1: '#2a0605', skyDanger3: '#5c120e', skyDanger2: '#7f1c14',
    starFar: '#4a5590', starNear: '#c8d2f5',
    ledge: '#dfe9ff', ledgeShade: '#a9b8e6', ledgeEdge: '#6f82c2', holeEdge: '#0b1024',
    ledgeBase: '#5c6fb0', islandCrust: '#bfe8ff', islandBase: '#3f6fa8',
    ceil: '#7fd7ff', ceilCrack: '#2c6f8f', ceilShade: '#4fa8d6',
    topi: '#7bffc4', topiDark: '#1f7a56', enemyEye: '#0b1024',
    nit: '#ffb37b', nitDark: '#a5581f',
    veg: '#ffd166', vegLeaf: '#7bffc4',
    durian: '#8a9a3f', durianSpike: '#4f5f24', durianHi: '#b9c96a',
    condor: '#eef3ff', condorAccent: '#ffd166',
    bear: '#f4f7ff', bearShade: '#c3cdea',
    basket: '#b98a4b', basketDark: '#7a5a2f',
    wallBody: '#2f3d72', wallShade: '#1c2650', wallHi: '#7f92d6', numGold: '#ffd166',
    dim: '#8fa0c9', ink: '#eef3ff'
  };

  const PERSONALITIES = {
    // predictSeconds: how far ahead each personality projects enemy movement
    // before deciding to dodge — short = reactive/instinctive, long = anticipates
    // the patrol swing like a chess player reading an opponent's next move.
    NAYKILLA: { attackChance: 0.82, dangerDist: 24 * K, holeMargin: 8 * K,  jumpHesitation: 0.14, predictSeconds: 0.18, impatience: 0.05, pauseChance: 0.15 },
    USHER:    { attackChance: 0.18, dangerDist: 40 * K, holeMargin: 20 * K, jumpHesitation: 0.4,  predictSeconds: 0.85, impatience: 0.01, pauseChance: 0.4 },
  };

  const COLORS = {
    NAYKILLA: { body: '#ff6bcb', dark: '#a83f8a', accent: '#ffe66d', skin: '#ffd8b0', accessory: 'spike', held: 'lollipop' },
    USHER:    { body: '#4d8dff', dark: '#1f4fb8', accent: '#eef3ff', skin: '#ffd8b0', accessory: 'visor', held: 'chicken' },
    ADAM:     { body: '#c8ff6b', dark: '#7fae2f', accent: '#ffe66d', skin: '#ffd8b0', accessory: 'cap', held: null },
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
      ctx: ensure,
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

  // ---- background music ------------------------------------------------------
  // A short original chiptune loop (lead + soft bass), off by default until the
  // player opts in. Not transcribed from any existing song — an original riff
  // in the same energetic 8-bit spirit.
  const BGM = (() => {
    let playing = false, timer = null, idx = 0;
    const lead = [523, 659, 784, 659, 587, 784, 698, 587, 523, 659, 880, 784, 659, 587, 494, 523];
    const bass = [131, 0, 165, 0, 147, 0, 165, 0, 131, 0, 220, 0, 165, 0, 123, 0];
    const noteDur = 0.18;
    function tick() {
      if (!playing) return;
      const c = SFX.ctx();
      const f = lead[idx % lead.length];
      const osc = c.createOscillator(), gain = c.createGain();
      osc.type = 'square'; osc.frequency.setValueAtTime(f, c.currentTime);
      gain.gain.setValueAtTime(0.022, c.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + noteDur * 0.85);
      osc.connect(gain); gain.connect(c.destination);
      osc.start(); osc.stop(c.currentTime + noteDur);

      const bf = bass[idx % bass.length];
      if (bf) {
        const bosc = c.createOscillator(), bgain = c.createGain();
        bosc.type = 'triangle'; bosc.frequency.setValueAtTime(bf, c.currentTime);
        bgain.gain.setValueAtTime(0.03, c.currentTime);
        bgain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + noteDur * 1.7);
        bosc.connect(bgain); bgain.connect(c.destination);
        bosc.start(); bosc.stop(c.currentTime + noteDur * 1.8);
      }
      idx++;
      timer = setTimeout(tick, noteDur * 1000);
    }
    return {
      isOn: () => playing,
      start() { if (playing) return; SFX.unlock(); playing = true; idx = 0; tick(); },
      stop() { playing = false; if (timer) clearTimeout(timer); },
      toggle() { if (playing) this.stop(); else this.start(); return playing; },
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

  // is x currently unsupported on this row? — every mid-row is 1-3 short
  // separate ledges (left/center/right, like the real game's staggered ice
  // floors), so anywhere off all of them is open air. Start and summit rows
  // are always fully solid.
  function rowHazardAt(row, x) {
    if (row.full) return false;
    if (!row.platforms) return true;
    for (const p of row.platforms) if (!p.broken && x > p.x && x < p.x + p.w) return false;
    return true;
  }

  // which specific ledge (if any) currently covers x — needed everywhere a
  // row might now have more than one, to know WHICH one an entity is on
  function platformAt(row, x) {
    if (row.full || !row.platforms) return null;
    for (const p of row.platforms) if (!p.broken && x > p.x && x < p.x + p.w) return p;
    return null;
  }

  // ---- world generation ------------------------------------------------------
  // Each mid-row is 1-3 short separate ledges (left/center/right, like the
  // real game's staggered ice floors), not a single lane. The PRIMARY ledge
  // on each row is placed relative to the one below it (not picked
  // independently inside a huge half-screen zone), so the main climbing path
  // is always within actual jump range — otherwise random placement could
  // (and did) produce climbs no jump arc could ever cross. Extra ledges are
  // placed relative to the primary one on the SAME row, giving real left/
  // center/right route choice without risking that guarantee. REACH is a
  // conservative measure of jump range: full-hold Mario-jump airtime
  // (~0.59s covering one ROW_H) times AIR_MOVE_SPEED.
  const REACH = 95 * K;
  function buildMountain(difficulty) {
    difficulty = difficulty || 0;
    const widthScale = clamp(1 - difficulty * 0.012, 0.72, 1); // ledges shrink slowly as rounds escalate
    // moving floorboards are a real, common fixture from the very first climb —
    // not a rare high-difficulty variant — ramping only their speed with difficulty
    const driftChance = clamp(0.3 + difficulty * 0.03, 0.3, 0.55);
    // cracking ice is common from round one too; higher difficulty just breaks faster
    const crackChance = clamp(0.3 + difficulty * 0.025, 0.3, 0.6);
    const crackTime = () => rnd(clamp(2.4 - difficulty * 0.08, 1.1, 2.4), clamp(3.2 - difficulty * 0.08, 1.6, 3.2));

    function makePlatform(x, w, driftMul, crackMul) {
      const plat = { x, w, homeX: x, broken: false };
      if (Math.random() < driftChance * driftMul) {
        const range = clamp(REACH * 0.45, 24 * K, 60 * K);
        plat.drift = {
          speed: rnd(18, 34) * K * (1 + difficulty * 0.04), dir: Math.random() < 0.5 ? -1 : 1,
          min: clamp(x - range, PAD, W - PAD - w), max: clamp(x + range, PAD, W - PAD - w),
        };
      }
      if (Math.random() < crackChance * crackMul) plat.crack = { timer: 0, maxTime: crackTime() };
      // stalactites hanging off the underside — jarred loose and fall the
      // moment someone lands on the ice above them. Stored as an OFFSET from
      // the platform's own x, not an absolute position, so they ride along
      // with a drifting platform instead of hanging in empty air behind it.
      plat.icicles = [];
      for (let off = 6 * K; off < w - 4 * K; off += 26 * K) plat.icicles.push({ off, fallen: false });
      return plat;
    }

    const rows = [];
    let prevX = null; // near-edge chaining anchor from the row below
    let lastGoingRight = Math.random() < 0.5;
    let lastWasRest = false;
    for (let i = 0; i <= TOP_ROW; i++) {
      const y = START_Y - i * ROW_H;
      if (i === 0 || i === TOP_ROW) { rows.push({ y, full: true, platforms: null }); prevX = null; continue; }

      // vary the rhythm row to row — a straight strict left-right-left-right
      // alternation with one fixed platform size reads as one repeating
      // pattern no matter how much the mountain is regenerated. Roll a real
      // shape per row instead: an occasional full-width rest floor to break
      // the beat, a wide easy ledge, a narrow tense reach, or a run of two
      // platforms on the SAME side instead of always swinging back across.
      const roll = Math.random();
      const canRest = i > 1 && i < TOP_ROW - 1 && !lastWasRest;
      if (canRest && roll < 0.14) {
        rows.push({ y, full: true, platforms: null });
        prevX = null; lastWasRest = true;
        continue;
      }
      lastWasRest = false;

      let w, gapMax;
      if (roll < 0.14 + 0.20) { w = rnd(52, 76) * K * widthScale; gapMax = REACH * 0.88; }        // tight, tense reach
      else if (roll < 0.14 + 0.20 + 0.18) { w = rnd(118, 150) * K * widthScale; gapMax = REACH * 0.45; } // wide, easy breather
      else { w = rnd(80, 116) * K * widthScale; gapMax = REACH * 0.7; }                          // normal

      const sameSide = prevX !== null && Math.random() < 0.3;
      const goingRight = sameSide ? lastGoingRight : !lastGoingRight;
      lastGoingRight = goingRight;

      let x;
      if (prevX === null) {
        x = rnd(PAD, W - PAD - w);
      } else {
        const gap = rnd(8 * K, gapMax); // always within reach, but still real horizontal distance
        x = goingRight ? prevX + gap : prevX - gap - w;
        x = clamp(x, PAD, W - PAD - w);
      }
      const primary = makePlatform(x, w, 1, 1);
      const platforms = [primary];

      // extra ledges on the SAME row for real left/center/right choice —
      // placed within reach of the primary one (not the row below), so they
      // add route variety without ever risking an unreachable main climb
      const extraRoll = Math.random();
      const extraCount = extraRoll < 0.35 ? 0 : extraRoll < 0.75 ? 1 : 2;
      for (let e = 0; e < extraCount; e++) {
        const ew = rnd(46, 96) * K * widthScale;
        const side = Math.random() < 0.5 ? -1 : 1;
        const gap2 = rnd(14 * K, REACH * 0.75);
        let ex = side < 0 ? x - gap2 - ew : x + w + gap2;
        ex = clamp(ex, PAD, W - PAD - ew);
        const overlaps = platforms.some(pl => ex < pl.x + pl.w + 10 * K && ex + ew > pl.x - 10 * K);
        if (overlaps) continue;
        platforms.push(makePlatform(ex, ew, 0.6, 0.6));
      }
      platforms.sort((a, b) => a.x - b.x);

      rows.push({ y, full: false, platforms });
      // hand off the edge the NEXT row will jump FROM — since direction
      // strictly alternates, that's the PRIMARY platform's far edge relative
      // to how we arrived (arrived going right -> next leaves going left ->
      // left edge); extra ledges don't participate in the chain guarantee
      prevX = goingRight ? x : x + w;
    }

    const midRows = [];
    for (let i = 1; i < TOP_ROW; i++) midRows.push(i);

    const enemies = [];
    const topiCount = clamp(2 + Math.floor(difficulty / 3), 2, midRows.length);
    const topiRows = [...midRows].sort(() => Math.random() - 0.5).slice(0, topiCount);
    const speedScale = 1 + Math.min(0.55, difficulty * 0.04);
    for (const r of topiRows) {
      const plats = rows[r].platforms;
      const platIdx = plats && plats.length ? Math.floor(Math.random() * plats.length) : -1;
      const plat = platIdx >= 0 ? plats[platIdx] : null;
      const spawnX = plat ? rnd(plat.x + 4 * K, plat.x + plat.w - 4 * K) : rnd(PAD + 10, W - PAD - 10);
      enemies.push({
        type: 'topi', row: r, platIdx, x: spawnX,
        dir: Math.random() < 0.5 ? -1 : 1, speed: rnd(34, 50) * speedScale * K,
        alive: true, respawnTimer: 0,
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

    // bonus platforms step up toward the condor at center — bigger and closer
    // to W/2 with each step, so the final stretch to the trophy is generous
    // rather than a knife-edge landing
    const topY = rows[TOP_ROW].y;
    const platW1 = 70 * K, platW2 = 58 * K, platW3 = 48 * K;
    const bonusPlatforms = [
      { x: clamp(rnd(W * 0.26, W * 0.74) - platW1 / 2, PAD, W - PAD - platW1), y: topY - 26 * K, w: platW1, dir: Math.random() < 0.5 ? -1 : 1, speed: rnd(20, 30) * K },
      { x: clamp(W / 2 + rnd(-70, 70) * K - platW2 / 2, PAD, W - PAD - platW2), y: topY - 50 * K, w: platW2, dir: Math.random() < 0.5 ? -1 : 1, speed: rnd(22, 32) * K },
      { x: clamp(W / 2 + rnd(-36, 36) * K - platW3 / 2, PAD, W - PAD - platW3), y: topY - 74 * K, w: platW3, dir: Math.random() < 0.5 ? -1 : 1, speed: rnd(18, 26) * K },
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
    p.stuckCount = 0; p.lastJumpRow = -1; p.pauseExtra = 0;
    p.bonusPhase = false; p.bonusStage = 0; p.bonusTimeLeft = BONUS_TIME;
    p.doneThisRound = false;
    p.airTargetX = p.x;
    if (!p.anim) p.anim = { mode: CELS.idle, f: 0, t: CELS.idle[0] };
  }

  // getting hit by a falling durian knocks you hard into open air — you fall
  // through empty space until the nearest floor below actually catches you
  // (which could cost you many rows of progress), not a teleport to the very
  // bottom of the mountain.
  function resetToBottom(state, p) {
    p.vy = 420 * K; p.vx = (Math.random() < 0.5 ? -1 : 1) * 140 * K;
    p.grounded = false; p.bonusPhase = false;
    p.stuckCount = 0; p.lastJumpRow = -1; p.avoidTimer = 0; p.safeTimer = 0;
    p.stun = STUN_TIME; p.invuln = INVULN_TIME * 1.5;
    p.falls++;
    spawnParticles(state, p.x, p.y, C.durian, 12);
    SFX.knock();
    state.hitStop = Math.max(state.hitStop, 0.12);
    say(state, p, 'durian');
  }

  // ---- random events (potions) -----------------------------------------------
  // Every ~20-30s something shifts the rules for a while — good or bad. Boosts
  // and hazards both work through the same physics/collision code every other
  // tick already uses (jumpBoost multiplies JUMP_VY, speedBoost multiplies
  // MOVE_SPEED, durianStorm just speeds up the existing durian spawner), so the
  // AI doesn't need special-case awareness — it reacts to the resulting world
  // exactly like it reacts to any other row/hazard state, precisely and live.
  function triggerRandomEvent(state) {
    const pool = ['jumpBoost', 'speedBoost', 'durianStorm', 'collapse', 'lift'];
    const kind = pool[Math.floor(Math.random() * pool.length)];
    const banner = (text, color) => { state.eventBanner = { text, life: 2.4, color }; };
    switch (kind) {
      case 'jumpBoost':
        state.jumpBoost = 1.5; state.activeEvent = kind; state.eventUntil = state.clock + 10;
        banner('SPRING ICE — HIGHER JUMPS!', C.condorAccent);
        break;
      case 'speedBoost':
        state.speedBoost = 1.45; state.activeEvent = kind; state.eventUntil = state.clock + 10;
        banner('TAILWIND — FASTER FEET!', C.condorAccent);
        break;
      case 'durianStorm':
        state.durianStormUntil = state.clock + 8; state.durianTimer = 0.4;
        banner('DURIAN SEASON INCOMING!', C.durian);
        break;
      case 'collapse': {
        const row = 1 + Math.floor(Math.random() * (TOP_ROW - 1));
        for (const p of state.players) {
          if (p.carried || p.doneThisRound || p.bonusPhase) continue;
          if (p.groundedRow >= row) {
            const target = Math.max(0, row - 1);
            p.groundedRow = target; p.y = state.rows[target].y - PLAYER_H;
            p.vx = 0; p.vy = 0; p.grounded = true; p.invuln = INVULN_TIME; p.falls++;
            spawnParticles(state, p.x, p.y, C.ledgeBase, 10);
          }
        }
        SFX.bear();
        banner('FLOOR ' + (row + 1) + ' GAVE WAY!', C.durianSpike);
        break;
      }
      case 'lift': {
        for (const p of state.players) {
          if (p.carried || p.doneThisRound || p.bonusPhase) continue;
          const target = Math.min(TOP_ROW, p.groundedRow + 1);
          p.groundedRow = target; p.y = state.rows[target].y - PLAYER_H;
          p.vy = 0; p.grounded = true;
          spawnParticles(state, p.x, p.y, C.islandCrust, 10);
          if (target === TOP_ROW && !p.bonusPhase && !p.doneThisRound) {
            p.bonusPhase = true; p.bonusStage = 0; p.bonusTimeLeft = BONUS_TIME;
          }
        }
        SFX.summit(false);
        banner('ICE LIFT — UP YOU GO!', C.condorAccent);
        break;
      }
    }
  }

  function clearEvent(state) {
    state.activeEvent = null;
    state.jumpBoost = 1;
    state.speedBoost = 1;
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
    p3.carrierId = p2.id;

    return {
      rows: mountain.rows, enemies: mountain.enemies,
      bonusPlatforms: mountain.bonusPlatforms, condor: mountain.condor,
      condorClaimedBy: null,
      veggies: [], vegTimer: rnd(3, 5),
      durians: [], durianTimer: rnd(5, 8),
      icicleShards: [],
      adamCommentTimer: rnd(14, 22),
      particles: [], popups: [], speech: [],
      players: [p1, p2, p3],
      roundComplete: false, bannerTimer: 0, roundTime: 0,
      pressureY: H + 40, bearActive: false,
      clock: 0, hitStop: 0, roundIndex: 0,
      condorAnim: { f: 0, t: CELS.condor[0] }, bearAnim: { f: 0, t: CELS.bear[0] },
      eventTimer: rnd(18, 26), activeEvent: null, eventUntil: 0, eventBanner: null,
      jumpBoost: 1, speedBoost: 1, durianStormUntil: 0,
      cameraY: 0,
    };
  }

  // World y DECREASES as a climber goes up (row0 near START_Y, the summit near
  // 0 or negative). So as the leader climbs, cameraY must go negative too —
  // translate(0,-cameraY) then pushes everything down by that same amount,
  // keeping the leader on screen. cameraY's valid range is therefore
  // [minScroll, 0]: 0 at the very start (no scroll needed yet), down to
  // minScroll once the summit is fully revealed.
  function updateCamera(state, dt) {
    let highestY = state.rows[0].y;
    for (const p of state.players) {
      if (p.carried || p.doneThisRound) continue;
      if (p.y < highestY) highestY = p.y;
    }
    const rawTarget = highestY - H * CAMERA_ANCHOR;
    const topY = state.rows[TOP_ROW].y;
    // generous margin above the condor — bonus-phase jump arcs can carry a
    // climber noticeably higher than the condor's own y for a moment
    const minScroll = (topY - BONUS_ZONE - 220 * K) - H * CAMERA_ANCHOR;
    const target = clamp(rawTarget, minScroll, 0);
    state.cameraY += (target - state.cameraY) * Math.min(1, dt * 9);

    // hard safety net, keyed to the single leading climber only — checking
    // every player individually let two climbers at very different heights
    // fight over cameraY each tick, with whichever was processed last winning
    // and undoing the other's fix. The leader is what the camera should
    // guarantee; a trailing climber may briefly sit outside the frame.
    const topMargin = 150 * K;
    const leaderScreenY = highestY - state.cameraY;
    if (leaderScreenY < topMargin) state.cameraY = highestY - topMargin;
    state.cameraY = clamp(state.cameraY, minScroll, 0);
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
    state.durians = [];
    state.icicleShards = [];
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
  function predictBounceX(x, dir, speed, t, lo, hi) {
    const steps = 6, sdt = t / steps;
    for (let i = 0; i < steps; i++) {
      x += dir * speed * sdt;
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
        const plat = e.platIdx >= 0 && row.platforms ? row.platforms[e.platIdx] : null;
        const lo = plat ? plat.x + 4 * K : PAD + 8, hi = plat ? plat.x + plat.w - 4 * K : W - PAD - 8;
        ex = predictT > 0 ? predictBounceX(e.x, e.dir, e.speed, predictT, lo, hi) : e.x;
        ey = row.y - 8 * K;
      } else {
        ex = predictT > 0 ? predictBounceX(e.x, e.dir, e.speed, predictT, PAD + 8, W - PAD - 8) : e.x;
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
      // no enemy in range — hammer the ice underfoot instead, same as the
      // original game's core use for the tool, not just an enemy-only swing
      return { left: false, right: false, jump: false, attack: true, attackTarget: 'ice' };
    }
    return { left: keys.left, right: keys.right, jump: keys.up, attack: false };
  }

  function decideBonus(state, p) {
    const atCondor = p.bonusStage >= state.bonusPlatforms.length;
    const target = atCondor ? state.condor : state.bonusPlatforms[p.bonusStage];
    if (p.human) return { left: keys.left, right: keys.right, jump: keys.up, attack: false };
    if (!p.grounded) {
      const dx = target.x - p.x;
      return { left: dx < -3, right: dx > 3, jump: false, attack: false };
    }
    const cx = target.x + (target.w || 0) / 2 * (atCondor ? 0 : 1);
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

    // falling durians have no patrol pattern to predict and are instantly
    // costly — dodge one on a real collision course before anything else,
    // the same "slide out of the way" a human would do during a storm wave
    const durianTargetY = p.y + PLAYER_H / 2;
    let durianDx = null, durianT = Infinity;
    for (const d of state.durians) {
      if (d.y > durianTargetY) continue;
      const t = (durianTargetY - d.y) / d.vy;
      if (t < 0 || t > 0.85) continue;
      const dx = wrapDelta(d.x, p.x, W);
      if (Math.abs(dx) > 46 * K) continue;
      if (t < durianT) { durianT = t; durianDx = dx; }
    }
    if (durianDx !== null) {
      const dir = durianDx >= 0 ? -1 : 1;
      return { left: dir < 0, right: dir > 0, jump: false, attack: false };
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
    const nextRow = p.groundedRow < TOP_ROW ? state.rows[p.groundedRow + 1] : null;
    // stuck 3+ jumps in a row without gaining a floor? stop repeating the same
    // approach and try the far side instead — "take another path." Still stuck
    // after that (a genuinely hostile row)? stop being picky about position
    // entirely and just keep swinging — guarantees forward progress eventually
    // rather than possibly cycling between two imperfect approaches forever.
    const rerouting = p.stuckCount >= 3;
    if (p.stuckCount >= 8) {
      p.safeTimer += dt;
      if (p.safeTimer > 0.08) {
        p.safeTimer = 0;
        p.airTargetX = p.x;
        return { left: false, right: false, jump: true, attack: false };
      }
      return { left: false, right: false, jump: false, attack: false };
    }

    // where the NEXT jump actually needs to land — every mid-row is a short
    // offset platform now (like the real game's zigzag ledges), so reaching it
    // almost always means crossing real horizontal distance, not just going up.
    // While still grounded, track the platform's LIVE position every tick
    // rather than a single stale prediction — that's what lets a drifting
    // floorboard actually be "waited for": alignment below only passes once
    // the real, current gap is closeable, so the AI holds position and keeps
    // re-tracking until the platform genuinely swings into range.
    //
    // The landing spot itself is picked by scoring a few candidate points —
    // left edge / center / right edge — the same shallow-evaluation idea a
    // chess engine uses to compare a handful of legal moves, rather than
    // committing to a single guessed heuristic: shorter hop wins some credit,
    // setting up the FOLLOWING jump (two rows ahead) wins more, and a patrol
    // currently standing on the landing row is a hard penalty.
    let trueTargetX = p.x;
    if (nextRow && !nextRow.full && nextRow.platforms) {
      // every ledge on the landing row gets left/center/right candidates —
      // comparing across ALL of them (not just one lane) is what makes
      // left/center/right routing an actual choice instead of a formality
      const candidates = [];
      for (const np of nextRow.platforms) {
        const leftEdge = np.x + 8 * K, rightEdge = np.x + np.w - 8 * K;
        const center = clamp(np.x + np.w / 2, PAD + 8 * K, W - PAD - 8 * K);
        if (rerouting) candidates.push(leftEdge, rightEdge);
        else candidates.push(leftEdge, center, rightEdge);
      }

      const next2Row = p.groundedRow < TOP_ROW - 1 ? state.rows[p.groundedRow + 2] : null;
      let n2Center = null;
      if (next2Row && !next2Row.full && next2Row.platforms && next2Row.platforms.length) {
        const mid = next2Row.platforms[Math.floor(next2Row.platforms.length / 2)];
        n2Center = mid.x + mid.w / 2;
      }
      const rowEnemies = state.enemies.filter(e => e.alive && e.type === 'topi' && e.row === p.groundedRow + 1);

      let best = candidates[0], bestScore = -Infinity;
      for (const c of candidates) {
        let score = 0;
        score -= Math.abs(wrapDelta(c, p.x, W)) * 0.02; // mild preference for the shorter hop
        if (n2Center !== null) score -= Math.abs(c - n2Center) * 0.05; // sets up the jump after this one too
        for (const e of rowEnemies) if (Math.abs(wrapDelta(c, e.x, W)) < 22 * K) score -= 40; // don't land on a patrol
        if (score > bestScore) { bestScore = score; best = c; }
      }
      trueTargetX = best;
    }

    // walking target stays on the CURRENT ledge (don't march off the edge
    // lining up) — the rest of the gap gets closed by air-steering mid-jump
    const standingOn = platformAt(row, p.x);
    let walkTargetX = trueTargetX;
    if (!row.full && standingOn) {
      walkTargetX = clamp(trueTargetX, standingOn.x + 4 * K, standingOn.x + standingOn.w - 4 * K);
    }

    const tdx = wrapDelta(p.x, walkTargetX, W);
    if (Math.abs(tdx) > 5 * K) {
      const dir = tdx < 0 ? 1 : -1;
      return { left: dir < 0, right: dir > 0, jump: false, attack: false };
    }

    // the ledge underfoot is about to give way — go now, alignment be damned
    const plat = standingOn;
    const urgent = plat && plat.crack && !plat.broken && plat.crack.timer > plat.crack.maxTime * 0.7;

    for (const other of state.players) {
      if (other === p || other.carried) continue;
      const odx = wrapDelta(other.x, p.x, W);
      if (other.groundedRow === p.groundedRow && other.grounded && Math.abs(odx) < 14 && !urgent) {
        const dir = odx > 0 ? -1 : 1;
        return { left: dir < 0, right: dir > 0, jump: false, attack: false };
      }
    }

    // a real pause before committing, not a robotic instant-jump every safe
    // tick — rolled once per wait so it doesn't flicker, refreshed after
    // every jump. USHER thinks it over more often than NAYKILLA does.
    p.safeTimer += dt;
    if (p.safeTimer <= dt) p.pauseExtra = Math.random() < perc.pauseChance ? rnd(0.15, 0.5) : 0;
    if (urgent || p.safeTimer > perc.jumpHesitation + p.pauseExtra) {
      p.safeTimer = 0;
      // committing NOW — the walk phase tracked the platform's live position,
      // but a moving platform won't still be there ~0.56s later when the
      // jump actually lands, so re-project the same chosen spot (center/edge/
      // planned offset) forward to where the platform will BE at landing
      let launchTargetX = trueTargetX;
      const landingPlat = nextRow && !nextRow.full ? platformAt(nextRow, trueTargetX) : null;
      if (landingPlat && landingPlat.drift) {
        const np = landingPlat;
        const offset = trueTargetX - np.x;
        const futureX = predictBounceX(np.x, np.drift.dir, np.drift.speed, JUMP_AIRTIME, np.drift.min, np.drift.max);
        launchTargetX = futureX + offset;
      }
      p.airTargetX = launchTargetX;
      return { left: false, right: false, jump: true, attack: false };
    }
    return { left: false, right: false, jump: false, attack: false };
  }

  // ---- dialogue ---------------------------------------------------------------
  // 100+ lines across every major event, kept short enough for a small bubble.
  // A few pools are personality-specific (NAYKILLA reckless, USHER dry, ADAM
  // self-aware about being the human) — say() picks the matching variant when
  // one exists, otherwise falls back to the shared pool.
  const DIALOGUE = {
    summit: [
      'MADE IT!', 'TOP OF THE WORLD!', 'YES!!', 'SUMMIT SECURED.', 'TOO EASY.', "WHO'S NEXT?",
      'PEAK GET.', 'CALLED IT.', 'ANOTHER ONE.', 'KING OF THE HILL.', "DIDN'T EVEN BREAK A SWEAT.",
      'FLAG PLANTED.', 'THAT NEVER GETS OLD.', 'ONE MORE FOR THE PILE.', 'VIEW\'S NICE UP HERE.',
      'AND THAT\'S HOW IT\'S DONE.',
    ],
    summit_NAYKILLA: ['RACE YOU DOWN NEXT TIME.', 'BARELY TRIED.', 'HA! FIRST AGAIN.'],
    summit_USHER: ['As calculated.', 'Textbook ascent.', 'Precision pays off.'],
    summit_ADAM: ['not bad for a human.', 'take THAT, bots.', 'adam: 1, mountain: 0'],
    encourage: [
      'NICE ONE!', 'GO GO GO!', 'SHOW OFF.', 'MY TURN NEXT!', 'GG!', "GUESS I'M SLOW...",
      'GET IT!', 'GOOD CLIMB.', "SHOW-OFF.", 'CARRY ME NEXT TIME.', "I'LL CATCH UP.",
      'CLASSY LANDING.', 'RUB IT IN, WHY DON\'T YOU.', 'FINE, IMPRESSIVE.', 'OKAY OKAY, NICE.',
      "DON'T GET COCKY.",
    ],
    encourage_NAYKILLA: ["BEAT YOU NEXT TIME.", "LUCKY RUN.", "I WAS DISTRACTED, OKAY."],
    encourage_USHER: ["Efficient.", "Duly noted.", "A reasonable result."],
    encourage_ADAM: ['show off much, adam?', 'the human strikes again.', 'okay THAT was actually good.'],
    fall: [
      'OH SHOOT!', 'OUCH!', 'NOT AGAIN...', 'WHOA!', 'OOF.', 'RUDE.',
      'WHO PUT THAT THERE.', 'I MEANT TO DO THAT.', 'OKAY, RESET.', 'THAT STINGS.',
      'DIDN\'T SEE THAT COMING.', 'BACK TO THE DRAWING BOARD.', 'ONE SEC.', 'YIKES.',
      'STYLE POINTS, AT LEAST.', 'NOTED. AVOID THAT.',
    ],
    fall_NAYKILLA: ["WORTH THE RISK.", "MINOR SETBACK.", "STILL FASTER THAN YOU."],
    fall_USHER: ["I should have predicted that.", "Recalculating.", "An acceptable loss."],
    fall_ADAM: ['my controller slipped.', 'rigged. definitely rigged.', 'okay THAT was a bug, right?'],
    durian: [
      'A DURIAN?! REALLY?', 'WHY IS FRUIT FALLING.', 'NOT THE SPIKY ONE.', 'STRAIGHT TO THE BOTTOM.',
      'WHO IS THROWING THESE.', 'SMELLS AS BAD AS IT HURTS.', 'FRUIT AMBUSH.', 'BACK TO SQUARE ONE.',
      'THAT ONE HURT.', "SPIKES. WHY SPIKES.", 'DURIAN: 1, ME: 0.', 'STARTING OVER, GREAT.',
    ],
    attack: [
      'HAMMER TIME.', 'CLEAR!', 'OUT OF MY WAY.', 'NICE TRY.', 'SWATTED.', 'TOO SLOW.',
      'ONE HIT.', 'NOT TODAY.', 'BACK OFF.', 'DEALT WITH.',
    ],
    breakIce: [
      'CRACK!', 'THROUGH!', 'ICE, MEET HAMMER.', 'OPEN UP.', 'ALMOST THERE.', 'ONE MORE HIT.',
      'BREAKING THROUGH.', 'THAT\'S THE SPOT.',
    ],
    veggie: [
      'SNACK GET.', 'BONUS!', 'DON\'T MIND IF I DO.', 'TASTY.', 'FUEL UP.', 'FREE POINTS.',
      'YOINK.', 'MINE NOW.',
    ],
    carried: [
      'HOP ON!', 'GOT YOU.', 'ALL ABOARD.', 'FREE RIDE, ADAM.', "DON'T FALL ASLEEP UP THERE.",
      "I'VE GOT THIS ONE.", 'BASKET CLASS: OPEN.', 'HANG ON TIGHT.', 'ADAM, INCOMING PICKUP.',
      "NAP TIME FOR ADAM.",
    ],
    hopOut: [
      "I'VE GOT IT FROM HERE.", 'OKAY, MY TURN.', "ADAM'S BACK.", 'LET ME DOWN, THANKS.',
      'BACK IN CONTROL.', "OKAY, I'M UP.", 'HUMAN TAKEOVER.', "ADAM RETURNS.",
      "ALRIGHT, WATCH THIS.", "I CAN WALK, YOU KNOW.",
    ],
    aboutAdam: [
      'WHERE\'S ADAM GONE?', 'ADAM, YOU AWAKE?', 'ADAM IS BEING CARRIED AGAIN.', 'CLASSIC ADAM.',
      'ADAM, ANY DAY NOW.', 'IS ADAM EVEN PLAYING?', 'ADAM\'S TAKING A NAP UP HERE.',
      'SOMEONE WAKE ADAM UP.', 'ADAM, PRESS A BUTTON.', 'ADAM JUST WATCHING, AS USUAL.',
      'CARRYING ADAM AGAIN, NO BIG DEAL.', 'ADAM WOKE UP AND CHOSE VIOLENCE.',
      'RESPECT FOR ADAM, ACTUALLY TRYING.', 'ADAM\'S GETTING GOOD AT THIS.', 'GO ADAM GO.',
    ],
  };
  function say(state, p, pool) {
    if (state.speech.some(s => s.ownerId === p.id && s.life > 0)) return; // one bubble at a time
    const named = DIALOGUE[pool + '_' + p.name];
    const lines = (named && Math.random() < 0.4) ? named : DIALOGUE[pool];
    const text = lines[Math.floor(Math.random() * lines.length)];
    state.speech.push({ x: p.x, y: p.y, text, life: 2.4, color: p.colors.body, ownerId: p.id });
  }
  function sayEncourage(state, aboutId) {
    const other = state.players.find(pl => pl.id !== aboutId && !pl.carried && !pl.doneThisRound);
    if (other) say(state, other, 'encourage');
  }
  function sayAboutAdam(state) {
    const speaker = state.players.find(pl => !pl.human && !pl.carried && !pl.doneThisRound);
    if (speaker && Math.random() < 0.5) say(state, speaker, 'aboutAdam');
  }

  // ---- combat ----------------------------------------------------------------
  function defeatEnemy(state, enemy, attacker) {
    enemy.alive = false;
    enemy.respawnTimer = rnd(4, 7);
    attacker.score += 40;
    spawnParticles(state, enemy.x, enemy.y || state.rows[enemy.row].y - 8, C.topi);
    SFX.hit();
    state.hitStop = Math.max(state.hitStop, 0.06);
    if (Math.random() < 0.35) say(state, attacker, 'attack');
  }

  // hammering the ice you're standing on shatters it outright — a real,
  // deliberate use for the tool beyond enemy combat, at the obvious cost
  // that you fall through it too (the very next physics tick handles that
  // automatically via the same rowHazardAt check a natural crack-break uses)
  function smashPlatform(state, attacker) {
    const row = state.rows[attacker.groundedRow];
    const plat = row.full ? null : platformAt(row, attacker.x);
    if (!plat) { SFX.hit(); return; }
    plat.broken = true;
    plat.respawnTimer = rnd(2.2, 3.4);
    if (plat.crack) plat.crack.timer = 0;
    attacker.score += 15;
    spawnParticles(state, attacker.x, attacker.y + PLAYER_H, C.ledgeBase, 14);
    SFX.hit();
    state.hitStop = Math.max(state.hitStop, 0.06);
    say(state, attacker, 'breakIce');
  }

  function respawnEnemy(state, e) {
    if (e.type === 'topi') {
      e.row = 1 + Math.floor(Math.random() * (TOP_ROW - 1));
      const plats = state.rows[e.row].platforms;
      e.platIdx = plats && plats.length ? Math.floor(Math.random() * plats.length) : -1;
      const plat = e.platIdx >= 0 ? plats[e.platIdx] : null;
      e.x = plat ? rnd(plat.x + 4 * K, plat.x + plat.w - 4 * K) : rnd(PAD + 10, W - PAD - 10);
      e.dir = Math.random() < 0.5 ? -1 : 1;
    } else {
      const lo = Math.min(2, TOP_ROW - 1);
      e.baseRow = lo + Math.floor(Math.random() * Math.max(1, TOP_ROW - lo));
      e.x = rnd(PAD + 10, W - PAD - 10);
      e.phase = rnd(0, Math.PI * 2);
    }
    e.alive = true;
  }

  // the icicle nearest where a climber actually landed shakes loose and falls
  // — real, and only the one you disturbed, not the whole row at once
  function shakeIcicles(state, row, x) {
    const plat = platformAt(row, x);
    if (!plat || !plat.icicles) return;
    let nearest = null, bestD = Infinity;
    for (const ic of plat.icicles) {
      if (ic.fallen) continue;
      const d = Math.abs(plat.x + ic.off - x);
      if (d < bestD) { bestD = d; nearest = ic; }
    }
    if (!nearest || bestD > 26 * K) return;
    nearest.fallen = true;
    state.icicleShards.push({ x: plat.x + nearest.off + 1.5 * K, y: row.y + PLATFORM_T * 2.2, vy: 20 * K, spin: 0 });
  }

  function updatePlatforms(state, dt) {
    state.rows.forEach((row, i) => {
      if (row.full || !row.platforms) return;
      for (const p of row.platforms) {
        if (p.broken) {
          p.respawnTimer -= dt;
          if (p.respawnTimer <= 0) {
            // respawn near its ORIGINAL spot, not a fresh random position —
            // neighboring ledges were placed reachable from homeX, and a
            // wholly new spot could reintroduce an uncrossable gap
            p.x = clamp(p.homeX + rnd(-12, 12) * K, PAD, W - PAD - p.w);
            for (const ic of p.icicles) ic.fallen = false; // regrown with the fresh ice
            p.broken = false;
            if (p.crack) p.crack.timer = 0;
          }
          continue;
        }

        if (p.drift) {
          p.x += p.drift.speed * p.drift.dir * dt;
          if (p.x < p.drift.min) { p.x = p.drift.min; p.drift.dir = 1; }
          if (p.x > p.drift.max) { p.x = p.drift.max; p.drift.dir = -1; }
        }

        if (p.crack) {
          const occupied = state.players.some(pl =>
            !pl.carried && pl.grounded && pl.groundedRow === i && pl.x > p.x && pl.x < p.x + p.w);
          if (occupied) {
            p.crack.timer += dt;
            if (p.crack.timer >= p.crack.maxTime) { p.broken = true; p.respawnTimer = rnd(2.5, 4); }
          } else {
            p.crack.timer = Math.max(0, p.crack.timer - dt * 0.6);
          }
        }
      }
    });
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
        const plat = e.platIdx >= 0 && row.platforms ? row.platforms[e.platIdx] : null;
        // patrols stay on its own short ledge — the row band is mostly open
        // air now, so a full-width patrol would walk the topi off into space
        const lo = plat ? plat.x + 4 * K : PAD + 8, hi = plat ? plat.x + plat.w - 4 * K : W - PAD - 8;
        e.x += e.dir * e.speed * dt;
        if (e.x < lo) { e.x = lo; e.dir = 1; }
        if (e.x > hi) { e.x = hi; e.dir = -1; }
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
      if (input.attackTarget === 'ice') smashPlatform(state, p);
      else defeatEnemy(state, input.attackTarget, p);
      return;
    }

    // icy footing: velocity eases toward the target instead of snapping, so
    // starting, stopping and turning all carry a bit of a slide.
    const moveSpeed = (p.grounded ? MOVE_SPEED : AIR_MOVE_SPEED) * state.speedBoost;
    let targetVx = 0;
    if (p.stun <= 0) {
      if (input.left) { targetVx = -moveSpeed; p.facing = -1; }
      if (input.right) { targetVx = moveSpeed; p.facing = 1; }
    }
    const accel = (targetVx === 0 ? 520 : 780) * K;
    if (p.vx < targetVx) p.vx = Math.min(targetVx, p.vx + accel * dt);
    else if (p.vx > targetVx) p.vx = Math.max(targetVx, p.vx - accel * dt);

    if (p.stun <= 0) {
      if (input.jump && p.grounded) {
        p.vy = JUMP_VY * state.jumpBoost; p.grounded = false; p.lastJumpRow = p.groundedRow; SFX.jump();
      }
    }
    // AI always holds for the full, tuned apex (matches the row-clearance
    // margins everything else is built on); a human can let go early to cut
    // the jump short, exactly like the original Mario variable-height jump.
    const holdingJump = p.human ? keys.up : true;
    const gravityMult = (p.vy < 0 && holdingJump) ? ASCEND_MULT : DESCEND_MULT;
    p.vy += GRAVITY * gravityMult * dt;
    if (p.bonusPhase) p.x = clamp(p.x + p.vx * dt, PAD, W - PAD); // small contained zone
    else p.x = wrap(p.x + p.vx * dt, W); // main field: walk off one edge, appear on the other

    const prevBottom = p.y + PLAYER_H;
    p.y += p.vy * dt;
    let bottom = p.y + PLAYER_H;
    let top = p.y;

    if (!p.bonusPhase) {
      if (p.grounded) {
        const row = state.rows[p.groundedRow];
        if (rowHazardAt(row, p.x)) p.grounded = false;
        else {
          const standing = platformAt(row, p.x);
          if (standing && standing.drift) p.x = wrap(p.x + standing.drift.dir * standing.drift.speed * dt, W); // ride the platform
        }
      }
      let landedRow = false;
      if (p.vy >= 0) {
        for (let i = 0; i <= TOP_ROW; i++) {
          const row = state.rows[i];
          if (rowHazardAt(row, p.x)) continue;
          if (prevBottom <= row.y && bottom >= row.y) {
            p.y = row.y - PLAYER_H; p.vy = 0; p.grounded = true; p.groundedRow = i;
            bottom = p.y + PLAYER_H;
            landedRow = true;
            if (!row.full) shakeIcicles(state, row, p.x);
            if (p.lastJumpRow >= 0) {
              // did that jump actually gain a floor, or land back where it started?
              p.stuckCount = i > p.lastJumpRow ? 0 : p.stuckCount + 1;
              p.lastJumpRow = -1;
            }
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

      // hard ceiling on the bonus stage itself — a jump arc shouldn't be able
      // to carry a climber far above the condor; this also keeps the camera's
      // job bounded, since it only has to reveal a fixed amount above the peak
      const bonusCeiling = state.condor.y - 60 * K;
      if (p.y < bonusCeiling) { p.y = bonusCeiling; if (p.vy < 0) p.vy = 0; }

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
    updateCamera(state, dt);

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
      if (Math.random() < 0.5) say(state, p3, 'hopOut');
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
          if (Math.random() < 0.5) say(state, nearest, 'carried');
        }
      }
    }

    // automatic: moving/attacking hops you out; going quiet for IDLE_TIMEOUT_MS gets you carried
    const humanActive = (performance.now() - lastHumanInput) < IDLE_TIMEOUT_MS;
    if (p3.carried && humanActive) {
      hopOut();
    } else if (!p3.carried && !humanActive) {
      const { nearest } = nearestCompanion();
      const carrier = nearest || state.players[0];
      p3.carried = true; p3.carrierId = carrier.id;
      if (Math.random() < 0.5) say(state, carrier, 'carried');
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

    updatePlatforms(state, dt);
    updateEnemies(state, dt);

    // fall too far behind the camera's view of the action — same as the real
    // game's screen-scroll kill — and you're swept back in near the leader's
    // current floor rather than left to climb all the way back up alone
    {
      const approxLeaderY = state.cameraY + H * CAMERA_ANCHOR;
      const leaderRow = clamp(Math.round((START_Y - approxLeaderY) / ROW_H), 0, TOP_ROW);
      for (const p of state.players) {
        if (p.carried || p.doneThisRound || p.bonusPhase || p.invuln > 0) continue;
        const screenY = p.y - state.cameraY;
        if (screenY <= H + 40 * K) continue;
        const target = clamp(leaderRow - 1, 0, TOP_ROW);
        const row = state.rows[target];
        p.groundedRow = target;
        const landPlat = row.full || !row.platforms || !row.platforms.length ? null
          : row.platforms.reduce((a, b) => Math.abs(a.x + a.w / 2 - p.x) < Math.abs(b.x + b.w / 2 - p.x) ? a : b);
        p.x = landPlat
          ? clamp(p.x, landPlat.x + 6 * K, landPlat.x + landPlat.w - 6 * K)
          : clamp(p.x, PAD + 6 * K, W - PAD - 6 * K);
        p.y = row.y - PLAYER_H; p.vx = 0; p.vy = 0; p.grounded = true;
        p.invuln = INVULN_TIME; p.stun = 0.2;
        p.stuckCount = 0; p.lastJumpRow = -1; p.avoidTimer = 0; p.safeTimer = 0;
        p.falls++;
        spawnParticles(state, p.x, p.y, C.bear, 10);
        say(state, p, 'fall');
      }
    }

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

    // same world-space/camera-anchoring fix as the durians below — a fixed
    // screen y would silently fall out of view once the camera scrolls
    state.vegTimer -= dt;
    if (state.vegTimer <= 0) {
      state.vegTimer = rnd(3.5, 6);
      state.veggies.push({ x: rnd(20 * K, W - 20 * K), y: state.cameraY - 20 * K, vy: 42 * K });
    }
    for (let i = state.veggies.length - 1; i >= 0; i--) {
      const v = state.veggies[i];
      v.y += v.vy * dt;
      let caught = false;
      for (const p of state.players) {
        if (p.carried || p.doneThisRound) continue;
        if (Math.abs(wrapDelta(v.x, p.x, W)) < 15 * K && Math.abs(v.y - (p.y + PLAYER_H / 2)) < 16 * K) {
          p.score += 30; spawnParticles(state, v.x, v.y, C.veg); SFX.veg();
          if (Math.random() < 0.3) say(state, p, 'veggie');
          caught = true; break;
        }
      }
      if (caught) { state.veggies.splice(i, 1); continue; }
      if (v.y > state.cameraY + H + 20 * K) state.veggies.splice(i, 1);
    }

    state.adamCommentTimer -= dt;
    if (state.adamCommentTimer <= 0) {
      state.adamCommentTimer = rnd(16, 26);
      sayAboutAdam(state);
    }

    if (state.activeEvent && state.clock > state.eventUntil) clearEvent(state);
    state.eventTimer -= dt;
    if (state.eventTimer <= 0) {
      state.eventTimer = rnd(22, 34);
      triggerRandomEvent(state);
    }
    if (state.eventBanner) {
      state.eventBanner.life -= dt;
      if (state.eventBanner.life <= 0) state.eventBanner = null;
    }

    // durians spawn/despawn in WORLD space, but the mountain scrolls under the
    // camera now — anchor both to state.cameraY, not a fixed screen coordinate,
    // or a spawned durian silently falls somewhere the camera has already left
    const durianStormActive = state.clock < state.durianStormUntil;
    const spawnY = state.cameraY - 30 * K;
    state.durianTimer -= dt;
    if (state.durianTimer <= 0) {
      // multiple durians at once, falling from staggered heights across the
      // width, ALWAYS — not one lone durian with a storm as the only time
      // more than one exists. A storm is a bigger, faster, denser version of
      // the same wave, not a separate mode.
      const waveCount = durianStormActive ? 4 + Math.floor(Math.random() * 3) : 3 + Math.floor(Math.random() * 3);
      state.durianTimer = durianStormActive ? rnd(0.7, 1.1) : rnd(1.0, 1.6);
      const vy = (durianStormActive ? 95 : 65) * K;
      const lane = (W - 40 * K) / waveCount;
      for (let w = 0; w < waveCount; w++) {
        state.durians.push({
          x: 20 * K + lane * (w + 0.5) + rnd(-lane * 0.3, lane * 0.3),
          y: spawnY - rnd(0, 70 * K), vy, spin: rnd(0, 6),
        });
      }
    }
    for (let i = state.durians.length - 1; i >= 0; i--) {
      const d = state.durians[i];
      d.y += d.vy * dt;
      d.spin += dt * 6;
      let hit = false;
      for (const p of state.players) {
        if (p.carried || p.doneThisRound || p.invuln > 0) continue;
        if (Math.abs(wrapDelta(d.x, p.x, W)) < 16 * K && Math.abs(d.y - (p.y + PLAYER_H / 2)) < 17 * K) {
          resetToBottom(state, p);
          hit = true; break;
        }
      }
      if (hit) { state.durians.splice(i, 1); continue; }
      if (d.y > state.cameraY + H + 20 * K) state.durians.splice(i, 1);
    }

    for (let i = state.icicleShards.length - 1; i >= 0; i--) {
      const s = state.icicleShards[i];
      s.vy += 500 * K * dt; // heavier, faster fall than a tumbling durian — it's a shard of ice, not fruit
      s.y += s.vy * dt;
      s.spin += dt * 8;
      let hit = false;
      for (const p of state.players) {
        if (p.carried || p.doneThisRound || p.invuln > 0) continue;
        if (Math.abs(wrapDelta(s.x, p.x, W)) < 10 * K && Math.abs(s.y - (p.y + PLAYER_H / 2)) < 14 * K) {
          resetToBottom(state, p);
          hit = true; break;
        }
      }
      if (hit) { state.icicleShards.splice(i, 1); continue; }
      if (s.y > state.cameraY + H + 20 * K) state.icicleShards.splice(i, 1);
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

  // two-layer ledge — an icy crust over a packed-ice base, like a snowbound
  // take on grass-over-dirt — with a few deterministic sparkle flecks on top.
  function drawTile(x, y, w, thickness, isIsland) {
    if (w <= 0) return;
    x = Math.round(x); y = Math.round(y); w = Math.round(w);
    const crustH = Math.round(thickness * 0.4);
    ctx.fillStyle = isIsland ? C.islandBase : C.ledgeBase;
    ctx.fillRect(x, y + crustH, w, thickness - crustH);
    ctx.fillStyle = isIsland ? C.islandCrust : C.ledge;
    ctx.fillRect(x, y, w, crustH);
    ctx.fillStyle = C.ledgeEdge;
    ctx.fillRect(x, y, w, 2 * K);
    // brick-block mortar lines — every short platform reads as a stack of
    // cut ice blocks (matching the reference art) rather than one smooth slab
    const block = 16 * K;
    for (let bx = x + block; bx < x + w - 2 * K; bx += block) {
      ctx.fillRect(Math.round(bx), y, Math.max(1, Math.round(1 * K)), thickness);
    }
    ctx.fillStyle = C.ledgeShade;
    const step = 14 * K;
    for (let fx = Math.ceil(x / step) * step; fx < x + w - 4 * K; fx += step) {
      if (Math.floor(fx / step) % 2 === 0) ctx.fillRect(fx, y + crustH * 0.4, 3 * K, 2 * K);
    }
  }

  // crack progress lives on the platform itself now (one short ledge, not a
  // gap carved into a full-width row) — draw the ledge, then overlay stress lines
  function drawCrackTile(plat, y, thickness) {
    drawTile(plat.x, y, plat.w, thickness, true);
    const crack = plat.crack;
    const t = clamp(crack.timer / crack.maxTime, 0, 1);
    if (t < 0.15) return; // fresh ice, no visible stress yet
    const lines = Math.min(4, Math.ceil(t * 4));
    ctx.fillStyle = t > 0.7 ? C.durianSpike : C.ceilCrack;
    for (let l = 0; l < lines; l++) {
      const cx = Math.round(plat.x + (l + 0.5) * (plat.w / lines));
      ctx.fillRect(cx, y, 2 * K, Math.round(thickness * 0.55));
    }
  }

  // ---- rendering ----------------------------------------------------------------
  function draw(state) {
    // flat banded sky, not a smooth gradient — real NES hardware had no
    // interpolated blends, only flat tile colors (palette swapped per band).
    // As the round timer runs out the palette steps toward red — three discrete
    // stages, not a smooth fade, same "hard cel swap" language as everything else.
    const urgency = state.bearActive
      ? clamp((state.roundTime - PRESSURE_DELAY) / Math.max(1, MAX_ROUND_TIME - PRESSURE_DELAY), 0, 1)
      : 0;
    const sky = urgency > 0.75 ? [C.skyDanger1, C.skyDanger3, C.skyDanger2]
      : urgency > 0.4 ? [C.skyWarn1, C.skyWarn3, C.skyWarn2]
      : [C.sky1, C.sky3, C.sky2];
    const bandH = H / 3;
    ctx.fillStyle = sky[0]; ctx.fillRect(0, 0, W, bandH);
    ctx.fillStyle = sky[1]; ctx.fillRect(0, bandH, W, bandH);
    ctx.fillStyle = sky[2]; ctx.fillRect(0, bandH * 2, W, H - bandH * 2);

    // gentle wind streaks drifting through the upper sky — purely decorative,
    // computed straight from the clock so no extra state is needed
    ctx.fillStyle = 'rgba(238,243,255,0.10)';
    for (let i = 0; i < 5; i++) {
      const wx = wrap(i * 173.2 - state.clock * (26 + i * 6), W + 40) - 20;
      const wy = wrap(i * 61.4, bandH * 1.3) + 10;
      ctx.fillRect(Math.round(wx), Math.round(wy), 22 * K, 1.5 * K);
    }

    // stars twinkle on a hard on/off cel, each with its own phase so they
    // don't all blink together
    ctx.fillStyle = C.starFar;
    for (let i = 0; i < 16; i++) {
      if (Math.floor((state.clock * 1.4 + i * 0.6)) % 3 === 0) continue;
      const x = wrap(i * 61.3 - parallax.x * 0.4, W);
      const y = wrap(i * 97.1, H);
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
    ctx.fillStyle = C.starNear;
    for (let i = 0; i < 14; i++) {
      if (Math.floor((state.clock * 1.7 + i * 0.9)) % 4 === 0) continue;
      const x = wrap(i * 53.7 - parallax.x, W);
      const y = wrap(i * 91.3 - parallax.y * 0.6, H);
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    }

    // a distant stalagmite layer at half scroll speed — real depth, not just
    // empty dark bands between ledges — sitting behind everything else
    ctx.save();
    ctx.translate(0, -state.cameraY * 0.5);
    // stepped pixel bands, not a smooth canvas path — a lineTo triangle
    // anti-aliases its diagonal edges, which clashes with the hard-edged
    // fillRect look everything else on screen uses
    ctx.fillStyle = C.wallShade;
    for (let i = 0; i < 26; i++) {
      const bx = wrap(i * 137.7, W);
      const baseY = i * 210 - 380;
      const bw = 20 * K + (i % 3) * 8 * K;
      const bh = 30 * K + (i % 4) * 16 * K;
      const steps = 6;
      const stepH = bh / steps;
      for (let s = 0; s < steps; s++) {
        const rowW = bw * (1 - s / steps) + 2 * K;
        const rx = bx - rowW / 2;
        const ry = baseY + bh - (s + 1) * stepH;
        ctx.fillRect(Math.round(rx), Math.round(ry), Math.round(rowW), Math.round(stepH) + 1);
      }
    }
    ctx.restore();

    // everything below is world-space and scrolls with the climb; the sky above
    // stays fixed, matching how the original game never scrolled its backdrop
    ctx.save();
    ctx.translate(0, -state.cameraY);

    // slow drifting snow through the whole climb, not just the fixed starfield
    // up top — the middle of a long ascent was otherwise just flat empty color
    ctx.fillStyle = 'rgba(238,243,255,0.16)';
    for (let i = 0; i < 22; i++) {
      const sx = wrap(i * 97.3 + Math.sin(state.clock * 0.5 + i) * 14 * K, W);
      const sy = wrap(i * 233.1 - state.clock * (10 + (i % 5) * 3), H * 2.4) + state.cameraY - H * 0.3;
      ctx.fillRect(Math.round(sx), Math.round(sy), 2 * K, 2 * K);
    }

    const rows = state.rows;

    // jagged icy cave walls frame the climb on both edges — decorative only,
    // players still wrap through them, but it reads as a mountain interior
    // rather than open space, matching the reference art's rock border
    const wallW = 13 * K; // stays inside PAD so it never visually collides with a platform edge
    for (let i = 0; i <= TOP_ROW; i++) {
      const bandY = Math.round(rows[i].y - ROW_H);
      const bandH = Math.round(ROW_H) + 1;
      const jagL = Math.round((Math.sin(i * 2.7) * 0.5 + 0.5) * 5 * K);
      const jagR = Math.round((Math.sin(i * 1.9 + 1.3) * 0.5 + 0.5) * 5 * K);
      const lW = Math.round(wallW + jagL), rW = Math.round(wallW + jagR);
      ctx.fillStyle = C.wallBody;
      ctx.fillRect(0, bandY, lW, bandH);
      ctx.fillRect(W - rW, bandY, rW, bandH);
      ctx.fillStyle = C.wallShade;
      ctx.fillRect(0, bandY, Math.round(lW * 0.4), bandH);
      ctx.fillRect(W - Math.round(rW * 0.4), bandY, Math.round(rW * 0.4), bandH);
      ctx.fillStyle = C.wallHi;
      ctx.fillRect(lW - 3 * K, bandY, 3 * K, bandH);
      ctx.fillRect(W - rW, bandY, 3 * K, bandH);
      // a couple of chipped ice-block notches per band for a rougher silhouette
      ctx.fillStyle = C.sky3;
      ctx.fillRect(Math.round(lW * 0.55), bandY + Math.round(bandH * 0.3), Math.round(4 * K), Math.round(6 * K));
      ctx.fillRect(W - Math.round(rW * 0.75), bandY + Math.round(bandH * 0.6), Math.round(4 * K), Math.round(6 * K));
    }

    const baseT = PLATFORM_T * 2.2; // thicker two-layer ledge: icy crust over packed base
    ctx.textAlign = 'left';
    ctx.font = `${Math.round(11 * K)}px 'Press Start 2P', 'Courier New', monospace`;
    for (let i = 0; i <= TOP_ROW; i++) {
      const row = rows[i], y = row.y;
      if (row.full) {
        drawTile(0, y, W, baseT, false);
      } else if (row.platforms) {
        for (const plat of row.platforms) {
          if (plat.broken) continue;
          if (plat.crack) drawCrackTile(plat, y, baseT);
          else drawTile(plat.x, y, plat.w, baseT, true);
          // stalactites hanging off the underside — jarred loose and fall when
          // someone lands on the ice above; a short ledge in open air otherwise
          // reads as bare and empty below it
          ctx.fillStyle = C.ledgeEdge;
          for (const ic of plat.icicles) {
            if (ic.fallen) continue;
            const icx = plat.x + ic.off;
            const drop = (Math.sin(icx * 0.13 + i) * 0.5 + 0.5) * 7 * K + 4 * K;
            ctx.fillRect(Math.round(icx), Math.round(y + baseT), Math.round(3 * K), Math.round(drop));
          }
        }
      }
      // per-row altitude marker along the cave wall, like the reference image
      if (i > 0 && i < TOP_ROW) {
        ctx.fillStyle = C.numGold;
        ctx.fillText(String(i), 2 * K, Math.round(y - 4 * K));
      }
    }

    // bonus stepping-stones match the rest of the mountain's ice-block look
    // now instead of a bare flat rect — the summit shouldn't look cheaper
    // than the climb that led to it
    for (const plat of state.bonusPlatforms) {
      drawTile(plat.x, plat.y, plat.w, baseT * 0.75, true);
    }

    // a real podium under the trophy, not a condor floating bare in empty
    // space — plus a small planted flag as the clear "you made it" beat
    const podiumW = 74 * K;
    const podiumX = state.condor.x - podiumW / 2;
    const podiumY = state.condor.y + 22 * K;
    drawTile(podiumX, podiumY, podiumW, baseT * 0.75, true);
    const poleX = state.condor.x - podiumW * 0.28, poleTop = podiumY - 28 * K;
    ctx.fillStyle = C.numGold;
    ctx.fillRect(Math.round(poleX), Math.round(poleTop), 2 * K, 28 * K);
    // stepped pennant, not a smooth lineTo path — same hard-pixel rule as
    // the background stalagmites below
    for (let s = 0; s < 5; s++) {
      const rowW = (13 * K) * (1 - s / 5) + 2 * K;
      ctx.fillRect(Math.round(poleX + 2 * K), Math.round(poleTop + s * 2 * K), Math.round(rowW), 2 * K);
    }

    // a slow ring of gold sparkle points behind the condor — a triumphant
    // focal point instead of the trophy just sitting in flat dark sky
    ctx.fillStyle = C.numGold;
    for (let r = 0; r < 8; r++) {
      const ang = (r / 8) * Math.PI * 2 + state.clock * 0.6;
      if (Math.floor(state.clock * 2 + r) % 3 === 0) continue; // hard on/off twinkle, not a fade
      const rx = state.condor.x + Math.cos(ang) * 34 * K;
      const ry = state.condor.y + Math.sin(ang) * 22 * K;
      ctx.fillRect(Math.round(rx), Math.round(ry), 2 * K, 2 * K);
    }

    drawCondor(state.condor.x, state.condor.y, state.condorAnim.f);

    for (const v of state.veggies) {
      const vx = Math.round(v.x), vy = Math.round(v.y);
      ctx.fillStyle = C.vegLeaf; ctx.fillRect(vx - 2 * K, vy - 6 * K, 4 * K, 3 * K);
      ctx.fillStyle = C.veg; ctx.fillRect(vx - 4 * K, vy - 3 * K, 8 * K, 7 * K);
    }

    for (const d of state.durians) {
      const dx = Math.round(d.x), dy = Math.round(d.y);
      const rx = 9 * K, ry = 8 * K; // slightly oval husk, not a perfect ball
      const wobble = Math.sin(d.spin) > 0 ? 1 : -1; // discrete tumble, no smooth rotation
      ctx.fillStyle = C.durian;
      ctx.beginPath();
      ctx.ellipse(dx + wobble, dy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      // a real durian husk is covered in many small thorns, not eight big
      // mace-like points — dense small spikes read as spiky fruit, not a mine
      ctx.fillStyle = C.durianSpike;
      const spikeCount = 14;
      for (let s = 0; s < spikeCount; s++) {
        const ang = (s / spikeCount) * Math.PI * 2 + d.spin * 0.4;
        const sx = dx + Math.cos(ang) * rx * 0.95;
        const sy = dy + Math.sin(ang) * ry * 0.95;
        ctx.fillRect(Math.round(sx - K), Math.round(sy - K), 2 * K, 2 * K);
      }
      // one soft highlight patch for roundness — flat cel shading, not a gradient
      ctx.fillStyle = C.durianHi;
      ctx.beginPath();
      ctx.ellipse(dx - rx * 0.3, dy - ry * 0.3, rx * 0.32, ry * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const s of state.icicleShards) {
      const sx = Math.round(s.x), sy = Math.round(s.y);
      const wobble = Math.sin(s.spin) > 0 ? 1 : -1;
      // stepped pixel shard, not a smooth lineTo path — same hard-edge rule
      ctx.fillStyle = C.ledgeEdge;
      for (let s = 0; s < 5; s++) {
        const rowW = (6 * K) * (1 - s / 5) + 1 * K;
        ctx.fillRect(Math.round(sx - rowW / 2 + wobble), Math.round(sy - 6 * K + s * 3 * K), Math.round(rowW), 3 * K);
      }
      ctx.fillStyle = C.ledge;
      ctx.fillRect(sx - 1 * K, sy - 5 * K, 2 * K, 5 * K);
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

    ctx.restore(); // back to screen-space for fixed overlays below

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

    if (state.eventBanner && !(state.eventBanner.life < 0.3 && Math.floor(state.eventBanner.life * 12) % 2 === 0)) {
      const by = HUD_CLEARANCE + 14 * K;
      ctx.font = `${Math.round(16 * K)}px "VT323", monospace`;
      ctx.textAlign = 'center';
      const tw = ctx.measureText(state.eventBanner.text).width;
      ctx.fillStyle = 'rgba(11,16,36,0.75)';
      ctx.fillRect(W / 2 - tw / 2 - 10 * K, by - 14 * K, tw + 20 * K, 22 * K);
      ctx.fillStyle = state.eventBanner.color;
      ctx.fillText(state.eventBanner.text, W / 2, by + 3 * K);
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
    if (!swinging) drawHeldItem(p, x, y, headH);

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

  function drawHeldItem(p, x, y, headH) {
    if (!p.colors.held) return;
    const hx = p.facing > 0 ? x + PLAYER_W : x - 11 * K;
    const hy = y + headH + 2 * K;
    switch (p.colors.held) {
      case 'lollipop':
        ctx.fillStyle = p.colors.dark;
        ctx.fillRect(hx + 4 * K, hy, 3 * K, 14 * K); // stick
        ctx.fillStyle = '#ff6bcb';
        ctx.fillRect(hx, hy - 11 * K, 11 * K, 11 * K); // candy head
        ctx.fillStyle = '#eef3ff';
        ctx.fillRect(hx + 3 * K, hy - 8 * K, 3 * K, 3 * K); // swirl fleck
        ctx.fillRect(hx + 6 * K, hy - 5 * K, 2 * K, 2 * K);
        break;
      case 'chicken':
        ctx.fillStyle = '#8a5a2f';
        ctx.fillRect(hx, hy, 13 * K, 9 * K); // meat
        ctx.fillStyle = '#6a4322';
        ctx.fillRect(hx, hy + 6 * K, 13 * K, 3 * K); // shading
        ctx.fillStyle = '#e8d3a8';
        ctx.fillRect(hx + (p.facing > 0 ? 9 * K : -6 * K), hy + 2 * K, 7 * K, 3 * K); // bone
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

  const musicBtn = document.getElementById('music-btn');
  musicBtn.classList.toggle('muted', true);
  musicBtn.addEventListener('click', () => {
    const on = BGM.toggle();
    musicBtn.classList.toggle('muted', !on);
  });

  g = newGame();
  window.__autoclimb = g;
  window.__autoclimbTick = (dt) => stepPhysics(g, dt ?? FIXED_DT); // debug hook, bypasses rAF throttling
  window.__autoclimbDraw = () => draw(g); // debug hook, force a repaint without waiting on rAF
  requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
})();
