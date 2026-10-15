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

  const PLAYER_DEFS = [
    {
      name: 'Tomato', color: '#ff4d6d', dark: '#c9184a', belt: '#ffbe0b',
      keys: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', dash: ['Space'] },
      startX: ARENA.x - 110, facing: 0,
    },
    {
      name: 'Blueberry', color: '#3a86ff', dark: '#1d4ed8', belt: '#8ac926',
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
  const pipEls = [document.getElementById('p1Pips'), document.getElementById('p2Pips')];

  let currentDpr = 0;
  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (dpr === currentDpr) return; // resizing the canvas clears it, so only do it when needed
    currentDpr = dpr;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // ---------- Input ----------
  const held = new Set();
  const GAME_KEYS = new Set();
  PLAYER_DEFS.forEach(d => {
    Object.values(d.keys).flat().forEach(k => GAME_KEYS.add(k));
  });

  window.addEventListener('keydown', e => {
    if (GAME_KEYS.has(e.code)) e.preventDefault(); // stop arrows/space scrolling the page
    held.add(e.code);
    if (!e.repeat) {
      players.forEach((p, i) => {
        if (PLAYER_DEFS[i].keys.dash.includes(e.code)) p.dashQueued = true;
      });
    }
  });
  window.addEventListener('keyup', e => held.delete(e.code));
  window.addEventListener('blur', () => held.clear());

  // ---------- Sound (tiny synth, no files) ----------
  let audio = null;
  function initAudio() {
    if (!audio) {
      try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { audio = null; }
    }
    if (audio && audio.state === 'suspended') audio.resume();
  }
  function tone(freq, dur = 0.12, type = 'square', vol = 0.15, slide = 0) {
    if (!audio) return;
    const t = audio.currentTime;
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
  const sfx = {
    bump: power => tone(140 + power * 0.25, 0.15, 'triangle', Math.min(0.35, 0.08 + power / 1500), -80),
    dash: () => tone(500, 0.12, 'sawtooth', 0.06, 400),
    beep: () => tone(520, 0.1, 'square', 0.08),
    go: () => tone(880, 0.25, 'square', 0.1),
    fall: () => tone(400, 0.6, 'sine', 0.2, -340),
    fanfare: () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.18, 'square', 0.09), i * 120)),
  };

  // ---------- Game state ----------
  let players = [];
  let scores = [0, 0];
  let state = 'menu';   // menu | countdown | fight | roundOver | matchOver
  let stateTimer = 0;
  let banner = null;    // { text, color, t }
  let particles = [];
  let shake = 0;
  let time = 0;

  function makePlayer(def) {
    return {
      def,
      x: def.startX, y: ARENA.y,
      vx: 0, vy: 0,
      r: 38,
      facing: def.facing,
      dashCd: 0,
      dashQueued: false,
      falling: false,
      fallT: 0,
      squash: 0, squashAngle: 0,
    };
  }

  function resetRound() {
    players = PLAYER_DEFS.map(makePlayer);
    particles = [];
    state = 'countdown';
    stateTimer = 0;
    lastCount = -1;
  }

  function startMatch() {
    initAudio();
    scores = [0, 0];
    updateScoreboard();
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
    });
  }

  document.getElementById('startBtn').addEventListener('click', e => { e.currentTarget.blur(); startMatch(); });
  document.getElementById('againBtn').addEventListener('click', e => { e.currentTarget.blur(); startMatch(); });

  // ---------- Physics ----------
  function burst(x, y, color, count, speed) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.5 + Math.random() * 0.4, max: 0.9, color, size: 3 + Math.random() * 5 });
    }
  }

  function updatePlayer(p, controllable, dt) {
    const k = p.def.keys;
    if (controllable && !p.falling) {
      let ix = (held.has(k.right) ? 1 : 0) - (held.has(k.left) ? 1 : 0);
      let iy = (held.has(k.down) ? 1 : 0) - (held.has(k.up) ? 1 : 0);
      if (ix || iy) {
        const len = Math.hypot(ix, iy);
        ix /= len; iy /= len;
        p.vx += ix * ACCEL * dt;
        p.vy += iy * ACCEL * dt;
        p.facing = Math.atan2(iy, ix);
      }
      if (p.dashQueued && p.dashCd <= 0) {
        p.vx += Math.cos(p.facing) * DASH_SPEED;
        p.vy += Math.sin(p.facing) * DASH_SPEED;
        p.dashCd = DASH_COOLDOWN;
        burst(p.x - Math.cos(p.facing) * p.r, p.y - Math.sin(p.facing) * p.r, '#e9d8a6', 10, 160);
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
      burst(cx, cy, '#ffffff', Math.min(24, 4 + impact / 25), 120 + impact * 0.4);
      burst(cx, cy, '#ffbe0b', Math.min(10, impact / 50), 200);
      shake = Math.min(18, shake + impact / 45);
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
        banner = { text: 'HAKKEYOI!', color: '#ffbe0b', t: 0, dur: 0.8 };
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
          burst(players[i].x, players[i].y, '#d4a373', 18, 220);
        }
      });
      if (out[0] || out[1]) {
        sfx.fall();
        shake = Math.max(shake, 10);
        state = 'roundOver';
        stateTimer = 0;
        if (out[0] && out[1]) {
          banner = { text: 'Double out! Redo!', color: '#ffffff', t: 0, dur: 2 };
        } else {
          const w = out[0] ? 1 : 0;
          scores[w]++;
          updateScoreboard();
          banner = { text: `${PLAYER_DEFS[w].name} wins the round!`, color: PLAYER_DEFS[w].color, t: 0, dur: 2 };
        }
      }
    } else if (state === 'roundOver' && stateTimer > 2) {
      const champ = scores.findIndex(s => s >= WIN_SCORE);
      if (champ >= 0) endMatch(champ);
      else resetRound();
    }

    particles.forEach(pt => {
      pt.x += pt.vx * dt; pt.y += pt.vy * dt;
      pt.vx *= 0.94; pt.vy *= 0.94;
      pt.life -= dt;
    });
    particles = particles.filter(pt => pt.life > 0);

    if (banner) {
      banner.t += dt;
      if (banner.t > banner.dur) banner = null;
    }
    shake = Math.max(0, shake - dt * 40);
  }

  function endMatch(w) {
    state = 'matchOver';
    const def = PLAYER_DEFS[w];
    winnerText.textContent = `🏆 ${def.name} is the Yokozuna! 🏆`;
    winnerText.style.color = def.color;
    finalScore.textContent = `Final score: ${scores[0]} – ${scores[1]}`;
    menuPanel.classList.add('hidden');
    overPanel.classList.remove('hidden');
    overlay.classList.remove('hidden');
    sfx.fanfare();
    for (let i = 0; i < 6; i++) burst(Math.random() * W, Math.random() * H * 0.6, def.color, 20, 300);
  }

  // ---------- Drawing ----------
  function drawArena() {
    // floor
    ctx.fillStyle = '#7fb069';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    for (let i = 0; i < W; i += 60) ctx.fillRect(i, 0, 30, H);

    // raised platform
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.arc(ARENA.x, ARENA.y + 14, ARENA.r + 40, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#b5835a';
    ctx.beginPath(); ctx.arc(ARENA.x, ARENA.y, ARENA.r + 40, 0, Math.PI * 2); ctx.fill();

    // clay ring
    const g = ctx.createRadialGradient(ARENA.x, ARENA.y - 60, 30, ARENA.x, ARENA.y, ARENA.r);
    g.addColorStop(0, '#f7dcb0');
    g.addColorStop(1, '#e3b97f');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(ARENA.x, ARENA.y, ARENA.r + 30, 0, Math.PI * 2); ctx.fill();

    // straw rope (tawara) — this is the edge!
    ctx.lineWidth = 14;
    ctx.strokeStyle = '#d6b85a';
    ctx.beginPath(); ctx.arc(ARENA.x, ARENA.y, ARENA.r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#a68a2e';
    ctx.setLineDash([6, 10]);
    ctx.beginPath(); ctx.arc(ARENA.x, ARENA.y, ARENA.r, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);

    // starting lines
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    [-1, 1].forEach(s => {
      ctx.beginPath();
      ctx.moveTo(ARENA.x + s * 45, ARENA.y - 28);
      ctx.lineTo(ARENA.x + s * 45, ARENA.y + 28);
      ctx.stroke();
    });
  }

  function drawWrestler(p) {
    const scale = p.falling ? Math.max(0, 1 - p.fallT * 1.4) : 1;
    if (scale <= 0) return;
    const d = p.def;

    // shadow
    if (!p.falling) {
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath(); ctx.ellipse(p.x, p.y + p.r * 0.7, p.r * 0.95, p.r * 0.4, 0, 0, Math.PI * 2); ctx.fill();
    }

    // dash-ready ring
    if (!p.falling && state !== 'matchOver') {
      const ready = 1 - p.dashCd / DASH_COOLDOWN;
      ctx.lineWidth = 4;
      ctx.strokeStyle = ready >= 1 ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ready);
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = scale;
    ctx.scale(scale, scale);
    if (p.falling) ctx.rotate(p.fallT * 8);

    // squash & stretch along the hit direction
    const wob = Math.sin(time * 40) * p.squash;
    ctx.rotate(p.squashAngle);
    ctx.scale(1 - p.squash * 0.22 + wob * 0.05, 1 + p.squash * 0.15);
    ctx.rotate(-p.squashAngle);

    const r = p.r;
    // arms (little nubs toward facing)
    const fx = Math.cos(p.facing), fy = Math.sin(p.facing);
    ctx.fillStyle = '#ffd7b5';
    ctx.strokeStyle = d.dark;
    ctx.lineWidth = 3;
    [-0.9, 0.9].forEach(off => {
      const a = p.facing + off;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95, r * 0.28, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    });

    // body
    const bg = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.2, 0, 0, r);
    bg.addColorStop(0, '#ffe3cc');
    bg.addColorStop(1, '#f4b98c');
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = d.dark;
    ctx.stroke();

    // mawashi belt
    ctx.fillStyle = d.color;
    ctx.beginPath();
    ctx.ellipse(0, r * 0.45, r * 0.92, r * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = d.belt;
    ctx.fillRect(-r * 0.12, r * 0.25, r * 0.24, r * 0.45);

    // face (looks toward facing direction)
    const lx = fx * r * 0.18, ly = fy * r * 0.12 - r * 0.15;
    ctx.fillStyle = 'rgba(255,100,120,0.45)';
    ctx.beginPath(); ctx.arc(lx - r * 0.42, ly + r * 0.18, r * 0.12, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(lx + r * 0.42, ly + r * 0.18, r * 0.12, 0, Math.PI * 2); ctx.fill();
    [-1, 1].forEach(s => {
      ctx.fillStyle = 'white';
      ctx.beginPath(); ctx.arc(lx + s * r * 0.25, ly, r * 0.17, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2b2d42';
      ctx.beginPath(); ctx.arc(lx + s * r * 0.25 + fx * r * 0.07, ly + fy * r * 0.07, r * 0.08, 0, Math.PI * 2); ctx.fill();
    });
    // determined eyebrows
    ctx.strokeStyle = '#2b2d42';
    ctx.lineWidth = 3;
    [-1, 1].forEach(s => {
      ctx.beginPath();
      ctx.moveTo(lx + s * r * 0.38, ly - r * 0.26);
      ctx.lineTo(lx + s * r * 0.12, ly - r * 0.18);
      ctx.stroke();
    });
    // mouth: "O" when hit or falling, grin otherwise
    ctx.beginPath();
    if (p.squash > 0.3 || p.falling) {
      ctx.fillStyle = '#2b2d42';
      ctx.arc(lx, ly + r * 0.3, r * 0.1, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.arc(lx, ly + r * 0.2, r * 0.14, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }

    // topknot
    ctx.fillStyle = '#2b2d42';
    ctx.beginPath(); ctx.arc(0, -r * 0.88, r * 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, -r * 1.06, r * 0.13, r * 0.08, 0, 0, Math.PI * 2); ctx.fill();

    ctx.restore();

    // danger sweat when close to the rope
    if (!p.falling && state === 'fight' && distFromCenter(p) > ARENA.r - 30) {
      const bob = Math.sin(time * 18) * 3;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#ff006e';
      ctx.lineWidth = 3;
      ctx.font = 'bold 28px "Trebuchet MS", sans-serif';
      ctx.textAlign = 'center';
      ctx.strokeText('!', p.x + p.r * 0.9, p.y - p.r - 6 + bob);
      ctx.fillText('!', p.x + p.r * 0.9, p.y - p.r - 6 + bob);
    }

    // name tag
    if (!p.falling) {
      ctx.font = 'bold 15px "Trebuchet MS", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = d.dark;
      ctx.fillText(d === PLAYER_DEFS[0] ? 'P1' : 'P2', p.x, p.y + p.r + 26);
    }
  }

  function drawBigText(text, color, size, alpha = 1, y = ARENA.y) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `900 ${size}px "Trebuchet MS", "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 10;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#2b2d42';
    ctx.strokeText(text, W / 2, y);
    ctx.fillStyle = color;
    ctx.fillText(text, W / 2, y);
    ctx.restore();
  }

  function draw() {
    ctx.save();
    if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);

    drawArena();

    // draw falling wrestlers first so the one still standing is on top
    [...players].sort((a, b) => (b.falling ? 1 : 0) - (a.falling ? 1 : 0) || a.y - b.y).forEach(drawWrestler);

    particles.forEach(pt => {
      ctx.globalAlpha = Math.max(0, pt.life / pt.max);
      ctx.fillStyle = pt.color;
      ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2); ctx.fill();
    });
    ctx.globalAlpha = 1;
    ctx.restore();

    if (state === 'countdown') {
      const n = 3 - Math.floor(stateTimer / COUNT_STEP);
      const frac = (stateTimer % COUNT_STEP) / COUNT_STEP;
      drawBigText(String(n), '#ffffff', 120 + (1 - frac) * 60, 1 - frac * 0.5);
    }
    if (banner) {
      const pop = Math.min(1, banner.t * 6);
      const fade = Math.min(1, (banner.dur - banner.t) * 4);
      drawBigText(banner.text, banner.color, 64 * (0.6 + 0.4 * pop), fade, 70);
    }
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

  players = PLAYER_DEFS.map(makePlayer);
  updateScoreboard();
  requestAnimationFrame(frame);
})();
