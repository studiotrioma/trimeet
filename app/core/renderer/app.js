// TriMeet - lógica da interface e do WebRTC
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const PALETTE = ['#64a8ff', '#4fd1a5', '#ff9f5a', '#c792ff', '#ff6b8b', '#ffd166', '#5ee0e0', '#a3e635'];
const FIXED = { levy: 0, levi: 0, brendo: 1, heriberto: 2 };
function colorOf(name) {
  const k = String(name || '').trim().toLowerCase();
  if (k in FIXED) return PALETTE[FIXED[k]];
  let h = 0;
  for (const ch of k) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[3 + (h % (PALETTE.length - 3))];
}
const initialOf = (n) => (String(n || '').trim()[0] || '?').toUpperCase();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = '') => `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`;
const orbHTML = (name) => `<span class="orb" style="--c:${colorOf(name)}">${esc(initialOf(name))}</span>`;
const DEFAULT_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const CONF = window.TRIMEET_CONFIG || { server: '', key: '' };

const state = {
  cfg: { name: '', room: '', server: '', share: {} },
  iceServers: DEFAULT_ICE,
  myName: null,
  ws: null,
  wsUrl: null,
  leaving: false,
  reconnectDelay: 1000,
  online: [],                 // nomes conectados à sala
  peers: new Map(),           // nome -> { pc, polite, makingOffer, ignoreOffer, senders: Map(shareId -> RTCRtpSender[]) }
  shares: new Map(),          // shareId -> { stream, label, kind, opts, tile }
  remoteMeta: new Map(),      // nome -> Map(streamId -> {label, kind})
  remotes: new Map(),         // streamId -> { from, stream, tile, receivers: [] }
  pending: new Map(),         // streamId -> { from, stream, receivers } (aguardando saber se é voz ou tela)
  voice: null,                // minha voz: { id, stream, muted, deaf, meter }
  voices: new Map(),          // streamId -> { from, stream, audio, meter }
  vstate: new Map(),          // nome -> { inVoice, muted, deaf }
  pref: { muted: false, deaf: false }, // mic/fone antes de entrar numa sala
  hub: null, hubOnline: [], hubReconnect: 1000,
  channels: new Map(),        // id -> { id, name, ts, order, deleted }
  presence: new Map(),        // nome -> { ch, inVoice, muted, deaf, live }
  channelId: null,
  editing: null,              // id da sala sendo criada/renomeada
  watching: new Set(),        // transmissões que eu escolhi assistir
  thumbs: new Map(),          // id da transmissão -> miniatura (jpeg)
  autoWatch: null,            // assistir fulano assim que a transmissão dele aparecer
  cam: null,                  // minha câmera: { id, stream, tile }
  focusId: null,
  selectedSource: null,
  srcTab: 'screen',
  sourcesCache: [],
};

// Transições suaves de layout (View Transitions do Chromium)
let vtCount = 0;
function smooth(fn) {
  let done = false;
  const run = () => { if (!done) { done = true; fn(); } };
  if (document.startViewTransition && document.visibilityState === 'visible' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    try {
      document.startViewTransition(run);
      setTimeout(run, 700); // janela minimizada/oculta: garante que a mudança acontece
      return;
    } catch {}
  }
  run();
}

// Mostrar/esconder com animação de saída
function showEl(el) { el.classList.remove('hidden', 'leaving'); }
function hideEl(el, ms = 230) {
  if (el.classList.contains('hidden') || el.classList.contains('leaving')) return;
  el.classList.add('leaving');
  clearTimeout(el._hideT);
  el._hideT = setTimeout(() => { el.classList.add('hidden'); el.classList.remove('leaving'); }, ms);
}

// ===================================================================
// Controles: segmentado com polegar deslizante e passo-a-passo
// ===================================================================
function syncSeg(seg, instant) {
  const thumb = seg.querySelector('.thumb');
  const on = seg.querySelector(':scope > button.on');
  if (!thumb) return;
  if (!on || !seg.offsetWidth) { thumb.style.width = '0px'; return; }
  if (instant || !thumb._placed) thumb.classList.add('instant');
  thumb.style.width = on.offsetWidth + 'px';
  thumb.style.transform = `translateX(${on.offsetLeft}px)`;
  thumb._placed = true;
  if (thumb.classList.contains('instant')) { thumb.offsetWidth; requestAnimationFrame(() => thumb.classList.remove('instant')); }
}
function syncAllSegs(instant) { $$('.segmented').forEach((s) => syncSeg(s, instant)); }
window.addEventListener('resize', () => syncAllSegs(true));

function initBoundSegs() {
  $$('.segmented[data-for]').forEach((seg) => {
    const input = document.getElementById(seg.dataset.for);
    seg.querySelectorAll(':scope > button').forEach((b) => {
      b.onclick = () => { input.value = b.dataset.v; refreshBoundSegs(); updateUploadHint(); };
    });
  });
}
function refreshBoundSegs() {
  $$('.segmented[data-for]').forEach((seg) => {
    const v = document.getElementById(seg.dataset.for).value;
    seg.querySelectorAll(':scope > button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    syncSeg(seg);
  });
}

const BITRATE_NAMES = { 4: 'Leve', 8: 'Boa', 12: 'Alta', 20: 'Muito alta', 35: 'Máxima' };
function initStepper() {
  const st = $('#bitrateStepper');
  const steps = st.dataset.steps.split(',').map(Number);
  const input = $('#optBitrate');
  const track = st.querySelector('.track');
  st.querySelectorAll('.track > i').forEach((d, i) => { d.style.left = (i / (steps.length - 1)) * 100 + '%'; });
  const pick = (clientX) => {
    const r = track.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const idx = Math.round(f * (steps.length - 1));
    if (String(steps[idx]) !== input.value) { input.value = steps[idx]; refreshStepper(); updateUploadHint(); }
  };
  st.addEventListener('pointerdown', (e) => {
    st.setPointerCapture(e.pointerId);
    st.classList.add('drag');
    pick(e.clientX);
    const move = (ev) => pick(ev.clientX);
    const up = () => { st.classList.remove('drag'); st.removeEventListener('pointermove', move); st.removeEventListener('pointerup', up); st.removeEventListener('pointercancel', up); };
    st.addEventListener('pointermove', move);
    st.addEventListener('pointerup', up);
    st.addEventListener('pointercancel', up);
  });
}
function refreshStepper() {
  const st = $('#bitrateStepper');
  const steps = st.dataset.steps.split(',').map(Number);
  let idx = steps.indexOf(Number($('#optBitrate').value));
  if (idx < 0) idx = 2;
  const p = (idx / (steps.length - 1)) * 100;
  st.querySelector('.fill').style.width = p + '%';
  st.querySelector('.knob').style.left = p + '%';
  $('#bitrateVal').textContent = `${steps[idx]} Mbps`;
  $('#bitrateVal').title = BITRATE_NAMES[steps[idx]] || '';
}

// ===================================================================
// Tela de entrada
// ===================================================================
async function initLogin() {
  const saved = await window.trimeet.loadConfig();
  if (saved) Object.assign(state.cfg, saved);
  if (state.cfg.voicePref) state.pref = { ...state.pref, ...state.cfg.voicePref };

  const nameInput = $('#nameInput');
  nameInput.value = state.cfg.name || '';
  nameInput.oninput = () => {
    const prev = initialOf(state.cfg.name);
    state.cfg.name = nameInput.value.trim();
    renderLogin(initialOf(state.cfg.name) !== prev);
  };
  nameInput.onkeydown = (e) => { if (e.key === 'Enter' && !$('#enterBtn').disabled) enter(); };
  nameInput.onfocus = nameInput.onblur = () => renderLogin();
  $('#enterBtn').onclick = enter;

  renderLogin();
  requestAnimationFrame(() => syncAllSegs(true));
  setTimeout(() => nameInput.focus(), 400);
}

function renderLogin(pop) {
  const c = state.cfg;
  const orb = $('#meOrb');
  orb.style.setProperty('--c', c.name ? colorOf(c.name) : '#8a8f98');
  $('#meInitial').innerHTML = c.name ? esc(initialOf(c.name)) : icon('user');
  if (pop) { orb.classList.remove('pop'); orb.offsetWidth; orb.classList.add('pop'); }
  $('#enterBtn').disabled = !c.name;
  $('#enterTxt').textContent = !c.name ? 'Digite seu nome' : 'Entrar';
  $('.name-field').classList.toggle('need', !c.name && document.activeElement !== $('#nameInput'));
}

const serverBase = () => (state.cfg.server || CONF.server || '').replace(/\/+$/, '');
const wsFor = (room) => `${serverBase().replace(/^http/, 'ws')}/ws?room=${encodeURIComponent(room)}&key=${encodeURIComponent(CONF.key)}`;

async function enter() {
  const c = state.cfg;
  $('#loginErr').textContent = '';
  $('#enterBtn').disabled = true;
  if (!serverBase()) { $('#loginErr').textContent = 'Servidor não configurado'; renderLogin(); return; }
  await window.trimeet.saveConfig(c);
  // credenciais do retransmissor (TURN) — se falhar, segue só com conexão direta
  try {
    const r = await fetch(`${serverBase()}/turn?key=${encodeURIComponent(CONF.key)}`, { cache: 'no-store' });
    if (r.ok) { const d = await r.json(); if (Array.isArray(d.iceServers) && d.iceServers.length) state.iceServers = d.iceServers; }
  } catch {}
  state.myName = c.name;
  state.loggedOut = false;
  loadChannels();
  smooth(() => {
    $('#login').classList.add('hidden');
    $('#room').classList.remove('hidden');
    renderMe();
    renderChannels();
    renderPeople();
    renderChanTitle();
    $('#room').classList.toggle('side-collapsed', !!state.cfg.sideCollapsed);
    layout(true);
  });
  if (window.TMPerms) {
    try {
      await TMPerms.init({
        hubSend,
        myName: () => state.myName,
        toast, orbHTML, icon,
        channels: () => [...state.channels.values()].filter((c) => !c.deleted),
        onChange: () => { renderChannels(); renderPeople(); renderAdminUI(); if (state.hub) publishPresence(); },
        onMoveMe: (ch, by) => { const c = state.channels.get(ch); if (c) { joinChannel(ch, { force: true }); toast(`${by || 'Um admin'} moveu você para ${c.name}`); } },
      });
    } catch (e) { console.warn('perms', e); }
  }
  renderAdminUI();
  connectHub();
}

// ===================================================================
// Saguão: lista de salas e quem está em cada uma (estilo Discord)
// Usa uma sala invisível no mesmo servidor só para trocar essas infos.
// ===================================================================
const DEFAULT_CHANNELS = [
  { id: 'geral', name: 'Geral', ts: 1, order: 1 },
  { id: 'jogos', name: 'Jogos', ts: 1, order: 2 },
  { id: 'filmes', name: 'Filmes', ts: 1, order: 3 },
];
function loadChannels() {
  state.channels = new Map();
  for (const c of DEFAULT_CHANNELS) state.channels.set(c.id, { ...c });
  for (const c of state.cfg.channels || []) mergeChannel(c);
}
function saveChannels() {
  state.cfg.channels = [...state.channels.values()];
  window.trimeet.saveConfig(state.cfg);
}
function mergeChannel(c) {
  if (!c || !c.id) return false;
  const cur = state.channels.get(c.id);
  if (cur && (cur.ts > c.ts || (cur.ts === c.ts && JSON.stringify(cur) >= JSON.stringify(c)))) return false;
  state.channels.set(c.id, { id: String(c.id).slice(0, 40), name: String(c.name || 'Sala').slice(0, 28), ts: +c.ts || 0, order: +c.order || 0, deleted: !!c.deleted });
  return true;
}
function myPresence() {
  const v = state.voice;
  return {
    ch: state.channelId,
    inVoice: !!v,
    muted: v ? v.muted : state.pref.muted,
    deaf: v ? v.deaf : state.pref.deaf,
    live: state.shares.size > 0,
    cam: !!state.cam,
    pub: window.TMPerms?.myPub?.() || null,
  };
}
function hubSend(m) { if (state.hub && state.hub.readyState === 1) state.hub.send(JSON.stringify(m)); }
function publishPresence(to) {
  const m = { type: 'presence', ...myPresence() };
  hubSend(to ? { ...m, to } : m);
  renderChannels();
  renderMe();
}
function publishChannels(to) {
  const m = { type: 'channels', list: [...state.channels.values()] };
  hubSend(to ? { ...m, to } : m);
}

function connectHub() {
  let ws;
  try { ws = new WebSocket(wsFor('trimeet-saguao')); } catch { return; }
  state.hub = ws;
  ws.onopen = () => { state.hubReconnect = 1000; ws.send(JSON.stringify({ type: 'join', name: state.myName })); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'welcome') { publishPresence(); publishChannels(); if (!state.channelId) setConn('conectado', 'ok'); }
    else if (m.type === 'peers') {
      const list = m.peers.filter((n) => n !== state.myName);
      const added = list.filter((n) => !state.hubOnline.includes(n));
      // aviso "ficou online" só para quem chegou depois de mim
      if (state.hubSeen) for (const n of added) window.trimeet.notify?.({ name: n, text: 'ficou online', color: colorOf(n) });
      state.hubSeen = true;
      state.hubOnline = list;
      for (const n of [...state.presence.keys()]) if (!list.includes(n)) state.presence.delete(n);
      for (const n of added) { publishPresence(n); publishChannels(n); window.TMSound?.onHubPeerAdded(n); window.TMPerms?.onHubPeerAdded(n); }
      renderChannels();
    } else if (typeof m.type === 'string' && m.type.startsWith('perm-')) {
      window.TMPerms?.onHubMessage(m);
    } else if (typeof m.type === 'string' && m.type.startsWith('snd-')) {
      window.TMSound?.onHubMessage(m);
    } else if (m.type === 'presence' && m.from) {
      state.presence.set(m.from, { ch: m.ch || null, inVoice: !!m.inVoice, muted: !!m.muted, deaf: !!m.deaf, live: !!m.live, cam: !!m.cam });
      if (m.pub) window.TMPerms?.notePresence(m.from, m.pub);
      renderChannels();
    } else if (m.type === 'channels') {
      let changed = false;
      for (const c of m.list || []) changed = mergeChannel(c) || changed;
      if (changed) {
        saveChannels();
        if (state.channelId && state.channels.get(state.channelId)?.deleted) leaveChannel();
        renderChannels();
        renderChanTitle();
      }
    }
  };
  ws.onclose = (ev) => {
    if (state.hub !== ws) return;
    state.hub = null;
    if (state.loggedOut) return;
    if (ev.code === 4000) { toast('Você entrou com este nome em outro PC'); return; }
    if (!state.channelId) setConn('reconectando…', 'bad');
    setTimeout(() => { if (!state.loggedOut) connectHub(); }, state.hubReconnect);
    state.hubReconnect = Math.min(state.hubReconnect * 1.6, 8000);
  };
}

function membersOf(chId) {
  const out = [];
  if (state.channelId === chId) out.push({ name: state.myName, me: true, ...myPresence() });
  for (const [n, p] of state.presence) if (p.ch === chId && state.hubOnline.includes(n)) out.push({ name: n, ...p });
  return out;
}

function renderChannels() {
  const box = $('#channels');
  if (!box) return;
  const canSee = (id) => !window.TMPerms || TMPerms.canSee(id) || state.channelId === id;
  const list = [...state.channels.values()].filter((c) => !c.deleted && canSee(c.id)).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const canManage = canDo('manageChannels');
  // linha de edição que já terminou: volta a ser uma sala normal
  for (const el of $$('.ch', box)) if (el.querySelector('.ch-edit') && state.editing !== el.dataset.id) el.remove();
  const keep = new Set();
  list.forEach((c, idx) => {
    keep.add(c.id);
    let el = box.querySelector(`.ch[data-id="${CSS.escape(c.id)}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'ch';
      el.dataset.id = c.id;
      el.innerHTML = `<button class="ch-row">${icon('speaker')}<span class="nm"></span><span class="lock" title="Sala restrita">${icon('lock')}</span><span class="count"></span><span class="acts"><span class="ren" title="Renomear">${icon('pencil')}</span><span class="del" title="Apagar">${icon('trash')}</span></span></button><div class="ch-members"></div>`;
      el.querySelector('.ch-row').onclick = (e) => {
        if (e.target.closest('.ren')) { e.stopPropagation(); startEdit(c.id); return; }
        if (e.target.closest('.del')) { e.stopPropagation(); deleteChannel(c.id); return; }
        joinChannel(c.id);
      };
      el.querySelector('.ch-row').ondblclick = (e) => { if (canDo('manageChannels')) { e.preventDefault(); startEdit(c.id); } };
      el.querySelector('.ch-row').oncontextmenu = (e) => { e.preventDefault(); openChannelMenu(e, c.id); };
      // soltar uma pessoa arrastada aqui = mover para esta sala
      el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/tm-member')) { e.preventDefault(); el.classList.add('drop'); } });
      el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop'); });
      el.addEventListener('drop', (e) => {
        el.classList.remove('drop');
        const who = e.dataTransfer.getData('text/tm-member');
        if (who) { e.preventDefault(); moveMember(who, c.id); }
      });
    }
    el.classList.toggle('no-manage', !canManage);
    const acc = window.TMPerms?.access?.(c.id) || {};
    el.classList.toggle('restricted', !!acc.restricted);
    el.classList.toggle('locked', !!acc.restricted && !!window.TMPerms && !TMPerms.canJoin(c.id));
    if (box.children[idx] !== el) box.insertBefore(el, box.children[idx] || null);
    if (state.editing === c.id && !el.querySelector('.ch-edit')) el.querySelector('.ch-row').replaceWith(editRow(c.id, c.name));
    const nm = el.querySelector('.ch-row .nm');
    if (nm && nm.textContent !== c.name) nm.textContent = c.name;
    const mem = membersOf(c.id);
    const cnt = el.querySelector('.count');
    if (cnt) cnt.textContent = mem.length ? String(mem.length) : '';
    el.classList.toggle('active', state.channelId === c.id);
    el.classList.toggle('has-live', mem.some((m) => m.live));
    // membros
    const mbox = el.querySelector('.ch-members');
    const names = mem.map((m) => m.name);
    for (const r of $$('.member', mbox)) if (!names.includes(r.dataset.name)) r.remove();
    mem.forEach((m, i) => {
      let r = mbox.querySelector(`.member[data-name="${CSS.escape(m.name)}"]`);
      if (!r) {
        r = document.createElement('div');
        r.className = 'member' + (m.me ? ' me' : '');
        r.dataset.name = m.name;
        r.innerHTML = `${orbHTML(m.name)}<span class="nm"></span><span class="badges"></span><span class="mi"></span>`;
        r.querySelector('.nm').textContent = m.name;
        r.oncontextmenu = (e) => { e.preventDefault(); openPersonMenu(e, m.name, c.id); };
        r.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/tm-member', m.name); e.dataTransfer.effectAllowed = 'move'; r.classList.add('dragging'); });
        r.addEventListener('dragend', () => r.classList.remove('dragging'));
      }
      r.draggable = canDo('moveMembers');
      paintBadges(r.querySelector('.badges'), m.name);
      if (mbox.children[i] !== r) mbox.insertBefore(r, mbox.children[i] || null);
      const lm = !m.me && isLocalMuted(m.name);
      const k = (m.live ? 'L' : '') + (m.cam ? 'C' : '') + (lm ? 'S' : '') + (m.deaf ? 'D' : m.muted ? 'M' : '');
      const mi = r.querySelector('.mi');
      if (mi.dataset.k !== k) {
        mi.dataset.k = k;
        mi.innerHTML = (m.cam ? `<span class="camic">${icon('camera')}</span>` : '') + (lm ? `<span class="lmute" title="Silenciado para você">${icon('mic-off')}</span>` : '') + (m.deaf ? icon('deaf') : m.muted ? icon('mic-off') : '') + (m.live ? '<span class="lv" title="Assistir">AO VIVO</span>' : '');
        const lv = mi.querySelector('.lv');
        if (lv) lv.onclick = (e) => { e.stopPropagation(); watchPerson(m.name, c.id); };
      }
    });
  });
  // sala nova sendo criada
  if (state.editing === '__new__') {
    keep.add('__new__');
    if (!box.querySelector('.ch[data-id="__new__"]')) {
      const el = document.createElement('div');
      el.className = 'ch';
      el.dataset.id = '__new__';
      el.appendChild(editRow('__new__', ''));
      box.appendChild(el);
    }
  }
  for (const el of $$('.ch', box)) if (!keep.has(el.dataset.id)) el.remove();
}

function editRow(id, value) {
  const row = document.createElement('label');
  row.className = 'ch-edit';
  row.innerHTML = `${icon('speaker')}<input type="text" maxlength="28" spellcheck="false" placeholder="Nome da sala" />`;
  const inp = row.querySelector('input');
  inp.value = value;
  let done = false;
  const finish = (ok) => {
    if (done) return; done = true;
    const name = inp.value.trim();
    state.editing = null;
    if (ok && name) {
      if (id === '__new__') {
        const nid = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const order = Math.max(0, ...[...state.channels.values()].map((c) => c.order)) + 1;
        mergeChannel({ id: nid, name, ts: Date.now(), order });
      } else {
        const c = state.channels.get(id);
        if (c && c.name !== name) mergeChannel({ ...c, name, ts: Date.now() });
      }
      saveChannels();
      publishChannels();
      renderChanTitle();
    }
    renderChannels();
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
  inp.onblur = () => finish(true);
  setTimeout(() => { inp.focus(); inp.select(); }, 30);
  return row;
}
function startEdit(id) { state.editing = id; renderChannels(); }
function deleteChannel(id) {
  const c = state.channels.get(id);
  if (!c) return;
  if (!confirm(`Apagar a sala "${c.name}"? Ela some para todos.`)) return;
  mergeChannel({ ...c, deleted: true, ts: Date.now() });
  saveChannels();
  publishChannels();
  if (state.channelId === id) leaveChannel();
  renderChannels();
}

function renderMe() {
  const box = $('#meOrbSmall');
  if (!box || !state.myName) return;
  if (box.dataset.n !== state.myName) { box.dataset.n = state.myName; box.innerHTML = orbHTML(state.myName); }
  $('#meName').textContent = state.myName;
  renderVoice();
}

function renderChanTitle() {
  const ch = state.channelId && state.channels.get(state.channelId);
  $('#chanName').textContent = ch ? ch.name : 'TriMeet';
  $('#room').classList.toggle('in-channel', !!ch);
  $('#emptyTxt').textContent = 'Escolha uma sala';
  $('#empty').classList.toggle('in-room', !!ch);
}

async function joinChannel(id, opts = {}) {
  if (state.channelId === id) return;
  if (!opts.force && window.TMPerms && !TMPerms.canJoin(id)) { toast('Sala restrita'); return; }
  if (state.shares.size && !confirm('Trocar de sala vai parar sua transmissão. Continuar?')) return;
  if (state.channelId) leaveChannel(true);
  if (opts.watch) state.autoWatch = opts.watch;
  state.channelId = id;
  state.leaving = false;
  state.wsUrl = wsFor('sala-' + id);
  renderChanTitle();
  renderMe();
  publishPresence();
  connectSignal();
  layout();
  await joinVoice();
  publishPresence();
}

function leaveChannel(switching) {
  if (!state.channelId) return;
  state.leaving = true;
  leaveVoice(true);
  if (state.cam) stopCamera(true);
  for (const id of [...state.shares.keys()]) stopShare(id);
  for (const n of [...state.peers.keys()]) closePeer(n);
  for (const [id] of state.pending) state.pending.delete(id);
  state.watching.clear();
  state.thumbs.clear();
  state.autoWatch = null;
  for (const c of $$('.tile.card')) c.remove();
  state.online = [];
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  state.channelId = null;
  state.focusId = null;
  renderDock();
  renderCam();
  if (!switching) chime('leave');
  renderPeople();
  renderChanTitle();
  renderMe();
  publishPresence();
  layout();
  setConn('conectado', state.hub ? 'ok' : 'bad');
}

// ===================================================================
// Sinalização (WebSocket)
// ===================================================================
function connectSignal() {
  setConn('conectando…', '');
  let ws;
  try { ws = new WebSocket(state.wsUrl); } catch (e) { setConn('endereço inválido', 'bad'); return; }
  state.ws = ws;
  ws.onopen = () => {
    state.reconnectDelay = 1000;
    ws.send(JSON.stringify({ type: 'join', name: state.myName }));
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    onSignal(m);
  };
  ws.onclose = (ev) => {
    if (state.ws !== ws) return;
    state.ws = null;
    if (state.leaving) return;
    if (ev.code === 4000) { setConn('você entrou em outro lugar', 'bad'); return; }
    setConn('reconectando…', 'bad');
    // não derruba as conexões de vídeo já estabelecidas; só tenta voltar
    setTimeout(() => { if (!state.leaving) connectSignal(); }, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 1.6, 8000);
  };
}

function send(m) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(m));
}

function onSignal(m) {
  switch (m.type) {
    case 'welcome':
      setConn('conectado', 'ok');
      break;
    case 'peers': {
      const list = m.peers.filter((n) => n !== state.myName);
      const added = list.filter((n) => !state.online.includes(n));
      const removed = state.online.filter((n) => !list.includes(n));
      state.online = list;
      for (const n of removed) closePeer(n);
      for (const n of added) {
        ensurePeer(n);
        announceShares(n);
        sendVoiceState(n);
      }
      renderPeople();
      break;
    }
    case 'signal':
      handleSignal(m.from, m).catch((e) => console.warn('signal', e));
      break;
    case 'shares':
      onRemoteShares(m.from, m.list || []);
      break;
    case 'sfx':
      window.TMSound?.onRoomMessage(m);
      break;
    case 'watch':
      handleWatch(m.from, m.id, !!m.on);
      break;
    case 'thumb':
      if (m.id && typeof m.data === 'string' && m.data.startsWith('data:image/')) {
        state.thumbs.set(m.id, m.data);
        const img = document.querySelector(`.tile.card[data-id="${CSS.escape(m.id)}"] .thumb`);
        if (img) { img.src = m.data; img.classList.add('on'); }
      }
      break;
    case 'vstate':
      state.vstate.set(m.from, { inVoice: !!m.inVoice, muted: !!m.muted, deaf: !!m.deaf });
      renderPeople();
      break;
    case 'hello-shares':
      announceShares(m.from);
      break;
  }
}

function setConn(text, cls) {
  const el = $('#connState');
  el.title = text;
  el.className = 'conn ' + (cls || '');
}

// ===================================================================
// WebRTC – uma conexão direta para cada amigo ("perfect negotiation")
// ===================================================================
function ensurePeer(name) {
  if (state.peers.has(name)) return state.peers.get(name);
  const pc = new RTCPeerConnection({ iceServers: state.iceServers, bundlePolicy: 'max-bundle' });
  const peer = { name, pc, polite: state.myName < name, makingOffer: false, ignoreOffer: false, senders: new Map() };
  state.peers.set(name, peer);

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      send({ type: 'signal', to: name, description: pc.localDescription });
    } catch (e) {
      console.warn('negotiation', e);
    } finally {
      peer.makingOffer = false;
    }
  };
  pc.onicecandidate = ({ candidate }) => { if (candidate) send({ type: 'signal', to: name, candidate }); };
  pc.onsignalingstatechange = () => { if (pc.signalingState === 'stable') applyAllParams(peer); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce();
    renderPeople();
  };
  pc.ontrack = (ev) => onRemoteTrack(name, ev);

  // a voz e a câmera vão para todos da sala; as telas só para quem clicar em Assistir
  if (state.voice) addVoiceToPeer(peer);
  if (state.cam) addCamToPeer(peer);
  return peer;
}

function closePeer(name) {
  const peer = state.peers.get(name);
  if (peer) { try { peer.pc.close(); } catch {} state.peers.delete(name); }
  state.remoteMeta.delete(name);
  state.vstate.delete(name);
  for (const [id, r] of state.remotes) if (r.from === name) removeRemote(id);
  for (const [id, v] of state.voices) if (v.from === name) removeVoice(id);
  for (const [id, p] of state.pending) if (p.from === name) state.pending.delete(id);
  for (const sh of state.shares.values()) if (sh.watchers?.delete(name)) paintViewers(sh);
  renderCards();
  renderDock();
}

async function handleSignal(from, { description, candidate }) {
  const peer = ensurePeer(from);
  const pc = peer.pc;
  if (description) {
    const desc = { type: description.type, sdp: mungeSdp(description.sdp) };
    const collision = desc.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) return;
    await pc.setRemoteDescription(desc);
    if (desc.type === 'offer') {
      await pc.setLocalDescription();
      send({ type: 'signal', to: from, description: pc.localDescription });
    }
  } else if (candidate) {
    try { await pc.addIceCandidate(candidate); } catch (e) { if (!peer.ignoreOffer) console.warn('ice', e); }
  }
}

// Ajustes de SDP: áudio Opus estéreo a 510 kbps e vídeo começando já em alta taxa
function mungeSdp(sdp) {
  const lines = sdp.split('\r\n');
  const opus = [];
  const video = [];
  for (const l of lines) {
    let m = l.match(/^a=rtpmap:(\d+) opus\/48000/i);
    if (m) opus.push(m[1]);
    m = l.match(/^a=rtpmap:(\d+) (H264|VP9|AV1|VP8)\/90000/i);
    if (m) video.push(m[1]);
  }
  return lines.map((l) => {
    const m = l.match(/^a=fmtp:(\d+) (.*)$/);
    if (!m) return l;
    if (opus.includes(m[1])) {
      let p = m[2].replace(/;?(stereo|sprop-stereo|maxaveragebitrate|maxplaybackrate|cbr)=[^;]*/g, '');
      return `a=fmtp:${m[1]} ${p};stereo=1;sprop-stereo=1;maxaveragebitrate=510000;maxplaybackrate=48000`.replace(' ;', ' ');
    }
    if (video.includes(m[1]) && !/x-google-start-bitrate/.test(m[2])) {
      return `${l};x-google-start-bitrate=6000;x-google-min-bitrate=1500`;
    }
    return l;
  }).join('\r\n');
}

// ===================================================================
// Minha transmissão
// ===================================================================
async function startShare(sourceId, label, opts, kind = 'screen') {
  await window.trimeet.selectSource(sourceId, opts.audio);
  const fps = parseInt(opts.fps, 10);
  const videoC = { frameRate: { ideal: fps, max: fps } };
  if (opts.res !== 'native') {
    const h = parseInt(opts.res, 10);
    videoC.height = { max: h };
    videoC.width = { max: Math.round((h * 16) / 9) };
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: videoC,
      audio: opts.audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 } : false,
    });
  } catch (e) {
    toast('Não foi possível capturar a tela: ' + e.message);
    return;
  }
  const v = stream.getVideoTracks()[0];
  if (v) {
    v.contentHint = opts.mode === 'detail' ? 'detail' : 'motion';
    try { await v.applyConstraints(videoC); } catch {}
  }
  const a = stream.getAudioTracks()[0];
  if (a) {
    a.contentHint = 'music';
    try { await a.applyConstraints({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }); } catch {}
  }

  const id = stream.id;
  const share = { stream, label, kind, opts, watchers: new Set(), thumbT: null };
  state.shares.set(id, share);
  if (v) v.onended = () => stopShare(id);

  share.tile = makeTile({ id, name: state.myName, label, kind, stream, mine: true });
  paintViewers(share);
  // miniatura para o cartão de quem ainda não está assistindo
  const sendThumb = () => {
    const vid = share.tile?.querySelector('video');
    if (!vid || vid.readyState < 2 || !vid.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = 384; c.height = Math.round(384 * vid.videoHeight / vid.videoWidth);
    c.getContext('2d').drawImage(vid, 0, 0, c.width, c.height);
    send({ type: 'thumb', id, data: c.toDataURL('image/jpeg', 0.6) });
  };
  setTimeout(sendThumb, 1500);
  share.thumbT = setInterval(sendThumb, 6000);
  announceShares();
  renderDock();
  renderPeople();
  publishPresence();
}

function stopShare(id) {
  const share = state.shares.get(id);
  if (!share) return;
  state.shares.delete(id);
  clearInterval(share.thumbT);
  share.stream.getTracks().forEach((t) => t.stop());
  for (const peer of state.peers.values()) {
    const senders = peer.senders.get(id) || [];
    for (const s of senders) { try { peer.pc.removeTrack(s); } catch {} }
    peer.senders.delete(id);
  }
  if (state.focusId === id) state.focusId = null;
  removeTile(share.tile);
  announceShares();
  renderPeople();
  publishPresence();
  renderDock();
}

// alguém clicou em Assistir (ou parou) a minha transmissão
function handleWatch(from, id, on) {
  const share = state.shares.get(id);
  const peer = state.peers.get(from) || (on ? ensurePeer(from) : null);
  if (!share || !peer) return;
  if (on && !share.watchers.has(from)) {
    share.watchers.add(from);
    addShareToPeer(peer, id, share);
  } else if (!on && share.watchers.has(from)) {
    share.watchers.delete(from);
    for (const snd of peer.senders.get(id) || []) { try { peer.pc.removeTrack(snd); } catch {} }
    peer.senders.delete(id);
  }
  paintViewers(share);
}
function paintViewers(share) {
  const el = share.tile?.querySelector('.viewers');
  if (!el) return;
  const n = share.watchers.size;
  el.innerHTML = n ? `${icon('eye')}<span>${n}</span>` : '';
  el.title = n ? [...share.watchers].join(', ') + ' assistindo' : '';
}

// ---- volumes por pessoa (voz e transmissão), guardados no PC ----
function getVol(kind, name) {
  const v = state.cfg.volumes?.[kind]?.[name];
  return typeof v === 'number' ? v : 1;
}
function isLocalMuted(name) { return !!state.cfg.volumes?.muted?.[name]; }
let volSaveT;
function saveVolumes() { clearTimeout(volSaveT); volSaveT = setTimeout(() => window.trimeet.saveConfig(state.cfg), 400); }
function setVol(kind, name, value) {
  const vols = state.cfg.volumes || (state.cfg.volumes = { voice: {}, stream: {}, muted: {} });
  vols[kind] = vols[kind] || {};
  vols[kind][name] = Math.max(0, Math.min(1, value));
  if (kind === 'voice') {
    for (const v of state.voices.values()) if (v.from === name) v.audio.volume = vols.voice[name];
  } else {
    for (const r of state.remotes.values()) if (r.from === name) {
      const video = r.tile.querySelector('video');
      video.volume = vols.stream[name]; video.muted = vols.stream[name] === 0;
      const sl = r.tile.querySelector('.vol input'); if (sl) sl.value = vols.stream[name];
      r.tile._paintVol?.();
    }
  }
  saveVolumes();
}
function setLocalMute(name, on) {
  const vols = state.cfg.volumes || (state.cfg.volumes = { voice: {}, stream: {}, muted: {} });
  vols.muted = vols.muted || {};
  if (on) vols.muted[name] = true; else delete vols.muted[name];
  const deaf = state.voice?.deaf;
  for (const v of state.voices.values()) if (v.from === name) v.audio.muted = !state.voice || deaf || on;
  saveVolumes();
  renderChannels();
  renderPeople();
}

// ---- menu do botão direito ----
let ctxEl = null;
function closeMenu() {
  if (!ctxEl) return;
  const el = ctxEl; ctxEl = null;
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 160);
}
function openMenu(e, build) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'ctx-menu glass';
  build(m);
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  const x = Math.min(e.clientX, innerWidth - r.width - 10), y = Math.min(e.clientY, innerHeight - r.height - 10);
  m.style.left = Math.max(10, x) + 'px';
  m.style.top = Math.max(10, y) + 'px';
  m.style.transformOrigin = `${e.clientX - x}px ${e.clientY - y}px`;
  ctxEl = m;
}
document.addEventListener('mousedown', (e) => { if (ctxEl && !ctxEl.contains(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

function menuHead(m, name, sub) {
  m.insertAdjacentHTML('beforeend', `<div class="cm-head">${orbHTML(name)}<div class="cm-t"><b></b><small></small></div></div>`);
  m.querySelector('.cm-head .cm-t b').textContent = name;
  m.querySelector('.cm-head .cm-t small').textContent = sub || '';
}
function menuSlider(m, ic, label, value, onInput) {
  const row = document.createElement('div');
  row.className = 'cm-slider';
  row.innerHTML = `<div class="cm-sl-top">${icon(ic)}<span>${label}</span><b class="mono"></b></div><input type="range" min="0" max="1" step="0.01">`;
  const inp = row.querySelector('input'), val = row.querySelector('b');
  const paint = () => { inp.style.setProperty('--p', inp.value * 100 + '%'); val.textContent = Math.round(inp.value * 100) + '%'; };
  inp.value = value; paint();
  inp.oninput = () => { paint(); onInput(+inp.value); };
  m.appendChild(row);
}
function menuItem(m, ic, label, onClick, opts = {}) {
  const b = document.createElement('button');
  b.className = 'cm-item' + (opts.danger ? ' danger' : '') + (opts.on ? ' on' : '');
  b.innerHTML = `${icon(ic)}<span></span>${opts.check != null ? `<i class="cm-check ${opts.check ? 'on' : ''}"></i>` : ''}`;
  b.querySelector('span').textContent = label;
  b.onclick = () => { onClick(); closeMenu(); };
  m.appendChild(b);
}
function menuSep(m) { m.insertAdjacentHTML('beforeend', '<div class="cm-sep"></div>'); }

// botão direito numa pessoa: voz + (se estiver ao vivo) transmissão
function openPersonMenu(e, name, chId) {
  if (name === state.myName) {
    openMenu(e, (m) => {
      menuHead(m, name, 'Você');
      menuItem(m, state.voice?.muted || state.pref.muted ? 'mic' : 'mic-off', state.voice?.muted || state.pref.muted ? 'Desmutar' : 'Mutar', toggleMute);
      menuItem(m, 'gear', 'Configurações de voz', () => $('#settingsBtn').click());
      if (window.TMPerms) { menuSep(m); menuItem(m, 'shield', 'Servidor e cargos', () => TMPerms.openServer()); }
      if (canDo('moveMembers')) addMoveItems(m, name);
    });
    return;
  }
  const here = chId === state.channelId;
  const meta = state.remoteMeta.get(name);
  const live = here ? [...(meta?.entries() || [])].find(([, x]) => x.kind === 'screen' || x.kind === 'window') : (state.presence.get(name)?.live ? ['?', {}] : null);
  const watchingId = live && state.watching.has(live[0]) ? live[0] : null;
  openMenu(e, (m) => {
    menuHead(m, name, here ? (live ? 'Ao vivo nesta sala' : 'Nesta sala') : (state.channels.get(chId)?.name ? 'Na sala ' + state.channels.get(chId).name : ''));
    menuSlider(m, 'headset', 'Volume da voz', getVol('voice', name), (v) => setVol('voice', name, v));
    menuItem(m, 'mic-off', 'Silenciar para mim', () => setLocalMute(name, !isLocalMuted(name)), { check: isLocalMuted(name) });
    if (live) {
      menuSep(m);
      if (watchingId) {
        menuSlider(m, 'screen', 'Volume da transmissão', getVol('stream', name), (v) => setVol('stream', name, v));
        menuItem(m, 'stop', 'Parar de assistir', () => unwatch(watchingId), { danger: true });
      } else {
        menuItem(m, 'play', 'Assistir transmissão', () => watchPerson(name, chId));
      }
    }
    if (window.TMPerms && (canDo('manageRoles') || canDo('moveMembers'))) {
      menuSep(m);
      if (canDo('manageRoles')) menuItem(m, 'shield', 'Cargos', () => TMPerms.openMember(name));
      if (canDo('moveMembers')) addMoveItems(m, name);
    }
  });
}

// ---- administração (cargos, salas restritas, mover pessoas) ----
function canDo(perm) { return !window.TMPerms || TMPerms.isOwner() || TMPerms.can(perm); }
function moveMember(name, chId) {
  if (!canDo('moveMembers')) { toast('Você não tem permissão para mover pessoas'); return; }
  const c = state.channels.get(chId);
  if (name === state.myName) { joinChannel(chId); return; }
  if (window.TMPerms?.move(name, chId)) toast(`${name} → ${c?.name || 'sala'}`);
}
function addMoveItems(m, name) {
  const cur = name === state.myName ? state.channelId : state.presence.get(name)?.ch;
  const rooms = [...state.channels.values()].filter((c) => !c.deleted && c.id !== cur && (!window.TMPerms || TMPerms.canSee(c.id)));
  if (!rooms.length) return;
  m.insertAdjacentHTML('beforeend', '<div class="cm-label">Mover para</div>');
  for (const c of rooms.slice(0, 8)) menuItem(m, 'speaker', c.name, () => moveMember(name, c.id));
}
function openChannelMenu(e, chId) {
  const c = state.channels.get(chId);
  if (!c) return;
  openMenu(e, (m) => {
    m.insertAdjacentHTML('beforeend', `<div class="cm-head cm-room">${icon('speaker')}<div class="cm-t"><b></b><small></small></div></div>`);
    m.querySelector('.cm-room b').textContent = c.name;
    const acc = window.TMPerms?.access?.(chId) || {};
    m.querySelector('.cm-room small').textContent = acc.hidden ? 'Oculta' : acc.restricted ? 'Restrita' : 'Aberta';
    if (state.channelId !== chId) menuItem(m, 'join', 'Entrar', () => joinChannel(chId));
    if (canDo('manageChannels')) {
      if (window.TMPerms) menuItem(m, 'lock', 'Acesso da sala', () => TMPerms.openChannel(chId));
      menuItem(m, 'pencil', 'Renomear', () => startEdit(chId));
      menuSep(m);
      menuItem(m, 'trash', 'Apagar sala', () => deleteChannel(chId), { danger: true });
    }
  });
}
function paintBadges(el, name) {
  if (!el || !window.TMPerms) return;
  const owner = TMPerms.isOwnerName?.(name);
  const roles = TMPerms.rolesOf?.(name) || [];
  const k = (owner ? 'O' : '') + roles.map((r) => r.name + r.color).join('|');
  if (el.dataset.k === k) return;
  el.dataset.k = k;
  el.innerHTML = (owner ? `<span class="crown" title="Dono">${icon('crown')}</span>` : '') +
    roles.slice(0, 3).map((r) => `<i class="rdot" style="background:${r.color}" title="${esc(r.name)}"></i>`).join('');
}
function renderAdminUI() {
  const add = $('#addRoomBtn');
  if (add) add.classList.toggle('hidden', !canDo('manageChannels'));
}

// botão direito numa transmissão: só a transmissão
function openTileMenu(e, { id, name, mine, tile }) {
  openMenu(e, (m) => {
    if (tile.classList.contains('card')) {
      menuHead(m, name, 'Ao vivo');
      menuItem(m, 'play', 'Assistir', () => tile.click());
      return;
    }
    menuHead(m, mine ? state.myName : name, mine ? 'Sua transmissão' : 'Transmissão');
    if (!mine) menuSlider(m, 'vol', 'Volume da transmissão', getVol('stream', name), (v) => setVol('stream', name, v));
    const pinned = state.focusId === id;
    menuItem(m, pinned ? 'shrink' : 'expand', pinned ? 'Desafixar' : 'Fixar em destaque', () => { state.focusId = pinned ? null : id; layout(); });
    menuItem(m, 'full', 'Tela cheia', () => toggleFullscreen(tile));
    menuSep(m);
    if (state.cam && id === state.cam.id) menuItem(m, 'camera-off', 'Desligar câmera', toggleCamera, { danger: true });
    else if (mine) menuItem(m, 'stop', 'Parar transmissão', () => stopShare(id), { danger: true });
    else if (!tile.classList.contains('cam')) menuItem(m, 'stop', 'Parar de assistir', () => unwatch(id), { danger: true });
  });
}

// ---- câmera (todos da sala veem automaticamente, como no Discord) ----
function applyCamParams(sender) {
  if (!sender.track) return;
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) p.encodings = [{}];
  p.encodings[0].maxBitrate = 1_500_000;
  p.encodings[0].maxFramerate = 30;
  sender.setParameters(p).catch(() => {});
}
function addCamToPeer(peer) {
  const c = state.cam;
  const track = c.stream.getVideoTracks()[0];
  if (!track) return;
  const sender = peer.pc.addTrack(track, c.stream);
  applyCamParams(sender);
  peer.senders.set(c.id, [sender]);
}
async function toggleCamera() {
  if (state.cam) return stopCamera();
  if (!state.channelId) { toast('Entre numa sala para ligar a câmera'); return; }
  let stream;
  const camId = state.cfg.audio?.camId;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, deviceId: camId ? { ideal: camId } : undefined },
      audio: false,
    });
  } catch (e) {
    toast(e && e.name === 'NotFoundError' ? 'Nenhuma câmera encontrada' : 'Câmera bloqueada — libere em Configurações do Windows › Privacidade › Câmera');
    return;
  }
  if (!state.channelId) { stream.getTracks().forEach((t) => t.stop()); return; }
  const v = stream.getVideoTracks()[0];
  if (v) { v.contentHint = 'motion'; v.onended = () => stopCamera(); }
  state.cam = { id: stream.id, stream, tile: null };
  state.cam.tile = makeTile({ id: stream.id, name: state.myName, label: 'Câmera', kind: 'camera', stream, mine: true });
  for (const peer of state.peers.values()) addCamToPeer(peer);
  announceShares();
  publishPresence();
  renderCam();
}
function stopCamera(silent) {
  const c = state.cam;
  if (!c) return;
  state.cam = null;
  c.stream.getTracks().forEach((t) => t.stop());
  for (const peer of state.peers.values()) {
    for (const snd of peer.senders.get(c.id) || []) { try { peer.pc.removeTrack(snd); } catch {} }
    peer.senders.delete(c.id);
  }
  if (state.focusId === c.id) state.focusId = null;
  removeTile(c.tile);
  if (!silent) { announceShares(); publishPresence(); }
  renderCam();
}
function renderCam() {
  const b = $('#camBtn');
  if (!b) return;
  b.classList.toggle('on', !!state.cam);
  b.innerHTML = icon(state.cam ? 'camera' : 'camera-off');
  b.title = state.cam ? 'Desligar câmera' : 'Ligar câmera';
}

// ---- assistir transmissões (estilo Discord) ----
function watch(from, id) {
  if (state.watching.has(id)) return;
  state.watching.add(id);
  send({ type: 'watch', to: from, id, on: true });
  const card = document.querySelector(`.tile.card[data-id="${CSS.escape(id)}"]`);
  if (card) card.classList.add('loading');
  renderDock();
}
function unwatch(id) {
  if (!state.watching.has(id)) return;
  state.watching.delete(id);
  const r = state.remotes.get(id);
  let from = r?.from;
  if (!from) for (const [n, meta] of state.remoteMeta) if (meta.has(id)) from = n;
  if (from) send({ type: 'watch', to: from, id, on: false });
  removeRemote(id);
  renderDock();
}
function unwatchAll() { for (const id of [...state.watching]) unwatch(id); }
function watchPerson(name, chId) {
  if (name === state.myName) return;
  if (chId && chId !== state.channelId) { joinChannel(chId, { watch: name }); return; }
  const meta = state.remoteMeta.get(name);
  const first = meta && [...meta.entries()].find(([, m]) => m.kind === 'screen' || m.kind === 'window');
  if (first) watch(name, first[0]);
  else state.autoWatch = name;
}

// cartões "Fulano está ao vivo · Assistir" para quem ainda não está vendo
function renderCards() {
  const want = new Map();
  for (const [from, meta] of state.remoteMeta) {
    for (const [id, m] of meta) if ((m.kind === 'screen' || m.kind === 'window') && !state.remotes.has(id)) want.set(id, { from, ...m });
  }
  for (const c of $$('.tile.card')) if (!want.has(c.dataset.id)) c.remove();
  for (const [id, m] of want) {
    let c = document.querySelector(`.tile.card[data-id="${CSS.escape(id)}"]`);
    if (!c) {
      c = document.createElement('div');
      c.className = 'tile card';
      c.dataset.id = id;
      c.style.viewTransitionName = 'tile-' + (++vtCount);
      c.dataset.order = vtCount;
      c.innerHTML = `<img class="thumb" alt="">
        <div class="card-body">
          <span class="card-orb">${orbHTML(m.from)}</span>
          <div class="card-txt"><b></b><span>${icon(m.kind === 'window' ? 'window' : 'screen')}<i></i></span></div>
          <button class="btn primary watch">${icon('play')}Assistir</button>
          <span class="card-wait"><span class="spinner"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>Conectando…</span>
        </div>
        <span class="chip live-chip"><span class="dot"></span>AO VIVO</span>`;
      c.querySelector('.card-txt b').textContent = m.from;
      c.onclick = () => watch(m.from, id);
      c.oncontextmenu = (e) => { e.preventDefault(); openTileMenu(e, { id, name: m.from, mine: false, tile: c }); };
      const th = state.thumbs.get(id);
      if (th) { const img = c.querySelector('.thumb'); img.src = th; img.classList.add('on'); }
      $('#grid').appendChild(c);
    }
    c.querySelector('.card-txt i').textContent = m.label;
    c.classList.toggle('loading', state.watching.has(id));
  }
  layout(true);
}

// barra de baixo: Compartilhar · Parar transmissão · Parar de assistir · Sair
function renderDock() {
  const sb = $('#stopShareBtn'), wb = $('#stopWatchBtn');
  if (!sb) return;
  sb.classList.toggle('hidden', state.shares.size === 0);
  wb.classList.toggle('hidden', state.watching.size === 0);
}

function addShareToPeer(peer, id, share) {
  const senders = [];
  for (const track of share.stream.getTracks()) {
    const sender = peer.pc.addTrack(track, share.stream);
    senders.push(sender);
    if (track.kind === 'video') preferCodec(peer.pc, sender, share.opts.codec);
    applyParams(sender, share.opts);
  }
  peer.senders.set(id, senders);
}

function preferCodec(pc, sender, codec) {
  const tr = pc.getTransceivers().find((t) => t.sender === sender);
  if (!tr || !tr.setCodecPreferences || !RTCRtpReceiver.getCapabilities) return;
  const caps = RTCRtpReceiver.getCapabilities('video');
  if (!caps) return;
  const want = 'video/' + (codec || 'H264').toLowerCase();
  let codecs = caps.codecs;
  const preferred = codecs.filter((c) => c.mimeType.toLowerCase() === want);
  if (!preferred.length) return; // codec não suportado neste PC: deixa o padrão
  // H.264: prefere o perfil High (melhor qualidade) quando disponível
  preferred.sort((a, b) => (/profile-level-id=64/.test(b.sdpFmtpLine || '') ? 1 : 0) - (/profile-level-id=64/.test(a.sdpFmtpLine || '') ? 1 : 0));
  codecs = [...preferred, ...codecs.filter((c) => c.mimeType.toLowerCase() !== want)];
  try { tr.setCodecPreferences(codecs); } catch (e) { console.warn('codec', e); }
}

function applyParams(sender, opts) {
  if (!sender.track) return;
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) p.encodings = [{}];
  const e = p.encodings[0];
  if (sender.track.kind === 'video') {
    e.maxBitrate = parseInt(opts.bitrate, 10) * 1_000_000;
    e.maxFramerate = parseInt(opts.fps, 10);
    e.scaleResolutionDownBy = 1;
    p.degradationPreference = opts.mode === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
  } else {
    e.maxBitrate = 510_000;
  }
  e.priority = 'high';
  e.networkPriority = 'high';
  sender.setParameters(p).catch(() => {});
}

function applyAllParams(peer) {
  for (const [id, senders] of peer.senders) {
    const share = state.shares.get(id);
    if (share) senders.forEach((s) => applyParams(s, share.opts));
    else if (state.voice && id === state.voice.id) senders.forEach(applyVoiceParams);
    else if (state.cam && id === state.cam.id) senders.forEach(applyCamParams);
  }
}

function announceShares(to) {
  const list = [...state.shares.entries()].map(([id, s]) => ({ id, label: s.label, kind: s.kind }));
  if (state.voice) list.push({ id: state.voice.id, label: 'Voz', kind: 'voice' });
  if (state.cam) list.push({ id: state.cam.id, label: 'Câmera', kind: 'camera' });
  send(to ? { type: 'shares', to, list } : { type: 'shares', list });
}

// ===================================================================
// Transmissões dos amigos
// ===================================================================
function onRemoteShares(from, list) {
  const meta = new Map(list.map((s) => [s.id, { label: s.label, kind: s.kind || 'screen' }]));
  state.remoteMeta.set(from, meta);
  for (const [id, r] of state.remotes) {
    if (r.from !== from) continue;
    if (!meta.has(id)) removeRemote(id);
    else {
      r.tile.querySelector('.ltxt').textContent = meta.get(id).label;
      r.tile.querySelector('.scr use').setAttribute('href', meta.get(id).kind === 'window' ? '#i-window' : meta.get(id).kind === 'camera' ? '#i-camera' : '#i-screen');
      r.tile.classList.toggle('cam', meta.get(id).kind === 'camera');
    }
  }
  for (const [id, v] of state.voices) if (v.from === from && !meta.has(id)) removeVoice(id);
  for (const [id, p] of state.pending) if (p.from === from && meta.has(id)) classifyStream(p.from, p.stream, p.receivers);
  for (const id of [...state.watching]) if (![...state.remoteMeta.values()].some((mm) => mm.has(id))) state.watching.delete(id);
  if (state.autoWatch === from) {
    const first = [...meta.entries()].find(([, m]) => m.kind === 'screen' || m.kind === 'window');
    if (first) { state.autoWatch = null; watch(from, first[0]); }
  }
  renderCards();
  renderDock();
  renderPeople();
}

function onRemoteTrack(from, ev) {
  const stream = ev.streams[0];
  if (!stream) return;
  // baixa latência: toca assim que chegar, sem "colchão" extra
  try { ev.receiver.jitterBufferTarget = 0; } catch {}
  try { ev.receiver.playoutDelayHint = 0; } catch {}
  const p = state.pending.get(stream.id);
  const receivers = p ? [...p.receivers, ev.receiver] : [ev.receiver];
  classifyStream(from, stream, receivers);
}

// Decide se o que chegou é uma tela (tem vídeo) ou a voz de alguém
function classifyStream(from, stream, receivers) {
  const meta = state.remoteMeta.get(from)?.get(stream.id);
  if (stream.getVideoTracks().length || (meta && meta.kind !== 'voice')) {
    state.pending.delete(stream.id);
    if (!stream.getVideoTracks().length) { state.pending.set(stream.id, { from, stream, receivers }); return; }
    let r = state.remotes.get(stream.id);
    if (!r) {
      const tile = makeTile({ id: stream.id, name: from, label: meta?.label || 'Tela', kind: meta?.kind, stream, mine: false });
      r = { from, stream, tile, receivers: [] };
      state.remotes.set(stream.id, r);
      stream.onremovetrack = () => { if (!stream.getTracks().length) removeRemote(stream.id); };
    }
    for (const rc of receivers) if (!r.receivers.includes(rc)) r.receivers.push(rc);
    const video = r.tile.querySelector('video');
    video.srcObject = stream;
    video.play().catch(() => {});
    return;
  }
  if (meta && meta.kind === 'voice') {
    state.pending.delete(stream.id);
    attachVoice(from, stream);
    return;
  }
  state.pending.set(stream.id, { from, stream, receivers });
}

function removeRemote(id) {
  const r = state.remotes.get(id);
  if (!r) return;
  state.remotes.delete(id);
  state.watching.delete(id);
  if (state.focusId === id) state.focusId = null;
  removeTile(r.tile);
  setTimeout(() => { renderCards(); renderDock(); }, 30);
}

// ===================================================================
// Interface: blocos de vídeo, layout, pessoas
// ===================================================================
function makeTile({ id, name, label, kind, stream, mine }) {
  const t = document.createElement('div');
  t.className = 'tile' + (mine ? ' mine' : '') + (kind === 'camera' ? ' cam' : '');
  t.dataset.id = id;
  t.style.viewTransitionName = 'tile-' + (++vtCount);
  t.dataset.order = document.querySelector(`.tile.card[data-id="${CSS.escape(id)}"]`)?.dataset.order || vtCount;
  t.innerHTML = `
    <video autoplay playsinline ${mine ? 'muted' : ''}></video>
    <div class="chip label">${orbHTML(name)}<span class="who"></span><span class="scr">${icon(kind === 'window' ? 'window' : kind === 'camera' ? 'camera' : 'screen')}<span class="ltxt"></span></span></div>
    <div class="chip stats"></div>
    <div class="chip ctrls">
      ${mine ? '' : `<div class="vol"><button class="btn icon mute" title="Mudo">${icon('vol')}</button><input type="range" min="0" max="1" step="0.01" value="1" title="Volume"></div>`}
      <button class="btn icon sbtn" title="Estatísticas">${icon('chart')}</button>
      <button class="btn icon fbtn" title="Destacar">${icon('expand')}</button>
      <button class="btn icon fsbtn" title="Tela cheia">${icon('full')}</button>
      ${mine || kind === 'camera' ? '' : `<button class="btn icon xbtn" title="Parar de assistir">${icon('stop', 'fill')}</button>`}
    </div>`;
  if (mine) t.querySelector('.label').insertAdjacentHTML('beforeend', '<span class="viewers"></span>');
  t.querySelector('.who').textContent = mine ? 'Você' : name;
  t.querySelector('.ltxt').textContent = label;
  const video = t.querySelector('video');
  video.srcObject = stream;
  video.play().catch(() => {});
  const vol = t.querySelector('.vol input');
  if (vol) {
    const muteBtn = t.querySelector('.mute');
    let lastVol = 1;
    const paint = () => {
      vol.style.setProperty('--p', vol.value * 100 + '%');
      muteBtn.innerHTML = icon(video.muted || video.volume === 0 ? 'mute' : 'vol');
    };
    vol.oninput = () => { setVol('stream', name, parseFloat(vol.value)); if (+vol.value > 0) lastVol = +vol.value; };
    muteBtn.onclick = () => setVol('stream', name, getVol('stream', name) > 0 ? 0 : (lastVol || 1));
    t._paintVol = paint;
    video.volume = getVol('stream', name);
    vol.value = video.volume;
    paint();
  }
  t.querySelector('.fbtn').onclick = () => { state.focusId = state.focusId === id ? null : id; layout(); };
  t.querySelector('.fsbtn').onclick = () => toggleFullscreen(t);
  t.ondblclick = (e) => { if (!e.target.closest('.ctrls')) toggleFullscreen(t); };
  t.oncontextmenu = (e) => { e.preventDefault(); openTileMenu(e, { id, name, mine, tile: t }); };
  t.querySelector('.sbtn').onclick = () => $('#statsToggle').click();
  const xb = t.querySelector('.xbtn');
  if (xb) xb.onclick = () => unwatch(id);
  smooth(() => {
    const card = document.querySelector(`.tile.card[data-id="${CSS.escape(id)}"]`);
    if (card) card.replaceWith(t); else $('#grid').appendChild(t);
    layout(true);
    video.play().catch(() => {});
  });
  return t;
}

function removeTile(tile) {
  smooth(() => { tile.remove(); layout(true); });
}

function toggleFullscreen(el) {
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen().catch(() => {});
}

function layout(noTransition) {
  const apply = () => {
    const grid = $('#grid');
    const focus = $('#focus');
    const stage = $('#stage');
    const tiles = $$('.tile');
    if (state.focusId && !tiles.some((t) => t.dataset.id === state.focusId)) state.focusId = null;
    for (const t of tiles) {
      const isF = t.dataset.id === state.focusId;
      const target = isF ? focus : grid;
      if (t.parentElement !== target) {
        target.appendChild(t);
        t.querySelector('video')?.play().catch(() => {}); // mover o elemento pausa o vídeo
      }
      const fb = t.querySelector('.fbtn');
      if (fb) { fb.innerHTML = icon(isF ? 'shrink' : 'expand'); fb.title = isF ? 'Voltar' : 'Destacar'; }
    }
    grid.className = 'grid';
    stage.classList.toggle('has-focus', !!state.focusId);
    focus.classList.toggle('hidden', !state.focusId);
    $('#empty').classList.toggle('hidden', tiles.length > 0);
    requestAnimationFrame(fitTiles);
    const roomVisible = !$('#room').classList.contains('hidden');
    window.Halftone && Halftone.setActive(!roomVisible || tiles.length === 0);
  };
  if (noTransition) apply(); else smooth(apply);
}

function renderPeople() {
  const box = $('#people');
  const everyone = [state.myName, ...state.online];
  // reaproveita elementos para não repetir a animação de entrada
  const existing = new Map($$('.person', box).map((el) => [el.dataset.name, el]));
  for (const [n, el] of existing) if (!everyone.includes(n)) el.remove();
  everyone.forEach((n, idx) => {
    if (!n) return;
    let el = existing.get(n);
    if (!el) {
      el = document.createElement('div');
      el.className = 'person';
      el.dataset.name = n;
      el.innerHTML = `${orbHTML(n)}<span class="nm"></span><span class="vic"></span><span class="st"></span><span class="live" title="Assistir">AO VIVO</span>`;
      el.querySelector('.live').onclick = () => watchPerson(n, state.channelId);
      el.oncontextmenu = (e) => { e.preventDefault(); openPersonMenu(e, n, state.channelId); };
      el.querySelector('.nm').innerHTML = esc(n) + (n === state.myName ? ' <span class="you">· você</span>' : '');
    }
    if (box.children[idx] !== el) box.insertBefore(el, box.children[idx] || null);
    const me = n === state.myName;
    let st = '', title = 'Conectado';
    if (!me) {
      const cs = state.peers.get(n)?.pc?.connectionState;
      if (cs === 'connecting') { st = 'wait'; title = 'Conectando…'; }
      if (cs === 'failed' || cs === 'disconnected') { st = 'bad'; title = 'Sem conexão direta — verifique a internet'; }
    }
    el.querySelector('.st').className = 'st ' + st;
    el.title = title;
    const live = me ? state.shares.size > 0 : [...(state.remoteMeta.get(n)?.values() || [])].some((x) => x.kind === 'screen' || x.kind === 'window');
    el.classList.toggle('is-live', live);
    const vs = me ? (state.voice ? { inVoice: true, muted: state.voice.muted, deaf: state.voice.deaf } : null) : state.vstate.get(n);
    const vic = el.querySelector('.vic');
    const vicKind = (!me && isLocalMuted(n)) ? 'local' : !vs || !vs.inVoice ? '' : vs.deaf ? 'deaf' : vs.muted ? 'mute' : 'on';
    if (vic.dataset.k !== vicKind) {
      vic.dataset.k = vicKind;
      vic.innerHTML = vicKind === 'local' ? icon('mic-off') : vicKind === 'deaf' ? icon('deaf') : vicKind === 'mute' ? icon('mic-off') : vicKind === 'on' ? icon('headset') : '';
      vic.className = 'vic ' + vicKind;
    }
    el.title = vicKind === 'local' ? title + ' · silenciado para você' : vicKind === 'on' ? title + ' · na voz' : vicKind === 'mute' ? title + ' · na voz (mudo)' : vicKind === 'deaf' ? title + ' · na voz (sem som)' : title;
  });
}

// Barra de salas: só recolhe quando a pessoa quiser
function setSideCollapsed(on) {
  $('#room').classList.toggle('side-collapsed', on);
  $('#sideToggle').title = on ? 'Mostrar salas' : 'Recolher salas';
  state.cfg.sideCollapsed = on;
  window.trimeet.saveConfig(state.cfg);
  setTimeout(fitTiles, 520);
}
$('#sideToggle').onclick = () => setSideCollapsed(!$('#room').classList.contains('side-collapsed'));

// ===================================================================
// Organização das telas: cada bloco no formato da própria imagem,
// em fileiras alinhadas e centralizadas, usando o máximo do espaço.
// ===================================================================
function aspectOf(t) {
  const v = t.querySelector('video');
  if (v && v.videoWidth && v.videoHeight) return v.videoWidth / v.videoHeight;
  return t.classList.contains('cam') ? 4 / 3 : 16 / 9;
}
function packRows(items, W, H, gap, maxRows) {
  const n = items.length;
  if (!n || W <= 0 || H <= 0) return null;
  let best = null;
  for (let r = 1; r <= Math.min(n, maxRows || n); r++) {
    // distribui em r fileiras equilibradas
    const per = Math.ceil(n / r);
    const rows = [];
    for (let i = 0; i < n; i += per) rows.push(items.slice(i, i + per));
    let h = (H - gap * (rows.length - 1)) / rows.length;
    for (const row of rows) {
      const sumA = row.reduce((s, it) => s + it.a, 0);
      h = Math.min(h, (W - gap * (row.length - 1)) / sumA);
    }
    if (h <= 0) continue;
    const area = items.reduce((s, it) => s + h * h * it.a, 0);
    if (!best || area > best.area + 1) best = { rows, h, area };
  }
  return best;
}
function placeIn(container, tiles, opts = {}) {
  const gap = opts.gap ?? 12;
  const W = container.clientWidth, H = container.clientHeight;
  const items = tiles.map((t) => ({ t, a: aspectOf(t) }));
  const best = packRows(items, W, H, gap, opts.maxRows);
  if (!best) return;
  const totalH = best.rows.length * best.h + gap * (best.rows.length - 1);
  let y = (H - totalH) / 2;
  for (const row of best.rows) {
    const rowW = row.reduce((s, it) => s + best.h * it.a, 0) + gap * (row.length - 1);
    let x = (W - rowW) / 2;
    for (const it of row) {
      const w = best.h * it.a;
      const st = it.t.style;
      st.left = Math.round(x) + 'px'; st.top = Math.round(y) + 'px';
      st.width = Math.round(w) + 'px'; st.height = Math.round(best.h) + 'px';
      x += w + gap;
    }
    y += best.h + gap;
  }
}
function placeRect(tiles, rect, opts = {}) {
  // posiciona dentro de um retângulo do #grid
  const gap = opts.gap ?? 12;
  const items = tiles.map((t) => ({ t, a: aspectOf(t) }));
  const best = packRows(items, rect.w, rect.h, gap, opts.maxRows);
  if (!best) return;
  const totalH = best.rows.length * best.h + gap * (best.rows.length - 1);
  let y = rect.y + (opts.alignTop ? 0 : (rect.h - totalH) / 2);
  for (const row of best.rows) {
    const rowW = row.reduce((s, it) => s + best.h * it.a, 0) + gap * (row.length - 1);
    let x = rect.x + (rect.w - rowW) / 2;
    for (const it of row) {
      const w = best.h * it.a, st = it.t.style;
      st.left = Math.round(x) + 'px'; st.top = Math.round(y) + 'px';
      st.width = Math.round(w) + 'px'; st.height = Math.round(best.h) + 'px';
      x += w + gap;
    }
    y += best.h + gap;
  }
}
function fitTiles() {
  const grid = $('#grid'), focus = $('#focus');
  if (!grid) return;
  // ordem fixa: transmissões primeiro, depois câmeras; dentro de cada grupo, por ordem de chegada
  const rank = (t) => (t.classList.contains('cam') ? 1 : 0) * 1e9 + (+t.dataset.order || 0);
  const focused = [...focus.children].filter((t) => t.classList.contains('tile'));
  const rest = [...grid.children].filter((t) => t.classList.contains('tile')).sort((x, y) => rank(x) - rank(y));
  if (focused.length) { placeIn(focus, focused, { gap: 0 }); if (rest.length) placeIn(grid, rest, { maxRows: 1, gap: 10 }); return; }
  // sem destaque: transmissões são a prioridade; câmeras ficam como segundo plano
  const screens = rest.filter((t) => !t.classList.contains('cam'));
  const cams = rest.filter((t) => t.classList.contains('cam'));
  const W = grid.clientWidth, H = grid.clientHeight, gap = 12;
  if (!screens.length || !cams.length) { placeIn(grid, rest); return; }
  if (W / H > 2.1) {
    // tela bem larga: câmeras numa coluna à direita
    const cw = Math.max(180, Math.min(320, W * 0.2));
    placeRect(screens, { x: 0, y: 0, w: W - cw - gap, h: H });
    placeRect(cams, { x: W - cw, y: 0, w: cw, h: H }, { gap: 10 });
  } else {
    // monitor normal ou celular: câmeras numa faixa embaixo
    const ch = Math.max(96, Math.min(180, H * 0.22));
    placeRect(screens, { x: 0, y: 0, w: W, h: H - ch - gap });
    placeRect(cams, { x: 0, y: H - ch, w: W, h: ch }, { maxRows: 1, gap: 10 });
  }
}
new ResizeObserver(() => fitTiles()).observe(document.getElementById('stage'));
// quando o vídeo descobre o próprio formato, reorganiza
document.addEventListener('loadedmetadata', (e) => { if (e.target.closest && e.target.closest('.tile')) fitTiles(); }, true);
document.addEventListener('resize', (e) => { if (e.target.tagName === 'VIDEO') fitTiles(); }, true);

// ===================================================================
// Estatísticas (FPS, resolução, Mbps, ping)
// ===================================================================
const lastBytes = new Map();
async function updateStats() {
  if (!document.body.classList.contains('show-stats')) return;
  // transmissões recebidas
  for (const [id, r] of state.remotes) {
    const vRecv = r.receivers.find((x) => x.track && x.track.kind === 'video');
    const aRecv = r.receivers.find((x) => x.track && x.track.kind === 'audio');
    let txt = '';
    try {
      if (vRecv) {
        const st = await vRecv.getStats();
        let rtt = null;
        st.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
            const prev = lastBytes.get(id + 'v');
            const now = { b: s.bytesReceived, t: s.timestamp };
            lastBytes.set(id + 'v', now);
            const mbps = prev ? ((now.b - prev.b) * 8) / ((now.t - prev.t) / 1000) / 1e6 : 0;
            const codec = s.codecId && st.get(s.codecId) ? st.get(s.codecId).mimeType.split('/')[1] : '';
            txt += `${s.frameWidth || '?'}×${s.frameHeight || '?'} @ ${Math.round(s.framesPerSecond || 0)} fps  ${codec}\n`;
            txt += `vídeo ${mbps.toFixed(1)} Mbps  perdidos ${s.packetsLost || 0}\n`;
          }
          if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded' && s.currentRoundTripTime != null) rtt = s.currentRoundTripTime;
        });
        if (rtt != null) txt += `ping ${Math.round(rtt * 1000)} ms\n`;
      }
      if (aRecv) {
        const st = await aRecv.getStats();
        st.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'audio') {
            const prev = lastBytes.get(id + 'a');
            const now = { b: s.bytesReceived, t: s.timestamp };
            lastBytes.set(id + 'a', now);
            const kbps = prev ? ((now.b - prev.b) * 8) / ((now.t - prev.t) / 1000) / 1000 : 0;
            txt += `áudio ${Math.round(kbps)} kbps`;
          }
        });
      }
    } catch {}
    const el = r.tile.querySelector('.stats');
    if (el) el.textContent = txt.trim() || 'aguardando dados…';
  }
  // minhas transmissões
  for (const [id, share] of state.shares) {
    let txt = '';
    for (const peer of state.peers.values()) {
      const s = (peer.senders.get(id) || []).find((x) => x.track && x.track.kind === 'video');
      if (!s) continue;
      try {
        const st = await s.getStats();
        st.forEach((o) => {
          if (o.type === 'outbound-rtp' && o.kind === 'video') {
            const key = id + peer.name;
            const prev = lastBytes.get(key);
            const now = { b: o.bytesSent, t: o.timestamp };
            lastBytes.set(key, now);
            const mbps = prev ? ((now.b - prev.b) * 8) / ((now.t - prev.t) / 1000) / 1e6 : 0;
            const lim = o.qualityLimitationReason && o.qualityLimitationReason !== 'none' ? `  limitado: ${o.qualityLimitationReason === 'bandwidth' ? 'internet' : o.qualityLimitationReason === 'cpu' ? 'processador' : o.qualityLimitationReason}` : '';
            const enc = o.encoderImplementation ? `  ${o.encoderImplementation}` : '';
            txt += `→ ${peer.name}: ${o.frameWidth || '?'}×${o.frameHeight || '?'} @ ${Math.round(o.framesPerSecond || 0)} fps  ${mbps.toFixed(1)} Mbps${enc}${lim}\n`;
          }
        });
      } catch {}
    }
    const el = share.tile.querySelector('.stats');
    if (el) el.textContent = txt.trim() || 'ninguém assistindo ainda';
  }
}
setInterval(updateStats, 1000);

// ===================================================================
// Modal de compartilhamento
// ===================================================================
async function openShareModal() {
  const s = state.cfg.share || {};
  for (const [k, sel] of [['res', '#optRes'], ['fps', '#optFps'], ['bitrate', '#optBitrate'], ['mode', '#optMode'], ['codec', '#optCodec']]) {
    if (s[k]) $(sel).value = s[k];
  }
  if (!['native', '1440', '1080', '720'].includes($('#optRes').value)) $('#optRes').value = '1080';
  if (typeof s.audio === 'boolean') $('#optAudio').checked = s.audio;
  state.selectedSource = null;
  $('#goShare').disabled = true;
  $('#sources').innerHTML = '';
  showEl($('#shareModal'));
  requestAnimationFrame(() => { refreshBoundSegs(); refreshStepper(); syncAllSegs(true); });
  updateUploadHint();
  state.sourcesCache = await window.trimeet.getSources();
  renderSources();
}

function renderSources() {
  const box = $('#sources');
  box.innerHTML = '';
  $$('#srcTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.srcTab));
  syncSeg($('#srcTabs'));
  const list = state.sourcesCache.filter((s) => s.type === state.srcTab);
  list.forEach((src, i) => {
    const b = document.createElement('button');
    b.className = 'src' + (state.selectedSource?.id === src.id ? ' on' : '');
    b.style.animationDelay = i * 40 + 'ms';
    b.innerHTML = `<img alt=""><span class="check">${icon('check')}</span><div class="meta">${icon(src.type === 'window' ? 'window' : 'screen')}<span class="t"></span><span class="i"></span></div>`;
    b.querySelector('img').src = src.thumb;
    b.querySelector('.t').textContent = src.label;
    b.querySelector('.i').textContent = (src.info || '').split(' • ')[0];
    b.title = src.info || src.label;
    b.onclick = () => {
      state.selectedSource = src;
      $('#goShare').disabled = false;
      $$('.src', box).forEach((x) => x.classList.toggle('on', x === b));
    };
    b.ondblclick = () => { state.selectedSource = src; goShare(); };
    box.appendChild(b);
  });
}

function updateUploadHint() {
  const mbps = parseInt($('#optBitrate').value, 10);
  const viewers = Math.max(state.online.length, 1);
  const total = Math.ceil(mbps * viewers + ($('#optAudio').checked ? 0.5 * viewers : 0));
  const h = $('#uploadHint');
  h.querySelector('.mono').textContent = `~${total} Mbps`;
  h.title = `Upload necessário: ${mbps} Mbps × ${viewers} ${viewers === 1 ? 'pessoa' : 'pessoas'}`;
  h.classList.toggle('warn', total > 40);
}

function closeShareModal() { hideEl($('#shareModal')); }

async function goShare() {
  const src = state.selectedSource;
  if (!src) return;
  const opts = {
    res: $('#optRes').value,
    fps: $('#optFps').value,
    bitrate: $('#optBitrate').value,
    mode: $('#optMode').value,
    codec: $('#optCodec').value,
    audio: $('#optAudio').checked && window.trimeet.platform === 'win32',
  };
  state.cfg.share = { ...opts, audio: $('#optAudio').checked };
  window.trimeet.saveConfig(state.cfg);
  closeShareModal();
  await startShare(src.id, src.label, opts, src.type);
}

// ===================================================================
// Diversos
// ===================================================================
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden', 'leaving');
  t.style.animation = 'none'; t.offsetWidth; t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hideEl(t, 200), 2600);
}

function logout() {
  leaveChannel(true);
  state.loggedOut = true;
  if (state.hub) { try { state.hub.close(); } catch {} state.hub = null; }
  state.hubOnline = [];
  state.hubSeen = false;
  state.presence.clear();
  smooth(() => {
    $('#room').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#people').innerHTML = '';
    Halftone.setActive(true);
    renderLogin();
  });
}

// ===================================================================
// Voz (estilo Discord)
// ===================================================================
let audioCtx = null;
function actx() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

// medidor de volume: acende o anel verde de quem está falando
function makeMeter(stream, onChange, threshold = 0.035) {
  try {
    const ctx = actx();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const data = new Uint8Array(an.fftSize);
    let speaking = false, lastLoud = 0;
    const iv = setInterval(() => {
      an.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / data.length);
      const now = performance.now();
      if (rms > threshold) lastLoud = now;
      const sp = now - lastLoud < 280;
      if (sp !== speaking) { speaking = sp; onChange(sp); }
    }, 60);
    return { stop() { clearInterval(iv); try { src.disconnect(); } catch {} } };
  } catch { return { stop() {} }; }
}

function setSpeaking(name, on) {
  if (!name) return;
  const sel = CSS.escape(name);
  document.querySelectorAll(`.person[data-name="${sel}"], .member[data-name="${sel}"]`).forEach((el) => el.classList.toggle('speaking', on));
  if (name === state.myName) $('.me-panel')?.classList.toggle('speaking', on);
}

// sons curtos de entrar/sair/mutar
function chime(kind) {
  try {
    const ctx = actx();
    const notes = { join: [523.25, 783.99], leave: [659.25, 392], mute: [440], unmute: [587.33], other: [698.46, 880] }[kind] || [600];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const t = ctx.currentTime + i * 0.09;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.08, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + 0.25);
    });
  } catch {}
}

function applyVoiceParams(sender) {
  if (!sender.track) return;
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) p.encodings = [{}];
  p.encodings[0].maxBitrate = 96_000;
  p.encodings[0].priority = 'high';
  p.encodings[0].networkPriority = 'high';
  sender.setParameters(p).catch(() => {});
}

function addVoiceToPeer(peer) {
  const v = state.voice;
  const track = v.stream.getAudioTracks()[0];
  if (!track) return;
  const sender = peer.pc.addTrack(track, v.stream);
  applyVoiceParams(sender);
  peer.senders.set(v.id, [sender]);
}

function sendVoiceState(to) {
  const v = state.voice;
  const m = { type: 'vstate', inVoice: !!v, muted: !!v?.muted, deaf: !!v?.deaf };
  send(to ? { ...m, to } : m);
}

async function joinVoice() {
  if (state.voice) return;
  let stream;
  try {
    stream = await getMic();
  } catch (e) {
    toast('Microfone bloqueado — libere em Configurações do Windows › Privacidade › Microfone');
    return;
  }
  if (!state.channelId) { releaseMic(stream); return; }
  state.voice = { id: stream.id, stream, muted: !!(state.pref.muted || state.pref.deaf), deaf: !!state.pref.deaf, meter: null };
  stream.getAudioTracks().forEach((t) => { t.enabled = !state.voice.muted; });
  state.voice.meter = makeMeter(stream, (on) => setSpeaking(state.myName, on && !state.voice?.muted), myThreshold());
  for (const peer of state.peers.values()) addVoiceToPeer(peer);
  for (const v of state.voices.values()) v.audio.muted = state.voice.deaf || isLocalMuted(v.from);
  announceShares();
  sendVoiceState();
  chime('join');
  renderVoice();
  renderPeople();
  if ($$('.tile.mine').length && state.cfg.share?.audio) toast('Dica: com "Som do PC" ligado, seus amigos podem ouvir a própria voz. Desligue se der eco.');
}

function leaveVoice(silent) {
  const v = state.voice;
  if (!v) return;
  state.voice = null;
  v.meter?.stop();
  releaseMic(v.stream);
  for (const peer of state.peers.values()) {
    for (const s of peer.senders.get(v.id) || []) { try { peer.pc.removeTrack(s); } catch {} }
    peer.senders.delete(v.id);
  }
  for (const rv of state.voices.values()) rv.audio.muted = true;
  setSpeaking(state.myName, false);
  if (!silent) { announceShares(); sendVoiceState(); chime('leave'); }
  renderVoice();
  renderPeople();
}

function savePref() {
  const v = state.voice;
  if (v) state.pref = { muted: v.muted, deaf: v.deaf };
  state.cfg.voicePref = state.pref;
  window.trimeet.saveConfig(state.cfg);
  publishPresence();
}
function toggleMute() {
  const v = state.voice;
  if (!v) {
    if (state.pref.deaf) state.pref = { muted: false, deaf: false };
    else state.pref.muted = !state.pref.muted;
    chime(state.pref.muted ? 'mute' : 'unmute');
    savePref(); renderVoice(); return;
  }
  if (v.deaf) { toggleDeaf(); return; }
  v.muted = !v.muted;
  v.stream.getAudioTracks().forEach((t) => { t.enabled = !v.muted; });
  if (v.muted) setSpeaking(state.myName, false);
  chime(v.muted ? 'mute' : 'unmute');
  sendVoiceState();
  savePref();
  renderVoice();
  renderPeople();
}

function toggleDeaf() {
  const v = state.voice;
  if (!v) {
    state.pref.deaf = !state.pref.deaf;
    if (state.pref.deaf) { state.pref.preDeafMuted = state.pref.muted; state.pref.muted = true; } else state.pref.muted = !!state.pref.preDeafMuted;
    chime(state.pref.deaf ? 'mute' : 'unmute');
    savePref(); renderVoice(); return;
  }
  v.deaf = !v.deaf;
  // ensurdecer também muta o microfone; ao voltar, mantém o mudo de antes (igual ao Discord)
  if (v.deaf) { v.preDeafMuted = v.muted; v.muted = true; } else v.muted = !!v.preDeafMuted;
  v.stream.getAudioTracks().forEach((t) => { t.enabled = !v.muted; });
  for (const rv of state.voices.values()) rv.audio.muted = v.deaf || isLocalMuted(rv.from);
  if (v.muted) setSpeaking(state.myName, false);
  chime(v.deaf ? 'mute' : 'unmute');
  sendVoiceState();
  savePref();
  renderVoice();
  renderPeople();
}

function attachVoice(from, stream) {
  if (state.voices.has(stream.id)) return;
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.srcObject = stream;
  audio.muted = !state.voice || state.voice.deaf; // só escuta quem também entrou na voz
  audio.volume = getVol('voice', from);
  document.body.appendChild(audio);
  if (window.TMAudio && state.cfg.audio?.outputId) TMAudio.setOutputDevice(audio, state.cfg.audio.outputId);
  audio.play().catch(() => {});
  const meter = makeMeter(stream, (on) => setSpeaking(from, on));
  state.voices.set(stream.id, { from, stream, audio, meter });
  stream.onremovetrack = () => { if (!stream.getTracks().length) removeVoice(stream.id); };
  if (state.voice) chime('other');
}

function removeVoice(id) {
  const v = state.voices.get(id);
  if (!v) return;
  state.voices.delete(id);
  v.meter.stop();
  v.audio.srcObject = null;
  v.audio.remove();
  setSpeaking(v.from, false);
  if (state.voice) chime('leave');
}

function renderVoice() {
  const v = state.voice;
  const muted = v ? v.muted : state.pref.muted || state.pref.deaf;
  const deaf = v ? v.deaf : state.pref.deaf;
  const mic = $('#micBtn'), dfb = $('#deafBtn');
  if (!mic) return;
  mic.innerHTML = icon(muted ? 'mic-off' : 'mic');
  mic.classList.toggle('off', muted);
  mic.title = muted ? 'Desmutar (M)' : 'Mutar (M)';
  dfb.innerHTML = icon(deaf ? 'deaf' : 'headset');
  dfb.classList.toggle('off', deaf);
  dfb.title = deaf ? 'Ativar som' : 'Desativar som';
}

function myThreshold() {
  const sens = state.cfg.audio?.sensitivity;
  return window.TMSettings && sens != null ? TMSettings.thresholdFor(sens) : 0.035;
}

// microfone: usa o módulo de áudio (modos de voz) quando disponível
async function getMic() {
  const a = state.cfg.audio || {};
  if (window.TMAudio) return TMAudio.getMicStream({ mode: a.mode || 'natural', deviceId: a.inputId || undefined });
  const s = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1, deviceId: a.inputId ? { exact: a.inputId } : undefined },
    video: false,
  });
  s.getAudioTracks().forEach((t) => { t.contentHint = 'speech'; });
  return s;
}
function releaseMic(stream) {
  if (!stream) return;
  if (window.TMAudio && TMAudio.release) { try { TMAudio.release(stream); return; } catch {} }
  stream.getTracks().forEach((t) => t.stop());
}
// configurações de áudio mudaram: troca o microfone sem sair da sala
window.addEventListener('tm-audio-change', async (e) => {
  state.cfg.audio = { ...(state.cfg.audio || {}), ...(e.detail || {}) };
  if (window.TMAudio) for (const rv of state.voices.values()) TMAudio.setOutputDevice(rv.audio, state.cfg.audio.outputId);
  const v = state.voice;
  if (!v) return;
  let ns;
  try { ns = await getMic(); } catch { toast('Não consegui trocar o microfone'); return; }
  const nt = ns.getAudioTracks()[0];
  nt.enabled = !v.muted;
  for (const peer of state.peers.values()) for (const snd of peer.senders.get(v.id) || []) { try { await snd.replaceTrack(nt); } catch {} }
  v.meter?.stop();
  const old = v.stream;
  v.stream = ns;
  v.meter = makeMeter(ns, (on) => setSpeaking(state.myName, on && !state.voice?.muted), myThreshold());
  releaseMic(old);
});

$('#micBtn').onclick = toggleMute;
$('#deafBtn').onclick = toggleDeaf;
document.addEventListener('keydown', (e) => {
  if ($('#room').classList.contains('hidden')) return;
  if (e.target.closest && e.target.closest('input, textarea')) return;
  if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); toggleMute(); }
});

$('#addRoomBtn').onclick = () => startEdit('__new__');
$('#homeBtn').oncontextmenu = (e) => {
  e.preventDefault();
  openMenu(e, (m) => {
    menuHead(m, state.myName, window.TMPerms?.isOwner() ? 'Dono do servidor' : 'Servidor');
    if (window.TMPerms) menuItem(m, 'shield', 'Servidor e cargos', () => TMPerms.openServer());
    menuSep(m);
    menuItem(m, 'leave', 'Sair do TriMeet', () => $('#homeBtn').click(), { danger: true });
  });
};
$('#settingsBtn').onclick = () => { if (window.TMSettings) TMSettings.open(); else toast('Configurações chegam na próxima versão'); };
setInterval(() => send({ type: 'ping' }), 25000);
$('#shareBtn').onclick = openShareModal;
$('#closeModal').onclick = closeShareModal;
$('#cancelShare').onclick = closeShareModal;
$('#goShare').onclick = goShare;
$('#leaveBtn').onclick = () => leaveChannel();
$('#homeBtn').onclick = () => {
  if (state.shares.size && !confirm('Sair do TriMeet vai parar sua transmissão. Continuar?')) return;
  logout();
};
$('#camBtn').onclick = toggleCamera;
$('#sfxBtn').onclick = () => window.TMSound ? TMSound.togglePanel($('#sfxBtn')) : toast('Efeitos chegam na próxima versão');
window.TMSound?.init({
  hubSend,
  roomSend: send,
  myName: () => state.myName,
  inChannel: () => !!state.channelId,
  isDeaf: () => !!(state.voice ? state.voice.deaf : state.pref.deaf),
  toast,
  orbHTML,
  icon,
});
$('#stopShareBtn').onclick = () => { for (const id of [...state.shares.keys()]) stopShare(id); };
$('#stopWatchBtn').onclick = unwatchAll;
$('#statsToggle').onclick = () => {
  const on = document.body.classList.toggle('show-stats');
  $$('.tile .sbtn').forEach((b) => b.classList.toggle('on', on));
  updateStats();
};
$('#shareModal').addEventListener('mousedown', (e) => { if (e.target === $('#shareModal')) closeShareModal(); });
$$('#srcTabs button').forEach((b) => { b.onclick = () => { state.srcTab = b.dataset.tab; renderSources(); }; });
$('#optAudio').onchange = updateUploadHint;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#shareModal').classList.contains('hidden')) closeShareModal(); });
initBoundSegs();
initStepper();

// ===================================================================
// Atualizações
// ===================================================================
let updDismissed = null;
let lastUpd = null;
function renderUpdate(u) {
  lastUpd = u;
  const short = (v) => String(v || '').replace(/\.0(\.0)?$/, '.0').replace(/^(\d+)\.0\.0$/, '$1.0');
  $('#verTxt').textContent = `v${short(u.current)}`;
  const chk = $('#checkUpd');
  const lbl = chk.querySelector('span');
  chk.disabled = false;
  chk.classList.toggle('ready', u.state === 'ready');
  const labels = {
    checking: 'Verificando…',
    none: 'Atualizado ✓',
    downloading: `Baixando ${u.percent || 0}%`,
    ready: `v${u.version} pronta`,
    error: 'Atualizações',
    unsupported: 'Atualizações',
  };
  lbl.textContent = labels[u.state] || 'Atualizações';
  chk.title = u.state === 'unsupported' ? 'Atualização automática chega na próxima versão' : (u.error || '');
  if (u.state === 'checking') chk.disabled = true;

  const ready = u.state === 'ready';
  const btn = $('#updBtn');
  btn.classList.toggle('hidden', !ready);
  if (ready) { btn.querySelector('span').textContent = `v${u.version}`; btn.title = u.notes || 'Atualizar e reiniciar'; }
  const banner = $('#updBanner');
  if (ready && updDismissed !== u.version) {
    $('#updTitle').textContent = `TriMeet ${u.version}`;
    $('#updNotes').textContent = u.notes || 'Pronta para instalar';
    if (banner.classList.contains('hidden')) showEl(banner);
  } else hideEl(banner);
}
function installUpdate() {
  if (state.shares.size && !confirm('Atualizar agora vai parar sua transmissão e reiniciar o TriMeet. Continuar?')) return;
  toast('Atualizando… o TriMeet reabre em segundos');
  window.trimeet.updateInstall();
}
window.trimeet.onUpdate(renderUpdate);
window.trimeet.updateGet().then(renderUpdate);
$('#checkUpd').onclick = () => {
  if (lastUpd?.state === 'ready') return installUpdate();
  window.trimeet.updateCheck();
};
$('#updBtn').onclick = installUpdate;
$('#updNow').onclick = installUpdate;
$('#updLater').onclick = () => { updDismissed = lastUpd?.version; hideEl($('#updBanner')); };

initLogin();
