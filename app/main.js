// TriMeet - inicialização
// Escolhe qual "núcleo" do app carregar: o que veio no instalador ou uma
// versão mais nova baixada pelo próprio app (atualização estilo Discord).
// Se a versão nova falhar ao carregar, volta sozinho para a do instalador.
const { app, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

if (process.env.TRIMEET_PROFILE) app.setPath('userData', process.env.TRIMEET_PROFILE);

const BUILTIN = path.join(__dirname, 'core');
const updDir = path.join(app.getPath('userData'), 'updates');

function verNum(v) { return String(v || '0').split('.').map((n) => parseInt(n, 10) || 0); }
function newer(a, b) {
  const x = verNum(a), y = verNum(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function pickCore() {
  const builtinVer = (readJSON(path.join(BUILTIN, 'version.json')) || {}).version || '0';
  const cur = readJSON(path.join(updDir, 'current.json'));
  if (cur && cur.version && newer(cur.version, builtinVer)) {
    const dir = path.join(updDir, String(cur.version));
    if (fs.existsSync(path.join(dir, 'main.js'))) return dir;
  }
  return BUILTIN;
}

const core = pickCore();
try {
  require(path.join(core, 'main.js'));
} catch (e) {
  if (core !== BUILTIN) {
    // versão baixada com problema: desativa e usa a do instalador
    try { fs.unlinkSync(path.join(updDir, 'current.json')); } catch {}
    require(path.join(BUILTIN, 'main.js'));
  } else {
    app.whenReady().then(() => { dialog.showErrorBox('TriMeet', String(e && e.stack || e)); app.quit(); });
  }
}
