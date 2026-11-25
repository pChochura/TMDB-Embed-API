const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('node:crypto');

const HEADER_LEN = 8;
const KM_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const IZ_LEN = 64;
const IZ_FROM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
const KEY_B64 = /[A-Za-z0-9+/]{43}=/g;
const SALT_B64 = /[A-Za-z0-9+/]{6,16}={1,2}|[A-Za-z0-9+/]{8}(?![A-Za-z0-9+/=])/g;
const LAWSUIT = /lawsuit_[a-f0-9]+_(0x[0-9a-f]+)/g;

let catalogDecryptMaterial = null;
let sealMaterial = null;

function setCatalogDecryptMaterial(next) {
  catalogDecryptMaterial = next;
}

function setSealMaterial(next) {
  sealMaterial = next;
}

function getCatalogDecryptMaterial() {
  return catalogDecryptMaterial;
}

function getSealMaterial() {
  return sealMaterial;
}

function extractXorTableConsts(chunk) {
  const m = chunk.match(
    /Uint8Array\(256\)[\s\S]{0,160}?o\+(0x[0-9a-f]{8})>>>0[\s\S]{0,100}?(0x[0-9a-f]{8})[\s\S]{0,100}?(0x[0-9a-f]{8})/,
  );
  if (!m) throw new Error('missing xor table constants');
  return { add: Number(m[1]), mul16: Number(m[2]), mul13: Number(m[3]) };
}

function extractHexSeed(chunk, which) {
  const m =
    which === 'ah'
      ? chunk.match(/]=(0x[0-9a-f]{8}),globalThis\.[^;]+;var ar=/)
      : chunk.match(/]=(0x[0-9a-f]{8}),globalThis\.[^;]+;var ax=/);
  if (!m) throw new Error('missing ' + which + ' xor seed');
  return Number(m[1]);
}

function makeAq(seed, c) {
  const e = new Uint8Array(256);
  let o = seed >>> 0;
  for (let i = 0; i < 256; i++) {
    let n = (o = (o + c.add) >>> 0);
    n = Math.imul(n ^ (n >>> 16), c.mul16) >>> 0;
    n = ((n = Math.imul(n ^ (n >>> 13), c.mul13) >>> 0) ^ (n >>> 16)) >>> 0;
    e[i] = 255 & n;
  }
  return e;
}

function u64le(n) {
  const b = Buffer.allocUnsafe(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

function decodeAzStream(aZ, seed, xor) {
  const aq = makeAq(seed, xor);
  const plain = Buffer.allocUnsafe(aZ.length);
  for (let i = 0; i < aZ.length; i++) plain[i] = aZ[i] ^ aq[i % 256];
  return plain;
}

function scanAzDecryptMaterial(aZ, seed, xor) {
  const text = decodeAzStream(aZ, seed, xor).toString('latin1');
  const hexes = [...text.matchAll(/[0-9a-f]{64}/g)].map((m) => m[0]);
  const fixedHex = [...new Set(hexes)][0];
  if (!fixedHex) throw new Error('aZ missing fixed hex');

  const aesAt = text.indexOf('aes-256-gcm');
  if (aesAt < 0) throw new Error('aZ missing aes-256-gcm');
  const window = text.slice(Math.max(0, aesAt - 8000), aesAt + 2000);
  const nums = [...new Set([...window.matchAll(/\d{9,12}/g)].map((m) => Number(m[0])))].filter(
    (n) => n > 1e8 && n < Number.MAX_SAFE_INTEGER,
  );
  if (nums.length < 2) throw new Error('aZ missing fixed parts');

  const parts = [nums[0], nums[1]];
  const fixed = Buffer.concat([Buffer.from(fixedHex, 'hex'), u64le(parts[0]), u64le(parts[1])]);
  return {
    fixedHex,
    parts,
    fixedHash: createHash('sha256').update(fixed).digest(),
  };
}

function makeAS(seed, c) {
  const e = new Uint8Array(256);
  let o = seed >>> 0;
  for (let i = 0; i < 256; i++) {
    let n = (o = (o + c.add) >>> 0);
    n = Math.imul(n ^ (n >>> 16), c.mul16) >>> 0;
    n = ((n = Math.imul(n ^ (n >>> 13), c.mul13) >>> 0) ^ (n >>> 16)) >>> 0;
    e[i] = 255 & n;
  }
  return e;
}

function decodeAhStream(ah, seed, xor) {
  const aS = makeAS(seed, xor);
  const plain = Buffer.allocUnsafe(ah.length);
  for (let i = 0; i < ah.length; i++) plain[i] = ah[i] ^ aS[i % 256];
  return plain;
}

function parseCQ(chunk) {
  const m = chunk.match(/cQ=JSON\.parse\('(\[[^\]]+\])'\)/);
  if (!m) throw new Error('missing cQ alphabet');
  const iz = JSON.parse(m[1]);
  if (iz.length !== IZ_LEN) throw new Error('iz alphabet length');
  return iz;
}

function scanRngConstants(plain) {
  const vals = [];
  for (let i = 0; i + 10 <= plain.length; i++) {
    if (plain[i] !== 0xcc || plain[i + 1] !== 0x4b) continue;
    const v = plain.readDoubleBE(i + 2);
    if (Number.isInteger(v) && v > 1e9 && v < 0x100000000) vals.push(v);
  }
  if (vals.length < 2) throw new Error('ah missing rng constants');
  return { fpMul: vals[0], golden: vals[1] };
}

function keys32In(text, from = 0, to = text.length) {
  const slice = text.slice(from, to);
  const out = [];
  for (const m of slice.matchAll(KEY_B64)) {
    const raw = Buffer.from(m[0], 'base64');
    if (raw.length === 32) out.push({ key: m[0], at: from + m.index });
  }
  return out;
}

function saltAfterKey(text, keyAt, key) {
  const win = text.slice(keyAt + key.length, keyAt + key.length + 80);
  for (const m of win.matchAll(SALT_B64)) {
    if (/^[0-9a-f]+$/i.test(m[0])) continue;
    const b = Buffer.from(m[0], 'base64');
    if (b.length >= 4 && b.length <= 12) return b;
  }
  return null;
}

function doublesIn(plain, from, to) {
  const nums = [];
  for (let i = from; i + 10 <= to; i++) {
    if (plain[i] === 0xcc && plain[i + 1] === 0x4b) {
      const v = plain.readDoubleBE(i + 2);
      if (Number.isInteger(v) && v >= 0 && v <= 256) nums.push(v);
    }
  }
  return nums;
}

function rotatePolarity(plain, from, to) {
  const slice = plain.subarray(from, to);
  const i10 = slice.indexOf(Buffer.from([0x2f, 0x10]));
  const i11 = slice.indexOf(Buffer.from([0x2f, 0x11]));
  return i10 >= 0 && (i11 < 0 || i10 < i11) ? 'shl' : 'shr';
}

function handlerFromBody(plain, from, to) {
  const nums = doublesIn(plain, from, to);
  if (!nums.length) return null;
  const n0 = nums[0];
  if (n0 === 59) return (x) => x ^ 59;
  if (n0 === 76) return (x) => (((x - 76) % 256) + 256) % 256;
  if (n0 === 200) return (x) => (((x - 200) % 256) + 256) % 256;
  if (n0 === 216) return (x) => (((x - 216) % 256) + 256) % 256;
  if (n0 === 218) return (x) => (((x - 218) % 256) + 256) % 256;
  if (n0 === 226) return (x) => (((x - 226) % 256) + 256) % 256;
  if (n0 === 230) return (x) => (x + 230) % 256;
  if (n0 === 1 && nums[1] === 7) return (x) => ((x << 1) | (x >> 7)) & 255;
  if (n0 === 2 && nums[1] === 6) {
    return rotatePolarity(plain, from, to) === 'shl'
      ? (x) => ((x << 2) | (x >> 6)) & 255
      : (x) => ((x >> 2) | (x << 6)) & 255;
  }
  if (n0 === 7 && nums[1] === 1) {
    return rotatePolarity(plain, from, to) === 'shl'
      ? (x) => ((x << 7) | (x >> 1)) & 255
      : (x) => ((x >> 7) | (x << 1)) & 255;
  }
  return null;
}

function idDefAt(text) {
  const map = new Map();
  const counts = new Map();
  for (const m of text.matchAll(LAWSUIT)) {
    if (!map.has(m[1])) map.set(m[1], m.index);
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return { defs: map, counts };
}

function handlerFn(plain, id, defs) {
  const setAt = defs.get(id);
  if (setAt === undefined) return null;
  return handlerFromBody(plain, Math.max(0, setAt - 130), setAt);
}

function recoverMap(text, plain, bodyFrom, bodyTo, defs) {
  const cases = [];
  for (let i = bodyFrom; i + 12 < bodyTo; i++) {
    if (plain[i] !== 0xcc || plain[i + 1] !== 0x4b) continue;
    const v = plain.readDoubleBE(i + 2);
    if (!Number.isInteger(v) || v < 0 || v > 9) continue;
    const slice = plain.subarray(i, i + 20);
    const jt = slice.indexOf(Buffer.from([0x2f, 0x06, 0x6c]));
    if (jt < 0) continue;
    cases.push({ v, t: slice.readUInt16BE(jt + 3), at: i });
    i += 10;
  }
  if (cases.length < 10) throw new Error('ah mix map cases missing');

  const after = text.slice(cases[cases.length - 1].at, bodyTo);
  const handlers = [];
  const seen = new Set();
  for (const m of after.matchAll(LAWSUIT)) {
    if (seen.has(m[1])) continue;
    const fn = handlerFn(plain, m[1], defs);
    if (!fn) continue;
    seen.add(m[1]);
    handlers.push(fn);
  }

  const targetIdx = new Map();
  for (const c of cases) {
    if (!targetIdx.has(c.t)) targetIdx.set(c.t, targetIdx.size);
  }
  if (targetIdx.size !== handlers.length) throw new Error('ah mix map handler count');

  const map = Array(10);
  for (const c of cases) {
    const fn = handlers[targetIdx.get(c.t)];
    if (!fn) throw new Error('ah mix map slot empty');
    map[c.v] = fn;
  }
  if (map.some((f) => !f)) throw new Error('ah mix map incomplete');
  return map;
}

function mixHelpers(text, defs, counts) {
  const out = [];
  const seen = new Set();
  for (const hit of keys32In(text)) {
    const salt = saltAfterKey(text, hit.at, hit.key);
    if (!salt) continue;
    const afterStart = hit.at + hit.key.length;
    const after = text.slice(afterStart, afterStart + 1500);
    const defsHere = [];
    for (const m of after.matchAll(LAWSUIT)) {
      const at = afterStart + m.index;
      if (defs.get(m[1]) === at) defsHere.push({ id: m[1], at });
    }
    const pick = [...defsHere].reverse().find((d) => counts.get(d.id) === 2);
    if (!pick || seen.has(pick.id)) continue;
    seen.add(pick.id);
    out.push({
      id: pick.id,
      key: hit.key,
      salt,
      bodyFrom: Math.max(0, hit.at - 80),
      bodyTo: pick.at,
    });
  }
  return out;
}

function callOrderedMix(text, helpers, rc4Keys) {
  const byId = new Map(helpers.map((h) => [h.id, h]));
  const ordered = [];
  for (const rk of rc4Keys) {
    const at = text.indexOf(rk);
    if (at < 0) throw new Error('rc4 key missing');
    const win = text.slice(Math.max(0, at - 80), at);
    const id = [...win.matchAll(LAWSUIT)].map((m) => m[1]).reverse().find((i) => byId.has(i));
    if (!id) throw new Error('mix helper missing before rc4 key');
    ordered.push(byId.get(id));
  }
  return ordered;
}

function listActionFromPlain(text) {
  const se = text.indexOf('/se/');
  if (se < 0) throw new Error('ah missing /se/');
  const hit = [...text.slice(se, se + 120).matchAll(/([A-Za-z0-9_-]{10,14})/g)]
    .map((m) => m[1])
    .find((s) => !s.startsWith('lawsuit') && !/^[0-9a-f]+$/i.test(s));
  if (!hit) throw new Error('ah missing list action');
  return hit;
}

function scanAhSealMaterial(ah, ahSeed, chunk, xor) {
  const plain = decodeAhStream(ah, ahSeed, xor);
  const text = plain.toString('latin1');
  const iz = parseCQ(chunk);
  const { fpMul, golden } = scanRngConstants(plain);
  const { defs, counts } = idDefAt(text);

  const aesKeyHex = text.match(/[0-9a-f]{64}/)?.[0];
  if (!aesKeyHex) throw new Error('ah missing aes key');
  const aesAt = text.indexOf(aesKeyHex);
  const afterAes = text.slice(aesAt + 64);
  const aesIvHex = afterAes.match(/[0-9a-f]{32}/)?.[0];
  if (!aesIvHex) throw new Error('ah missing aes iv');
  const afterIv = afterAes.slice(afterAes.indexOf(aesIvHex) + 32);
  const c7Hex = afterIv.match(/[0-9a-f]{17,21}/)?.[0];
  if (!c7Hex) throw new Error('ah missing c7');

  const helpers = mixHelpers(text, defs, counts);
  if (helpers.length < 5) throw new Error('ah missing mix helpers');

  const mixKeySet = new Set(helpers.map((h) => h.key));
  const rc4Keys = keys32In(text, aesAt)
    .map((h) => h.key)
    .filter((k) => !mixKeySet.has(k))
    .filter((k, i, arr) => arr.indexOf(k) === i)
    .slice(0, 5);
  if (rc4Keys.length < 5) throw new Error('ah missing rc4 keys');

  const ordered = callOrderedMix(text, helpers, rc4Keys);
  const rounds = ordered.map((h, i) => ({
    key: Buffer.from(h.key, 'base64'),
    salt: h.salt,
    rc4Key: Buffer.from(rc4Keys[i], 'base64'),
    map: recoverMap(text, plain, h.bodyFrom, h.bodyTo, defs),
  }));

  return {
    aesKey: Buffer.from(aesKeyHex, 'hex'),
    aesIv: Buffer.from(aesIvHex, 'hex'),
    c7: Buffer.from(c7Hex, 'hex'),
    iz,
    rounds,
    fpMul,
    golden,
    listAction: listActionFromPlain(text),
  };
}

function decryptCatalogBody(body) {
  if (!catalogDecryptMaterial) throw new Error('catalog decrypt material not loaded');
  const raw = Buffer.from(body, 'base64');
  if (raw.length < KM_LEN + IV_LEN + TAG_LEN + 1) {
    throw new Error('catalog ciphertext too short');
  }

  const km = raw.subarray(0, KM_LEN);
  const iv = raw.subarray(KM_LEN, KM_LEN + IV_LEN);
  const tag = raw.subarray(raw.length - TAG_LEN);
  const ct = raw.subarray(KM_LEN + IV_LEN, raw.length - TAG_LEN);
  const key = createHash('sha256').update(catalogDecryptMaterial.fixedHash).update(km).digest();

  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  if (plain.length <= HEADER_LEN) throw new Error('catalog plaintext empty');

  return JSON.parse(plain.subarray(HEADER_LEN).toString('utf8'));
}

function rol(x, n) {
  n &= 7;
  return ((x << n) | (x >>> (8 - n))) & 255;
}

function makeRng(seed, fp, fpMul, golden) {
  const h = createHash('sha256').update(seed).digest();
  let s =
    ((h.readUInt32LE(0) ^ h.readUInt32LE(4) ^ h.readUInt32LE(8) ^ h.readUInt32LE(12)) ^
      (Math.imul(fp, fpMul) >> 0)) >>>
    0;
  if (s === 0) s = golden;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
}

function fisherYates(n, next) {
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  for (let i = n - 1; i >= 0; i--) {
    const j = next() % (i + 1);
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  return order;
}

function writeTimeLE(buf, offset, now) {
  let v = BigInt(now);
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function iZEncode(buf, iz) {
  let out = '';
  const b64 = buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  for (const c of b64) {
    const d = IZ_FROM.indexOf(c);
    if (d === -1) throw new Error('iZ encode bad alphabet');
    out += iz[d];
  }
  return out;
}

function packBody(ct, r16, fp, m) {
  const body = Buffer.from(ct);
  let ks = createHash('sha256').update(Buffer.concat([m.c7, r16])).digest();
  for (let i = 0; i < body.length; i++) {
    if (i % 32 === 0 && i !== 0) ks = createHash('sha256').update(ks).digest();
    body[i] ^= ks[i % 32];
  }

  const ks2 = createHash('sha256').update(Buffer.concat([m.aesKey, r16])).digest();
  for (let i = 0; i < body.length; i++) {
    const k = ks2[i % 32];
    body[i] = (rol(body[i], ((k & 7) + (fp & 3)) & 7) + (k ^ 165)) & 255;
  }

  const rngS = makeRng(Buffer.concat([r16, m.c7, m.aesIv]), fp, m.fpMul, m.golden);
  const sbox = new Uint8Array(256);
  for (let i = 0; i < 256; i++) sbox[i] = i;
  for (let i = 255; i >= 0; i--) {
    const j = (rngS() + (Math.imul(fp, ((i | 1) ^ 90) >> 0) >> 0)) % (i + 1);
    const t = sbox[i];
    sbox[i] = sbox[j];
    sbox[j] = t;
  }
  for (let i = 0; i < body.length; i++) body[i] = sbox[body[i]];

  const nBlocks = Math.ceil(body.length / 16);
  const order = fisherYates(nBlocks, makeRng(Buffer.concat([m.c7, r16]), fp, m.fpMul, m.golden));
  const shuffled = Buffer.alloc(nBlocks * 16);
  for (let i = 0; i < nBlocks; i++) {
    body.copy(shuffled, i * 16, order[i] * 16, order[i] * 16 + 16);
  }
  const out = Buffer.from(shuffled.subarray(0, body.length));

  const perm = fisherYates(
    out.length,
    makeRng(Buffer.concat([m.aesKey, r16, Buffer.from([out.length & 255])]), fp, m.fpMul, m.golden),
  );
  const copy = Buffer.from(out);
  for (let i = 0; i < out.length; i++) out[i] = copy[perm[i]];

  const orderBuf = Buffer.alloc(nBlocks * 4);
  for (let i = 0; i < nBlocks; i++) orderBuf.writeUInt32LE(order[i], i * 4);
  const u16 = Buffer.alloc(2);
  u16.writeUInt16LE(nBlocks);
  const mac = createHash('sha256').update(Buffer.concat([orderBuf, out])).digest().subarray(0, 8);
  return Buffer.concat([Buffer.from([1]), r16, u16, orderBuf, out, mac]);
}

function mix(data, key, salt, map) {
  const out = [];
  for (let i = 0; i < data.length; i++) {
    if (i < salt.length) out.push(salt[i]);
    out.push(map[i % 10](data[i] ^ key[i % 32]) & 255);
  }
  return Buffer.from(out);
}

function rc4(key, data) {
  const S = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) % 256;
    [S[i], S[j]] = [S[j], S[i]];
  }
  let i = 0;
  j = 0;
  const out = Buffer.alloc(data.length);
  for (let n = 0; n < data.length; n++) {
    i = (i + 1) % 256;
    j = (j + S[i]) % 256;
    [S[i], S[j]] = [S[j], S[i]];
    out[n] = data[n] ^ S[(S[i] + S[j]) % 256];
  }
  return out;
}

function postEncode(encodeOut, m) {
  const reversed = [...encodeOut].reverse().join('');
  let state = Buffer.from(Buffer.from(reversed, 'utf8').toString('hex'), 'utf8');
  for (const round of m.rounds) {
    state = mix(state, round.key, round.salt, round.map);
    state = rc4(round.rc4Key, state);
  }
  return state
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function sealEn(en) {
  if (!sealMaterial) throw new Error('seal material not loaded');
  const m = sealMaterial;
  const fp = 0;
  const r16 = randomBytes(16);
  const now = Date.now();

  const pt = Buffer.alloc(16 + 8 + Buffer.byteLength(en));
  r16.copy(pt, 0);
  writeTimeLE(pt, 16, now);
  pt.write(en, 24, 'utf8');

  const cipher = createCipheriv('aes-256-cbc', m.aesKey, m.aesIv);
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return postEncode(iZEncode(packBody(ct, r16, fp, m), m.iz), m);
}

module.exports = {
  extractXorTableConsts,
  extractHexSeed,
  scanAzDecryptMaterial,
  scanAhSealMaterial,
  setCatalogDecryptMaterial,
  setSealMaterial,
  getCatalogDecryptMaterial,
  getSealMaterial,
  decryptCatalogBody,
  sealEn,
};
