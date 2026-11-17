// Vidro líquido: gera um "mapa de refração" para a borda de cada painel
// e aplica como filtro SVG no backdrop-filter (o Electron/Chromium suporta).
'use strict';
(() => {
  const defs = document.getElementById('glassDefs');
  const NS = 'http://www.w3.org/2000/svg';
  let n = 0;

  function buildMap(w, h, radius, bezel) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    const d = img.data;
    const r = Math.min(radius, w / 2, h / 2);
    const hx = w / 2, hy = h / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = x + 0.5 - hx, py = y + 0.5 - hy;
        const qx = Math.abs(px) - (hx - r), qy = Math.abs(py) - (hy - r);
        // distância até a borda (positivo = dentro)
        const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
        const inside = Math.min(Math.max(qx, qy), 0);
        const dist = -(outside + inside - r);
        let dx = 0, dy = 0;
        if (dist >= 0 && dist < bezel) {
          let nx, ny;
          if (qx > 0 && qy > 0) { const l = Math.hypot(qx, qy) || 1; nx = (qx / l) * Math.sign(px); ny = (qy / l) * Math.sign(py); }
          else if (qx > qy) { nx = Math.sign(px); ny = 0; }
          else { nx = 0; ny = Math.sign(py); }
          // perfil de lente: forte na borda, some suavemente para dentro
          const t = 1 - dist / bezel;
          const m = t * t * (3 - 2 * t);
          dx = -nx * m; dy = -ny * m;
        }
        const i = (y * w + x) * 4;
        d[i] = 128 + dx * 127;
        d[i + 1] = 128 + dy * 127;
        d[i + 2] = 128;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL();
  }

  function apply(el) {
    const rect = el.getBoundingClientRect();
    const w = Math.round(rect.width), h = Math.round(rect.height);
    if (w < 8 || h < 8) return;
    const key = w + 'x' + h;
    if (el._glassKey === key) return;
    el._glassKey = key;
    const radius = parseFloat(el.dataset.glass) || 24;
    const bezel = Math.min(18, Math.min(w, h) / 3);
    const id = el._glassId || (el._glassId = 'lg' + (++n));
    let f = document.getElementById(id);
    if (!f) {
      f = document.createElementNS(NS, 'filter');
      f.id = id;
      f.setAttribute('color-interpolation-filters', 'sRGB');
      f.setAttribute('filterUnits', 'userSpaceOnUse');
      f.innerHTML = '<feImage result="map" preserveAspectRatio="none"/><feDisplacementMap in="SourceGraphic" in2="map" xChannelSelector="R" yChannelSelector="G"/>';
      defs.appendChild(f);
    }
    f.setAttribute('x', 0); f.setAttribute('y', 0); f.setAttribute('width', w); f.setAttribute('height', h);
    const im = f.querySelector('feImage');
    im.setAttribute('href', buildMap(w, h, radius, bezel));
    im.setAttribute('x', 0); im.setAttribute('y', 0); im.setAttribute('width', w); im.setAttribute('height', h);
    f.querySelector('feDisplacementMap').setAttribute('scale', Math.min(46, bezel * 2.4));
    el.style.setProperty('--lg-filter', `url(#${id})`);
    el.classList.add('lg-ready');
  }

  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      clearTimeout(e.target._glassT);
      e.target._glassT = setTimeout(() => apply(e.target), 80);
    }
  });

  window.LiquidGlass = {
    observe(root = document) {
      root.querySelectorAll('[data-glass]').forEach((el) => {
        if (el._glassObs) return;
        el._glassObs = true;
        ro.observe(el);
      });
    },
  };
  window.addEventListener('DOMContentLoaded', () => LiquidGlass.observe());
  if (document.readyState !== 'loading') LiquidGlass.observe();
})();
