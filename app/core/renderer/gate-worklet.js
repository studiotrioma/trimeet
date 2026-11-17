// TriMeet - portão de voz (estilo "sensibilidade de entrada automática" do Discord)
// Só deixa passar o microfone quando há voz de verdade: corta teclado, respiração e ruídos entre as falas.
//  - automático: acompanha o ruído de fundo e abre ~16 dB acima dele
//  - manual: limiar fixo em dB escolhido pela pessoa
//  - olha 10 ms "à frente" (atraso curto) para não cortar o começo das palavras
//  - estalos curtos (tecla) não abrem: precisa de energia por alguns blocos seguidos
class TMGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.auto = true;
    this.thrDb = -50;
    this.enabled = true;
    this.DELAY = 512;
    this.buf = new Float32Array(this.DELAY);
    this.w = 0;
    this.sm = -90;       // nível suavizado (dB)
    this.floor = -70;    // ruído de fundo estimado (dB)
    this.above = 0;      // blocos seguidos acima do limiar
    this.hold = 0;       // amostras restantes com o portão aberto
    this.g = 0;          // ganho atual 0..1
    this.n = 0;
    const sr = sampleRate;
    this.HOLD = Math.round(0.32 * sr);
    this.aOpen = 1 - Math.exp(-1 / (0.003 * sr));
    this.aClose = 1 - Math.exp(-1 / (0.09 * sr));
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.auto === 'boolean') this.auto = d.auto;
      if (typeof d.thrDb === 'number') this.thrDb = d.thrDb;
      if (typeof d.enabled === 'boolean') this.enabled = d.enabled;
    };
  }
  threshold() {
    if (!this.auto) return this.thrDb;
    return Math.min(-26, Math.max(-46, this.floor + 16));
  }
  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    if (!inp) { out.fill(0); return true; }
    let s = 0;
    for (let i = 0; i < inp.length; i++) s += inp[i] * inp[i];
    const db = Math.max(-90, 10 * Math.log10(s / inp.length + 1e-12));
    this.sm = this.sm * 0.7 + db * 0.3;
    if (this.sm < this.floor) this.floor = this.floor * 0.9 + this.sm * 0.1;
    else this.floor += (this.sm - this.floor) * 0.0004;
    const thr = this.threshold();
    this.above = db > thr ? this.above + 1 : 0;
    if (!this.enabled || this.above >= 3) this.hold = this.HOLD;
    const open = this.hold > 0;
    for (let i = 0; i < inp.length; i++) {
      const x = this.buf[this.w];
      this.buf[this.w] = inp[i];
      this.w = (this.w + 1) % this.DELAY;
      const target = this.hold > 0 ? 1 : 0;
      if (this.hold > 0) this.hold--;
      this.g += (target - this.g) * (target > this.g ? this.aOpen : this.aClose);
      out[i] = x * this.g;
    }
    if (++this.n % 8 === 0) this.port.postMessage({ db: this.sm, open, thr });
    return true;
  }
}
registerProcessor('tm-gate', TMGate);
