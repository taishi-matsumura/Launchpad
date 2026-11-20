// T2 probe: the bytes with which Launchpad can try to move the USB routing mode Valeton's DSP answers to.
// What Valeton's app firmware (section 0x62) really does — read from its code, disassembled in
// src/_dev/gp5-mod-switch-brief.md §15-16: it keeps one mode byte (0..3); a UI page in the pedal sets it and
// saves it; at power-on it's restored and pushed to the DSP over the internal link as frame 0x6001 [arg]. The
// 0x10/0x11 global records are a separate store: writing them ACKs and read-back works, but none of the five
// unmapped ones was seen to change the sound (brief §14) — this console re-tests them with the record read back
// (does the write persist?) and the ear (does it change routing?), and pushes what the pedal itself writes.
// The link frames themselves are only bridged over USB by OpenGP5 platform firmware (7E 00); Valeton's own
// answers nothing to them — those buttons wait for a development firmware that listens.

export const recId = (a, b) => a | (b << 8);
export const recName = (id) => `(${id & 0xFF}, ${id >> 8})`;
export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
const u16le = (v) => [v & 0xFF, (v >>> 8) & 0xFF];
const u32le = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
export const readU32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// Valeton's own protocol: [12 10] reads all global records; [11 11 a b 00 00 u32] writes one (an ACK answers).
export const GLOBALS_READ = [0x12, 0x10];
export const setGlobal = (id, value) => [0x11, 0x11, id & 0xFF, id >> 8, 0x00, 0x00, ...u32le(value >>> 0)];

// The DSP link frame (OpenGP5 docs/platform/protocols.md): [cmd u16][length u16 = 8][arg u32], and the bridge
// OpenGP5 firmware accepts: class 1 index 0, payload [7E 00 frame...].
export const linkFrame = (cmd, arg) => [...u16le(cmd), 0x08, 0x00, ...u32le(arg >>> 0)];
export const linkInject = (frame) => [0x7e, 0x00, ...frame];

// The records Valeton's own app and menus never name, copied with their sizes from a real GP-5's 0x10 reply
// (VLTN-Tone-Studio's capture; brief §13). (7,4)=3 leads: 3 is also the routing the pedal boots with.
// (3,2)=100 was left out — a value like that reads as a level, not a mode.
export const PROBE_RECORDS = [
  { id: recId(7, 4), def: 3, note: "lead candidate: the pedal boots into routing 3, and this record holds 3" },
  { id: recId(4, 4), def: 1, note: "the GP-50 family keeps its REC mode at (4,4)" },
  { id: recId(3, 4), def: 1, note: "" },
  { id: recId(2, 1), def: 1, note: "" },
  { id: recId(1, 2), def: 0, note: "" },
];

// Frame 0x6001 carries the mode: 0 is Valeton's plain routing, 1..3 the ones the DSP's code already has
// (T1's test plan says what each does to the sound). 0x1001 arg 1 is the DSP query the app sends at boot.
export const MODE_FRAMES = [0, 1, 2, 3].map((v) => ({ label: `mode ${v}`, payload: linkInject(linkFrame(0x6001, v)) }));
export const DSP_PING = { label: "query", payload: linkInject(linkFrame(0x1001, 1)) };

// A global-record write the pedal pushes by itself ([11 11 a b 00 00 u32]): the way to learn the pedal's own
// controls changed something, without asking. Null unless it is one.
export function pushedSetGlobal(p) {
  if (!p || p.length < 10 || p[0] !== 0x11 || p[1] !== 0x11) return null;
  return { id: recId(p[2], p[3]), value: readU32(p, 6) };
}

// What an arriving message was, as one console line: a name when it's known, then the raw hex.
export function describeMessage(p) {
  if (!p || !p.length) return "";
  const h = hex(p);
  const g = pushedSetGlobal(p);
  if (g) return `record ${recName(g.id)} = ${g.value} — written by the pedal itself — ${h}`;
  if (p[0] === 0x14) return p[2] === 0 ? `acknowledged — ${h}` : `refused, status ${p[2]} — ${h}`;
  if (p[0] === 0x12) return `reply to ${hex(p.subarray(0, 2))} — ${h}`;
  if (p[0] === 0x11) return `command ${hex(p.subarray(0, 2))} — ${h}`;
  if (p[0] === 0x7e) return `platform ${hex(p.subarray(0, 2))} — ${h}`;
  return h;
}

// How readGlobals (stockpresets.js) hands a record back: a number for 4-byte items, raw bytes otherwise.
export const fmtValue = (v) => (typeof v === "number" ? String(v) : hex(v));
