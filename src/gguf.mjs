// Lecture des métadonnées d'un GGUF distant sans le télécharger : l'en-tête est au début du
// fichier, on le lit par requêtes HTTP partielles (Range). Il dit l'architecture exacte :
// couches, têtes KV, couches d'attention pleine (modèles hybrides), experts, tête MTP.

const TYPE = { U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STRING: 8, ARRAY: 9, U64: 10, I64: 11, F64: 12 };
const SIZE = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

class NeedMore extends Error {}

class Reader {
  constructor(buffer) { this.buf = buffer; this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength); this.pos = 0; }
  need(n) { if (this.pos + n > this.buf.length) throw new NeedMore(); }
  u32() { this.need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  u64() { this.need(8); const v = Number(this.view.getBigUint64(this.pos, true)); this.pos += 8; return v; }
  string() { const n = this.u64(); this.need(n); const s = this.buf.subarray(this.pos, this.pos + n).toString('utf8'); this.pos += n; return s; }
  scalar(type) {
    this.need(SIZE[type]);
    const v = this.view;
    const p = this.pos;
    this.pos += SIZE[type];
    switch (type) {
      case TYPE.U8: return v.getUint8(p);
      case TYPE.I8: return v.getInt8(p);
      case TYPE.U16: return v.getUint16(p, true);
      case TYPE.I16: return v.getInt16(p, true);
      case TYPE.U32: return v.getUint32(p, true);
      case TYPE.I32: return v.getInt32(p, true);
      case TYPE.F32: return v.getFloat32(p, true);
      case TYPE.BOOL: return v.getUint8(p) !== 0;
      case TYPE.U64: return Number(v.getBigUint64(p, true));
      case TYPE.I64: return Number(v.getBigInt64(p, true));
      case TYPE.F64: return v.getFloat64(p, true);
      default: throw new Error(`type GGUF inconnu ${type}`);
    }
  }
  value(type) {
    if (type === TYPE.STRING) return this.string();
    if (type !== TYPE.ARRAY) return this.scalar(type);
    const inner = this.u32();
    const count = this.u64();
    // Les grands tableaux (vocabulaire) ne servent pas : on les saute sans les garder.
    if (count > 4096) {
      if (inner === TYPE.STRING) for (let i = 0; i < count; i += 1) { const n = this.u64(); this.need(n); this.pos += n; }
      else { this.need(SIZE[inner] * count); this.pos += SIZE[inner] * count; }
      return { skipped: count };
    }
    const out = [];
    for (let i = 0; i < count; i += 1) out.push(this.value(inner));
    return out;
  }
}

function parse(buffer) {
  const r = new Reader(buffer);
  r.need(4);
  if (buffer.subarray(0, 4).toString('latin1') !== 'GGUF') throw new Error('Ce fichier n’est pas un GGUF');
  r.pos = 4;
  const version = r.u32();
  const tensors = r.u64();
  const count = r.u64();
  const meta = {};
  for (let i = 0; i < count; i += 1) {
    const key = r.string();
    const type = r.u32();
    meta[key] = r.value(type);
  }
  return { version, tensors, meta };
}

export async function readGgufMetadata(url, headers = {}) {
  let size = 4 * 1024 * 1024;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(url, { headers: { 'User-Agent': 'harn', ...headers, Range: `bytes=0-${size - 1}` }, redirect: 'follow' });
    if (!response.ok && response.status !== 206) throw new Error(`Lecture de l’en-tête refusée (${response.status})`);
    const buffer = Buffer.from(await response.arrayBuffer());
    try {
      return parse(buffer);
    } catch (error) {
      if (!(error instanceof NeedMore) || buffer.length < size) throw error;
      size *= 2;
    }
  }
  throw new Error('En-tête GGUF trop grand');
}

// Ce qui compte pour l'inférence, tiré des métadonnées.
export function profileFromMetadata({ meta }) {
  const arch = meta['general.architecture'];
  const get = (key) => meta[`${arch}.${key}`];
  const layers = get('block_count') ?? 0;
  const keyLength = get('attention.key_length') ?? (get('embedding_length') && get('attention.head_count') ? get('embedding_length') / [].concat(get('attention.head_count'))[0] : 128);
  const valueLength = get('attention.value_length') ?? keyLength;
  const kvHeads = get('attention.head_count_kv');
  // Couches qui portent un cache KV : toutes, sauf dans les hybrides (attention linéaire
  // entre deux couches d'attention pleine) et quand les têtes KV sont données couche par couche.
  let kvSum;
  if (Array.isArray(kvHeads)) kvSum = kvHeads.reduce((sum, n) => sum + (n || 0), 0);
  else {
    const interval = get('full_attention_interval');
    const attnLayers = interval ? Math.ceil(layers / interval) : layers;
    kvSum = attnLayers * (kvHeads ?? 8);
  }
  const f16PerToken = kvSum * (keyLength + valueLength) * 2;
  const experts = get('expert_count') ?? 0;
  const used = get('expert_used_count') ?? 0;
  return {
    arch,
    name: meta['general.name'] ?? null,
    sizeLabel: meta['general.size_label'] ?? null,
    layers,
    contextLength: get('context_length') ?? null,
    experts,
    expertsUsed: used,
    mtp: (get('nextn_predict_layers') ?? 0) > 0,
    // q8_0 = 34 octets pour 32 valeurs, q4_0 = 18 : rapports à f16 (64 octets).
    kvBytesPerToken: { f16: Math.round(f16PerToken), q8_0: Math.round(f16PerToken * 34 / 64), q4_0: Math.round(f16PerToken * 18 / 64) },
  };
}
