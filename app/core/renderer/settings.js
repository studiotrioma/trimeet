// TriMeet - painel de configurações de voz e áudio
// window.TMSettings.open()  → abre o painel
// Salva em cfg.audio = { mode, inputId, outputId, sensitivity } e avisa com o evento 'tm-audio-change'.
'use strict';
(() => {
  const DEFAULTS = { mode: 'natural', inputId: 'default', outputId: 'default', sensitivity: 50 };

  // ícones próprios (só são criados se o app ainda não tiver)
  const ICONS = {
    'i-wave': '<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0"/>',
    'i-mic': '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    'i-headset': '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="7" rx="2"/><rect x="17" y="14" width="4" height="7" rx="2"/>',
    'i-gear': '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    'i-x': '<path d="M6 6l12 12M18 6 6 18"/>',
    'i-chev': '<path d="M6 9l6 6 6-6"/>',
    'i-play': '<path d="M8 5v14l11-7z"/>',
    'i-gate': '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    'i-info': '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  };
  function ensureIcons() {
    let host = document.getElementById('tmSettingsIcons');
    if (!host) {
      host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      host.id = 'tmSettingsIcons';
      host.setAttribute('width', '0'); host.setAttribute('height', '0');
      host.style.position = 'absolute';
      host.innerHTML = '<defs></defs>';
      document.body.prepend(host);
    }
    const defs = host.querySelector('defs');
    for (const [id, body] of Object.entries(ICONS)) {
      if (document.getElementById(id)) continue;
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'symbol');
      s.id = id; s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = body;
      defs.appendChild(s);
    }
  }
  const ic = (n, cls = '') => `<svg class="ic ${cls}"><use href="#${n}"/></svg>`;

  // limiar do indicador de fala (rms) a partir da sensibilidade 0..100
  const thresholdFor = (s) => 0.004 + 0.12 * Math.pow(1 - Math.min(100, Math.max(0, s)) / 100, 2);

  let root = null, cfg = null, aud = { ...DEFAULTS };
  let test = null; // { stream, meter }
  let busy = 0;

  function build() {
    ensureIcons();
    root = document.createElement('div');
    root.className = 'modal tm-settings hidden';
    root.innerHTML = `
      <div class="modal-card glass" data-glass="32">
        <div class="st-head">
          <span class="ttl">${ic('i-gear')}Voz e áudio</span>
          <span class="grow"></span>
          <button class="btn icon ghost st-close" aria-label="Fechar">${ic('i-x')}</button>
        </div>

        <div class="ctl" title="Modo de voz">
          ${ic('i-wave', 'lead')}
          <div class="segmented st-mode"><span class="thumb"></span>
            <button data-v="natural" title="Som puro do microfone">Natural</button>
            <button data-v="isolamento" title="Tira ruídos de fundo">Isolamento</button>
            <button data-v="isolamento-forte" title="Rede neural: só a sua voz">Forte</button>
          </div>
        </div>

        <div class="ctl" title="Microfone">
          ${ic('i-mic', 'lead')}
          <label class="tm-select"><select class="st-in"></select>${ic('i-chev', 'chev')}</label>
        </div>

        <div class="ctl" title="Saída de som">
          ${ic('i-headset', 'lead')}
          <label class="tm-select"><select class="st-out"></select>${ic('i-chev', 'chev')}</label>
          <button class="btn icon st-play" title="Tocar som de teste">${ic('i-play')}</button>
        </div>

        <div class="ctl" title="Teste do microfone · arraste a linha branca para ajustar a sensibilidade">
          ${ic('i-gate', 'lead')}
          <div class="tm-meter">
            <div class="track"><div class="lvl"></div></div>
            <div class="gate"></div>
            <input type="range" class="st-sens" min="0" max="100" step="1" aria-label="Sensibilidade">
          </div>
          <span class="speaking-dot" title="Acende quando o app considera que você está falando"></span>
        </div>

        <div class="st-foot">${ic('i-info')}<span class="st-msg">Fale algo: a barra mostra o que seus amigos ouvem.</span></div>
      </div>`;
    document.body.appendChild(root);
    if (window.LiquidGlass) LiquidGlass.observe(root);

    root.querySelector('.st-close').onclick = close;
    root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });

    root.querySelectorAll('.st-mode > button').forEach((b) => {
      b.onclick = () => { aud.mode = b.dataset.v; paintMode(); commit(true); };
    });
    root.querySelector('.st-in').onchange = (e) => { aud.inputId = e.target.value; commit(true); };
    root.querySelector('.st-out').onchange = (e) => { aud.outputId = e.target.value; commit(false); };
    const sens = root.querySelector('.st-sens');
    sens.oninput = () => { aud.sensitivity = Number(sens.value); paintGate(); };
    sens.onchange = () => commit(false);
    root.querySelector('.st-play').onclick = playTest;
    window.addEventListener('resize', () => isOpen() && paintMode(true));
  }

  const isOpen = () => root && !root.classList.contains('hidden') && !root.classList.contains('leaving');

  function paintMode(instant) {
    const seg = root.querySelector('.st-mode');
    seg.querySelectorAll(':scope > button').forEach((b) => b.classList.toggle('on', b.dataset.v === aud.mode));
    const on = seg.querySelector(':scope > button.on');
    const thumb = seg.querySelector('.thumb');
    if (!on || !seg.offsetWidth) return;
    if (instant) thumb.classList.add('instant');
    thumb.style.width = on.offsetWidth + 'px';
    thumb.style.transform = `translateX(${on.offsetLeft}px)`;
    if (instant) { thumb.offsetWidth; requestAnimationFrame(() => thumb.classList.remove('instant')); }
  }

  // posição da linha branca: o mesmo eixo em dB do medidor
  function gatePos() {
    const thr = thresholdFor(aud.sensitivity);
    return Math.min(1, Math.max(0, (20 * Math.log10(thr) + 60) / 60));
  }
  function paintGate() {
    root.querySelector('.st-sens').value = aud.sensitivity;
    root.querySelector('.gate').style.left = `calc(12px + (100% - 24px) * ${gatePos()})`;
  }

  async function fillDevices() {
    const { inputs, outputs } = await TMAudio.listDevices();
    const fill = (sel, list, cur) => {
      sel.innerHTML = '';
      for (const d of list) {
        const o = document.createElement('option');
        o.value = d.deviceId; o.textContent = d.label;
        sel.appendChild(o);
      }
      sel.value = list.some((d) => d.deviceId === cur) ? cur : list[0].deviceId;
    };
    fill(root.querySelector('.st-in'), inputs, aud.inputId);
    fill(root.querySelector('.st-out'), outputs, aud.outputId);
    const canSink = typeof HTMLMediaElement.prototype.setSinkId === 'function';
    root.querySelector('.st-out').disabled = !canSink;
  }

  async function startTest() {
    stopTest();
    const my = ++busy;
    const msg = root.querySelector('.st-msg');
    const foot = root.querySelector('.st-foot');
    try {
      const stream = await TMAudio.getMicStream({ mode: aud.mode, deviceId: aud.inputId });
      if (my !== busy || !isOpen()) { TMAudio.release(stream); return; }
      const lvl = root.querySelector('.lvl');
      const dot = root.querySelector('.speaking-dot');
      const m = TMAudio.meter(stream, (v, rms) => {
        lvl.style.width = (v * 100).toFixed(1) + '%';
        const talking = rms > thresholdFor(aud.sensitivity);
        lvl.classList.toggle('hot', talking);
        dot.classList.toggle('on', talking);
      });
      test = { stream, meter: m };
      foot.classList.toggle('warn', !!stream._tmFallback);
      msg.textContent = stream._tmFallback ? 'Isolamento forte indisponível neste PC — usando o Isolamento.' : 'Fale algo: a barra mostra o que seus amigos ouvem.';
      await fillDevices(); // depois da permissão os nomes dos aparelhos aparecem
    } catch (e) {
      foot.classList.add('warn');
      msg.textContent = 'Microfone bloqueado — libere em Privacidade › Microfone do Windows.';
    }
  }
  function stopTest() {
    if (!test) return;
    test.meter.stop();
    TMAudio.release(test.stream);
    test = null;
    const lvl = root && root.querySelector('.lvl');
    if (lvl) lvl.style.width = '0';
  }

  async function playTest() {
    const btn = root.querySelector('.st-play');
    try {
      const c = new AudioContext();
      const dest = c.createMediaStreamDestination();
      [523.25, 659.25, 783.99].forEach((f, i) => {
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const t = c.currentTime + i * 0.12;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        o.connect(g).connect(dest); o.start(t); o.stop(t + 0.4);
      });
      const a = new Audio();
      a.srcObject = dest.stream;
      await TMAudio.setOutputDevice(a, aud.outputId);
      btn.classList.add('playing');
      await a.play();
      setTimeout(() => { btn.classList.remove('playing'); a.srcObject = null; c.close(); }, 900);
    } catch { btn.classList.remove('playing'); }
  }

  async function commit(restartMic) {
    cfg = (await window.trimeet.loadConfig()) || {};
    cfg.audio = { ...aud };
    await window.trimeet.saveConfig(cfg);
    window.dispatchEvent(new CustomEvent('tm-audio-change', { detail: { ...aud } }));
    if (restartMic && isOpen()) startTest();
  }

  async function open() {
    if (!root) build();
    cfg = (await window.trimeet.loadConfig()) || {};
    aud = { ...DEFAULTS, ...(cfg.audio || {}) };
    root.classList.remove('hidden', 'leaving');
    requestAnimationFrame(() => { paintMode(true); paintGate(); });
    await fillDevices();
    startTest();
  }

  function close() {
    if (!isOpen()) return;
    busy++;
    stopTest();
    root.classList.add('leaving');
    setTimeout(() => { root.classList.add('hidden'); root.classList.remove('leaving'); }, 230);
  }

  async function get() {
    const c = (await window.trimeet.loadConfig()) || {};
    return { ...DEFAULTS, ...(c.audio || {}) };
  }

  window.TMSettings = { open, close, get, thresholdFor, DEFAULTS };
})();
