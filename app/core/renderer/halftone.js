// Fundo animado em pontos (estilo painel de LED): manchas azul e creme
// vistas através de uma grade de pontinhos. Pausa quando não está visível.
'use strict';
(() => {
  const cv = document.getElementById('halftone');
  const g = cv.getContext('2d');
  const small = document.createElement('canvas');
  const sg = small.getContext('2d');
  const STEP = 7;        // espaçamento entre pontos (px)
  const DOT = 4.4;       // tamanho do ponto
  let W = 0, H = 0, cols = 0, rows = 0, dpr = 1, pattern = null;
  let active = true, raf = 0, last = 0, t0 = performance.now();

  const blobs = [
    { c: [243, 233, 214], x: .78, y: .12, r: .42, sx: .05, sy: .03, p: 0 },
    { c: [62, 160, 225], x: .92, y: .45, r: .30, sx: .04, sy: .06, p: 2 },
    { c: [240, 228, 205], x: .15, y: .52, r: .38, sx: .06, sy: .04, p: 4 },
    { c: [70, 170, 230], x: .05, y: .28, r: .22, sx: .03, sy: .05, p: 1 },
    { c: [236, 222, 196], x: .55, y: .88, r: .40, sx: .05, sy: .03, p: 3 },
    { c: [55, 130, 200], x: .35, y: .70, r: .20, sx: .04, sy: .05, p: 5 },
  ];

  function makePattern() {
    const p = document.createElement('canvas');
    const s = Math.round(STEP * dpr);
    p.width = p.height = s;
    const pg = p.getContext('2d');
    const d = DOT * dpr, o = (s - d) / 2, rr = d * 0.28;
    pg.fillStyle = '#fff';
    pg.beginPath();
    pg.roundRect(o, o, d, d, rr);
    pg.fill();
    pattern = g.createPattern(p, 'repeat');
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cols = Math.ceil(W / STEP); rows = Math.ceil(H / STEP);
    small.width = cols; small.height = rows;
    makePattern();
    draw(performance.now());
  }

  function draw(now) {
    if (!cols || !rows || !cv.width || !cv.height) return;
    const t = (now - t0) / 1000;
    sg.globalCompositeOperation = 'source-over';
    sg.fillStyle = '#000';
    sg.fillRect(0, 0, cols, rows);
    sg.globalCompositeOperation = 'lighter';
    const m = Math.max(cols, rows);
    for (const b of blobs) {
      const x = (b.x + Math.sin(t * b.sx + b.p) * 0.12) * cols;
      const y = (b.y + Math.cos(t * b.sy + b.p * 1.3) * 0.10) * rows;
      const r = b.r * m * (0.9 + Math.sin(t * 0.07 + b.p) * 0.1);
      const gr = sg.createRadialGradient(x, y, 0, x, y, r);
      const [R, G, B] = b.c;
      gr.addColorStop(0, `rgba(${R},${G},${B},.95)`);
      gr.addColorStop(.45, `rgba(${R},${G},${B},.45)`);
      gr.addColorStop(1, `rgba(${R},${G},${B},0)`);
      sg.fillStyle = gr;
      sg.fillRect(0, 0, cols, rows);
    }
    // vinheta para o centro/esquerda ficar mais escuro (texto legível)
    sg.globalCompositeOperation = 'source-over';
    const v = sg.createRadialGradient(cols * .32, rows * .55, 0, cols * .32, rows * .55, m * .55);
    v.addColorStop(0, 'rgba(0,0,0,.72)');
    v.addColorStop(1, 'rgba(0,0,0,0)');
    sg.fillStyle = v;
    sg.fillRect(0, 0, cols, rows);

    g.globalCompositeOperation = 'source-over';
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, cv.width, cv.height);
    g.drawImage(small, 0, 0, cols * STEP * dpr, rows * STEP * dpr);
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = pattern;
    g.fillRect(0, 0, cv.width, cv.height);
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - last < 33) return; // ~30 fps é suficiente e economiza a placa de vídeo
    last = now;
    draw(now);
  }

  function setActive(on) {
    on = !!on;
    cv.classList.toggle('off', !on);
    if (on === active) return;
    active = on;
    if (on && !raf) { raf = requestAnimationFrame(loop); }
    if (!on) setTimeout(() => { if (!active) { cancelAnimationFrame(raf); raf = 0; } }, 1000);
  }

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
    else if (active && !raf) raf = requestAnimationFrame(loop);
  });
  resize();
  raf = requestAnimationFrame(loop);
  window.Halftone = { setActive };
})();
