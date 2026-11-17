// TriMeet - processo principal (Electron)
const { app, BrowserWindow, ipcMain, desktopCapturer, session, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { net } = require('electron');

// versão deste "núcleo" (código do app); o instalador só traz o motor (Electron)
const CORE_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).version;

// Melhor qualidade/latência de captura e codificação por hardware
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

let win;
let pendingSourceId = null;
let pendingAudio = true;

const cfgPath = () => path.join(app.getPath('userData'), 'config.json');

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: 'TriMeet',
    icon: path.join(app.getAppPath(), 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  if (process.env.TRIMEET_AUTOTEST) {
    win.webContents.on('console-message', (_e, level, message) => console.log(`[${process.env.TRIMEET_AUTOTEST}] ${message}`));
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  // Quando o app chama getDisplayMedia, entregamos a tela escolhida + áudio do PC (loopback)
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const src = sources.find((s) => s.id === pendingSourceId) || sources[0];
      const res = { video: src };
      if (pendingAudio && process.platform === 'win32') res.audio = 'loopback';
      callback(res);
    } catch (e) {
      callback({});
    }
  });

  ipcMain.handle('get-sources', async () => {
    const displays = screen.getAllDisplays();
    const primaryId = screen.getPrimaryDisplay().id;
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 400, height: 225 },
      fetchWindowIcons: false,
    });
    return sources
      .filter((s) => s.name && !s.name.startsWith('TriMeet'))
      .map((s) => {
        let label = s.name;
        let info = '';
        if (s.id.startsWith('screen:')) {
          const idx = displays.findIndex((d) => String(d.id) === s.display_id);
          const d = displays[idx];
          const n = idx >= 0 ? idx + 1 : null;
          label = n ? `Monitor ${n}` : s.name;
          if (d) {
            const w = Math.round(d.size.width * d.scaleFactor);
            const h = Math.round(d.size.height * d.scaleFactor);
            info = `${w}×${h}${d.displayFrequency ? ' • ' + Math.round(d.displayFrequency) + ' Hz' : ''}${d.id === primaryId ? ' • principal' : ''}`;
          }
        }
        return {
          id: s.id,
          type: s.id.startsWith('screen:') ? 'screen' : 'window',
          label,
          info,
          thumb: s.thumbnail.toDataURL(),
        };
      })
      .sort((a, b) => (a.type === b.type ? a.label.localeCompare(b.label, 'pt', { numeric: true }) : a.type === 'screen' ? -1 : 1));
  });

  ipcMain.handle('select-source', (_e, id, withAudio) => {
    pendingSourceId = id;
    pendingAudio = !!withAudio;
    return true;
  });


  ipcMain.handle('load-config', () => {
    try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch { return null; }
  });
  ipcMain.handle('save-config', (_e, cfg) => {
    try { fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2)); } catch {}
    return true;
  });
  ipcMain.handle('local-ips', () => {
    const os = require('os');
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, tailscale: a.address.startsWith('100.') });
      }
    }
    return out.sort((a, b) => b.tailscale - a.tailscale);
  });

  createWindow();
  setupUpdater();
});

// ===================================================================
// Atualização dentro do app (estilo Discord)
// O app baixa só o "núcleo" novo (poucos KB), guarda em userData/updates
// e, ao clicar em Atualizar, reinicia já na versão nova.
// ===================================================================
const UPD_DIR = () => path.join(app.getPath('userData'), 'updates');
let updateState = { state: 'idle', current: CORE_VERSION };
let downloading = false;

function verNum(v) { return String(v || '0').split('.').map((n) => parseInt(n, 10) || 0); }
function newer(a, b) {
  const x = verNum(a), y = verNum(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}
function pushUpdate(patch) {
  updateState = { ...updateState, ...patch, current: CORE_VERSION };
  if (win && !win.isDestroyed()) win.webContents.send('update-status', updateState);
}
function serverBase() {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
    if (cfg.server) return cfg.server.replace(/\/+$/, '');
  } catch {}
  const src = fs.readFileSync(path.join(__dirname, 'renderer', 'config.js'), 'utf8');
  const m = src.match(/server:\s*'([^']+)'/);
  return m ? m[1].replace(/\/+$/, '') : '';
}

async function checkForUpdates() {
  if (downloading) return;
  const base = serverBase();
  if (!base) return pushUpdate({ state: 'none' });
  try {
    // já baixada e esperando o clique?
    const pend = readPending();
    pushUpdate({ state: 'checking' });
    const r = await net.fetch(`${base}/update/latest.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return pushUpdate(pend ? { state: 'ready', version: pend.version, notes: pend.notes } : { state: 'none' });
    const info = await r.json();
    if (!info.version || !newer(info.version, CORE_VERSION)) return pushUpdate({ state: 'none' });
    if (pend && pend.version === info.version) return pushUpdate({ state: 'ready', version: info.version, notes: info.notes || '' });
    downloading = true;
    pushUpdate({ state: 'downloading', version: info.version, notes: info.notes || '', percent: 0 });
    const res = await net.fetch(new URL(info.bundle, base + '/').toString(), { cache: 'no-store' });
    if (!res.ok) throw new Error('download ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (info.sha256 && hash !== info.sha256) throw new Error('arquivo corrompido');
    const pack = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
    const dest = path.join(UPD_DIR(), String(info.version));
    fs.rmSync(dest, { recursive: true, force: true });
    for (const [rel, b64] of Object.entries(pack.files || {})) {
      const safe = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
      const out = path.join(dest, safe);
      if (!out.startsWith(dest)) continue;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    }
    if (!fs.existsSync(path.join(dest, 'main.js'))) throw new Error('pacote incompleto');
    fs.writeFileSync(path.join(UPD_DIR(), 'pending.json'), JSON.stringify({ version: info.version, notes: info.notes || '' }));
    downloading = false;
    pushUpdate({ state: 'ready', version: info.version, notes: info.notes || '' });
  } catch (e) {
    downloading = false;
    pushUpdate({ state: 'error', error: String(e && e.message || e) });
  }
}
function readPending() {
  try { return JSON.parse(fs.readFileSync(path.join(UPD_DIR(), 'pending.json'), 'utf8')); } catch { return null; }
}
function setupUpdater() {
  ipcMain.handle('update-get', () => ({ ...updateState, supported: true }));
  ipcMain.handle('update-check', () => checkForUpdates());
  ipcMain.handle('update-install', () => {
    const pend = readPending();
    if (pend) {
      fs.writeFileSync(path.join(UPD_DIR(), 'current.json'), JSON.stringify({ version: pend.version }));
      try { fs.unlinkSync(path.join(UPD_DIR(), 'pending.json')); } catch {}
    }
    app.relaunch();
    app.exit(0);
  });
  setTimeout(checkForUpdates, 4000);
  setInterval(checkForUpdates, 30 * 60 * 1000);
}

app.on('window-all-closed', () => app.quit());
