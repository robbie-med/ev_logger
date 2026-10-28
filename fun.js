/* fun.js — Fun mode: emoji confetti + procedurally generated happy music (Web Audio, no files).
 * Exposes window.Fun = { toggle(), on, burst() }. Music only starts from a tap (browser autoplay rules).
 */
'use strict';

(function () {
  const EMOJI = ['💖', '💕', '🦄', '🍬', '🍭', '🌈', '✨', '🧁', '💗', '⭐'];
  const COLORS = ['#ff4fa3', '#ffd23f', '#3ee0cf', '#9b5de5', '#00bbf9', '#f15bb5', '#fee440'];
  const calm = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- confetti ----------
  let canvas, cx, parts = [], raf = 0, last = 0;

  function spawn(x, y, n, spread) {
    for (let i = 0; i < n; i++) {
      const emoji = Math.random() < 0.45;
      parts.push({
        x, y,
        vx: (Math.random() - 0.5) * spread, vy: -Math.random() * spread * 0.9 - 2,
        r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
        s: emoji ? 18 + Math.random() * 14 : 6 + Math.random() * 6,
        c: COLORS[(Math.random() * COLORS.length) | 0],
        e: emoji ? EMOJI[(Math.random() * EMOJI.length) | 0] : null,
        life: 1,
      });
    }
  }

  function frame(t) {
    const dt = Math.min(50, t - (last || t)) / 16.7;
    last = t;
    const w = canvas.width = innerWidth, h = canvas.height = innerHeight;
    cx.clearRect(0, 0, w, h);
    // gentle rain while fun mode is on
    if (Fun.on && !calm && Math.random() < 0.12 * dt) spawn(Math.random() * w, -20, 1, 2);
    parts = parts.filter(p => p.y < h + 40 && p.life > 0);
    for (const p of parts) {
      p.vy += 0.12 * dt; p.vx *= 0.995; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
      if (!Fun.on) p.life -= 0.02 * dt;
      cx.save();
      cx.globalAlpha = Math.max(0, p.life);
      cx.translate(p.x, p.y);
      cx.rotate(p.r);
      if (p.e) { cx.font = `${p.s}px serif`; cx.fillText(p.e, -p.s / 2, p.s / 2); }
      else { cx.fillStyle = p.c; cx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); }
      cx.restore();
    }
    raf = (Fun.on || parts.length) ? requestAnimationFrame(frame) : 0;
  }

  function ensureLoop() {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'fun-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      document.body.appendChild(canvas);
      cx = canvas.getContext('2d');
    }
    if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
  }

  function burst(x = innerWidth / 2, y = innerHeight / 3) {
    ensureLoop();
    spawn(x, y, calm ? 15 : 80, 14);
  }

  // ---------- music: I–V–vi–IV in a random happy key, pentatonic melody, arps, bass ----------
  let ac = null, master = null, timer = 0, next = 0, step = 0, mel = 2;
  const PROG = [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]];
  const PENTA = [0, 2, 4, 7, 9, 12, 14, 16];
  const BPM = 112, STEP = 60 / BPM / 4; // sixteenth notes
  let key = 60;
  const hz = midi => 440 * Math.pow(2, (midi - 69) / 12);

  function tone(midi, t, dur, type, gain) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.value = hz(midi);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function schedule() {
    while (next < ac.currentTime + 0.12) {
      const bar = Math.floor(step / 16) % PROG.length, s = step % 16, chord = PROG[bar].map(n => key + n);
      if (s === 0) chord.forEach(n => tone(n, next, STEP * 15, 'sine', 0.035));            // pad
      if (s % 8 === 0) tone(chord[0] - 24, next, STEP * 6, 'triangle', 0.12);               // bass
      if (s % 2 === 0) tone(chord[(s / 2) % 3] + 12, next, STEP * 1.5, 'triangle', 0.04);  // arpeggio
      // melody: a random walk on the pentatonic, landing on chord tones on the beat
      if ((s % 4 === 0 && Math.random() < 0.9) || (s % 2 === 0 && Math.random() < 0.35)) {
        mel = Math.max(0, Math.min(PENTA.length - 1, mel + [-2, -1, -1, 0, 1, 1, 2][(Math.random() * 7) | 0]));
        let n = key + 12 + PENTA[mel];
        if (s % 4 === 0) n = chord.map(c => c + 12).reduce((a, c) => (Math.abs(c - n) < Math.abs(a - n) ? c : a));
        tone(n, next, STEP * (s % 4 === 0 ? 3 : 1.6), 'square', 0.025);
      }
      if (Math.random() < 0.04) tone(key + 36 + PENTA[(Math.random() * 5) | 0], next, STEP * 2, 'sine', 0.03); // sparkle
      next += STEP;
      step++;
    }
  }

  function startMusic() {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    ac.resume();
    master = ac.createGain();
    master.gain.value = 0.8;
    const delay = ac.createDelay(), fb = ac.createGain();
    delay.delayTime.value = STEP * 3;
    fb.gain.value = 0.28;
    master.connect(ac.destination);
    master.connect(delay).connect(fb).connect(delay);
    fb.connect(ac.destination);
    key = [60, 62, 65, 67][(Math.random() * 4) | 0]; // C, D, F or G major
    step = 0;
    next = ac.currentTime + 0.05;
    timer = setInterval(schedule, 25);
  }

  // ---------- cute click chirps: a quick two-note pentatonic "boop-bip" ----------
  function chirp() {
    if (!ac) return;
    const t = ac.currentTime, n = key + 24 + PENTA[(Math.random() * 6) | 0];
    [[n, 0, 'sine'], [n + [4, 5, 7, 12][(Math.random() * 4) | 0], 0.07, 'triangle']].forEach(([m, dt, type]) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type;
      o.frequency.setValueAtTime(hz(m) * 0.92, t + dt);
      o.frequency.exponentialRampToValueAtTime(hz(m), t + dt + 0.04); // little upward "boing"
      g.gain.setValueAtTime(0.0001, t + dt);
      g.gain.exponentialRampToValueAtTime(0.12, t + dt + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.16);
      o.connect(g).connect(ac.destination);
      o.start(t + dt);
      o.stop(t + dt + 0.2);
    });
  }

  function onTap(e) {
    if (!Fun.on || e.target.closest('#fun')) return;
    chirp();
    ensureLoop();
    spawn(e.clientX, e.clientY, calm ? 3 : 12, 7);
  }

  // ---------- random confetti explosions while fun mode is on ----------
  let boomTimer = 0;
  function scheduleBoom() {
    boomTimer = setTimeout(() => {
      if (!Fun.on) return;
      burst(innerWidth * (0.15 + Math.random() * 0.7), innerHeight * (0.15 + Math.random() * 0.5));
      scheduleBoom();
    }, 2500 + Math.random() * 4500);
  }

  function stopMusic() {
    clearInterval(timer);
    if (master) { master.gain.setTargetAtTime(0, ac.currentTime, 0.1); master = null; }
  }

  const Fun = {
    on: false,
    burst,
    toggle() {
      Fun.on = !Fun.on;
      document.body.classList.toggle('fun', Fun.on);
      if (Fun.on) { burst(); startMusic(); if (!calm) scheduleBoom(); }
      else { stopMusic(); clearTimeout(boomTimer); }
      ensureLoop();
      return Fun.on;
    },
  };
  window.Fun = Fun;
  document.addEventListener('pointerdown', onTap, true);
})();
