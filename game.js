(() => {
  'use strict';

  // ---- Fixed logical resolution: physics/drawing always use these units,
  // the canvas is scaled+letterboxed to fit whatever real screen it's on. ----
  const LW = 400;
  const LH = 700;

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(window.innerWidth / LW, window.innerHeight / LH);
    canvas.style.width = (LW * scale) + 'px';
    canvas.style.height = (LH * scale) + 'px';
    canvas.width = Math.round(LW * scale * dpr);
    canvas.height = Math.round(LH * scale * dpr);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  resize();

  // ---- Constants (tuned in logical px, scaled by dt so frame-rate independent) ----
  const GRAVITY = 1050;      // px/s^2
  const FLAP_VELOCITY = -370; // px/s
  const MAX_FALL = 550;
  const GROUND_H = 54;
  const PIPE_W = 74;
  const GAP_H = 250;
  const PIPE_SPEED = 115;    // px/s
  const PIPE_INTERVAL = 1750; // ms
  const PLAYER_X = LW * 0.28;
  const HALF_W = 34;
  const HALF_H = 24;
  const HORIZON_Y = LH - GROUND_H - 30;
  const SKY_SCALE = 2.3;      // blows the per-city skyline drawings up to fill most of the screen
  const SKY_SPEED = 46;       // px/s on-screen scroll speed for the near skyline layer
  const SKY_SPEED_FAR = 24;   // px/s for the lighter, more distant layer — slower, for parallax depth

  const BEST_KEY = 'camelJumpBest';
  const MUTE_KEY = 'camelJumpMuted';
  const CITY_KEY = 'camelJumpCity';
  const CHARACTER_KEY = 'camelJumpCharacter';
  const MUTE_BTN = { x: LW - 46, y: 10, w: 36, h: 36 };
  const BACK_BTN = { x: 10, y: 10, w: 36, h: 36 };
  const SHARE_BTN = { x: LW / 2 - 75, y: LH * 0.58 - 19, w: 150, h: 38 };
  const LOGOUT_LABEL = { x: LW / 2 - 90, y: LH - 26, w: 180, h: 20 };

  // ---- Procedurally generated background music (no audio files) ----
  // Same looping rhythmic phrase for every city, but each city transposes it
  // onto a different maqam (Arabic melodic mode) at its own root note and
  // tempo, so the "song" genuinely changes when you change city. Neutral
  // (non-12-TET) scale steps like 1.5 or 3.5 semitones are real maqam
  // intervals (e.g. Bayati's neutral 2nd) — oscillators can play any
  // frequency, so we don't need to round them to a piano keyboard.
  const Music = (() => {
    const MAQAM = {
      hijaz: [0, 1, 4, 5, 7, 8, 11, 12],       // Hijaz — augmented 2nd, the "classic" Arabic sound
      bayati: [0, 1.5, 3, 5, 7, 8, 10, 12],    // Bayati — neutral 2nd, very common in Egypt/Levant
      rast: [0, 2, 3.5, 5, 7, 9, 10.5, 12],    // Rast — neutral 3rd/7th, foundational Arabic maqam
      kurd: [0, 1, 3, 5, 7, 8, 10, 12],        // Kurd — phrygian-like
      nahawand: [0, 2, 3, 5, 7, 8, 10, 12],    // Nahawand — harmonic-minor-like, more somber
    };
    const CITY_MUSIC = {
      cairo: { root: 293.66, maqam: 'bayati', tempo: 96 },
      riyadh: { root: 293.66, maqam: 'hijaz', tempo: 96 },
      abudhabi: { root: 261.63, maqam: 'rast', tempo: 100 },
      doha: { root: 329.63, maqam: 'hijaz', tempo: 104 },
      kuwaitcity: { root: 293.66, maqam: 'kurd', tempo: 100 },
      rabat: { root: 220.00, maqam: 'nahawand', tempo: 88 },
      amman: { root: 196.00, maqam: 'nahawand', tempo: 84 },
      beirut: { root: 220.00, maqam: 'hijaz', tempo: 88 },
    };
    const MELODY = [4, -1, 3, 2, 3, -1, 1, 0, 0, -1, 1, 2, 4, -1, 2, -1];

    function buildScale(root, offsets) {
      return offsets.map(semi => root * Math.pow(2, semi / 12));
    }

    let SCALE = buildScale(CITY_MUSIC.cairo.root, MAQAM.bayati);
    let TEMPO = CITY_MUSIC.cairo.tempo;
    let STEP_DUR = 60 / TEMPO / 2;
    let rootFreq = CITY_MUSIC.cairo.root;

    let ctx = null;
    let masterGain = null;
    let drone = null;
    let started = false;
    let muted = localStorage.getItem(MUTE_KEY) === '1';
    let nextStepTime = 0;
    let stepIndex = 0;
    let schedulerTimer = null;

    function playNote(freq, time, dur) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, time);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, time);
      g.gain.linearRampToValueAtTime(0.18, time + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, time + dur);
      osc.connect(g).connect(masterGain);
      osc.start(time);
      osc.stop(time + dur + 0.05);
    }

    function playHit(time, dum) {
      const dur = dum ? 0.16 : 0.07;
      const size = Math.floor(ctx.sampleRate * dur);
      const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < size; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / size, dum ? 2 : 4);
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = dum ? 'lowpass' : 'highpass';
      filter.frequency.value = dum ? 300 : 2500;
      const g = ctx.createGain();
      g.gain.value = dum ? 0.45 : 0.2;
      src.connect(filter).connect(g).connect(masterGain);
      src.start(time);
    }

    function scheduler() {
      while (nextStepTime < ctx.currentTime + 0.2) {
        const deg = MELODY[stepIndex % MELODY.length];
        if (deg >= 0) playNote(SCALE[deg], nextStepTime, STEP_DUR * 1.4);
        if (stepIndex % 8 === 0) playHit(nextStepTime, true);
        else if (stepIndex % 4 === 0) playHit(nextStepTime, false);
        nextStepTime += STEP_DUR;
        stepIndex++;
      }
    }

    function start() {
      if (started) return;
      started = true;
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.gain.value = muted ? 0 : 0.35;
      masterGain.connect(ctx.destination);

      drone = ctx.createOscillator();
      drone.type = 'sine';
      drone.frequency.value = rootFreq / 2;
      const droneGain = ctx.createGain();
      droneGain.gain.value = 0.07;
      drone.connect(droneGain).connect(masterGain);
      drone.start();

      nextStepTime = ctx.currentTime + 0.1;
      stepIndex = 0;
      schedulerTimer = setInterval(scheduler, 100);
    }

    function resume() {
      if (ctx && ctx.state === 'suspended') ctx.resume();
    }

    function toggleMute() {
      muted = !muted;
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
      if (masterGain) masterGain.gain.setTargetAtTime(muted ? 0 : 0.35, ctx.currentTime, 0.05);
    }

    function setCity(cityKey) {
      const cfg = CITY_MUSIC[cityKey] || CITY_MUSIC.cairo;
      SCALE = buildScale(cfg.root, MAQAM[cfg.maqam] || MAQAM.hijaz);
      TEMPO = cfg.tempo;
      STEP_DUR = 60 / TEMPO / 2;
      rootFreq = cfg.root;
      if (drone && ctx) {
        drone.frequency.setTargetAtTime(rootFreq / 2, ctx.currentTime, 0.6);
      }
    }

    return { start, resume, toggleMute, isMuted: () => muted, setCity };
  })();

  function pointInRect(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  // ---- Cities: each maps to a biome (which picks obstacle shapes/colors)
  // and a landmark-drawing function (hoisted function declarations, defined
  // further down in the Drawing section). ----
  const CITIES = [
    { key: 'cairo', nameEn: 'Cairo', nameAr: 'القاهرة', biome: 'desert', nearColor: '#5c3d24', farColor: '#c9905c', landmark: (c) => drawLandmarkCairo(c) },
    { key: 'riyadh', nameEn: 'Riyadh', nameAr: 'الرياض', biome: 'desert', nearColor: '#453a52', farColor: '#a08fc4', landmark: (c) => drawLandmarkRiyadh(c) },
    { key: 'abudhabi', nameEn: 'Abu Dhabi', nameAr: 'أبوظبي', biome: 'coastal', nearColor: '#33524a', farColor: '#8fc7b5', landmark: (c) => drawLandmarkAbuDhabi(c) },
    { key: 'doha', nameEn: 'Doha', nameAr: 'الدوحة', biome: 'coastal', nearColor: '#2f3f52', farColor: '#84aecb', landmark: (c) => drawLandmarkDoha(c) },
    { key: 'kuwaitcity', nameEn: 'Kuwait City', nameAr: 'مدينة الكويت', biome: 'coastal', nearColor: '#294252', farColor: '#7bb3cf', landmark: (c) => drawLandmarkKuwaitCity(c) },
    { key: 'rabat', nameEn: 'Rabat', nameAr: 'الرباط', biome: 'coastal', nearColor: '#523823', farColor: '#c99a68', landmark: (c) => drawLandmarkRabat(c) },
    { key: 'amman', nameEn: 'Amman', nameAr: 'عمّان', biome: 'hill', nearColor: '#52462f', farColor: '#c2ad7e', landmark: (c) => drawLandmarkAmman(c) },
    { key: 'beirut', nameEn: 'Beirut', nameAr: 'بيروت', biome: 'hill', nearColor: '#37413f', farColor: '#93a8a5', landmark: (c) => drawLandmarkBeirut(c) },
  ];

  const BIOME_SHAPES = {
    desert: {
      pipeShape: (x, isTop, edgeY) => duneShape(x, isTop, edgeY),
      accent: (cx, groundY) => drawCactus(cx, groundY),
      gradientStops: [[0, '#d9a066'], [0.5, '#f0c98a'], [1, '#c98a4f']],
    },
    coastal: {
      pipeShape: (x, isTop, edgeY) => palmPipeShape(x, isTop, edgeY),
      accent: (cx, groundY) => drawPalmTree(cx, groundY),
      gradientStops: [[0, '#4a8a86'], [0.5, '#6fb3ad'], [1, '#3d726e']],
    },
    hill: {
      pipeShape: (x, isTop, edgeY) => cedarPipeShape(x, isTop, edgeY),
      accent: null,
      gradientStops: [[0, '#5c6b4a'], [0.5, '#7d8f68'], [1, '#4a5a3c']],
    },
  };

  // ---- Menu layout (computed once) ----
  const CITY_GRID = { top: 150, cardW: 168, cardH: 114, colGap: 16, rowGap: 14, sideMargin: 24 };
  const cityCardRects = CITIES.map((c, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    return {
      x: CITY_GRID.sideMargin + col * (CITY_GRID.cardW + CITY_GRID.colGap),
      y: CITY_GRID.top + row * (CITY_GRID.cardH + CITY_GRID.rowGap),
      w: CITY_GRID.cardW,
      h: CITY_GRID.cardH,
    };
  });
  const manCardRect = { x: LW / 2 - 170, y: 220, w: 160, h: 260 };
  const womanCardRect = { x: LW / 2 + 10, y: 220, w: 160, h: 260 };

  let state = 'authCheck'; // authCheck | auth | citySelect | characterSelect | start | playing | gameover
  let selectedCity, selectedCharacter, currentBiome;
  let player, pipes, score, best, spawnTimer, groundOffset, skyScrollX, skyScrollXFar, lastTime;
  let flapAnim = 0;

  function resetGame() {
    player = { y: LH * 0.42, vy: 0 };
    pipes = [];
    score = 0;
    spawnTimer = 0;
    groundOffset = 0;
    skyScrollX = 0;
    skyScrollXFar = 0;
    flapAnim = 0;
  }

  best = Number(localStorage.getItem(BEST_KEY) || 0);
  selectedCity = localStorage.getItem(CITY_KEY) || 'cairo';
  selectedCharacter = localStorage.getItem(CHARACTER_KEY) || 'man';
  currentBiome = (CITIES.find(c => c.key === selectedCity) || CITIES[0]).biome;
  Music.setCity(selectedCity);
  resetGame();

  // ---- Account sign-in (Firebase, via auth.js) ----
  const authOverlay = document.getElementById('authOverlay');
  const authUsernameInput = document.getElementById('authUsername');
  const authEmailInput = document.getElementById('authEmail');
  const authPasswordInput = document.getElementById('authPassword');
  const authErrorEl = document.getElementById('authError');

  function setAuthError(msg, isStatus) {
    authErrorEl.textContent = msg || '';
    authErrorEl.style.color = isStatus ? '#c8f7c5' : '#ffe08a';
  }

  function showAuthOverlay() {
    authOverlay.hidden = false;
    state = 'auth';
  }

  function enterGame() {
    authOverlay.hidden = true;
    state = 'citySelect';
  }

  async function afterSignedIn() {
    try {
      const remoteBest = await CamelAuth.getBestScore();
      if (typeof remoteBest === 'number' && remoteBest > best) {
        best = remoteBest;
        localStorage.setItem(BEST_KEY, String(best));
      } else if (best > (remoteBest || 0)) {
        CamelAuth.syncBestScore(best);
      }
    } catch (e) {
      // offline or rules issue — local best still stands
    }
    enterGame();
  }

  document.getElementById('authLoginBtn').addEventListener('click', async () => {
    setAuthError('');
    try {
      await CamelAuth.login(authUsernameInput.value, authPasswordInput.value);
      await afterSignedIn();
    } catch (e) {
      setAuthError(e.message || 'Log in failed');
    }
  });

  document.getElementById('authSignupBtn').addEventListener('click', async () => {
    setAuthError('');
    try {
      await CamelAuth.signup(authUsernameInput.value, authEmailInput.value, authPasswordInput.value);
      await afterSignedIn();
    } catch (e) {
      setAuthError(e.message || 'Sign up failed');
    }
  });

  document.getElementById('authGuestBtn').addEventListener('click', () => {
    enterGame();
  });

  document.getElementById('authForgotBtn').addEventListener('click', async () => {
    setAuthError('');
    try {
      await CamelAuth.resetPassword(authUsernameInput.value);
      setAuthError('Check your email for a password reset link.', true);
    } catch (e) {
      setAuthError(e.message || 'Could not send reset email');
    }
  });

  CamelAuth.ready((user) => {
    if (!CamelAuth.isAvailable()) {
      enterGame();
    } else if (user) {
      afterSignedIn();
    } else {
      showAuthOverlay();
    }
  });

  function selectCity(key) {
    selectedCity = key;
    const city = CITIES.find(c => c.key === key);
    currentBiome = city ? city.biome : 'desert';
    Music.setCity(key);
    localStorage.setItem(CITY_KEY, key);
    state = 'characterSelect';
  }

  function selectCharacter(value) {
    selectedCharacter = value;
    localStorage.setItem(CHARACTER_KEY, value);
    state = 'start';
  }

  function flap() {
    if (state === 'start') {
      state = 'playing';
      player.vy = FLAP_VELOCITY;
      flapAnim = 1;
    } else if (state === 'playing') {
      player.vy = FLAP_VELOCITY;
      flapAnim = 1;
    } else if (state === 'gameover') {
      resetGame();
      state = 'start';
    }
  }

  function getActiveButtons() {
    if (state === 'citySelect') {
      const buttons = CITIES.map((c, i) => ({ rect: cityCardRects[i], onTap: () => selectCity(c.key) }));
      if (CamelAuth.isLoggedIn()) {
        buttons.push({ rect: LOGOUT_LABEL, onTap: () => { CamelAuth.logout(); } });
      }
      return buttons;
    }
    if (state === 'characterSelect') {
      return [
        { rect: manCardRect, onTap: () => selectCharacter('man') },
        { rect: womanCardRect, onTap: () => selectCharacter('woman') },
        { rect: BACK_BTN, onTap: () => { state = 'citySelect'; } },
      ];
    }
    if (state === 'start') {
      return [{ rect: BACK_BTN, onTap: () => { state = 'citySelect'; } }];
    }
    if (state === 'gameover') {
      return [{ rect: SHARE_BTN, onTap: () => shareScore() }];
    }
    return [];
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    Music.start();
    Music.resume();

    const rect = canvas.getBoundingClientRect();
    const lx = (e.clientX - rect.left) * (LW / rect.width);
    const ly = (e.clientY - rect.top) * (LH / rect.height);

    if (pointInRect(lx, ly, MUTE_BTN)) {
      Music.toggleMute();
      return;
    }

    for (const b of getActiveButtons()) {
      if (pointInRect(lx, ly, b.rect)) {
        b.onTap();
        return;
      }
    }

    if (state === 'start' || state === 'playing' || state === 'gameover') {
      flap();
    }
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp') {
      e.preventDefault();
      Music.start();
      Music.resume();
      flap();
    }
  });

  function spawnPipe() {
    const margin = 70;
    const gapY = margin + Math.random() * (LH - GROUND_H - margin * 2 - GAP_H) + GAP_H / 2;
    pipes.push({ x: LW + PIPE_W, gapY, scored: false, accent: Math.random() < 0.5 });
  }

  function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  function update(dt) {
    if (state !== 'playing') return;

    player.vy += GRAVITY * dt;
    if (player.vy > MAX_FALL) player.vy = MAX_FALL;
    player.y += player.vy * dt;

    spawnTimer += dt * 1000;
    if (spawnTimer >= PIPE_INTERVAL) {
      spawnTimer = 0;
      spawnPipe();
    }

    const groundY = LH - GROUND_H;
    let dead = false;

    for (const p of pipes) {
      p.x -= PIPE_SPEED * dt;

      const topH = p.gapY - GAP_H / 2;
      const botY = p.gapY + GAP_H / 2;

      if (rectsOverlap(PLAYER_X - HALF_W, player.y - HALF_H, HALF_W * 2, HALF_H * 2, p.x, 0, PIPE_W, topH) ||
          rectsOverlap(PLAYER_X - HALF_W, player.y - HALF_H, HALF_W * 2, HALF_H * 2, p.x, botY, PIPE_W, groundY - botY)) {
        dead = true;
      }

      if (!p.scored && p.x + PIPE_W < PLAYER_X - HALF_W) {
        p.scored = true;
        score++;
      }
    }

    pipes = pipes.filter(p => p.x + PIPE_W > -10);

    if (player.y - HALF_H < 0) {
      player.y = HALF_H;
      player.vy = 0;
    }
    if (player.y + HALF_H > groundY) {
      player.y = groundY - HALF_H;
      dead = true;
    }

    if (dead) {
      state = 'gameover';
      if (score > best) {
        best = score;
        localStorage.setItem(BEST_KEY, String(best));
        CamelAuth.syncBestScore(best);
      }
    }

    groundOffset = (groundOffset + PIPE_SPEED * dt) % 40;
    skyScrollX = (skyScrollX + SKY_SPEED * dt) % (BASE_SKYLINE_W * SKY_SCALE);
    skyScrollXFar = (skyScrollXFar + SKY_SPEED_FAR * dt) % (BASE_SKYLINE_W * SKY_SCALE);
    if (flapAnim > 0) flapAnim = Math.max(0, flapAnim - dt * 3);
  }

  // ---------------- Drawing ----------------

  function roundRectPath(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, LH);
    g.addColorStop(0, '#ff9a56');
    g.addColorStop(0.45, '#ff7096');
    g.addColorStop(1, '#ffd9a0');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, LW, LH);

    ctx.fillStyle = 'rgba(255, 244, 214, 0.9)';
    ctx.beginPath();
    ctx.arc(LW * 0.78, LH * 0.22, 46, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawHorizon(biome) {
    const colors = { desert: 'rgba(150, 70, 90, 0.35)', coastal: 'rgba(20, 90, 120, 0.35)', hill: 'rgba(90, 100, 70, 0.35)' };
    const amps = { desert: 14, coastal: 8, hill: 20 };
    ctx.fillStyle = colors[biome] || colors.desert;
    const amp = amps[biome] || 14;
    ctx.beginPath();
    ctx.moveTo(0, HORIZON_Y + 40);
    for (let x = 0; x <= LW; x += 40) {
      const y = HORIZON_Y + Math.sin((x + groundOffset * 0.4) * 0.02) * amp;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(LW, LH);
    ctx.lineTo(0, LH);
    ctx.closePath();
    ctx.fill();
  }

  // ---- Per-city skylines: wireframe/line-art style (stroked outlines, not
  // flat silhouettes) so each city reads as a distinct architectural sketch
  // rather than a generic filled shape. A shared "filler" building row gives
  // each skyline more density, and each city's signature landmark is drawn
  // bigger and more detailed on top of it. ----

  // Every landmark below is drawn in a LOCAL coordinate space where y=0 is
  // the ground line and negative y goes up — this lets drawSkyline() scale
  // and tile the whole drawing to fill the screen and scroll continuously,
  // without each function needing to know about that.
  //
  // Style: flat, solid single-color silhouettes (no outlines/strokes) layered
  // two-deep — a dense generic "filler" skyline shared by every city, plus
  // each city's own recognizable landmark silhouette drawn on top of it.

  function drawFilledBuilding(b, color) {
    const topY = -b.h;
    ctx.fillStyle = color;
    ctx.fillRect(b.x, topY, b.w, b.h);

    if (b.top === 'peak') {
      ctx.beginPath();
      ctx.moveTo(b.x, topY);
      ctx.lineTo(b.x + b.w / 2, topY - b.w * 0.55);
      ctx.lineTo(b.x + b.w, topY);
      ctx.closePath();
      ctx.fill();
    } else if (b.top === 'dome') {
      ctx.beginPath();
      ctx.arc(b.x + b.w / 2, topY, b.w / 2, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
    } else if (b.top === 'notch') {
      const nw = b.w * 0.5;
      ctx.fillRect(b.x + (b.w - nw) / 2, topY - b.h * 0.22, nw, b.h * 0.22);
    } else if (b.top === 'antenna') {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(b.x + b.w / 2, topY);
      ctx.lineTo(b.x + b.w / 2, topY - b.h * 0.4);
      ctx.stroke();
    }
  }

  // Shared dense "generic city" pattern reused by every city (recolored and
  // rescaled per city) so the skyline reads as a full, continuous cityscape
  // like a real silhouette illustration, not a few isolated buildings.
  const BASE_SKYLINE = [
    { w: 22, h: 40, top: 'flat', gap: 4 }, { w: 16, h: 65, top: 'antenna', gap: 6 }, { w: 28, h: 30, top: 'flat', gap: 3 },
    { w: 20, h: 78, top: 'flat', gap: 5 }, { w: 24, h: 50, top: 'notch', gap: 4 }, { w: 18, h: 35, top: 'flat', gap: 7 },
    { w: 32, h: 68, top: 'flat', gap: 3 }, { w: 20, h: 45, top: 'dome', gap: 5 }, { w: 16, h: 85, top: 'antenna', gap: 4 },
    { w: 26, h: 55, top: 'flat', gap: 6 }, { w: 18, h: 38, top: 'flat', gap: 3 }, { w: 22, h: 62, top: 'notch', gap: 5 },
    { w: 28, h: 48, top: 'flat', gap: 4 }, { w: 16, h: 72, top: 'flat', gap: 6 }, { w: 20, h: 32, top: 'flat', gap: 3 },
    { w: 24, h: 58, top: 'dome', gap: 5 }, { w: 14, h: 42, top: 'flat', gap: 4 }, { w: 18, h: 66, top: 'antenna', gap: 6 },
  ];
  const BASE_SKYLINE_W = BASE_SKYLINE.reduce((sum, b) => sum + b.w + b.gap, 0);

  function drawSilhouetteRow(color, heightScale) {
    let x = 0;
    BASE_SKYLINE.forEach(spec => {
      drawFilledBuilding({ x, w: spec.w, h: spec.h * heightScale, top: spec.top }, color);
      x += spec.w + spec.gap;
    });
  }

  function drawLandmarkCairo(color) {
    ctx.fillStyle = color;
    [[255, 46, 34], [300, 68, 52], [345, 42, 32]].forEach(([cx, w, h]) => {
      ctx.beginPath();
      ctx.moveTo(cx - w / 2, 0);
      ctx.lineTo(cx, -h);
      ctx.lineTo(cx + w / 2, 0);
      ctx.closePath();
      ctx.fill();
    });
  }

  function drawLandmarkRiyadh(color) {
    // Kingdom Centre Tower — the "keyhole" notch cut into the top
    ctx.fillStyle = color;
    const x = 175, w = 36, h = 140;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, 0);
    ctx.lineTo(x - w / 2, -h);
    ctx.lineTo(x - 6, -h);
    ctx.lineTo(x - 6, -h + 32);
    ctx.quadraticCurveTo(x, -h + 48, x + 6, -h + 32);
    ctx.lineTo(x + 6, -h);
    ctx.lineTo(x + w / 2, -h);
    ctx.lineTo(x + w / 2, 0);
    ctx.closePath();
    ctx.fill();
  }

  function drawLandmarkAbuDhabi(color) {
    // Sheikh Zayed Grand Mosque — domes on a hall, flanked by minarets
    ctx.fillStyle = color;
    ctx.fillRect(150, -30, 100, 30);
    [[200, 26], [165, 14], [235, 14]].forEach(([cx, r]) => {
      ctx.beginPath(); ctx.arc(cx, -30, r, Math.PI, 0); ctx.closePath(); ctx.fill();
    });
    [130, 260].forEach(mx => {
      ctx.fillRect(mx, -95, 10, 95);
      ctx.beginPath(); ctx.arc(mx + 5, -95, 6, Math.PI, 0); ctx.closePath(); ctx.fill();
    });
  }

  function drawLandmarkDoha(color) {
    ctx.fillStyle = color;
    // Doha Tower: tapering stack of slightly rotated rects
    for (let i = 0; i < 7; i++) {
      const w = 32 - i * 3;
      const h = 18;
      const y = -(i + 1) * h;
      ctx.save();
      ctx.translate(150, y + h / 2);
      ctx.rotate((i % 2 === 0 ? 1 : -1) * 0.09);
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.restore();
    }
    // Torch Tower
    ctx.beginPath();
    ctx.moveTo(228, 0);
    ctx.lineTo(237, -135);
    ctx.lineTo(251, -135);
    ctx.lineTo(260, 0);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(237, -135); ctx.lineTo(244, -156); ctx.lineTo(251, -135);
    ctx.closePath();
    ctx.fill();
  }

  function drawFilledBallTower(cx, stemW, stemH, ballR, color) {
    ctx.fillStyle = color;
    ctx.fillRect(cx - stemW / 2, -stemH, stemW, stemH);
    ctx.beginPath();
    ctx.arc(cx, -stemH - ballR * 0.5, ballR, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawLandmarkKuwaitCity(color) {
    drawFilledBallTower(150, 6, 50, 11, color);
    drawFilledBallTower(180, 9, 100, 20, color);
    drawFilledBallTower(210, 7, 70, 14, color);
  }

  function drawLandmarkAmman(color) {
    // Amman Citadel on its hill, with a crenellated wall along the top
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(258, 0);
    ctx.quadraticCurveTo(300, -72, 342, 0);
    ctx.closePath();
    ctx.fill();
    for (let cx = 282; cx <= 318; cx += 9) {
      ctx.fillRect(cx, -70, 6, 12);
    }
  }

  function drawLandmarkBeirut(color) {
    ctx.fillStyle = color;
    // Pigeon Rocks (Raouché), offshore
    ctx.beginPath(); ctx.moveTo(30, 0); ctx.quadraticCurveTo(48, -38, 66, 0); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(70, 0); ctx.quadraticCurveTo(82, -24, 94, 0); ctx.closePath(); ctx.fill();
    // Mosque dome + minaret
    ctx.fillRect(220, -30, 40, 30);
    ctx.beginPath(); ctx.arc(240, -30, 18, Math.PI, 0); ctx.closePath(); ctx.fill();
    ctx.fillRect(270, -90, 8, 90);
    ctx.beginPath(); ctx.arc(274, -90, 5, Math.PI, 0); ctx.closePath(); ctx.fill();
    // Church spire
    ctx.beginPath(); ctx.moveTo(300, 0); ctx.lineTo(310, -70); ctx.lineTo(320, 0); ctx.closePath(); ctx.fill();
  }

  function drawLandmarkRabat(color) {
    // Hassan Tower — deliberately flat/unfinished top, no dome or spire
    ctx.fillStyle = color;
    ctx.fillRect(180, -92, 38, 92);
    ctx.fillRect(150, -20, 20, 20);
    ctx.fillRect(228, -15, 16, 15);
  }

  // Draws the current city's skyline as two parallax layers — a lighter,
  // slower-scrolling far layer and a darker, faster near layer carrying the
  // city's landmark — both scaled up to fill most of the screen and tiled
  // seamlessly so they keep scrolling past, giving a sense of forward motion.
  function drawSkyline(cityKey) {
    const city = CITIES.find(c => c.key === cityKey);
    if (!city) return;
    const tileW = BASE_SKYLINE_W * SKY_SCALE;

    const farBase = -(skyScrollXFar % tileW);
    for (let i = -1; i <= 1; i++) {
      ctx.save();
      ctx.translate(farBase + i * tileW, HORIZON_Y);
      ctx.scale(SKY_SCALE, SKY_SCALE);
      drawSilhouetteRow(city.farColor, 0.85);
      ctx.restore();
    }

    const nearBase = -(skyScrollX % tileW);
    for (let i = -1; i <= 1; i++) {
      ctx.save();
      ctx.translate(nearBase + i * tileW, HORIZON_Y);
      ctx.scale(SKY_SCALE, SKY_SCALE);
      drawSilhouetteRow(city.nearColor, 1);
      city.landmark(city.nearColor);
      ctx.restore();
    }
  }

  // ---- Desert biome (existing dune/cactus obstacles) ----

  function duneShape(x, isTop, edgeY) {
    ctx.beginPath();
    if (isTop) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, edgeY - 18);
      ctx.quadraticCurveTo(x + PIPE_W / 2, edgeY + 16, x + PIPE_W, edgeY - 18);
      ctx.lineTo(x + PIPE_W, 0);
    } else {
      ctx.moveTo(x, LH);
      ctx.lineTo(x, edgeY + 18);
      ctx.quadraticCurveTo(x + PIPE_W / 2, edgeY - 16, x + PIPE_W, edgeY + 18);
      ctx.lineTo(x + PIPE_W, LH);
    }
    ctx.closePath();
  }

  function drawCactus(cx, topY) {
    ctx.fillStyle = '#3f7d4f';
    ctx.fillRect(cx - 5, topY - 34, 10, 34);
    ctx.fillRect(cx - 16, topY - 22, 10, 14);
    ctx.fillRect(cx + 6, topY - 28, 10, 18);
  }

  // ---- Coastal biome (palm trees) ----

  function palmPipeShape(x, isTop, edgeY) {
    ctx.beginPath();
    if (isTop) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, edgeY - 8);
      ctx.quadraticCurveTo(x + PIPE_W / 2, edgeY + 6, x + PIPE_W, edgeY - 8);
      ctx.lineTo(x + PIPE_W, 0);
    } else {
      ctx.moveTo(x, LH);
      ctx.lineTo(x, edgeY + 8);
      ctx.quadraticCurveTo(x + PIPE_W / 2, edgeY - 6, x + PIPE_W, edgeY + 8);
      ctx.lineTo(x + PIPE_W, LH);
    }
    ctx.closePath();
  }

  function drawPalmTree(cx, groundY) {
    ctx.strokeStyle = '#7a5a34';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, groundY);
    ctx.quadraticCurveTo(cx + 4, groundY - 20, cx, groundY - 38);
    ctx.stroke();

    ctx.fillStyle = '#3f7d4f';
    const topX = cx, topY = groundY - 38;
    for (let i = 0; i < 5; i++) {
      const angle = -Math.PI / 2 + (i - 2) * 0.5;
      const fx = topX + Math.cos(angle) * 22;
      const fy = topY + Math.sin(angle) * 14;
      ctx.beginPath();
      ctx.moveTo(topX, topY);
      ctx.quadraticCurveTo(topX + Math.cos(angle) * 11, topY + Math.sin(angle) * 7 - 6, fx, fy);
      ctx.quadraticCurveTo(topX + Math.cos(angle) * 11, topY + Math.sin(angle) * 7 + 6, topX, topY);
      ctx.closePath();
      ctx.fill();
    }
  }

  // ---- Hill / Mediterranean biome (cedar-wedge pipes, no separate accent) ----

  function cedarPipeShape(x, isTop, edgeY) {
    const w = PIPE_W;
    ctx.beginPath();
    if (isTop) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, edgeY - 55);
      ctx.lineTo(x + w * 0.15, edgeY - 55);
      ctx.lineTo(x + w * 0.15, edgeY - 30);
      ctx.lineTo(x + w * 0.35, edgeY - 30);
      ctx.lineTo(x + w * 0.35, edgeY - 12);
      ctx.lineTo(x + w / 2, edgeY - 12);
      ctx.lineTo(x + w / 2, edgeY);
      ctx.lineTo(x + w * 0.65, edgeY - 12);
      ctx.lineTo(x + w * 0.65, edgeY - 30);
      ctx.lineTo(x + w * 0.85, edgeY - 30);
      ctx.lineTo(x + w * 0.85, edgeY - 55);
      ctx.lineTo(x + w, edgeY - 55);
      ctx.lineTo(x + w, 0);
      ctx.closePath();
    } else {
      ctx.moveTo(x, LH);
      ctx.lineTo(x, edgeY + 55);
      ctx.lineTo(x + w * 0.15, edgeY + 55);
      ctx.lineTo(x + w * 0.15, edgeY + 30);
      ctx.lineTo(x + w * 0.35, edgeY + 30);
      ctx.lineTo(x + w * 0.35, edgeY + 12);
      ctx.lineTo(x + w / 2, edgeY + 12);
      ctx.lineTo(x + w / 2, edgeY);
      ctx.lineTo(x + w * 0.65, edgeY + 12);
      ctx.lineTo(x + w * 0.65, edgeY + 30);
      ctx.lineTo(x + w * 0.85, edgeY + 30);
      ctx.lineTo(x + w * 0.85, edgeY + 55);
      ctx.lineTo(x + w, edgeY + 55);
      ctx.lineTo(x + w, LH);
      ctx.closePath();
    }
  }

  function drawPipes() {
    const biome = BIOME_SHAPES[currentBiome] || BIOME_SHAPES.desert;
    for (const p of pipes) {
      const topH = p.gapY - GAP_H / 2;
      const botY = p.gapY + GAP_H / 2;

      const g = ctx.createLinearGradient(p.x, 0, p.x + PIPE_W, 0);
      biome.gradientStops.forEach(([stop, color]) => g.addColorStop(stop, color));
      ctx.fillStyle = g;

      biome.pipeShape(p.x, true, topH);
      ctx.fill();
      biome.pipeShape(p.x, false, botY);
      ctx.fill();

      if (biome.accent && p.accent) {
        biome.accent(p.x + PIPE_W / 2, botY - 18);
      }
    }
  }

  function drawGround() {
    const y = LH - GROUND_H;
    ctx.fillStyle = '#e0a85f';
    ctx.fillRect(0, y, LW, GROUND_H);
    ctx.fillStyle = '#c98a4f';
    for (let x = -40; x < LW + 40; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x - groundOffset, y);
      ctx.lineTo(x - groundOffset + 20, y);
      ctx.lineTo(x - groundOffset + 10, y + 10);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#b97a3f';
    ctx.fillRect(0, y, LW, 4);
  }

  function drawRiderMan() {
    // thobe (white robe, triangular sitting shape)
    ctx.fillStyle = '#f5f3ee';
    ctx.beginPath();
    ctx.moveTo(-10, -14);
    ctx.lineTo(10, -14);
    ctx.lineTo(14, 4);
    ctx.lineTo(-14, 4);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // arm
    ctx.strokeStyle = '#f5f3ee';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(6, -10);
    ctx.lineTo(20, -14);
    ctx.stroke();

    // head
    ctx.fillStyle = '#e8b98a';
    ctx.beginPath();
    ctx.arc(0, -20, 7, 0, Math.PI * 2);
    ctx.fill();

    // keffiyeh (checkered headdress)
    ctx.fillStyle = '#f7f5f0';
    ctx.beginPath();
    ctx.moveTo(-9, -25);
    ctx.lineTo(9, -25);
    ctx.lineTo(11, -14);
    ctx.lineTo(-6, -10);
    ctx.lineTo(-11, -14);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(-9, -25, 18, 3);
    ctx.beginPath();
    ctx.arc(0, -28, 6, Math.PI, 0);
    ctx.fill();
    // agal (black cord)
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, -24, 8, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
  }

  function drawRiderWoman() {
    // abaya (dark robe, same silhouette as the thobe)
    ctx.fillStyle = '#2b2b2f';
    ctx.beginPath();
    ctx.moveTo(-10, -14);
    ctx.lineTo(10, -14);
    ctx.lineTo(14, 4);
    ctx.lineTo(-14, 4);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // arm
    ctx.strokeStyle = '#2b2b2f';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(6, -10);
    ctx.lineTo(20, -14);
    ctx.stroke();

    // head
    ctx.fillStyle = '#e8b98a';
    ctx.beginPath();
    ctx.arc(0, -20, 7, 0, Math.PI * 2);
    ctx.fill();

    // hijab (hood over the head)
    ctx.fillStyle = '#7a3b4a';
    ctx.beginPath();
    ctx.arc(0, -21, 9, Math.PI, 0);
    ctx.lineTo(9, -14);
    ctx.quadraticCurveTo(6, -8, 2, -6);
    ctx.lineTo(-2, -14);
    ctx.lineTo(-9, -14);
    ctx.closePath();
    ctx.fill();

    // drape falling toward the shoulder
    ctx.beginPath();
    ctx.moveTo(6, -16);
    ctx.quadraticCurveTo(14, -4, 10, 6);
    ctx.quadraticCurveTo(6, -2, 2, -12);
    ctx.closePath();
    ctx.fill();
  }

  function drawPlayer() {
    const x = PLAYER_X;
    const y = player.y;
    const bob = Math.sin(Date.now() / 120) * 2 * (state === 'playing' ? 1 : 0.4);
    const hop = flapAnim * -6;
    const cy = y + bob + hop;

    ctx.save();
    ctx.translate(x, cy);

    const angle = state === 'playing' ? Math.max(-0.3, Math.min(0.5, player.vy / 900)) : 0;
    ctx.rotate(angle);

    // legs
    ctx.strokeStyle = '#7a5230';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-14, 16); ctx.lineTo(-16, 30);
    ctx.moveTo(-2, 18); ctx.lineTo(-4, 32);
    ctx.moveTo(10, 18); ctx.lineTo(12, 32);
    ctx.moveTo(20, 14); ctx.lineTo(22, 28);
    ctx.stroke();

    // camel body
    const bodyGrad = ctx.createLinearGradient(-30, -10, 30, 20);
    bodyGrad.addColorStop(0, '#c99a63');
    bodyGrad.addColorStop(1, '#a97c46');
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.ellipse(0, 6, 30, 16, 0, 0, Math.PI * 2);
    ctx.fill();

    // hump
    ctx.beginPath();
    ctx.ellipse(-4, -10, 14, 12, 0, 0, Math.PI * 2);
    ctx.fill();

    // neck + head
    ctx.beginPath();
    ctx.moveTo(24, 2);
    ctx.quadraticCurveTo(38, -6, 34, -20);
    ctx.quadraticCurveTo(32, -26, 26, -24);
    ctx.quadraticCurveTo(30, -14, 20, -4);
    ctx.closePath();
    ctx.fill();

    // camel face detail
    ctx.fillStyle = '#3a2a18';
    ctx.beginPath();
    ctx.arc(33, -21, 1.6, 0, Math.PI * 2);
    ctx.fill();

    if (selectedCharacter === 'woman') {
      drawRiderWoman();
    } else {
      drawRiderMan();
    }

    ctx.restore();
  }

  function drawText(text, x, y, size, color, weight = '700') {
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px "Segoe UI", Tahoma, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  function drawOutlinedText(text, x, y, size, color) {
    ctx.font = `800 ${size}px "Segoe UI", Tahoma, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = size * 0.12;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function drawCitySelectScreen() {
    drawOutlinedText('اختر مدينتك', LW / 2, 56, 26, '#ffffff');
    drawText('Choose your city', LW / 2, 84, 15, 'rgba(255,255,255,0.85)', '600');

    CITIES.forEach((c, i) => {
      const r = cityCardRects[i];
      const selected = c.key === selectedCity;
      roundRectPath(r.x, r.y, r.w, r.h, 12);
      ctx.fillStyle = selected ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.28)';
      ctx.fill();
      ctx.lineWidth = selected ? 3 : 1;
      ctx.strokeStyle = selected ? '#ffe08a' : 'rgba(255,255,255,0.3)';
      ctx.stroke();

      drawText(c.nameAr, r.x + r.w / 2, r.y + r.h / 2 - 12, 18, '#ffffff', '700');
      drawText(c.nameEn, r.x + r.w / 2, r.y + r.h / 2 + 14, 12, 'rgba(255,255,255,0.85)', '500');
    });
  }

  function drawCharacterCard(r, key, nameAr, nameEn) {
    const selected = selectedCharacter === key;
    roundRectPath(r.x, r.y, r.w, r.h, 14);
    ctx.fillStyle = selected ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.28)';
    ctx.fill();
    ctx.lineWidth = selected ? 3 : 1;
    ctx.strokeStyle = selected ? '#ffe08a' : 'rgba(255,255,255,0.3)';
    ctx.stroke();

    ctx.save();
    ctx.translate(r.x + r.w / 2, r.y + r.h / 2 - 20);
    ctx.scale(1.8, 1.8);
    if (key === 'woman') drawRiderWoman(); else drawRiderMan();
    ctx.restore();

    drawText(nameAr, r.x + r.w / 2, r.y + r.h - 46, 18, '#ffffff', '700');
    drawText(nameEn, r.x + r.w / 2, r.y + r.h - 24, 13, 'rgba(255,255,255,0.85)', '500');
  }

  function drawCharacterSelectScreen() {
    drawOutlinedText('اختر شخصيتك', LW / 2, 56, 26, '#ffffff');
    drawText('Choose your character', LW / 2, 84, 15, 'rgba(255,255,255,0.85)', '600');

    drawCharacterCard(manCardRect, 'man', 'رجل', 'Man');
    drawCharacterCard(womanCardRect, 'woman', 'امرأة', 'Woman');
  }

  function drawBackButton() {
    const { x, y, w, h } = BACK_BTN;
    const cx = x + w / 2, cy = y + h / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
    ctx.beginPath();
    ctx.arc(cx, cy, w / 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + 5, cy - 8);
    ctx.lineTo(cx - 5, cy);
    ctx.lineTo(cx + 5, cy + 8);
    ctx.stroke();
    ctx.restore();
  }

  function drawHUD() {
    if (state === 'playing') {
      drawOutlinedText(String(score), LW / 2, 70, 48, '#ffffff');
    }

    if (state === 'start') {
      const city = CITIES.find(c => c.key === selectedCity);
      drawOutlinedText('قفزة الجمل', LW / 2, LH * 0.24, 34, '#ffffff');
      drawText('Camel Jump', LW / 2, LH * 0.24 + 34, 18, 'rgba(255,255,255,0.9)', '600');
      if (city) {
        drawText(`${city.nameAr} · ${city.nameEn}`, LW / 2, LH * 0.24 + 58, 13, 'rgba(255,255,255,0.8)', '500');
      }
      drawText('اضغط للبدء', LW / 2, LH * 0.6, 20, '#ffffff');
      drawText('tap to start', LW / 2, LH * 0.6 + 26, 14, 'rgba(255,255,255,0.85)', '400');
      if (best > 0) {
        drawText(`Best: ${best}`, LW / 2, LH * 0.6 + 56, 14, 'rgba(255,255,255,0.85)', '400');
      }
    }

    if (state === 'gameover') {
      ctx.fillStyle = 'rgba(30, 15, 20, 0.45)';
      ctx.fillRect(0, 0, LW, LH);
      drawOutlinedText('انتهت اللعبة', LW / 2, LH * 0.36, 30, '#ffffff');
      drawText('Game Over', LW / 2, LH * 0.36 + 30, 16, 'rgba(255,255,255,0.9)', '600');
      drawText(`Score: ${score}`, LW / 2, LH * 0.5, 22, '#ffffff');
      drawText(`Best: ${best}`, LW / 2, LH * 0.5 + 30, 16, 'rgba(255,255,255,0.85)', '400');
      drawText('tap to play again', LW / 2, LH * 0.68, 15, 'rgba(255,255,255,0.85)', '400');
    }
  }

  function drawShareButton() {
    const { x, y, w, h } = SHARE_BTN;
    roundRectPath(x, y, w, h, 19);
    ctx.fillStyle = 'rgba(255, 224, 138, 0.95)';
    ctx.fill();
    drawText('Share Score · شارك', x + w / 2, y + h / 2, 13, '#3a1f4d', '700');
  }

  function drawLogoutLabel() {
    if (!CamelAuth.isLoggedIn()) return;
    const { x, y, w, h } = LOGOUT_LABEL;
    const name = CamelAuth.currentUsername() || '';
    drawText(`${name} · Log out`, x + w / 2, y + h / 2, 12, 'rgba(255,255,255,0.75)', '500');
  }

  // Renders a standalone score-card image (independent canvas, not the game's)
  // and hands it to the phone's native share sheet, falling back to a direct
  // download if navigator.share isn't available (e.g. desktop browsers).
  async function shareScore() {
    const W = 800, H = 1000;
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const c = off.getContext('2d');

    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#ff9a56');
    g.addColorStop(0.5, '#ff7096');
    g.addColorStop(1, '#ffd9a0');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);

    c.fillStyle = 'rgba(255, 244, 214, 0.9)';
    c.beginPath();
    c.arc(W * 0.5, H * 0.2, 110, 0, Math.PI * 2);
    c.fill();

    // simple static camel + rider silhouette
    c.save();
    c.translate(W * 0.5, H * 0.55);
    c.scale(3.4, 3.4);
    c.strokeStyle = '#3a2a3f';
    c.lineWidth = 4;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(-14, 16); c.lineTo(-16, 30);
    c.moveTo(-2, 18); c.lineTo(-4, 32);
    c.moveTo(10, 18); c.lineTo(12, 32);
    c.moveTo(20, 14); c.lineTo(22, 28);
    c.stroke();
    c.fillStyle = '#3a2a3f';
    c.beginPath(); c.ellipse(0, 6, 30, 16, 0, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.ellipse(-4, -10, 14, 12, 0, 0, Math.PI * 2); c.fill();
    c.beginPath();
    c.moveTo(24, 2);
    c.quadraticCurveTo(38, -6, 34, -20);
    c.quadraticCurveTo(32, -26, 26, -24);
    c.quadraticCurveTo(30, -14, 20, -4);
    c.closePath();
    c.fill();
    c.fillStyle = '#f5f3ee';
    c.beginPath();
    c.moveTo(-10, -14); c.lineTo(10, -14); c.lineTo(14, 4); c.lineTo(-14, 4);
    c.closePath();
    c.fill();
    c.restore();

    c.textAlign = 'center';
    c.font = '800 44px "Segoe UI", Tahoma, sans-serif';
    c.lineWidth = 6;
    c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.strokeText('قفزة الجمل', W / 2, 90);
    c.fillStyle = '#ffffff';
    c.fillText('قفزة الجمل', W / 2, 90);
    c.font = '600 24px "Segoe UI", Tahoma, sans-serif';
    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.fillText('Camel Jump', W / 2, 128);

    const username = CamelAuth.currentUsername() || 'Guest';
    c.font = '700 34px "Segoe UI", Tahoma, sans-serif';
    c.fillStyle = '#ffffff';
    c.fillText(username, W / 2, H * 0.32);

    const boxW = 560, boxH = 190, boxX = (W - boxW) / 2, boxY = H * 0.72;
    const r = 20;
    c.beginPath();
    c.moveTo(boxX + r, boxY);
    c.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + boxH, r);
    c.arcTo(boxX + boxW, boxY + boxH, boxX, boxY + boxH, r);
    c.arcTo(boxX, boxY + boxH, boxX, boxY, r);
    c.arcTo(boxX, boxY, boxX + boxW, boxY, r);
    c.closePath();
    c.fillStyle = 'rgba(0, 0, 0, 0.3)';
    c.fill();

    const city = CITIES.find(ci => ci.key === selectedCity);
    const cityLabel = city ? `${city.nameAr} · ${city.nameEn}` : '';

    c.fillStyle = '#ffffff';
    c.font = '700 40px "Segoe UI", Tahoma, sans-serif';
    c.fillText(`Score: ${score}`, W / 2, boxY + 55);
    c.font = '500 26px "Segoe UI", Tahoma, sans-serif';
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.fillText(`Best: ${best}`, W / 2, boxY + 100);
    c.fillText(cityLabel, W / 2, boxY + 140);

    c.font = '400 18px "Segoe UI", Tahoma, sans-serif';
    c.fillStyle = 'rgba(255,255,255,0.7)';
    c.fillText('khalidoa.github.io/camel-flap', W / 2, H - 30);

    const blob = await new Promise(resolve => off.toBlob(resolve, 'image/png'));
    if (!blob) return;

    const shareText = `I scored ${score} in Camel Jump (${cityLabel})! Best: ${best}`;
    const file = new File([blob], 'camel-jump-score.png', { type: 'image/png' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Camel Jump', text: shareText });
        return;
      } catch (e) {
        // user cancelled, or share failed — fall back to a direct download below
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'camel-jump-score.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function drawMuteButton() {
    const { x, y, w, h } = MUTE_BTN;
    const cx = x + w / 2 - 5;
    const cy = y + h / 2;

    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
    ctx.beginPath();
    ctx.arc(x + w / 2, cy, w / 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 9, cy - 5);
    ctx.lineTo(cx - 4, cy - 5);
    ctx.lineTo(cx + 4, cy - 11);
    ctx.lineTo(cx + 4, cy + 11);
    ctx.lineTo(cx - 4, cy + 5);
    ctx.lineTo(cx - 9, cy + 5);
    ctx.closePath();
    ctx.fill();

    if (Music.isMuted()) {
      ctx.beginPath();
      ctx.moveTo(cx + 9, cy - 6); ctx.lineTo(cx + 17, cy + 6);
      ctx.moveTo(cx + 17, cy - 6); ctx.lineTo(cx + 9, cy + 6);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(cx + 8, cy, 4, -0.6, 0.6);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + 8, cy, 8, -0.7, 0.7);
      ctx.stroke();
    }
    ctx.restore();
  }

  function draw() {
    drawSky();

    if (state === 'authCheck' || state === 'auth') {
      drawHorizon('desert');
      return; // the HTML auth overlay covers the rest; skip the mute button too
    } else if (state === 'citySelect') {
      drawHorizon('desert');
      drawCitySelectScreen();
      drawLogoutLabel();
    } else if (state === 'characterSelect') {
      drawHorizon(currentBiome);
      drawSkyline(selectedCity);
      drawCharacterSelectScreen();
      drawBackButton();
    } else {
      drawHorizon(currentBiome);
      drawSkyline(selectedCity);
      drawPipes();
      drawGround();
      drawPlayer();
      drawHUD();
      if (state === 'start') drawBackButton();
      if (state === 'gameover') drawShareButton();
    }

    drawMuteButton();
  }

  function loop(timestamp) {
    if (!lastTime) lastTime = timestamp;
    let dt = (timestamp - lastTime) / 1000;
    lastTime = timestamp;
    if (dt > 0.05) dt = 0.05; // clamp to avoid big jumps on tab switch

    if (state !== 'playing') {
      groundOffset = (groundOffset + PIPE_SPEED * dt * 0.3) % 40;
      skyScrollX = (skyScrollX + SKY_SPEED * dt * 0.3) % (BASE_SKYLINE_W * SKY_SCALE);
      skyScrollXFar = (skyScrollXFar + SKY_SPEED_FAR * dt * 0.3) % (BASE_SKYLINE_W * SKY_SCALE);
    } else {
      update(dt);
    }
    draw();
    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
})();
