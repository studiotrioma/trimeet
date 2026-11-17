// TriMeet no navegador: faz o papel do "preload" do app.
// A interface é exatamente a mesma do app (arquivos de app/core/renderer servidos pelo servidor),
// então site e app ficam sempre na mesma versão e nas mesmas salas.
'use strict';
(() => {
  const LS_CFG = 'trimeet.cfg', LS_KEY = 'trimeet.key';
  const PERM_KEYS = ['identity', 'ownerSeed', 'perms'];
  const readCfg = () => { try { return JSON.parse(localStorage.getItem(LS_CFG)) || {}; } catch { return {}; } };

  // ---- sons da mesa de efeitos: IndexedDB (podem ser grandes demais para o localStorage) ----
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('trimeet', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function kvGet(k) {
    const db = await idb();
    return new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); });
  }
  async function kvSet(k, v) {
    const db = await idb();
    return new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(true); t.onerror = () => res(false); });
  }

  // ---- versão: o site sempre carrega a última; avisa se sair outra com a página aberta ----
  let loadedVersion = null, updCb = null, latest = null;
  async function fetchVersion() {
    try { return (await (await fetch('/version.json', { cache: 'no-store' })).json()).version; } catch { return null; }
  }
  async function checkVersion() {
    const v = await fetchVersion();
    if (!loadedVersion) loadedVersion = v;
    latest = v && loadedVersion && v !== loadedVersion ? { state: 'ready', version: v, current: loadedVersion, notes: 'Versão nova: recarregar a página' } : { state: 'none', current: loadedVersion };
    if (updCb) updCb(latest);
    return latest;
  }
  setInterval(checkVersion, 10 * 60 * 1000);

  const isWin = /Win/i.test(navigator.platform || navigator.userAgent);

  window.trimeet = {
    web: true,
    engine: 'web',
    platform: isWin ? 'win32' : 'web',
    autotest: null,
    // configuração (mesma regra do app: a tela principal não sobrescreve identidade/código de dono/cargos)
    loadConfig: async () => readCfg(),
    saveConfig: async (cfg) => {
      if (!cfg || typeof cfg !== 'object') return false;
      const out = { ...cfg };
      if (out._perms) delete out._perms;
      else {
        const disk = readCfg();
        for (const k of PERM_KEYS) { if (k in disk) out[k] = disk[k]; else delete out[k]; }
      }
      if (out.server && typeof out.server !== 'string') delete out.server;
      try { localStorage.setItem(LS_CFG, JSON.stringify(out)); } catch {}
      return true;
    },
    soundsLoad: async () => (await kvGet('sounds')) || [],
    soundsSave: async (list) => kvSet('sounds', Array.isArray(list) ? list : []),
    // compartilhar tela: no navegador quem escolhe a tela é a janela do próprio navegador
    getSources: async () => [],
    selectSource: async () => true,
    localIps: async () => [],
    // atualização = recarregar a página
    updateGet: async () => latest || checkVersion(),
    updateCheck: async () => checkVersion(),
    updateInstall: () => location.reload(),
    onUpdate: (cb) => { updCb = cb; },
    // aviso "ficou online": notificação do navegador, só com a aba em segundo plano
    notify: (n) => {
      try {
        if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
        new Notification(n.name || 'TriMeet', { body: n.text || '', silent: true, tag: 'trimeet-' + (n.name || '') });
      } catch {}
    },
    // código de convite: troca pelo acesso ao servidor e fica guardado neste navegador
    hasInvite: () => !!localStorage.getItem(LS_KEY),
    redeemInvite: async (code) => {
      const r = await fetch('/web-auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: String(code || '').trim() }) });
      if (!r.ok) return false;
      const { key } = await r.json();
      if (!key) return false;
      localStorage.setItem(LS_KEY, key);
      if (window.TRIMEET_CONFIG) window.TRIMEET_CONFIG.key = key;
      return true;
    },
    forgetInvite: () => { localStorage.removeItem(LS_KEY); if (window.TRIMEET_CONFIG) window.TRIMEET_CONFIG.key = ''; },
  };

  document.documentElement.classList.add('is-web');
  checkVersion();
})();
