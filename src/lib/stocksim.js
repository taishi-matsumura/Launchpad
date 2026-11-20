// A simulated GP-5 running Valeton's firmware, for the tests and for #sim=stock: the preset commands as
// docs/stock-preset-protocol.md describes them (multi-packet reassembly with "keep going" ACKs, 19-byte reply
// packets, the order map, factory fallback for erased slots, the edit buffer). It holds no Valeton data: tests
// may hand it factory presets read from a local firmware file, otherwise it makes up its own.
import { buildSysex, parseSysex } from "./gp5flash.js";
import { decodePreset, encodePreset, PRESETS, FACTORY, MSG } from "./stockpresets.js";

const ACK = (s) => buildSysex(1, 0, [0x14, 0x08, s]);
const clone = (p) => JSON.parse(JSON.stringify(p));

// The template the pedal uses for presets 50..99 and anything unreadable (FUN_44b10).
export function blankPreset() {
  return { name: "GP-5", version: 1, volume: 50, tempo: 120, mask: 0, order: [0, 1, 2, 9, 3, 4, 5, 6, 7, 8],
           models: Array(10).fill(0), params: Array.from({ length: 10 }, () => Array(8).fill(0)), groupA: 7, groupB: 7 };
}

// Made-up factory presets (the simulation must not carry Valeton's); the model IDs are real catalog IDs.
function madeUpFactory(i) {
  const p = blankPreset();
  p.name = ["Glass", "Amber", "Velvet", "Dust", "Neon"][i % 5] + " " + String(i + 1).padStart(2, "0");
  p.mask = 0b0111111001 | (i & 6);               // never SnapTone together with amp + cab
  p.models = [0x1B, 0x14, 0x03000000, 0x07000001 + (i % 4), 0x0A000001, 0x01000035, 0x04000000, 0x0B000001, 0x0C000001, 0x0F000000];
  p.params = p.params.map((row, b) => row.map((_, k) => (k < 5 ? 20 + ((i * 7 + b * 3 + k * 11) % 60) : 0)));
  p.params[7][1] = 300 + i * 10;                 // delay time
  p.volume = 40 + (i % 30);
  return p;
}

export class StockModel {
  constructor({ factory = null } = {}) {
    this.factory = factory || Array.from({ length: FACTORY }, (_, i) => madeUpFactory(i));
    this.slots = Array(PRESETS).fill(null);      // user slots 0x171000 + s*0x400 (null = erased)
    this.map = Array.from({ length: PRESETS }, (_, i) => i);
    this.current = 0; this.dirty = false;
    this.edit = this.read(0);
    this.buf = []; this.count = 0; this.got = 0;
    this.banks = { 0x24: Array.from({ length: 80 }, (_, i) => (i % 3 === 0 && i < 30 ? `Tone ${i + 1}` : null)),
                   0x20: Array.from({ length: 20 }, (_, i) => (i < 4 ? `Cab IR ${i + 1}` : null)) };
    this.flashWrites = 0; this.dropEvery = 0; this.seen = 0; this.log = []; this.failNextWrite = false; this.corruptNextWrite = false;
    this.globals = new Map();                     // SET_GLOBAL (11 11 a b 00 00 u32) values written since boot
  }
  read(n) {                                       // §3.3
    const slot = this.map[n];
    let p = slot < PRESETS ? this.slots[slot] : this.factory[slot - PRESETS];
    if (!p) p = n < FACTORY ? this.factory[n] : blankPreset();
    return clone(p);
  }
  save(n, p) {                                    // §3.2: silently skipped if the map points outside the user slots
    const slot = this.map[n];
    this.flashWrites++;
    if (slot >= PRESETS) return;
    const q = clone(p);
    if (this.corruptNextWrite) { this.corruptNextWrite = false; q.params[0][0] += 1; }
    this.slots[slot] = q;
  }
  // Handle one raw packet. Returns the frames to answer with, or null when it isn't a preset message (the
  // detection 12 30 and the loader commands stay with the flasher's simulation).
  handle(raw) {
    const m = parseSysex(raw);
    if (!m) return null;
    if (!m.ok) return [ACK(1)];
    const count = m.cls, idx = m.index, pl = Array.from(m.payload);
    if (idx === 0 && count === 1 && pl[0] === 0x12 && pl[1] === 0x30) return null;
    if (idx === 0 && count === 1 && pl[0] === 0x11 && [0x6F, 0x60, 0x61, 0x6E].includes(pl[1])) return null;
    if (idx === 0) { this.buf = []; this.got = 0; this.count = count; }
    this.buf.push(...pl); this.got++;
    if (idx + 1 !== count) return [ACK(0)];
    if (this.got !== count) return [ACK(1)];
    const msg = Uint8Array.from(this.buf);
    if (this.dropEvery && ++this.seen % this.dropEvery === 0) return [];      // a missed exchange, as seen on hardware
    this.log.push(msg[0].toString(16) + " " + msg[1].toString(16).padStart(2, "0"));
    return this.dispatch(msg);
  }
  reply(bytes) {
    const out = [], n = Math.max(1, Math.ceil(bytes.length / 19));
    for (let i = 0; i < n; i++) out.push(buildSysex(n, i, bytes.subarray(i * 19, (i + 1) * 19)));
    return out;
  }
  dispatch(msg) {
    const dv = new DataView(msg.buffer), u16 = (o) => dv.getUint16(o, true), u32 = (o) => dv.getUint32(o, true);
    const [a, c] = msg;
    if (a === 0x12) {
      switch (c) {
        case 0x40: {
          const r = new Uint8Array(2 + PRESETS * 20); r[0] = 0x12; r[1] = 0x40;
          const rv = new DataView(r.buffer);
          for (let n = 0; n < PRESETS; n++) { rv.setUint32(2 + n * 20, this.map[n], true); r.set(new TextEncoder().encode(this.read(n).name.slice(0, 10)), 6 + n * 20); }
          return this.reply(r);
        }
        case 0x4F: {
          const n = u16(2), e = encodePreset(this.read(n), n);
          e[0] = 0x12; e[2] = e[3] = e[4] = e[5] = 0xFF;
          return this.reply(e);
        }
        case 0x41: {
          const e = encodePreset(this.edit, 0), r = new Uint8Array(2 + MSG - 0x16);
          r[0] = 0x12; r[1] = 0x41; r.set(e.subarray(0x16), 2);
          return this.reply(r);
        }
        case 0x43: return this.reply(Uint8Array.from([0x12, 0x43, this.current & 0xFF, this.current >> 8]));
        case 0x10: {                              // globals: a few of the real items, 0x0202 = output level × 100,
                                                 // the unmapped GP-5 records (sizes as captured on a real pedal,
                                                 // linkprobe.js PROBE_RECORDS) and whatever SET_GLOBAL wrote
          const le = (x) => [x & 0xFF, (x >> 8) & 0xFF, (x >> 16) & 0xFF, (x >> 24) & 0xFF];
          const items = [[0x0101, 4, le(0x01010006)], [0x0102, 4, le(1)], [0x0202, 4, le(this.level ?? 70)], [0x0203, 4, le(64)]];
          for (const p of [[0x0407, 2, [3, 0]], [0x0404, 1, [1]], [0x0403, 1, [1]], [0x0201, 1, [0]]])
            if (!this.globals.has(p[0])) items.push(p);
          for (const [id, x] of this.globals) items.push([id, 4, le(x)]);
          const r = new Uint8Array(2 + items.reduce((n, [, s]) => n + 4 + s, 0));
          r[0] = 0x12; r[1] = 0x10; let o = 2;
          for (const [id, s, val] of items) { r[o] = id & 0xFF; r[o + 1] = id >> 8; r[o + 2] = s; r.set(val, o + 4); o += 4 + s; }
          return this.reply(r);
        }
        case 0x45: return this.reply(Uint8Array.from([0x12, 0x45, this.dirty ? 1 : 0]));
        case 0x1A: return this.reply(Uint8Array.from([0x12, 0x1A, 0x06, 0x00, 0x01, 0x01]));
        case 0x24: case 0x20: {
          const bank = this.banks[c], n = bank.length, r = new Uint8Array(2 + n * 17); r[0] = 0x12; r[1] = c;
          bank.forEach((nm, i) => { r[2 + i] = nm ? 1 : 0; r.set(new TextEncoder().encode((nm || "Empty").slice(0, 15)), 2 + n + 16 * i); });
          return this.reply(r);
        }
        default: return [];
      }
    }
    if (a !== 0x11) return [];
    const ok = (s = 0) => [ACK(s)];
    switch (c) {
      case 0x4F: {
        const n = u16(2);
        if (n >= PRESETS) return ok(1);
        if (this.failNextWrite) { this.failNextWrite = false; return ok(1); }
        const r = msg.slice(); r[0] = 0x12;
        const p = decodePreset(r);
        this.save(n, p);
        if (n === this.current) { this.edit = this.read(n); this.dirty = false; }
        return ok();
      }
      case 0x4C: {
        const n = u32(2);
        if (n >= PRESETS) return ok(1);
        const p = this.read(n); p.name = new TextDecoder("latin1").decode(msg.subarray(6, 17)).split("\0")[0];
        this.save(n, p);
        if (n === this.current) this.edit.name = p.name;
        return ok();
      }
      case 0x46: case 0x1F: {
        const n = u16(2);
        if (n >= PRESETS) return ok(1);
        this.save(n, n < FACTORY ? this.factory[n] : blankPreset());
        if (n === this.current) { this.edit = this.read(n); this.dirty = false; }
        return ok();
      }
      case 0x4A: {
        const n = u16(2);
        if (n >= PRESETS) return ok(1);
        const p = clone(this.edit); p.name = new TextDecoder("latin1").decode(msg.subarray(6, 17)).split("\0")[0];
        this.save(n, p); this.current = n; this.edit = this.read(n); this.dirty = false;
        return ok();
      }
      case 0x27: case 0x23: {                     // delete by ID; an unknown ID hits slot 0, as on the pedal
        const bank = this.banks[c === 0x27 ? 0x24 : 0x20], base = c === 0x27 ? 0x0F000000 : 0x0A100000, i = u32(2) - base;
        bank[i >= 0 && i < bank.length ? i : 0] = null;
        return ok();
      }
      case 0x43: { const n = u16(2); if (n >= PRESETS) return ok(1); this.current = n; this.edit = this.read(n); this.dirty = false; return ok(); }
      case 0x48: { const b = u32(2), k = u32(6); if (b < 10 && k < 8) { this.edit.params[b][k] = dv.getFloat32(10, true); this.dirty = true; } return ok(); }
      case 0x47: { const b = u32(2); if (b < 10) { this.edit.models[b] = u32(10); this.dirty = true; } return ok(); }
      case 0x49: { const b = msg[2]; if (b < 10) { this.edit.mask = u32(6) ? this.edit.mask | (1 << b) : this.edit.mask & ~(1 << b); this.dirty = true; } return ok(); }
      case 0x44: this.edit.order = Array.from(msg.subarray(2, 12)); this.dirty = true; return ok();
      case 0x42: if (u16(2) === 0x2001) { this.edit.volume = Math.min(100, msg[6]); this.dirty = true; } return ok();
      case 0x11: this.globals.set(u16(2), u32(6)); return ok();   // SET_GLOBAL (11 11 a b 00 00 u32): store and answer
      default: return ok();
    }
  }
}
