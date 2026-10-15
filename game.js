(() => {
  'use strict';

  // ---------- Tuning ----------
  const W = 900, H = 640;
  const ARENA = { x: W / 2, y: H / 2 + 10, r: 255 };
  const WIN_SCORE = 3;
  const ACCEL = 1150;          // px/s² while holding a direction
  const DRAG = 2.4;            // velocity decay per second (higher = less slippery)
  const DASH_SPEED = 520;      // instant speed boost from a dash
  const DASH_COOLDOWN = 1.1;   // seconds
  const RESTITUTION = 0.85;    // bounciness of collisions
  const STEP = 1 / 120;        // fixed physics step

  const FONT = '"Segoe UI", "Helvetica Neue", Arial, "Noto Sans Hebrew", sans-serif';
  const TEXT = '#f1ece3';
  const MUTED = '#9b968d';
  const DUST = '#d9c49c';
  const INK = '#2a231d';   // dark text drawn directly on the sand

  const PLAYER_DEFS = [
    {
      defaultName: 'Player 1', color: '#d9434f', dark: '#8f222c',
      keys: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', dash: ['Space'] },
      startX: ARENA.x - 110, facing: 0,
    },
    {
      defaultName: 'Player 2', color: '#3f80d8', dark: '#1f4c8f',
      keys: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', dash: ['Enter', 'NumpadEnter'] },
      startX: ARENA.x + 110, facing: Math.PI,
    },
  ];

  // ---------- Setup ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('overlay');
  const menuPanel = document.getElementById('menuPanel');
  const overPanel = document.getElementById('overPanel');
  const winnerText = document.getElementById('winnerText');
  const finalScore = document.getElementById('finalScore');
  const roundLabel = document.getElementById('roundLabel');
  const pipEls = [document.getElementById('p1Pips'), document.getElementById('p2Pips')];
  const scoreEls = [document.getElementById('p1Score'), document.getElementById('p2Score')];
  const nameEls = [document.getElementById('p1Name'), document.getElementById('p2Name')];
  const nameInputs = [document.getElementById('p1Input'), document.getElementById('p2Input')];

  let currentDpr = 0;
  let arenaLayer = null; // the static arena is pre-rendered once per pixel ratio
  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (dpr === currentDpr) return; // resizing the canvas clears it, so only do it when needed
    currentDpr = dpr;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    arenaLayer = buildArenaLayer(dpr);
  }

  // ---------- Mode ----------
  const CPU_NAME = 'Computer';
  const modeRadios = [...document.querySelectorAll('input[name="mode"]')];
  let mode = (modeRadios.find(r => r.checked) || {}).value || 'duo'; // 'solo' (vs computer) | 'duo'
  const isCpu = i => mode === 'solo' && i === 1;
  // In solo the human (Player 1) plays with the arrow keys and Enter.
  const keysFor = i => (mode === 'solo' ? PLAYER_DEFS[1] : PLAYER_DEFS[i]).keys;

  function showMode() {
    document.body.classList.toggle('mode-solo', mode === 'solo');
  }
  // the scoreboard follows the choice right away ("Computer" in solo)
  modeRadios.forEach(r => r.addEventListener('change', () => { mode = r.value; showMode(); applyNames(); }));
  showMode();

  // ---------- Input ----------
  const held = new Set();
  const GAME_KEYS = new Set();
  PLAYER_DEFS.forEach(d => {
    Object.values(d.keys).flat().forEach(k => GAME_KEYS.add(k));
  });

  function isTyping(e) {
    const t = e.target;
    return t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  window.addEventListener('keydown', e => {
    if (isTyping(e)) return; // typing a name must never move or dash
    // while a menu or the winner screen is up, keys keep their normal job (Enter presses a button)
    if (!overlay.classList.contains('hidden')) return;
    if (GAME_KEYS.has(e.code)) e.preventDefault(); // stop arrows/space scrolling the page
    held.add(e.code);
    if (!e.repeat) {
      players.forEach((p, i) => {
        if (!isCpu(i) && keysFor(i).dash.includes(e.code)) p.dashQueued = true;
      });
    }
  });
  window.addEventListener('keyup', e => held.delete(e.code));
  window.addEventListener('blur', () => held.clear());
  nameInputs.forEach(input => input.addEventListener('focus', () => held.clear()));

  // ---------- Sound (tiny synth, no files) ----------
  let audio = null;
  function initAudio() {
    if (!audio) {
      try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { audio = null; }
    }
    if (audio && audio.state === 'suspended') audio.resume();
  }
  function tone(freq, dur = 0.12, type = 'sine', vol = 0.15, slide = 0, delay = 0) {
    if (!audio) return;
    const t = audio.currentTime + delay;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + dur);
  }
  // Low, drum-like thuds instead of arcade beeps.
  const sfx = {
    bump: power => tone(90 + power * 0.12, 0.22, 'sine', Math.min(0.45, 0.12 + power / 1200), -50),
    dash: () => tone(180, 0.1, 'triangle', 0.08, 120),
    beep: () => tone(440, 0.09, 'sine', 0.1),
    go: () => { tone(110, 0.35, 'sine', 0.35, -50); tone(660, 0.18, 'triangle', 0.06); },
    fall: () => tone(160, 0.5, 'sine', 0.3, -100),
    fanfare: () => [220, 277, 330, 440].forEach((f, i) => tone(f, 0.5, 'triangle', 0.08, 0, i * 0.13)),
  };

  // ---------- Music (generated, no files) ----------
  // A 4-bar loop at 128 BPM: taiko-style drums, a tense bass ostinato and a sparse melody in
  // the Japanese "in" scale (D Eb G A Bb). Notes are scheduled slightly ahead on the audio clock,
  // and everything goes through one music bus so it can be faded out as a whole.
  const MUSIC_VOL = 0.22;             // bus level; sound effects stay well above it
  const STEP_DUR = 60 / 128 / 4;      // one 16th note
  const LOOP_STEPS = 64;
  const NOTE = { C2: 65.41, D2: 73.42, Eb2: 77.78, A1: 55, Bb1: 58.27, D4: 293.66, Eb4: 311.13, G4: 392, A4: 440, Bb4: 466.16, D5: 587.33 };
  const BASS = [ // one note per 8th, 8 per bar
    'D2', 'D2', 'D2', 'D2', 'D2', 'D2', 'Eb2', 'D2',
    'D2', 'D2', 'D2', 'D2', 'C2', 'C2', 'Eb2', 'Eb2',
    'Bb1', 'Bb1', 'Bb1', 'Bb1', 'A1', 'A1', 'Eb2', 'D2',
    'D2', 'D2', 'D2', 'D2', 'D2', 'Eb2', 'D2', 'C2',
  ];
  const MELODY = { // step: [note, length in steps]
    0: ['A4', 6], 6: ['Bb4', 2], 8: ['A4', 8],
    16: ['G4', 4], 20: ['A4', 4], 24: ['Eb4', 8],
    32: ['D5', 6], 38: ['Bb4', 2], 40: ['A4', 6], 46: ['G4', 2],
    48: ['A4', 4], 52: ['Eb4', 4], 56: ['D4', 8],
  };
  const KICK_STEPS = [0, 6, 8, 14];
  const KICK_FILL = [0, 6, 8, 10, 12, 13, 14, 15]; // last bar builds into the loop

  let musicOn = true;
  try { musicOn = localStorage.getItem('sumo-music') !== 'off'; } catch (_) { /* storage blocked */ }
  let musicStarted = false; // set at the first Start, so music never plays before that
  let musicBus = null, musicTimer = null, musicStep = 0, musicNext = 0, noiseBuf = null;

  function voice(t, dur, vol, build) {
    const g = audio.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    g.connect(musicBus);
    build(g);
  }
  function noise(t, dur, vol, filterType, freq, q = 1) {
    voice(t, dur, vol, g => {
      const src = audio.createBufferSource();
      src.buffer = noiseBuf;
      const f = audio.createBiquadFilter();
      f.type = filterType; f.frequency.value = freq; f.Q.value = q;
      src.connect(f).connect(g);
      src.start(t); src.stop(t + dur);
    });
  }
  function drum(t, vol) { // deep taiko hit: falling sine plus a soft skin slap
    voice(t, 0.4, vol, g => {
      const o = audio.createOscillator();
      o.frequency.setValueAtTime(120, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.14);
      o.connect(g); o.start(t); o.stop(t + 0.4);
    });
    noise(t, 0.04, vol * 0.25, 'lowpass', 900);
  }
  function bass(t, freq, dur) {
    voice(t, dur, 0.28, g => {
      const o = audio.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      const f = audio.createBiquadFilter();
      f.type = 'lowpass'; f.Q.value = 6;
      f.frequency.setValueAtTime(900, t);
      f.frequency.exponentialRampToValueAtTime(220, t + dur);
      o.connect(f).connect(g); o.start(t); o.stop(t + dur);
    });
  }
  function lead(t, freq, dur) { // breathy, flute-like line with gentle vibrato
    const g = audio.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.06);
    g.gain.setValueAtTime(0.07, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    g.connect(musicBus);
    const o = audio.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const lfo = audio.createOscillator();
    const depth = audio.createGain();
    lfo.frequency.value = 5.5; depth.gain.value = freq * 0.006;
    lfo.connect(depth).connect(o.frequency);
    o.connect(g);
    o.start(t); lfo.start(t); o.stop(t + dur); lfo.stop(t + dur);
  }

  function playStep(step, t) {
    const inBar = step % 16, lastBar = step >= 48;
    if ((lastBar ? KICK_FILL : KICK_STEPS).includes(inBar)) drum(t, inBar === 0 ? 0.9 : 0.6);
    if (inBar === 4 || inBar === 12) noise(t, 0.05, 0.22, 'bandpass', 1900, 2.5); // rim click
    noise(t, 0.03, inBar % 2 ? 0.03 : 0.07, 'highpass', 7000);                      // shaker
    if (step % 2 === 0) bass(t, NOTE[BASS[step / 2]], STEP_DUR * 1.8);
    const m = MELODY[step];
    if (m) lead(t, NOTE[m[0]], STEP_DUR * m[1]);
  }

  function scheduleMusic() {
    const now = audio.currentTime;
    if (musicNext < now - 0.2) musicNext = now + 0.05; // tab was in the background: skip ahead, don't burst
    while (musicNext < now + 0.12) {
      playStep(musicStep, musicNext);
      musicStep = (musicStep + 1) % LOOP_STEPS;
      musicNext += STEP_DUR;
    }
  }

  // Safe to call any number of times: there is only ever one loop running.
  function startMusic() {
    if (!audio || !musicOn || !musicStarted || musicTimer) return;
    if (!noiseBuf) {
      noiseBuf = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    musicBus = audio.createGain();
    musicBus.gain.value = MUSIC_VOL;
    musicBus.connect(audio.destination);
    musicStep = 0;
    musicNext = audio.currentTime + 0.06;
    scheduleMusic();
    musicTimer = setInterval(scheduleMusic, 25);
  }

  function stopMusic() {
    if (!musicTimer) return;
    clearInterval(musicTimer);
    musicTimer = null;
    const bus = musicBus; // notes already queued on this bus fade out with it
    musicBus = null;
    bus.gain.setTargetAtTime(0, audio.currentTime, 0.03);
    setTimeout(() => bus.disconnect(), 500);
  }

  const musicBtn = document.getElementById('musicBtn');
  function showMusicSetting() {
    musicBtn.textContent = musicOn ? 'Music: On' : 'Music: Off';
    musicBtn.setAttribute('aria-pressed', String(musicOn));
  }
  musicBtn.addEventListener('click', () => {
    musicOn = !musicOn;
    try { localStorage.setItem('sumo-music', musicOn ? 'on' : 'off'); } catch (_) { /* storage blocked */ }
    showMusicSetting();
    if (musicOn) startMusic(); else stopMusic();
    musicBtn.blur(); // so Space/Enter go back to the game
  });
  showMusicSetting();

  // ---------- Game state ----------
  let players = [];
  let scores = [0, 0];
  let names = PLAYER_DEFS.map(d => d.defaultName);
  let state = 'menu';   // menu | countdown | fight | roundOver | matchOver
  let stateTimer = 0;
  let banner = null;    // { kind: 'call' | 'result', title, kicker, color, t, dur }
  let particles = [];
  let rings = [];       // expanding impact rings
  let shake = 0;
  let time = 0;

  function makePlayer(def, index) {
    return {
      def,
      index,
      x: def.startX, y: ARENA.y,
      vx: 0, vy: 0,
      r: 38,
      facing: def.facing,
      look: def.facing,  // smoothed facing used for drawing
      dashCd: 0,
      dashQueued: false,
      falling: false,
      fallT: 0,
      squash: 0, squashAngle: 0,
      brain: makeBrain(), // only used when the computer controls this wrestler
    };
  }

  const roundNumber = () => scores[0] + scores[1] + 1;
  let currentRound = 1; // the bout being fought; the scoreboard only advances when the next one starts

  function resetRound() {
    players = PLAYER_DEFS.map(makePlayer);
    particles = [];
    rings = [];
    state = 'countdown';
    stateTimer = 0;
    lastCount = -1;
    currentRound = roundNumber();
    updateScoreboard();
  }

  // Clean up a typed name; blank or spaces-only falls back to "Player 1"/"Player 2".
  function cleanName(raw, fallback) {
    const name = raw.replace(/\s+/g, ' ').trim();
    return name || fallback;
  }

  // Wrap a name in Unicode bidi isolates so Hebrew names sit correctly inside English text.
  const iso = name => '⁨' + name + '⁩';

  function applyNames() {
    names = PLAYER_DEFS.map((d, i) => isCpu(i) ? CPU_NAME : cleanName(nameInputs[i].value, d.defaultName));
    names.forEach((n, i) => {
      nameEls[i].textContent = n;
      nameEls[i].title = n;
    });
  }

  function startMatch() {
    initAudio();
    musicStarted = true;
    startMusic(); // keeps playing through rounds and replays
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    held.clear();
    scores = [0, 0];
    overlay.classList.add('hidden');
    resetRound();
  }

  function updateScoreboard() {
    pipEls.forEach((el, i) => {
      el.innerHTML = '';
      for (let k = 0; k < WIN_SCORE; k++) {
        const pip = document.createElement('span');
        pip.className = 'pip' + (k < scores[i] ? ' won' : '');
        el.appendChild(pip);
      }
      scoreEls[i].textContent = scores[i];
    });
    const done = scores.some(s => s >= WIN_SCORE);
    roundLabel.textContent = done ? 'Final' : `Round ${currentRound}`;
  }

  // Start (button or Enter in a name field) reads the names; Play Again reuses them.
  menuPanel.addEventListener('submit', e => {
    e.preventDefault();
    mode = (modeRadios.find(r => r.checked) || {}).value || mode;
    showMode();
    applyNames();
    startMatch();
  });
  document.getElementById('againBtn').addEventListener('click', startMatch);
  document.getElementById('namesBtn').addEventListener('click', () => {
    state = 'menu';
    scores = [0, 0];
    currentRound = 1;
    updateScoreboard();
    players = PLAYER_DEFS.map(makePlayer);
    overPanel.classList.add('hidden');
    menuPanel.classList.remove('hidden');
    (modeRadios.find(r => r.checked) || nameInputs[0]).focus();
  });

  // ---------- Computer opponent ----------
  // It looks at the ring only every so often (its reaction time) and keeps its last decision
  // in between, with a little wobble in its aim, so a quick human can out-manoeuvre it.
  const CPU = {
    reactMin: 0.16, reactMax: 0.28, // seconds between decisions
    firstReact: 0.3,                // extra hesitation at the start call
    aimNoise: 0.2,                  // radians of random error in its aim
    edgeCaution: 0.74,              // how close to the rope (incl. momentum) before it backs off
    dashChance: 0.35,               // chance to charge when it sees a good opening
  };

  function makeBrain() {
    return { wait: CPU.firstReact + Math.random() * 0.15, ix: 0, iy: 0, dash: false };
  }

  function cpuIntent(me, opp, dt) {
    const b = me.brain;
    b.wait -= dt;
    if (b.wait <= 0) {
      cpuDecide(me, opp);
      b.wait = CPU.reactMin + Math.random() * (CPU.reactMax - CPU.reactMin);
    }
    const dash = b.dash;
    b.dash = false; // a charge is a single press
    return { ix: b.ix, iy: b.iy, dash };
  }

  function cpuDecide(me, opp) {
    const b = me.brain;
    const mx = me.x - ARENA.x, my = me.y - ARENA.y;
    const dMe = Math.hypot(mx, my) || 1;
    const ox = opp.x - ARENA.x, oy = opp.y - ARENA.y;
    const dOpp = Math.hypot(ox, oy) || 1;

    // aim slightly ahead of where the opponent is going
    const dx = opp.x + opp.vx * 0.15 - me.x, dy = opp.y + opp.vy * 0.15 - me.y;
    const dist = Math.hypot(dx, dy) || 1;

    // how close to falling out, counting speed already carrying it toward the rope
    const outSpeed = (me.vx * mx + me.vy * my) / dMe;
    const danger = dMe / ARENA.r + Math.max(0, outSpeed) / 900;

    let ax, ay;
    if (danger > CPU.edgeCaution) {
      // recover: head back to the centre, sidestepping away from the opponent
      ax = -mx / dMe; ay = -my / dMe;
      const px = -ay, py = ax;
      const side = Math.sign(dx * px + dy * py) || 1;
      ax -= px * side * 0.6; ay -= py * side * 0.6;
      if (dist < 130 && me.dashCd <= 0 && Math.random() < 0.3) b.dash = true;
    } else {
      // attack from the centre side so the push drives the opponent toward the rope
      const ux = ox / dOpp, uy = oy / dOpp;
      const inside = (dx * ux + dy * uy) / dist; // 1 = pushing straight outward
      if (inside > 0.2 || dist < 100) {
        ax = dx; ay = dy;
      } else {
        ax = opp.x - ux * 95 - me.x; ay = opp.y - uy * 95 - me.y;
      }
      if (me.dashCd <= 0 && dist > 90 && dist < 230 && inside > 0.3 && Math.random() < CPU.dashChance) b.dash = true;
    }

    const a = Math.atan2(ay, ax) + (Math.random() * 2 - 1) * CPU.aimNoise;
    b.ix = Math.cos(a);
    b.iy = Math.sin(a);
  }

  // ---------- Physics ----------
  function burst(x, y, color, count, speed) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.4 + Math.random() * 0.4, max: 0.8, color, size: 1.5 + Math.random() * 3 });
    }
  }

  // What a human is asking for this step: a direction and whether to charge.
  function keyIntent(p) {
    const k = keysFor(p.index);
    return {
      ix: (held.has(k.right) ? 1 : 0) - (held.has(k.left) ? 1 : 0),
      iy: (held.has(k.down) ? 1 : 0) - (held.has(k.up) ? 1 : 0),
      dash: p.dashQueued,
    };
  }

  // Humans and the computer both go through here, so they share the same movement,
  // acceleration, charge strength and cooldown.
  function updatePlayer(p, controllable, dt) {
    if (controllable && !p.falling) {
      const intent = isCpu(p.index) ? cpuIntent(p, players[1 - p.index], dt) : keyIntent(p);
      let { ix, iy } = intent;
      if (ix || iy) {
        const len = Math.hypot(ix, iy);
        ix /= len; iy /= len;
        p.vx += ix * ACCEL * dt;
        p.vy += iy * ACCEL * dt;
        p.facing = Math.atan2(iy, ix);
      }
      if (intent.dash && p.dashCd <= 0) {
        p.vx += Math.cos(p.facing) * DASH_SPEED;
        p.vy += Math.sin(p.facing) * DASH_SPEED;
        p.dashCd = DASH_COOLDOWN;
        burst(p.x - Math.cos(p.facing) * p.r, p.y - Math.sin(p.facing) * p.r, DUST, 10, 140);
        sfx.dash();
      }
    }
    p.dashQueued = false;
    p.dashCd = Math.max(0, p.dashCd - dt);

    const drag = Math.exp(-DRAG * dt);
    p.vx *= drag;
    p.vy *= drag;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.squash = Math.max(0, p.squash - dt * 4);

    // turn the body smoothly toward the facing direction
    let diff = p.facing - p.look;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    p.look += diff * Math.min(1, dt * 14);

    if (p.falling) p.fallT += dt;
  }

  function collide(a, b) {
    if (a.falling || b.falling) return;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 0.001;
    const minDist = a.r + b.r;
    if (dist >= minDist) return;

    const nx = dx / dist, ny = dy / dist;
    const overlap = minDist - dist;
    a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
    b.x += nx * overlap / 2; b.y += ny * overlap / 2;

    const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (rel >= 0) return; // already separating

    const impact = -rel;
    // Equal masses: j is the impulse each wrestler receives along the normal.
    let j = (1 + RESTITUTION) * impact / 2;
    // Extra "oomph" on big hits so collisions feel punchy (but not when just leaning).
    if (impact > 80) j += Math.min(impact * 0.25, 160);
    a.vx -= j * nx; a.vy -= j * ny;
    b.vx += j * nx; b.vy += j * ny;

    if (impact > 80) {
      const cx = a.x + nx * a.r, cy = a.y + ny * a.r;
      burst(cx, cy, DUST, Math.min(18, 4 + impact / 30), 100 + impact * 0.35);
      rings.push({ x: cx, y: cy, t: 0, max: 0.35, power: Math.min(1, impact / 600) });
      shake = Math.min(10, shake + impact / 70);
      const ang = Math.atan2(ny, nx);
      a.squash = b.squash = Math.min(1, impact / 500);
      a.squashAngle = b.squashAngle = ang;
      sfx.bump(impact);
    }
  }

  function distFromCenter(p) {
    return Math.hypot(p.x - ARENA.x, p.y - ARENA.y);
  }

  let lastCount = -1;
  const COUNT_STEP = 0.55;

  function update(dt) {
    time += dt;
    stateTimer += dt;

    if (state === 'countdown') {
      const n = Math.floor(stateTimer / COUNT_STEP);
      if (n !== lastCount && n < 3) { lastCount = n; sfx.beep(); }
      if (stateTimer >= COUNT_STEP * 3) {
        state = 'fight';
        stateTimer = 0;
        banner = { kind: 'call', title: 'HAKKEYOI', color: INK, t: 0, dur: 0.9 };
        sfx.go();
      }
    }

    const controllable = state === 'fight';
    players.forEach(p => updatePlayer(p, controllable, dt));
    if (players.length === 2) collide(players[0], players[1]);

    if (state === 'fight') {
      const out = players.map(p => distFromCenter(p) > ARENA.r + 4);
      out.forEach((o, i) => {
        if (o) {
          players[i].falling = true;
          burst(players[i].x, players[i].y, DUST, 16, 180);
        }
      });
      if (out[0] || out[1]) {
        sfx.fall();
        shake = Math.max(shake, 7);
        state = 'roundOver';
        stateTimer = 0;
        const kicker = `Round ${currentRound}`;
        if (out[0] && out[1]) {
          banner = { kind: 'result', kicker, title: 'Both out — replay the round', color: MUTED, t: 0, dur: 2 };
        } else {
          const w = out[0] ? 1 : 0;
          scores[w]++;
          banner = { kind: 'result', kicker, title: `${iso(names[w])} wins the round`, color: PLAYER_DEFS[w].color, t: 0, dur: 2 };
          updateScoreboard();
        }
      }
    } else if (state === 'roundOver' && stateTimer > 2) {
      const champ = scores.findIndex(s => s >= WIN_SCORE);
      if (champ >= 0) endMatch(champ);
      else resetRound();
    }

    particles.forEach(pt => {
      pt.x += pt.vx * dt; pt.y += pt.vy * dt;
      pt.vx *= 0.93; pt.vy *= 0.93;
      pt.life -= dt;
    });
    particles = particles.filter(pt => pt.life > 0);
    rings.forEach(rg => { rg.t += dt; });
    rings = rings.filter(rg => rg.t < rg.max);

    if (banner) {
      banner.t += dt;
      if (banner.t > banner.dur) banner = null;
    }
    shake = Math.max(0, shake - dt * 30);
  }

  function endMatch(w) {
    state = 'matchOver';
    const def = PLAYER_DEFS[w];
    winnerText.textContent = names[w];
    winnerText.style.color = def.color;
    finalScore.textContent = `Wins the match ${scores[w]} – ${scores[1 - w]}`;
    menuPanel.classList.add('hidden');
    overPanel.classList.remove('hidden');
    overlay.classList.remove('hidden');
    sfx.fanfare();
  }

  // ---------- Drawing ----------
  function circle(g, x, y, r) {
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
  }

  // Everything that never moves: floor, raised dohyo, clay, straw rope, start lines, lighting.
  function buildArenaLayer(dpr) {
    const layer = document.createElement('canvas');
    layer.width = W * dpr;
    layer.height = H * dpr;
    const g = layer.getContext('2d');
    g.scale(dpr, dpr);
    const { x: cx, y: cy, r } = ARENA;
    const P = 292;      // half-size of the square clay platform
    const DEPTH = 14;   // visible height of the platform's front face

    // dark hall floor with a warm overhead light
    g.fillStyle = '#121315';
    g.fillRect(0, 0, W, H);
    const hall = g.createRadialGradient(cx, cy - 40, 80, cx, cy, 620);
    hall.addColorStop(0, 'rgba(255, 210, 150, 0.12)');
    hall.addColorStop(1, 'rgba(255, 210, 150, 0)');
    g.fillStyle = hall;
    g.fillRect(0, 0, W, H);

    // tassels (fusa) hanging at the four corners, in their traditional colors
    [['#2f5d4a', 70, 70], ['#a33a32', W - 70, H - 70], ['#d8d2c4', 70, H - 70], ['#26262a', W - 70, 70]].forEach(([col, x, y]) => {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      circle(g, x + 3, y + 5, 15); g.fill();
      g.fillStyle = col;
      circle(g, x, y, 14); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.12)';
      g.lineWidth = 1;
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * 13, y + Math.sin(a) * 13); g.stroke();
      }
    });

    // platform: shadow, front face, top face
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.7)';
    g.shadowBlur = 40;
    g.shadowOffsetY = 18;
    g.fillStyle = '#6f583b';
    g.fillRect(cx - P, cy - P + DEPTH, P * 2, P * 2);
    g.restore();
    g.fillStyle = '#7a6142';
    g.fillRect(cx - P, cy - P + DEPTH, P * 2, P * 2);
    const top = g.createLinearGradient(0, cy - P, 0, cy + P);
    top.addColorStop(0, '#c8aa7b');
    top.addColorStop(1, '#b49366');
    g.fillStyle = top;
    g.fillRect(cx - P, cy - P, P * 2, P * 2);

    // swept sand just outside the rope (janome) — shows where a foot stepped out
    g.strokeStyle = 'rgba(238, 224, 192, 0.35)';
    g.lineWidth = 16;
    circle(g, cx, cy, r + 20); g.stroke();

    // clay inside the ring
    const clay = g.createRadialGradient(cx, cy - 60, 20, cx, cy, r);
    clay.addColorStop(0, '#e6d2aa');
    clay.addColorStop(1, '#ccae80');
    g.fillStyle = clay;
    circle(g, cx, cy, r); g.fill();

    // fine grain over the whole platform
    for (let i = 0; i < 7000; i++) {
      const x = cx - P + Math.random() * P * 2;
      const y = cy - P + Math.random() * P * 2;
      g.fillStyle = Math.random() < 0.5 ? 'rgba(80, 55, 30, 0.08)' : 'rgba(255, 245, 225, 0.08)';
      g.fillRect(x, y, 1.4, 1.4);
    }

    // straw rope (tawara) — the boundary
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = 14;
    circle(g, cx, cy + 2, r); g.stroke();
    g.strokeStyle = '#a98a52';
    g.lineWidth = 13;
    circle(g, cx, cy, r); g.stroke();
    g.strokeStyle = 'rgba(232, 210, 155, 0.75)';
    g.lineWidth = 3;
    circle(g, cx, cy - 2, r - 2); g.stroke();
    // bale bindings
    g.strokeStyle = 'rgba(70, 48, 22, 0.45)';
    g.lineWidth = 2;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 20) {
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6));
      g.lineTo(cx + Math.cos(a) * (r + 6), cy + Math.sin(a) * (r + 6));
      g.stroke();
    }

    // starting lines (shikiri-sen)
    g.strokeStyle = '#f2ede3';
    g.lineWidth = 5;
    [-1, 1].forEach(s => {
      g.beginPath();
      g.moveTo(cx + s * 45, cy - 26);
      g.lineTo(cx + s * 45, cy + 26);
      g.stroke();
    });

    // vignette: the light falls off toward the edges of the hall
    const vig = g.createRadialGradient(cx, cy, 240, cx, cy, 640);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.6)');
    g.fillStyle = vig;
    g.fillRect(0, 0, W, H);
    return layer;
  }

  // Shorten text with an ellipsis until it fits in maxW.
  function fitText(text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let s = text;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  function drawGroundMarker(p) {
    const d = p.def;
    const near = state === 'fight' && distFromCenter(p) > ARENA.r - 45;

    // highlight the stretch of rope the wrestler is pressed against
    if (near) {
      const a = Math.atan2(p.y - ARENA.y, p.x - ARENA.x);
      const pulse = 0.45 + 0.25 * Math.sin(time * 14);
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = d.color;
      ctx.lineWidth = 13;
      ctx.beginPath();
      ctx.arc(ARENA.x, ARENA.y, ARENA.r, a - 0.28, a + 0.28);
      ctx.stroke();
      ctx.restore();
    }

    // contact shadow
    const sh = ctx.createRadialGradient(p.x + 3, p.y + 6, p.r * 0.5, p.x + 3, p.y + 6, p.r * 1.25);
    sh.addColorStop(0, 'rgba(40, 25, 10, 0.4)');
    sh.addColorStop(1, 'rgba(40, 25, 10, 0)');
    ctx.fillStyle = sh;
    circle(ctx, p.x + 3, p.y + 6, p.r * 1.25); ctx.fill();

    // player ring; the bright arc shows the charge cooldown
    if (state !== 'matchOver') {
      const ready = 1 - p.dashCd / DASH_COOLDOWN;
      ctx.lineWidth = 3;
      ctx.strokeStyle = d.color;
      ctx.globalAlpha = 0.3;
      circle(ctx, p.x, p.y, p.r + 8); ctx.stroke();
      ctx.globalAlpha = ready >= 1 ? 0.95 : 0.7;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ready);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // Front-facing rikishi: round body, colored mawashi with hanging cords, topknot (chonmage).
  // Eyes and a slight lean follow the direction of movement.
  function drawWrestler(p) {
    const scale = p.falling ? Math.max(0, 1 - p.fallT * 1.4) : 1;
    if (scale <= 0) return;
    const d = p.def;
    const r = p.r;
    const fx = Math.cos(p.look), fy = Math.sin(p.look);

    if (!p.falling) drawGroundMarker(p);

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = scale;
    ctx.scale(scale, scale);

    // squash along the hit direction
    ctx.rotate(p.squashAngle);
    ctx.scale(1 - p.squash * 0.14, 1 + p.squash * 0.08);
    ctx.rotate(-p.squashAngle);

    ctx.rotate(fx * 0.12 + (p.falling ? p.fallT * 3 : 0));

    const skinLight = '#ecc4a2', skin = '#d9a582', skinDark = '#b47f5c';
    const outline = 'rgba(70, 40, 22, 0.55)';
    const hair = '#1c1b1f';
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = outline;

    // legs
    ctx.fillStyle = skinDark;
    [-1, 1].forEach(s => {
      ctx.beginPath(); ctx.ellipse(s * r * 0.42, r * 0.9, r * 0.27, r * 0.2, 0, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    });

    // body
    const by = r * 0.1, br = r * 0.92;
    const body = ctx.createRadialGradient(-r * 0.25, by - r * 0.35, r * 0.1, 0, by, br);
    body.addColorStop(0, skinLight);
    body.addColorStop(0.7, skin);
    body.addColorStop(1, skinDark);
    ctx.fillStyle = body;
    circle(ctx, 0, by, br); ctx.fill(); ctx.stroke();

    // chest and navel, drawn faintly
    ctx.strokeStyle = 'rgba(120, 70, 40, 0.35)';
    [-1, 1].forEach(s => {
      ctx.beginPath(); ctx.arc(s * r * 0.3, -r * 0.12, r * 0.24, 0.25 * Math.PI, 0.75 * Math.PI); ctx.stroke();
    });
    ctx.fillStyle = 'rgba(120, 70, 40, 0.4)';
    circle(ctx, 0, r * 0.18, r * 0.04); ctx.fill();

    // mawashi: a band around the hips, clipped to the body
    ctx.save();
    circle(ctx, 0, by, br); ctx.clip();
    ctx.fillStyle = d.color;
    ctx.fillRect(-r, r * 0.3, r * 2, r * 0.36);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(-r, r * 0.3, r * 2, r * 0.05);
    ctx.fillStyle = d.dark;
    ctx.fillRect(-r, r * 0.6, r * 2, r * 0.06);
    ctx.restore();
    // sagari: stiff cords hanging from the front of the belt
    ctx.strokeStyle = d.dark;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(i * r * 0.12, r * 0.66);
      ctx.lineTo(i * r * 0.13, r * 1.0);
      ctx.stroke();
    }

    // arms at the sides; during a charge they thrust toward the facing direction
    const charging = Math.max(0, (p.dashCd - (DASH_COOLDOWN - 0.35)) / 0.35);
    ctx.fillStyle = skin;
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.5;
    [-1, 1].forEach(s => {
      const ax = s * r * 0.9 + fx * r * 0.45 * charging;
      const ay = r * 0.05 - r * 0.15 * charging;
      ctx.beginPath(); ctx.ellipse(ax, ay, r * 0.24, r * 0.4, s * 0.3, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    });

    // head
    const hr = r * 0.4, hx = fx * r * 0.08, hy = -r * 0.8;
    ctx.fillStyle = skin;
    [-1, 1].forEach(s => { circle(ctx, hx + s * hr * 0.95, hy + hr * 0.08, hr * 0.18); ctx.fill(); ctx.stroke(); });
    ctx.fillStyle = skinLight;
    circle(ctx, hx, hy, hr); ctx.fill(); ctx.stroke();
    // hair cap
    ctx.save();
    circle(ctx, hx, hy, hr); ctx.clip();
    ctx.fillStyle = hair;
    ctx.beginPath(); ctx.ellipse(hx, hy - hr * 0.55, hr * 1.2, hr * 0.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // chonmage folded on top of the head
    ctx.fillStyle = hair;
    ctx.beginPath(); ctx.ellipse(hx, hy - hr * 1.02, hr * 0.5, hr * 0.2, 0, 0, Math.PI * 2); ctx.fill();
    circle(ctx, hx, hy - hr * 0.85, hr * 0.17); ctx.fill();

    // face looks where the wrestler is heading
    const ex = hx + fx * hr * 0.28, ey = hy + hr * 0.15 + fy * hr * 0.1;
    ctx.fillStyle = hair;
    [-1, 1].forEach(s => { circle(ctx, ex + s * hr * 0.32, ey, hr * 0.09); ctx.fill(); });
    ctx.strokeStyle = hair;
    ctx.lineWidth = 2;
    [-1, 1].forEach(s => {
      ctx.beginPath();
      ctx.moveTo(ex + s * hr * 0.48, ey - hr * 0.26);
      ctx.lineTo(ex + s * hr * 0.16, ey - hr * 0.18);
      ctx.stroke();
    });
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    if (p.squash > 0.3 || p.falling) {
      ctx.ellipse(ex, ey + hr * 0.42, hr * 0.1, hr * 0.13, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#5a2a22'; ctx.fill();
    } else {
      ctx.moveTo(ex - hr * 0.16, ey + hr * 0.42); ctx.lineTo(ex + hr * 0.16, ey + hr * 0.42);
      ctx.stroke();
    }

    ctx.restore();

    // name tag under the wrestler
    if (!p.falling) {
      ctx.font = `600 12px ${FONT}`;
      const label = fitText(names[PLAYER_DEFS.indexOf(d)], 120);
      const tw = ctx.measureText(label).width;
      const bw = tw + 22, bh = 20;
      const bx = p.x - bw / 2, by = p.y + r + 26;
      ctx.fillStyle = 'rgba(16, 16, 18, 0.72)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 4); else ctx.rect(bx, by, bw, bh);
      ctx.fill();
      ctx.fillStyle = d.color;
      ctx.fillRect(bx, by, 3, bh);
      ctx.fillStyle = TEXT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, p.x + 2, by + bh / 2 + 1);
    }
  }

  function setFont(weight, size) {
    ctx.font = `${weight} ${size}px ${FONT}`;
  }

  // Spaced-out caps; letterSpacing is ignored by browsers that don't support it.
  function spaced(px) {
    if ('letterSpacing' in ctx) ctx.letterSpacing = px + 'px';
  }

  function drawCountdown() {
    const n = 3 - Math.floor(stateTimer / COUNT_STEP);
    const frac = (stateTimer % COUNT_STEP) / COUNT_STEP;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    setFont(700, 13);
    spaced(4);
    ctx.fillStyle = 'rgba(42, 35, 29, 0.7)';
    ctx.fillText(`ROUND ${currentRound}`, W / 2, ARENA.y - 78);

    spaced(0);
    ctx.globalAlpha = 1 - frac * 0.4;
    setFont(700, Math.round(104 - frac * 14));
    ctx.fillStyle = INK;
    ctx.fillText(String(n), W / 2, ARENA.y + 4);
    ctx.restore();
  }

  function drawBanner(b) {
    const appear = Math.min(1, b.t / 0.18);
    const fade = Math.min(1, (b.dur - b.t) / 0.3);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(appear, fade));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (b.kind === 'call') {
      // the referee's call to start: clean spaced type between two rules
      const y = ARENA.y - 150; // above the wrestlers on their start lines
      setFont(700, 54);
      spaced(14);
      ctx.fillStyle = INK;
      ctx.fillText(b.title, W / 2 + 7, y);
      const half = ctx.measureText(b.title).width / 2 + 24;
      const len = 60 * appear;
      ctx.strokeStyle = 'rgba(42, 35, 29, 0.45)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(W / 2 - half - len, y); ctx.lineTo(W / 2 - half, y);
      ctx.moveTo(W / 2 + half, y); ctx.lineTo(W / 2 + half + len, y);
      ctx.stroke();
    } else {
      // broadcast-style result card
      const bw = 560, bh = 96;
      const bx = (W - bw) / 2, by = ARENA.y - bh / 2 + (1 - appear) * 10;
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 30;
      ctx.fillStyle = 'rgba(20, 21, 24, 0.92)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.shadowBlur = 0;
      ctx.fillStyle = b.color;
      ctx.fillRect(bx, by, bw, 3);

      setFont(700, 12);
      spaced(4);
      ctx.fillStyle = MUTED;
      ctx.fillText(b.kicker.toUpperCase(), W / 2, by + 28);

      spaced(0);
      setFont(600, 30);
      const maxW = bw - 48;
      const tw = ctx.measureText(b.title).width;
      if (tw > maxW) setFont(600, Math.floor(30 * maxW / tw));
      ctx.fillStyle = TEXT;
      ctx.fillText(b.title, W / 2, by + 62);
    }
    ctx.restore();
  }

  function draw() {
    ctx.save();
    if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);

    ctx.drawImage(arenaLayer, 0, 0, W, H);

    // draw falling wrestlers first so the one still standing is on top
    [...players].sort((a, b) => (b.falling ? 1 : 0) - (a.falling ? 1 : 0) || a.y - b.y).forEach(drawWrestler);

    particles.forEach(pt => {
      ctx.globalAlpha = Math.max(0, pt.life / pt.max) * 0.8;
      ctx.fillStyle = pt.color;
      circle(ctx, pt.x, pt.y, pt.size); ctx.fill();
    });
    rings.forEach(rg => {
      const k = rg.t / rg.max;
      ctx.globalAlpha = (1 - k) * 0.7;
      ctx.strokeStyle = TEXT;
      ctx.lineWidth = 2 + 2 * rg.power;
      circle(ctx, rg.x, rg.y, 8 + k * (40 + 50 * rg.power)); ctx.stroke();
    });
    ctx.globalAlpha = 1;
    ctx.restore();

    if (state === 'countdown') drawCountdown();
    if (banner) drawBanner(banner);
  }

  // ---------- Main loop ----------
  let last = performance.now();
  let acc = 0;
  function frame(now) {
    acc += Math.min(0.1, (now - last) / 1000);
    last = now;
    while (acc >= STEP) {
      update(STEP);
      acc -= STEP;
    }
    draw();
    requestAnimationFrame(frame);
  }

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  players = PLAYER_DEFS.map(makePlayer);
  applyNames(); // the browser may restore a previous mode choice on reload
  updateScoreboard();
  requestAnimationFrame(frame);
})();
