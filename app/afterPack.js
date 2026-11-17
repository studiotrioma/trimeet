// tira DLLs do WebGPU (o TriMeet não usa) para o instalador caber no limite de 100 MB do GitHub
const fs = require('fs'); const path = require('path');
exports.default = async (ctx) => {
  for (const f of ['dxcompiler.dll', 'dxil.dll']) {
    const p = path.join(ctx.appOutDir, f);
    if (fs.existsSync(p)) { fs.unlinkSync(p); console.log('  removido', f); }
  }
};
