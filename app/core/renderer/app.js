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
const cleanRoom = (r) => String(r || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 32);

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

  const nameInput = $('#nameInput');
  nameInput.value = state.cfg.name || '';
  nameInput.oninput = () => {
    const prev = initialOf(state.cfg.name);
    state.cfg.name = nameInput.value.trim();
    renderLogin(initialOf(state.cfg.name) !== prev);
  };
  nameInput.onkeydown = (e) => { if (e.key === 'Enter') { if (!$('#enterBtn').disabled) enter(); else $('#roomInput').focus(); } };
  nameInput.onfocus = nameInput.onblur = () => renderLogin();
  const roomInput = $('#roomInput');
  roomInput.value = state.cfg.room || '';
  roomInput.oninput = () => {
    const v = cleanRoom(roomInput.value);
    if (v !== roomInput.value) { const p = roomInput.selectionStart; roomInput.value = v; roomInput.setSelectionRange(p, p); }
    state.cfg.room = v;
    renderLogin();
  };
  roomInput.onkeydown = (e) => { if (e.key === 'Enter' && !$('#enterBtn').disabled) enter(); };
  $('#diceBtn').onclick = () => {
    const words = ['orbe', 'tela', 'pixel', 'aurora', 'nebula', 'cometa', 'neon', 'prisma', 'onda', 'luz'];
    roomInput.value = `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(1000 + Math.random() * 9000)}`;
    roomInput.dispatchEvent(new Event('input'));
    roomInput.focus();
  };
  $('#serverInput').value = state.cfg.server || '';
  $('#serverInput').placeholder = CONF.server || 'https://…workers.dev';
  $('#serverInput').oninput = (e) => { state.cfg.server = e.target.value.trim(); };
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
  const okRoom = cleanRoom(c.room).length >= 3;
  $('#enterBtn').disabled = !c.name || !okRoom;
  $('#enterTxt').textContent = !c.name ? 'Digite seu nome' : !okRoom ? 'Digite o código da sala' : 'Entrar';
  $('.name-field').classList.toggle('need', !c.name && document.activeElement !== $('#nameInput'));
}

async function enter() {
  const c = state.cfg;
  $('#loginErr').textContent = '';
  $('#enterBtn').disabled = true;
  c.room = cleanRoom(c.room);
  const base = (c.server || CONF.server || '').replace(/\/+$/, '');
  if (!base) { $('#loginErr').textContent = 'Servidor não configurado'; renderLogin(); return; }
  await window.trimeet.saveConfig(c);
  // credenciais do retransmissor (TURN) — se falhar, segue só com conexão direta
  try {
    const r = await fetch(`${base}/turn?key=${encodeURIComponent(CONF.key)}`, { cache: 'no-store' });
    if (r.ok) { const d = await r.json(); if (Array.isArray(d.iceServers) && d.iceServers.length) state.iceServers = d.iceServers; }
  } catch {}
  state.myName = c.name;
  state.leaving = false;
  state.wsUrl = `${base.replace(/^http/, 'ws')}/ws?room=${encodeURIComponent(c.room)}&key=${encodeURIComponent(CONF.key)}`;
  $('#roomName').textContent = c.room;
  smooth(() => {
    $('#login').classList.add('hidden');
    $('#room').classList.remove('hidden');
    renderPeople();
    layout(true);
  });
  connectSignal();
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

  // envia o que eu já estiver transmitindo
  for (const [id, share] of state.shares) addShareToPeer(peer, id, share);
  return peer;
}

function closePeer(name) {
  const peer = state.peers.get(name);
  if (peer) { try { peer.pc.close(); } catch {} state.peers.delete(name); }
  state.remoteMeta.delete(name);
  for (const [id, r] of state.remotes) if (r.from === name) removeRemote(id);
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
  const share = { stream, label, kind, opts };
  state.shares.set(id, share);
  if (v) v.onended = () => stopShare(id);

  share.tile = makeTile({ id, name: state.myName, label, kind, stream, mine: true });
  for (const peer of state.peers.values()) addShareToPeer(peer, id, share);
  announceShares();
  renderPeople();
}

function stopShare(id) {
  const share = state.shares.get(id);
  if (!share) return;
  state.shares.delete(id);
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
  }
}

function announceShares(to) {
  const list = [...state.shares.entries()].map(([id, s]) => ({ id, label: s.label, kind: s.kind }));
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
      r.tile.querySelector('.scr use').setAttribute('href', meta.get(id).kind === 'window' ? '#i-window' : '#i-screen');
    }
  }
  renderPeople();
}

function onRemoteTrack(from, ev) {
  const stream = ev.streams[0];
  if (!stream) return;
  // baixa latência: toca assim que chegar, sem "colchão" extra
  try { ev.receiver.jitterBufferTarget = 0; } catch {}
  try { ev.receiver.playoutDelayHint = 0; } catch {}

  let r = state.remotes.get(stream.id);
  if (!r) {
    const m = state.remoteMeta.get(from)?.get(stream.id);
    const tile = makeTile({ id: stream.id, name: from, label: m?.label || 'Tela', kind: m?.kind, stream, mine: false });
    r = { from, stream, tile, receivers: [] };
    state.remotes.set(stream.id, r);
    stream.onremovetrack = () => { if (!stream.getTracks().length) removeRemote(stream.id); };
  }
  r.receivers.push(ev.receiver);
  const video = r.tile.querySelector('video');
  video.srcObject = stream;
  video.play().catch(() => {});
}

function removeRemote(id) {
  const r = state.remotes.get(id);
  if (!r) return;
  state.remotes.delete(id);
  if (state.focusId === id) state.focusId = null;
  removeTile(r.tile);
}

// ===================================================================
// Interface: blocos de vídeo, layout, pessoas
// ===================================================================
function makeTile({ id, name, label, kind, stream, mine }) {
  const t = document.createElement('div');
  t.className = 'tile' + (mine ? ' mine' : '');
  t.dataset.id = id;
  t.style.viewTransitionName = 'tile-' + (++vtCount);
  t.innerHTML = `
    <video autoplay playsinline ${mine ? 'muted' : ''}></video>
    <div class="chip label">${orbHTML(name)}<span class="who"></span><span class="scr">${icon(kind === 'window' ? 'window' : 'screen')}<span class="ltxt"></span></span></div>
    <div class="chip stats"></div>
    <div class="chip ctrls">
      ${mine ? '' : `<div class="vol"><button class="btn icon mute" title="Mudo">${icon('vol')}</button><input type="range" min="0" max="1" step="0.01" value="1" title="Volume"></div>`}
      <button class="btn icon fbtn" title="Destacar">${icon('expand')}</button>
      <button class="btn icon fsbtn" title="Tela cheia">${icon('full')}</button>
      ${mine ? `<button class="btn stop" title="Parar">${icon('stop')}Parar</button>` : ''}
    </div>`;
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
    vol.oninput = () => { video.volume = parseFloat(vol.value); video.muted = false; if (video.volume > 0) lastVol = video.volume; paint(); };
    muteBtn.onclick = () => {
      if (video.muted || video.volume === 0) { video.muted = false; video.volume = lastVol || 1; vol.value = video.volume; }
      else { video.muted = true; vol.value = 0; }
      paint();
    };
    paint();
  }
  t.querySelector('.fbtn').onclick = () => { state.focusId = state.focusId === id ? null : id; layout(); };
  t.querySelector('.fsbtn').onclick = () => toggleFullscreen(t);
  t.ondblclick = (e) => { if (!e.target.closest('.ctrls')) toggleFullscreen(t); };
  const stop = t.querySelector('.stop');
  if (stop) stop.onclick = () => stopShare(id);
  smooth(() => { $('#grid').appendChild(t); layout(true); video.play().catch(() => {}); });
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
        t.querySelector('video').play().catch(() => {}); // mover o elemento pausa o vídeo
      }
      const fb = t.querySelector('.fbtn');
      fb.innerHTML = icon(isF ? 'shrink' : 'expand');
      fb.title = isF ? 'Voltar' : 'Destacar';
    }
    grid.className = 'grid n' + Math.min(grid.children.length, 9);
    stage.classList.toggle('has-focus', !!state.focusId);
    focus.classList.toggle('hidden', !state.focusId);
    $('#empty').classList.toggle('hidden', tiles.length > 0);
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
      el.innerHTML = `${orbHTML(n)}<span class="nm"></span><span class="st"></span><span class="live">AO VIVO</span>`;
      el.querySelector('.nm').innerHTML = esc(n) + (n === state.myName ? ' <span class="you">· você</span>' : '');
    }
    if (box.children[idx] !== el) box.insertBefore(el, box.children[idx] || null);
    const me = n === state.myName;
    let st = '', title = 'Conectado';
    if (!me) {
      const cs = state.peers.get(n)?.pc?.connectionState;
      if (cs === 'connecting') { st = 'wait'; title = 'Conectando…'; }
      if (cs === 'failed' || cs === 'disconnected') { st = 'bad'; title = 'Sem conexão direta — verifique o Tailscale'; }
    }
    el.querySelector('.st').className = 'st ' + st;
    el.title = title;
    const live = me ? state.shares.size > 0 : (state.remoteMeta.get(n)?.size || 0) > 0;
    el.classList.toggle('is-live', live);
  });
}

// Esconde barra e dock quando o mouse fica parado (só com alguém ao vivo)
let idleT;
function poke() {
  document.body.classList.remove('idle');
  clearTimeout(idleT);
  idleT = setTimeout(() => {
    const busy = !$('#shareModal').classList.contains('hidden') || $('#room').classList.contains('hidden') || !$$('.tile').length;
    if (!busy && !document.querySelector('.topbar:hover, .dock:hover')) document.body.classList.add('idle');
  }, 2800);
}
['mousemove', 'mousedown', 'keydown', 'wheel'].forEach((ev) => window.addEventListener(ev, poke, { passive: true }));

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

function leave() {
  state.leaving = true;
  for (const id of [...state.shares.keys()]) stopShare(id);
  for (const n of [...state.peers.keys()]) closePeer(n);
  state.online = [];
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  smooth(() => {
    $('#room').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#people').innerHTML = '';
    Halftone.setActive(true);
    renderLogin();
  });
}

$('#roomChip').onclick = () => {
  navigator.clipboard.writeText(state.cfg.room);
  toast('Código copiado');
};
setInterval(() => send({ type: 'ping' }), 25000);
$('#shareBtn').onclick = openShareModal;
$('#closeModal').onclick = closeShareModal;
$('#cancelShare').onclick = closeShareModal;
$('#goShare').onclick = goShare;
$('#leaveBtn').onclick = leave;
$('#statsBtn').onclick = () => {
  const on = document.body.classList.toggle('show-stats');
  $('#statsBtn').classList.toggle('on', on);
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
