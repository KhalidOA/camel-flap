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

  const BEST_KEY = 'camelFlapBest';
  const MUTE_KEY = 'camelFlapMuted';
  const MUTE_BTN = { x: LW - 46, y: 10, w: 36, h: 36 };

  // ---- Procedurally generated background music (no audio files) ----
  // A short looping phrase in D Hijaz (a scale common in Arabic music)
  // over a drone, plus a simple darbuka-style dum/tak percussion pulse.
  const Music = (() => {
    const SCALE = [293.66, 311.13, 369.99, 392.00, 440.00, 466.16, 523.25, 587.33]; // D Eb F# G A Bb C D
    const MELODY = [4, -1, 3, 2, 3, -1, 1, 0, 0, -1, 1, 2, 4, -1, 2, -1];
    const TEMPO = 96;
    const STEP_DUR = 60 / TEMPO / 2;

    let ctx = null;
    let masterGain = null;
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

      const drone = ctx.createOscillator();
      drone.type = 'sine';
      drone.frequency.value = SCALE[0] / 2;
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

    return { start, resume, toggleMute, isMuted: () => muted };
  })();

  function isMuteButtonHit(lx, ly) {
    return lx >= MUTE_BTN.x && lx <= MUTE_BTN.x + MUTE_BTN.w &&
           ly >= MUTE_BTN.y && ly <= MUTE_BTN.y + MUTE_BTN.h;
  }

  let state = 'start'; // start | playing | gameover
  let player, pipes, score, best, spawnTimer, groundOffset, lastTime;
  let flapAnim = 0;

  function resetGame() {
    player = { y: LH * 0.42, vy: 0 };
    pipes = [];
    score = 0;
    spawnTimer = 0;
    groundOffset = 0;
    flapAnim = 0;
  }

  best = Number(localStorage.getItem(BEST_KEY) || 0);
  resetGame();

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

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    Music.start();
    Music.resume();

    const rect = canvas.getBoundingClientRect();
    const lx = (e.clientX - rect.left) * (LW / rect.width);
    const ly = (e.clientY - rect.top) * (LH / rect.height);
    if (isMuteButtonHit(lx, ly)) {
      Music.toggleMute();
      return;
    }
    flap();
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
    pipes.push({ x: LW + PIPE_W, gapY, scored: false, cactus: Math.random() < 0.5 });
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
      }
    }

    groundOffset = (groundOffset + PIPE_SPEED * dt) % 40;
    if (flapAnim > 0) flapAnim = Math.max(0, flapAnim - dt * 3);
  }

  // ---------------- Drawing ----------------

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

  function drawDistantDunes() {
    ctx.fillStyle = 'rgba(150, 70, 90, 0.35)';
    const baseY = LH - GROUND_H - 30;
    ctx.beginPath();
    ctx.moveTo(0, baseY + 40);
    for (let x = 0; x <= LW; x += 40) {
      const y = baseY + Math.sin((x + groundOffset * 0.4) * 0.02) * 14;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(LW, LH);
    ctx.lineTo(0, LH);
    ctx.closePath();
    ctx.fill();
  }

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

  function drawPipes() {
    for (const p of pipes) {
      const topH = p.gapY - GAP_H / 2;
      const botY = p.gapY + GAP_H / 2;

      const g = ctx.createLinearGradient(p.x, 0, p.x + PIPE_W, 0);
      g.addColorStop(0, '#d9a066');
      g.addColorStop(0.5, '#f0c98a');
      g.addColorStop(1, '#c98a4f');
      ctx.fillStyle = g;

      duneShape(p.x, true, topH);
      ctx.fill();
      duneShape(p.x, false, botY);
      ctx.fill();

      if (p.cactus) {
        drawCactus(p.x + PIPE_W / 2, botY - 18);
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

    // ---- rider ----
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

  function drawHUD() {
    if (state === 'playing') {
      drawOutlinedText(String(score), LW / 2, 70, 48, '#ffffff');
    }

    if (state === 'start') {
      drawOutlinedText('قفزة الجمل', LW / 2, LH * 0.28, 34, '#ffffff');
      drawText('Camel Flap', LW / 2, LH * 0.28 + 34, 18, 'rgba(255,255,255,0.9)', '600');
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
    drawDistantDunes();
    drawPipes();
    drawGround();
    drawPlayer();
    drawHUD();
    drawMuteButton();
  }

  function loop(timestamp) {
    if (!lastTime) lastTime = timestamp;
    let dt = (timestamp - lastTime) / 1000;
    lastTime = timestamp;
    if (dt > 0.05) dt = 0.05; // clamp to avoid big jumps on tab switch

    if (state !== 'playing') {
      groundOffset = (groundOffset + PIPE_SPEED * dt * 0.3) % 40;
    } else {
      update(dt);
    }
    draw();
    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
})();
