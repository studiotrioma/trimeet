// TriMeet no celular (site no Chrome do Android ou no Safari do iPhone)
//  - barra de salas vira gaveta (abre pelo botão do topo; fecha ao tocar fora ou ao entrar numa sala)
//  - microfone, fone e câmera também ficam no rodapé (a gaveta fica fechada quase sempre)
//  - toque longo = botão direito (menus de pessoa, sala, microfone, fone)
//  - toque duplo = dois cliques (entrar na sala, voltar ao início)
// No computador nada disto muda.
'use strict';
(() => {
  const mq = window.matchMedia('(max-width: 760px), (pointer: coarse) and (max-width: 1024px)');
  const isMobile = () => mq.matches;
  const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const q = (s) => document.querySelector(s);

  function apply() {
    document.documentElement.classList.toggle('is-mobile', isMobile());
    if (typeof fitTiles === 'function') setTimeout(fitTiles, 60);
  }
  mq.addEventListener?.('change', apply);
  apply();

  // ---- gaveta de salas ----
  window.tmMobileCloseDrawer = () => {
    if (!isMobile()) return;
    const room = q('#room');
    if (room && !room.classList.contains('side-collapsed')) room.classList.add('side-collapsed');
  };
  document.addEventListener('click', (e) => {
    if (!isMobile()) return;
    const room = q('#room');
    if (!room || room.classList.contains('side-collapsed')) return;
    if (e.target.closest('.sidebar, #sideToggle, .ctx-menu, .sfx-panel, .modal')) return;
    room.classList.add('side-collapsed');
  }, true);

  // ---- botões de voz no rodapé (espelham os do painel) ----
  const dock = q('#dock');
  if (dock) {
    const mk = (id, src, icon, title) => {
      const b = document.createElement('button');
      b.id = id;
      b.className = 'btn icon m-only';
      b.title = title;
      b.innerHTML = `<svg class="ic"><use href="#${icon}"/></svg>`;
      b.onclick = () => q(src).click();
      b.oncontextmenu = (e) => { e.preventDefault(); q(src).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: e.clientX, clientY: e.clientY })); };
      return b;
    };
    const first = dock.firstElementChild;
    for (const b of [mk('mMic', '#micBtn', 'i-mic', 'Microfone'), mk('mDeaf', '#deafBtn', 'i-headset', 'Som'), mk('mCam', '#camBtn', 'i-camera-off', 'Câmera')]) dock.insertBefore(b, first);
    // copia o estado (ícone e cor) dos botões do painel
    const mirror = () => {
      for (const [m, s] of [['#mMic', '#micBtn'], ['#mDeaf', '#deafBtn'], ['#mCam', '#camBtn']]) {
        const a = q(m), b = q(s);
        if (!a || !b) continue;
        a.className = 'btn icon m-only ' + [...b.classList].filter((c) => !['btn', 'icon', 'sm'].includes(c)).join(' ');
        const use = b.querySelector('use')?.getAttribute('href');
        if (use) a.querySelector('use').setAttribute('href', use);
      }
    };
    for (const s of ['#micBtn', '#deafBtn', '#camBtn']) {
      const el = q(s);
      if (el) new MutationObserver(mirror).observe(el, { attributes: true, subtree: true, attributeFilter: ['class', 'href'] });
    }
    mirror();
  }
  // celular não compartilha tela (o navegador do celular não deixa); assistir funciona normal
  if (!navigator.mediaDevices?.getDisplayMedia) document.documentElement.classList.add('no-share');

  if (!touch) return;

  // ---- toque longo = botão direito ----
  let lpT = null, lpStart = null, lpFired = false;
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    lpStart = { x: t.clientX, y: t.clientY, target: e.target };
    lpFired = false;
    clearTimeout(lpT);
    lpT = setTimeout(() => {
      lpFired = true;
      navigator.vibrate?.(12);
      lpStart.target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: lpStart.x, clientY: lpStart.y }));
    }, 480);
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!lpStart) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - lpStart.x, t.clientY - lpStart.y) > 10) clearTimeout(lpT);
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    clearTimeout(lpT);
    if (lpFired) { e.preventDefault(); lpFired = false; } // não vira clique depois do menu
  });
  // o Android também dispara "contextmenu" sozinho no toque longo: evita menu em dobro
  let lastCtx = 0;
  document.addEventListener('contextmenu', (e) => {
    const now = Date.now();
    if (now - lastCtx < 600) { e.stopImmediatePropagation(); e.preventDefault(); return; }
    lastCtx = now;
  }, true);

  // ---- toque duplo = dois cliques ----
  let lastTap = { t: 0, el: null };
  let synthAt = 0;
  document.addEventListener('touchend', (e) => {
    if (lpFired) return;
    const el = e.target.closest('.ch-row, #homeBtn, .src, .sfx-item, .tile');
    const now = Date.now();
    if (el && lastTap.el === el && now - lastTap.t < 380) {
      synthAt = now;
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      lastTap = { t: 0, el: null };
      return;
    }
    lastTap = { t: now, el };
  });
  // se o navegador também mandar o dblclick dele, ignora (não entra/sai duas vezes)
  document.addEventListener('dblclick', (e) => {
    if (e.isTrusted && Date.now() - synthAt < 600) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
})();
