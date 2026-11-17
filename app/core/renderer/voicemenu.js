// TriMeet - menus de voz estilo Discord
//  botão direito no microfone → dispositivo de entrada, perfil de voz e sensibilidade (com medidor ao vivo)
//  botão direito no fone      → dispositivo de saída e volume geral
// Usa o menu do app (openMenu/closeMenu) e a configuração state.cfg.audio (via audioCfg()).
'use strict';

function vmAnchorEvent(btn) {
  const r = btn.getBoundingClientRect();
  return { clientX: r.left, clientY: r.top - 8 };
}

// item com marcação que não fecha o menu (para escolher e continuar ajustando)
function vmRadio(m, group, label, hint, on, onPick) {
  const b = document.createElement('button');
  b.className = 'cm-item vm-radio' + (on ? ' on' : '');
  b.dataset.group = group;
  b.innerHTML = `<i class="vm-dot"></i><span class="vm-l"><span></span>${hint ? '<small></small>' : ''}</span>`;
  b.querySelector('.vm-l span').textContent = label;
  if (hint) b.querySelector('.vm-l small').textContent = hint;
  b.onclick = () => {
    m.querySelectorAll(`.vm-radio[data-group="${group}"]`).forEach((x) => x.classList.toggle('on', x === b));
    onPick();
  };
  m.appendChild(b);
  return b;
}

function vmLabel(m, text) {
  const d = document.createElement('div');
  d.className = 'cm-label';
  d.textContent = text;
  m.appendChild(d);
  return d;
}

async function vmFillDevices(box, kind, cur, onPick) {
  const { inputs, outputs } = await TMAudio.listDevices();
  const list = (kind === 'in' ? inputs : outputs).filter((d) => d.deviceId !== 'communications').slice(0, 6);
  box.innerHTML = '';
  const sel = list.some((d) => d.deviceId === cur) ? cur : 'default';
  for (const d of list) vmRadio(box, 'dev-' + kind, d.label, '', d.deviceId === sel || (!list.some((x) => x.deviceId === sel) && d === list[0]), () => onPick(d.deviceId));
}

function openMicMenu(e) {
  const btn = document.querySelector('#micBtn');
  const a = audioCfg();
  let stopLevel = null, testStream = null;
  openMenu(e || vmAnchorEvent(btn), (m) => {
    m.classList.add('vm-menu');
    m._onClose = () => { stopLevel && stopLevel(); if (testStream) TMAudio.release(testStream); };

    vmLabel(m, 'Dispositivo de entrada');
    const devBox = document.createElement('div');
    devBox.className = 'vm-list';
    m.appendChild(devBox);
    vmFillDevices(devBox, 'in', a.inputId || 'default', (id) => {
      a.inputId = id; saveAudio();
      window.dispatchEvent(new CustomEvent('tm-audio-change', { detail: { inputId: id } }));
      setTimeout(hookLevel, 400);
    });

    menuSep(m);
    vmLabel(m, 'Perfil de voz');
    for (const [id, mode] of Object.entries(TMAudio.modes)) {
      vmRadio(m, 'mode', mode.label, mode.hint, a.mode === id, () => {
        a.mode = id; saveAudio();
        window.dispatchEvent(new CustomEvent('tm-audio-change', { detail: { mode: id } }));
        setTimeout(hookLevel, 400);
      });
    }

    menuSep(m);
    const sens = document.createElement('div');
    sens.className = 'vm-sens' + (a.autoSens ? ' auto' : '');
    sens.innerHTML = `
      <div class="vm-sens-top"><span>Sensibilidade</span>
        <button class="vm-auto"><span>Automática</span><i class="cm-check ${a.autoSens ? 'on' : ''}"></i></button></div>
      <div class="vm-meter"><div class="vm-lvl"></div><div class="vm-thr"></div>
        <input type="range" min="-80" max="0" step="1" aria-label="Sensibilidade"></div>
      <small class="vm-hint"></small>`;
    m.appendChild(sens);
    const range = sens.querySelector('input');
    const lvl = sens.querySelector('.vm-lvl'), thrEl = sens.querySelector('.vm-thr'), hint = sens.querySelector('.vm-hint');
    const pos = (db) => Math.min(100, Math.max(0, ((db + 80) / 80) * 100));
    let lastThr = a.sensDb;
    const paintThr = (db) => { thrEl.style.left = pos(db) + '%'; };
    range.value = a.sensDb;
    paintThr(a.autoSens ? -50 : a.sensDb);
    hint.textContent = a.autoSens ? 'O TriMeet ajusta sozinho e corta teclado e respiração.' : 'Só passa o que estiver à direita da linha.';
    sens.querySelector('.vm-auto').onclick = () => {
      a.autoSens = !a.autoSens; saveAudio();
      sens.classList.toggle('auto', a.autoSens);
      sens.querySelector('.cm-check').classList.toggle('on', a.autoSens);
      if (!a.autoSens) { a.sensDb = Math.round(lastThr); range.value = a.sensDb; paintThr(a.sensDb); saveAudio(); }
      hint.textContent = a.autoSens ? 'O TriMeet ajusta sozinho e corta teclado e respiração.' : 'Só passa o que estiver à direita da linha.';
      applyGate();
    };
    range.oninput = () => { a.sensDb = +range.value; paintThr(a.sensDb); applyGate(); };
    range.onchange = () => saveAudio();

    function applyGate() {
      const s = state.voice?.stream || testStream;
      s?._tmGate?.set({ auto: a.autoSens, thrDb: a.sensDb });
    }
    // medidor ao vivo: usa o microfone da chamada; fora da sala abre um de teste enquanto o menu estiver aberto
    async function hookLevel() {
      stopLevel && stopLevel(); stopLevel = null;
      let s = state.voice?.stream;
      if (!s) {
        if (testStream) { TMAudio.release(testStream); testStream = null; }
        try { testStream = await getMic(); } catch { hint.textContent = 'Microfone bloqueado no Windows'; return; }
        if (!m.isConnected) { TMAudio.release(testStream); testStream = null; return; }
        s = testStream;
      }
      if (!s._tmGate) return;
      stopLevel = s._tmGate.onLevel((d) => {
        lvl.style.width = pos(d.db) + '%';
        lvl.classList.toggle('open', !!d.open);
        lastThr = d.thr;
        if (a.autoSens) paintThr(d.thr);
      });
    }
    hookLevel();
  });
}

function openDeafMenu(e) {
  const btn = document.querySelector('#deafBtn');
  const a = audioCfg();
  openMenu(e || vmAnchorEvent(btn), (m) => {
    m.classList.add('vm-menu');
    vmLabel(m, 'Dispositivo de saída');
    const devBox = document.createElement('div');
    devBox.className = 'vm-list';
    m.appendChild(devBox);
    vmFillDevices(devBox, 'out', a.outputId || 'default', (id) => {
      a.outputId = id; saveAudio();
      window.dispatchEvent(new CustomEvent('tm-audio-change', { detail: { outputId: id, restart: false } }));
      for (const rv of state.voices.values()) TMAudio.setOutputDevice(rv.audio, id);
      if (window.TMSound?.setOutput) TMSound.setOutput(id);
    });
    menuSep(m);
    menuSlider(m, 'headset', 'Volume de saída', a.outVol, (v) => {
      a.outVol = v;
      for (const rv of state.voices.values()) rv.audio.volume = voiceVolume(rv.from);
      clearTimeout(openDeafMenu._t); openDeafMenu._t = setTimeout(saveAudio, 300);
    });
  });
}

document.querySelector('#micBtn').oncontextmenu = (e) => { e.preventDefault(); openMicMenu(e); };
document.querySelector('#deafBtn').oncontextmenu = (e) => { e.preventDefault(); openDeafMenu(e); };
