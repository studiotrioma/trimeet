// TriMeet — Soundboard (efeitos sonoros estilo Discord)
// Biblioteca compartilhada: cada PC guarda uma cópia e os apps trocam os sons
// entre si pelo saguão. Tocar um efeito manda só um aviso curto para a sala.
'use strict';
(() => {
  const MAX_BYTES = 400 * 1024;
  const MAX_SECONDS = 15;
  const COOLDOWN = 1500;
  const EMOJIS = ['😂', '🤣', '👏', '🔥', '💀', '😱', '🥁', '🎺', '📯', '🔔', '🤡', '👀', '🐐', '💥', '🎉', '😴'];
  const BUILTIN = [
    { id: 'b-sino', name: 'Sino', emoji: '🔔', builtin: true },
    { id: 'b-tambor', name: 'Tambor', emoji: '🥁', builtin: true },
    { id: 'b-buzina', name: 'Buzina', emoji: '📯', builtin: true },
    { id: 'b-festa', name: 'Festa', emoji: '🎉', builtin: true },
  ];

  let api = null;
  const lib = new Map();      // id -> { id, name, emoji, by, ts, deleted, size, data }
  const buffers = new Map();  // id -> AudioBuffer decodificado
  const lastRecv = new Map(); // nome -> último toque recebido (anti-spam)
  let lastSent = 0;
  let ctx = null;
  let master = null;
  let panel = null;
  let anchor = null;
  let draft = null;           // som sendo adicionado
  let saveT = null;

  let volume = 0.8;
  try { const v = parseFloat(localStorage.getItem('tm-sfx-vol')); if (!Number.isNaN(v)) volume = Math.max(0, Math.min(1, v)); } catch {}

  const ic = (n) => (api && api.icon ? api.icon(n) : '');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function actx() {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // ------------------------------------------------------------------
  // Biblioteca
  // ------------------------------------------------------------------
  function valid(s) {
    return s && typeof s.id === 'string' && /^[a-z0-9-]{3,40}$/i.test(s.id) && !s.id.startsWith('b-');
  }
  function merge(s) {
    if (!valid(s)) return false;
    const cur = lib.get(s.id);
    const ts = +s.ts || 0;
    if (cur && cur.ts >= ts) return false;
    if (!s.deleted && (typeof s.data !== 'string' || !s.data.startsWith('data:audio/') || s.data.length > 900 * 1024)) return false;
    lib.set(s.id, {
      id: s.id,
      name: String(s.name || 'Som').slice(0, 20),
      emoji: String(s.emoji || '🔊').slice(0, 8),
      by: String(s.by || '').slice(0, 32),
      ts,
      deleted: !!s.deleted,
      size: +s.size || 0,
      data: s.deleted ? '' : s.data,
    });
    buffers.delete(s.id);
    return true;
  }
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => { try { window.trimeet.soundsSave([...lib.values()]); } catch {} }, 300);
  }
  function index() {
    return [...lib.values()].map(({ data, ...rest }) => rest);
  }
  function allSounds() {
    const users = [...lib.values()].filter((s) => !s.deleted).sort((a, b) => a.ts - b.ts);
    return [...BUILTIN, ...users];
  }
  function find(id) { return BUILTIN.find((b) => b.id === id) || (lib.get(id)?.deleted ? null : lib.get(id)); }

  async function load() {
    try {
      const list = (await window.trimeet.soundsLoad()) || [];
      for (const s of list) merge(s);
    } catch {}
    render();
  }

  // ------------------------------------------------------------------
  // Sons de exemplo sintetizados (sem arquivos)
  // ------------------------------------------------------------------
  function noiseBuffer(c, seconds) {
    const b = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  function synth(id) {
    const c = actx();
    const t0 = c.currentTime + 0.02;
    const out = c.createGain();
    out.connect(master);
    if (id === 'b-sino') {
      [[880, 0.5], [1320, 0.25], [1760, 0.12], [2637, 0.06]].forEach(([f, a]) => {
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(a, t0 + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.8);
        o.connect(g).connect(out); o.start(t0); o.stop(t0 + 1.9);
      });
    } else if (id === 'b-tambor') {
      const nb = noiseBuffer(c, 0.06);
      for (let i = 0; i < 26; i++) {
        const t = t0 + i * 0.045;
        const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
        s.buffer = nb; f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.8;
        const a = 0.12 + (i / 26) * 0.35;
        g.gain.setValueAtTime(a, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
        s.connect(f).connect(g).connect(out); s.start(t);
      }
      const tEnd = t0 + 26 * 0.045 + 0.05;
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(140, tEnd); o.frequency.exponentialRampToValueAtTime(45, tEnd + 0.4);
      g.gain.setValueAtTime(0.9, tEnd); g.gain.exponentialRampToValueAtTime(0.001, tEnd + 0.6);
      o.connect(g).connect(out); o.start(tEnd); o.stop(tEnd + 0.7);
      const cs = c.createBufferSource(), cf = c.createBiquadFilter(), cg = c.createGain();
      cs.buffer = noiseBuffer(c, 1); cf.type = 'highpass'; cf.frequency.value = 5000;
      cg.gain.setValueAtTime(0.35, tEnd); cg.gain.exponentialRampToValueAtTime(0.001, tEnd + 0.9);
      cs.connect(cf).connect(cg).connect(out); cs.start(tEnd);
    } else if (id === 'b-buzina') {
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; lp.connect(out);
      [[0, 0.16], [0.22, 0.16], [0.44, 0.75]].forEach(([at, dur]) => {
        const t = t0 + at;
        [466, 469, 932].forEach((f, k) => {
          const o = c.createOscillator(), g = c.createGain();
          o.type = 'sawtooth'; o.frequency.setValueAtTime(f * 0.97, t); o.frequency.linearRampToValueAtTime(f, t + 0.05);
          const a = k === 2 ? 0.05 : 0.12;
          g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(a, t + 0.02);
          g.gain.setValueAtTime(a, t + dur - 0.04); g.gain.linearRampToValueAtTime(0, t + dur);
          o.connect(g).connect(lp); o.start(t); o.stop(t + dur + 0.02);
        });
      });
    } else if (id === 'b-festa') {
      const ps = c.createBufferSource(), pf = c.createBiquadFilter(), pg = c.createGain();
      ps.buffer = noiseBuffer(c, 0.3); pf.type = 'bandpass'; pf.frequency.value = 900;
      pg.gain.setValueAtTime(0.8, t0); pg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25);
      ps.connect(pf).connect(pg).connect(out); ps.start(t0);
      [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
        const t = t0 + 0.12 + i * 0.07;
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'triangle'; o.frequency.value = f;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.22, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        o.connect(g).connect(out); o.start(t); o.stop(t + 0.4);
      });
      for (let i = 0; i < 14; i++) {
        const t = t0 + 0.45 + Math.random() * 0.6;
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.value = 2500 + Math.random() * 2500;
        g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        o.connect(g).connect(out); o.start(t); o.stop(t + 0.14);
      }
    }
  }

  async function bufferFor(s) {
    if (buffers.has(s.id)) return buffers.get(s.id);
    const c = actx();
    const bin = atob(s.data.split(',')[1] || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const buf = await c.decodeAudioData(bytes.buffer);
    buffers.set(s.id, buf);
    return buf;
  }

  async function play(id) {
    const s = find(id);
    if (!s) return false;
    if (s.builtin) { synth(id); return true; }
    try {
      const buf = await bufferFor(s);
      const c = actx();
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(master);
      src.start();
      return true;
    } catch { return false; }
  }

  function pulse(id) {
    const el = panel && panel.querySelector(`.sfx-item[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
  }

  // ------------------------------------------------------------------
  // Tocar para a sala
  // ------------------------------------------------------------------
  function trigger(id) {
    if (!api.inChannel()) { play(id); pulse(id); return; }
    const now = Date.now();
    if (now - lastSent < COOLDOWN) { panel?.classList.add('cool'); setTimeout(() => panel?.classList.remove('cool'), 300); return; }
    lastSent = now;
    api.roomSend({ type: 'sfx', id });
    if (!api.isDeaf()) play(id);
    pulse(id);
  }
  function listenLocal(id) { play(id); pulse(id); }

  function remove(id) {
    const s = lib.get(id);
    if (!s || s.deleted) return;
    const tomb = { id, name: s.name, emoji: s.emoji, by: s.by, ts: Date.now(), deleted: true, size: 0 };
    merge(tomb);
    save();
    api.hubSend({ type: 'snd-data', sound: tomb });
    render();
  }

  // ------------------------------------------------------------------
  // Adicionar som do PC
  // ------------------------------------------------------------------
  function pickFile() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'audio/*';
    inp.onchange = () => { if (inp.files && inp.files[0]) readFile(inp.files[0]); };
    inp.click();
  }
  function readFile(file) {
    if (file.size > MAX_BYTES) { draft = { error: `Arquivo grande demais (${Math.round(file.size / 1024)} KB). Máximo: 400 KB.` }; render(); return; }
    const fr = new FileReader();
    fr.onload = async () => {
      const data = String(fr.result || '');
      let seconds = 0;
      try {
        const c = actx();
        const bin = atob(data.split(',')[1] || '');
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const buf = await c.decodeAudioData(bytes.buffer);
        seconds = buf.duration;
      } catch {
        draft = { error: 'Não consegui abrir esse áudio. Use mp3, wav ou ogg.' }; render(); return;
      }
      if (seconds > MAX_SECONDS) { draft = { error: `Áudio longo demais (${seconds.toFixed(1)} s). Máximo: ${MAX_SECONDS} s.` }; render(); return; }
      const fixed = data.startsWith('data:audio/') ? data : data.replace(/^data:[^;]*;/, 'data:audio/mpeg;');
      draft = {
        data: fixed,
        size: file.size,
        seconds,
        name: file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 20),
        emoji: '😂',
      };
      render();
      setTimeout(() => panel?.querySelector('.sfx-name')?.focus(), 30);
    };
    fr.readAsDataURL(file);
  }
  function saveDraft() {
    if (!draft || !draft.data) return;
    const name = (panel.querySelector('.sfx-name')?.value || '').trim().slice(0, 20) || 'Som';
    const s = {
      id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      emoji: draft.emoji,
      by: api.myName() || '',
      ts: Date.now(),
      deleted: false,
      size: draft.size,
      data: draft.data,
    };
    merge(s);
    save();
    api.hubSend({ type: 'snd-data', sound: s });
    draft = null;
    render();
    api.toast(`${s.emoji} ${s.name} adicionado para todos`);
  }

  // ------------------------------------------------------------------
  // Painel
  // ------------------------------------------------------------------
  function place() {
    if (!panel || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = panel.offsetWidth;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(12, Math.min(innerWidth - w - 12, left));
    panel.style.left = left + 'px';
    panel.style.bottom = (innerHeight - r.top + 12) + 'px';
    panel.style.transformOrigin = `${r.left + r.width / 2 - left}px 100%`;
  }

  function render() {
    if (!panel) return;
    const inCh = api.inChannel();
    const sounds = allSounds();
    const body = panel.querySelector('.sfx-body');
    if (draft) {
      if (draft.error) {
        body.innerHTML = `<div class="sfx-msg err">${esc(draft.error)}</div>
          <div class="sfx-row-btns"><button class="btn ghost sfx-cancel">Voltar</button><button class="btn primary sfx-pick">${ic('plus')}Escolher outro</button></div>`;
      } else {
        body.innerHTML = `<div class="sfx-form">
            <div class="sfx-prev"><button class="btn icon sfx-try" title="Ouvir">${ic('play')}</button>
              <input class="sfx-name" type="text" maxlength="20" spellcheck="false" placeholder="Nome do som" />
              <span class="sfx-dur mono">${draft.seconds.toFixed(1)}s</span></div>
            <div class="sfx-emojis">${EMOJIS.map((e) => `<button class="sfx-emo${e === draft.emoji ? ' on' : ''}" data-e="${e}">${e}</button>`).join('')}</div>
            <div class="sfx-row-btns"><button class="btn ghost sfx-cancel">Cancelar</button><button class="btn primary sfx-save">${ic('plus')}Adicionar</button></div>
          </div>`;
        const nameIn = body.querySelector('.sfx-name');
        nameIn.value = draft.name;
        nameIn.oninput = () => { draft.name = nameIn.value; };
        nameIn.onkeydown = (e) => { if (e.key === 'Enter') saveDraft(); };
        body.querySelectorAll('.sfx-emo').forEach((b) => {
          b.onclick = () => { draft.emoji = b.dataset.e; body.querySelectorAll('.sfx-emo').forEach((x) => x.classList.toggle('on', x === b)); };
        });
        body.querySelector('.sfx-try').onclick = async () => {
          try {
            const c = actx();
            const bin = atob(draft.data.split(',')[1] || '');
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const buf = await c.decodeAudioData(bytes.buffer);
            const src = c.createBufferSource(); src.buffer = buf; src.connect(master); src.start();
          } catch {}
        };
        body.querySelector('.sfx-save').onclick = saveDraft;
      }
      body.querySelector('.sfx-cancel').onclick = () => { draft = null; render(); };
      body.querySelector('.sfx-pick')?.addEventListener('click', () => { draft = null; pickFile(); });
      place();
      return;
    }
    body.innerHTML = `${inCh ? '' : `<div class="sfx-msg">${ic('vol')}Entre numa sala para todos ouvirem</div>`}
      <div class="sfx-grid">
        ${sounds.map((s) => `<div class="sfx-item" data-id="${esc(s.id)}" title="${esc(s.name)}${s.by ? ' · por ' + esc(s.by) : ''}">
            <button class="sfx-play"><span class="emo">${esc(s.emoji)}</span><span class="nm">${esc(s.name)}</span></button>
            <span class="sfx-acts">
              <button class="sfx-local" title="Ouvir só pra mim">${ic('vol')}</button>
              ${s.builtin ? '' : `<button class="sfx-del" title="Apagar para todos">${ic('trash')}</button>`}
            </span>
          </div>`).join('')}
        <button class="sfx-add" title="Adicionar som do PC">${ic('plus')}<span>Adicionar</span></button>
      </div>`;
    body.querySelectorAll('.sfx-item').forEach((el) => {
      const id = el.dataset.id;
      el.querySelector('.sfx-play').onclick = () => trigger(id);
      el.querySelector('.sfx-local').onclick = (e) => { e.stopPropagation(); listenLocal(id); };
      const del = el.querySelector('.sfx-del');
      if (del) del.onclick = (e) => {
        e.stopPropagation();
        if (el.classList.contains('confirm')) remove(id);
        else { el.classList.add('confirm'); setTimeout(() => el.classList.remove('confirm'), 2500); }
      };
      el.oncontextmenu = (e) => { e.preventDefault(); el.classList.toggle('show-acts'); };
    });
    body.querySelector('.sfx-add').onclick = pickFile;
    place();
  }

  function open(anchorEl) {
    anchor = anchorEl || anchor;
    if (panel) return;
    panel = document.createElement('div');
    panel.className = 'sfx-panel glass';
    panel.innerHTML = `<div class="sfx-head">
        <span class="sfx-title">${ic('sparkles')}Efeitos</span>
        <label class="sfx-vol" title="Volume dos efeitos">${ic('vol')}<input type="range" min="0" max="1" step="0.01" /></label>
        <button class="btn icon ghost sfx-close" title="Fechar">${ic('x')}</button>
      </div>
      <div class="sfx-body"></div>`;
    document.body.appendChild(panel);
    const vol = panel.querySelector('.sfx-vol input');
    const paintVol = () => vol.style.setProperty('--p', vol.value * 100 + '%');
    vol.value = volume; paintVol();
    vol.oninput = () => {
      volume = +vol.value; paintVol();
      if (master) master.gain.value = volume;
      try { localStorage.setItem('tm-sfx-vol', String(volume)); } catch {}
    };
    panel.querySelector('.sfx-close').onclick = close;
    anchor?.classList.add('on');
    render();
  }
  function close() {
    if (!panel) return;
    const el = panel;
    panel = null;
    draft = null;
    anchor?.classList.remove('on');
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 180);
  }
  document.addEventListener('mousedown', (e) => {
    if (!panel) return;
    if (panel.contains(e.target) || (anchor && anchor.contains(e.target))) return;
    close();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel) close(); });
  window.addEventListener('resize', () => place());

  // ------------------------------------------------------------------
  // API usada pelo app.js
  // ------------------------------------------------------------------
  window.TMSound = {
    init(a) { api = a; load(); },
    togglePanel(anchorEl) { if (panel) close(); else open(anchorEl); },
    onHubPeerAdded(name) {
      if (!api) return;
      api.hubSend({ type: 'snd-index', to: name, list: index() });
    },
    onHubMessage(m) {
      if (!api || !m || !m.from) return;
      if (m.type === 'snd-index' && Array.isArray(m.list)) {
        const need = [];
        let changed = false;
        for (const it of m.list) {
          if (!valid(it)) continue;
          const cur = lib.get(it.id);
          if (it.deleted) { if (merge(it)) changed = true; continue; }
          if (!cur || cur.ts < (+it.ts || 0)) need.push(it.id);
        }
        if (changed) { save(); render(); }
        if (need.length) api.hubSend({ type: 'snd-get', to: m.from, ids: need.slice(0, 200) });
      } else if (m.type === 'snd-get' && Array.isArray(m.ids)) {
        for (const id of m.ids) {
          const s = lib.get(id);
          if (s && !s.deleted && s.data) api.hubSend({ type: 'snd-data', to: m.from, sound: s });
        }
      } else if (m.type === 'snd-data' && m.sound) {
        if (merge(m.sound)) { save(); render(); }
      }
    },
    onRoomMessage(m) {
      if (!api || !m || !m.from || !m.id) return;
      const now = Date.now();
      if (now - (lastRecv.get(m.from) || 0) < COOLDOWN - 100) return;
      lastRecv.set(m.from, now);
      const s = find(m.id);
      if (!s) return;
      if (!api.isDeaf()) play(m.id);
      pulse(m.id);
      api.toast(`${m.from} tocou ${s.emoji} ${s.name}`);
    },
    // usado em testes/prévia
    _lib: lib,
    _play: play,
    _readFile: readFile,
  };
})();
