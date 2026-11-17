// TriMeet - microfone: modos de voz (estilo Discord) e dispositivos de áudio
//   natural          → som quase puro do microfone (só cancelamento de eco)
//   isolamento       → filtros do Chromium (supressão de ruído + ganho automático)
//   isolamento-forte → RNNoise (rede neural) rodando num AudioWorklet
'use strict';
(() => {
  const RNN_DIR = 'vendor/rnnoise/';
  const RNN_ID = '@sapphi-red/web-noise-suppressor/rnnoise';

  const modes = {
    natural: { label: 'Natural', constraints: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } },
    isolamento: { label: 'Isolamento', constraints: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } },
    'isolamento-forte': { label: 'Isolamento forte', constraints: { echoCancellation: true, noiseSuppression: false, autoGainControl: true }, rnnoise: true },
  };

  let ctx = null;
  let workletReady = null;
  let wasmBinary = null;

  function getCtx() {
    if (!ctx || ctx.state === 'closed') { ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }); workletReady = null; }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // carrega arquivo local (file://) — XHR funciona onde o fetch de file:// não funciona
  function loadBinary(url) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('GET', url);
      x.responseType = 'arraybuffer';
      x.onload = () => (x.status === 0 || (x.status >= 200 && x.status < 300)) && x.response ? resolve(x.response) : reject(new Error('falha ao carregar ' + url));
      x.onerror = () => reject(new Error('falha ao carregar ' + url));
      x.send();
    });
  }

  function simdSupported() {
    try {
      return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
    } catch { return false; }
  }

  async function ensureRnnoise(c) {
    if (!wasmBinary) {
      const bin = await loadBinary(RNN_DIR + (simdSupported() ? 'rnnoise_simd.wasm' : 'rnnoise.wasm'));
      // confere aqui se o WASM pode rodar (CSP); se não puder, cai no isolamento do Chromium
      await WebAssembly.compile(bin);
      wasmBinary = bin;
    }
    if (!workletReady) workletReady = c.audioWorklet.addModule(RNN_DIR + 'rnnoise-worklet.js');
    await workletReady;
  }

  function release(stream) {
    if (stream && typeof stream._tmRelease === 'function') stream._tmRelease();
    else if (stream) stream.getTracks().forEach((t) => t.stop());
  }

  async function getMicStream({ mode = 'natural', deviceId } = {}) {
    const m = modes[mode] || modes.natural;
    const audio = { ...m.constraints, channelCount: 1, sampleRate: 48000 };
    if (deviceId && deviceId !== 'default') audio.deviceId = { exact: deviceId };
    let raw;
    try {
      raw = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (e) {
      // aparelho escolhido sumiu? tenta o padrão
      if (audio.deviceId) { delete audio.deviceId; raw = await navigator.mediaDevices.getUserMedia({ audio, video: false }); }
      else throw e;
    }
    raw.getAudioTracks().forEach((t) => { t.contentHint = 'speech'; });

    if (!m.rnnoise) {
      raw._tmRelease = () => raw.getTracks().forEach((t) => t.stop());
      raw._tmMode = mode;
      return raw;
    }

    // isolamento forte: mic → passa-alta 80 Hz → RNNoise → saída
    try {
      const c = getCtx();
      await ensureRnnoise(c);
      const src = c.createMediaStreamSource(raw);
      const hp = c.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 80;
      const rnn = new AudioWorkletNode(c, RNN_ID, { processorOptions: { maxChannels: 1, wasmBinary: wasmBinary.slice(0) }, channelCount: 1, channelCountMode: 'explicit' });
      const dest = c.createMediaStreamDestination();
      dest.channelCount = 1;
      src.connect(hp).connect(rnn).connect(dest);
      const out = dest.stream;
      out.getAudioTracks().forEach((t) => { t.contentHint = 'speech'; });
      out._tmRaw = raw;
      out._tmMode = mode;
      out._tmRelease = () => {
        try { rnn.port.postMessage('destroy'); } catch {}
        try { src.disconnect(); hp.disconnect(); rnn.disconnect(); } catch {}
        raw.getTracks().forEach((t) => t.stop());
        out.getTracks().forEach((t) => t.stop());
      };
      return out;
    } catch (e) {
      console.warn('RNNoise indisponível, usando isolamento do Chromium', e);
      raw.getTracks().forEach((t) => t.stop());
      const fb = await getMicStream({ mode: 'isolamento', deviceId });
      fb._tmMode = 'isolamento';
      fb._tmFallback = true;
      return fb;
    }
  }

  async function listDevices() {
    let list = [];
    try { list = await navigator.mediaDevices.enumerateDevices(); } catch {}
    const nice = (d, i, kind) => ({
      deviceId: d.deviceId,
      label: d.deviceId === 'default' ? 'Padrão do Windows' + (d.label ? ` · ${d.label.replace(/^Default - |^Padrão - /, '')}` : '')
        : d.deviceId === 'communications' ? 'Comunicações do Windows' + (d.label ? ` · ${d.label.replace(/^Communications - |^Comunicações - /, '')}` : '')
        : d.label || `${kind} ${i + 1}`,
    });
    const inputs = list.filter((d) => d.kind === 'audioinput').map((d, i) => nice(d, i, 'Microfone'));
    const outputs = list.filter((d) => d.kind === 'audiooutput').map((d, i) => nice(d, i, 'Saída'));
    if (!inputs.length) inputs.push({ deviceId: 'default', label: 'Padrão do Windows' });
    if (!outputs.length) outputs.push({ deviceId: 'default', label: 'Padrão do Windows' });
    return { inputs, outputs };
  }

  async function setOutputDevice(audioEl, deviceId) {
    if (!audioEl || typeof audioEl.setSinkId !== 'function') return false;
    try { await audioEl.setSinkId(deviceId && deviceId !== 'default' ? deviceId : ''); return true; } catch { return false; }
  }

  // medidor de nível 0..1 (para o teste de microfone)
  function meter(stream, onLevel) {
    const c = getCtx();
    const src = c.createMediaStreamSource(stream);
    const an = c.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const data = new Float32Array(an.fftSize);
    let raf = 0, smooth = 0;
    const tick = () => {
      an.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      const lvl = Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-8) + 60) / 60)); // -60 dB..0 dB
      smooth = lvl > smooth ? lvl : smooth * 0.85 + lvl * 0.15;
      onLevel(smooth, rms);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return { stop() { cancelAnimationFrame(raf); try { src.disconnect(); } catch {} } };
  }

  window.TMAudio = { modes, getMicStream, release, listDevices, setOutputDevice, meter };
})();
