// Mods of Valeton's stock firmware. A mod is a list of byte patches against ONE exact stock version; Launchpad
// never ships Valeton's firmware or a patched copy of it. The user supplies their own stock image (from Valeton),
// Launchpad checks it is that exact version, checks every byte a patch expects, patches the sections on this
// computer and flashes only the sections the mod changes. Version strings stay stock (the pedal checks them).
//
// Mods come built in (MODS) or as files anyone can share (.gp5mod, JSON):
//   { "format": "gp5-mod", "version": 1, "id": "short-name", "title": "...", "summary": "...", "author": "...",
//     "base": "1.0.6",
//     "patches": [ { "section": "app" | "presets" | "dsp", "offset": 1234 | "0x4d2", "before": "hex", "after": "hex",
//                    "note": "what this changes" } ] }
//
// Patchable: the control processor's app (0x62) and presets (0x65), and the DSP's program (0x63). All three are
// always recoverable: Foot+PARA lives in the control processor's factory loader, and the DSP's update mode in its
// factory resident (DSP flash 0x0-0x4000), neither of which any update writes. The start-up code is off limits:
// the app's vector table and loader magic (first 0x100 bytes), the DSP program's header and vector table (first
// 0x400 bytes).
import { inspect, storedCrc, checkApp, checkDsp, SECTIONS } from "./gp5flash.js";

// Valeton's sections, by version: CRC as stored in the container, and length.
export const STOCK = {
  "1.0.6": { 0x63: [0x3688, 49992], 0x67: [0x27A5, 348200], 0x66: [0x2010, 274404], 0x62: [0x985C, 1237352], 0x65: [0xC73C, 184320] },
};
const PATCHABLE = { app: 0x62, presets: 0x65, dsp: 0x63 };
const BOOT_PATH = { 0x62: 0x100, 0x63: 0x400, 0x65: 0 };
export const MOD_FORMAT = "gp5-mod";

// Mods that change the same section are alternatives: installing one writes that whole section from the stock image
// again, so the others' changes are gone. The Mods screen says that above the list; each summary ends with it too,
// because a .gp5mod file travels on its own.
const DSP_NOTE = " Another mod that changes the DSP program puts this one back.";
// The three mods below fill the choices there are: what the pedal sends over USB (Valeton's preset / the dry guitar)
// and what the outputs play (Valeton's mix / only what the computer sends back). Valeton's firmware is the pair that
// isn't a mod. A runtime switch for both, instead of reflashing, is what to work towards.
export const MODS = [
  {
    id: "usb-no-passthrough",
    title: "USB audio interface, no direct monitoring",
    summary: "The outputs play only what comes back over USB, not the guitar, so with nothing coming back they are " +
      "silent. The recording doesn't change: the pedal still sends its preset (two channels, no dry channel to pick " +
      "off). Undo it to use the pedal on its own." + DSP_NOTE,
    base: "1.0.6",
    // "research": being worked out, can't be installed; "untested": installable, not yet confirmed on a pedal;
    // "ready": confirmed on a pedal
    status: "ready",                                  // tried on a pedal, 2026-11-15
    // The DSP's audio routine (runs from RAM at 0x2000108C / 0x200010B6, copied from section 0x63 at start-up) adds
    // the USB return into the processed signal before the outputs: vmla.f32 s0, s1, s2 (out += usb * gain), once per
    // channel. vmul.f32 s0, s1, s2 makes it out = usb * gain. Only in normal mode; re-amp mode is unchanged.
    // The loop is 0xB880..0xB8E2: 64 turns over interleaved L/R pairs in the frame at sp+0x504, and it reads the
    // return sample into s1 first; 0xB8A4 is the left channel, 0xB8CE the right.
    patches: [
      { section: 0x63, offset: 0xB8A4, before: "00ee810a", after: "20ee810a", note: "left output: USB return only (vmla -> vmul)" },
      { section: 0x63, offset: 0xB8CE, before: "00ee810a", after: "20ee810a", note: "right output: USB return only (vmla -> vmul)" },
    ],
  },
  // Both mods below change the DSP's two pack loops, which is what decides what the USB recording carries:
  // the DSP sends the control processor 512 bytes a block: 64 samples x 4 channels x 16 bit, really two stereo
  // pairs. +0x000..0x0FF is mono (the same value in L and R, from (B - A) / 2), +0x100..0x1FF is the processed
  // stereo output. The control processor only puts two of those four channels on USB, and today it sends the second
  // half (the recording comes back as the preset). Swapping where the two pack loops write makes the half on USB
  // the dry one. Each of those patches is one literal in a ldr [pc, #..] pool (the loop stores to [base, r0, lsl #2]),
  // so same length, no code moved. What isn't proven: why the half is dry (its source buffers are initialised by the
  // DSP's resident ROM, which isn't in any image we have), whether the control processor reads the other half
  // anywhere else, and whether the dry pack reads the frame the output mix loop writes (if it did, the USB would
  // carry the return rather than the dry guitar). The 0xB4C0 literal is shared with three test-mode handlers
  // (0xB114, 0xB1AA, 0xB220) that normal running never reaches; if they did run they would write over the pointer
  // array at 0x20002060, which sits right after the block (no room to spare).
  {
    id: "usb-dry-out",
    title: "USB sends the dry guitar",
    summary: "The USB recording gets the dry guitar instead of the preset. The outputs keep playing the preset and " +
      "whatever comes back over USB, so the pedal works on its own. Tried on a pedal: a DAW records a clean DI, " +
      "without the preset's sound." + DSP_NOTE,
    base: "1.0.6",
    status: "ready",                                   // tried on a pedal, 2026-11-19
    patches: [
      { section: 0x63, offset: 0xB4C0, before: "601e0020", after: "601f0020", note: "dry pack: write to the second half (0x20001E60 -> 0x20001F60)" },
      { section: 0x63, offset: 0xB904, before: "601e0020", after: "601d0020", note: "preset pack: write to the first half (0x20001E60 -> 0x20001D60)" },
    ],
  },
  {
    id: "usb-dry-out-and-return",
    title: "USB sends the dry guitar, the outputs play what comes back",
    summary: "The USB recording gets the dry guitar instead of the preset, and the outputs play only what comes back " +
      "over USB: with nothing coming back they are silent, so undo it to play on your own. The send on its own, the " +
      "outputs left as Valeton made them, is confirmed on a pedal; this pair isn't yet." + DSP_NOTE,
    base: "1.0.6",
    status: "untested",                                // the two changes together have not been on a pedal
    // The other mod's two vmla -> vmul changes on top of the pack swaps above: the whole of what Valeton's own
    // interface mode looks like it wants, a DAW recording the dry guitar and the pedal playing back what the
    // computer sends. Four patches, two loops, no bytes shared (see above).
    patches: [
      { section: 0x63, offset: 0xB4C0, before: "601e0020", after: "601f0020", note: "dry pack: write to the second half (0x20001E60 -> 0x20001F60)" },
      { section: 0x63, offset: 0xB904, before: "601e0020", after: "601d0020", note: "preset pack: write to the first half (0x20001E60 -> 0x20001D60)" },
      { section: 0x63, offset: 0xB8A4, before: "00ee810a", after: "20ee810a", note: "left output: USB return only (vmla -> vmul)" },
      { section: 0x63, offset: 0xB8CE, before: "00ee810a", after: "20ee810a", note: "right output: USB return only (vmla -> vmul)" },
    ],
  },
];

export class ModError extends Error {}
const hexBytes = (s, what) => {
  if (typeof s !== "string" || !/^([0-9a-fA-F]{2})+$/.test(s.replace(/\s+/g, ""))) throw new ModError(`${what} isn't hex bytes.`);
  return Uint8Array.from(s.replace(/\s+/g, "").match(/../g).map((b) => parseInt(b, 16)));
};

// Read and check a .gp5mod file: the mod in the same shape as the built-in ones (status "file"). Throws ModError.
export function readModFile(bytes) {
  let o;
  try { o = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ModError("This isn't a GP-5 mod file."); }
  if (!o || o.format !== MOD_FORMAT) throw new ModError("This isn't a GP-5 mod file.");
  if (o.version !== 1) throw new ModError("This mod file was made for a newer Launchpad.");
  const text = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "");
  const mod = { id: text(o.id, 40) || "mod", title: text(o.title, 80) || "Unnamed mod", summary: text(o.summary, 400), author: text(o.author, 80),
                base: text(o.base, 12), status: "file", patches: [] };
  if (!STOCK[mod.base]) throw new ModError(`This mod is for Valeton's firmware V${mod.base || "?"}, which Launchpad doesn't know.`);
  if (!Array.isArray(o.patches) || !o.patches.length) throw new ModError("This mod changes nothing.");
  if (o.patches.length > 4096) throw new ModError("This mod has too many changes.");
  for (const [i, p] of o.patches.entries()) {
    const what = `Change ${i + 1}`;
    if (!p || typeof p !== "object") throw new ModError(`${what} is damaged.`);
    const section = PATCHABLE[p.section];
    if (!section) throw new ModError(`${what} is for the "${p.section}" part; mods can only change the app, the presets or the DSP program.`);
    const offset = typeof p.offset === "string" ? Number(p.offset) : p.offset;
    if (!Number.isInteger(offset) || offset < 0) throw new ModError(`${what} has no proper position.`);
    const before = hexBytes(p.before, `${what}: "before"`), after = hexBytes(p.after, `${what}: "after"`);
    if (before.length !== after.length) throw new ModError(`${what} changes the length of the firmware; mods may only replace bytes.`);
    mod.patches.push({ section, offset, before, after, note: text(p.note, 200) });
  }
  return mod;
}

// A mod file for a mod (for sharing / the tests).
export function modFile(mod) {
  const name = Object.fromEntries(Object.entries(PATCHABLE).map(([k, v]) => [v, k]));
  const hx = (b) => Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
  return new TextEncoder().encode(JSON.stringify({ format: MOD_FORMAT, version: 1, id: mod.id, title: mod.title, summary: mod.summary, author: mod.author || "",
    base: mod.base, patches: mod.patches.map((p) => ({ section: name[p.section], offset: "0x" + p.offset.toString(16), before: hx(asBytes(p.before)), after: hx(asBytes(p.after)), note: p.note || "" })) }, null, 1) + "\n");
}
const asBytes = (v) => (v instanceof Uint8Array ? v : hexBytes(v, "patch"));

// Which Valeton version an image is, or null (some section isn't Valeton's).
export function stockVersion(imageBytes) {
  let sections;
  try { sections = inspect(imageBytes).sections; } catch { return null; }
  for (const [v, want] of Object.entries(STOCK)) {
    if (sections.length === Object.keys(want).length && sections.every(([t, d]) => want[t] && want[t][0] === storedCrc(d) && want[t][1] === d.length)) return v;
  }
  return null;
}

// Check a stock image for a mod and build the sections to flash: [[type, data]] plus a readable plan.
// Throws ModError with a plain reason; nothing is changed unless every check passes.
export function buildMod(imageBytes, mod) {
  if (mod.status === "research" || !mod.patches.length) throw new ModError(`"${mod.title}" isn't ready to install yet.`);
  let sections;
  try { sections = inspect(imageBytes).sections; } catch { throw new ModError("That file isn't a GP-5 firmware image."); }
  const want = STOCK[mod.base];
  if (!want) throw new ModError(`Launchpad doesn't know Valeton's firmware V${mod.base}.`);
  if (stockVersion(imageBytes) !== mod.base) throw new ModError(`That isn't Valeton's original firmware V${mod.base} (the mod is made for exactly that version, unchanged).`);
  const out = new Map(sections.filter(([t]) => t in PATCHABLE_TYPES).map(([t, d]) => [t, Uint8Array.from(d)]));
  const plan = [];
  for (const [i, p] of mod.patches.entries()) {
    const d = out.get(p.section), before = asBytes(p.before), after = asBytes(p.after);
    if (!d || before.length !== after.length || p.offset + before.length > d.length) throw new ModError(`Change ${i + 1} doesn't fit the image.`);
    if (p.offset < BOOT_PATH[p.section]) throw new ModError(`Change ${i + 1} touches start-up code, which mods must leave alone.`);
    for (let k = 0; k < before.length; k++) if (d[p.offset + k] !== before[k]) throw new ModError(`The image doesn't contain what change ${i + 1} expects. Nothing was changed.`);
    plan.push({ section: p.section, offset: p.offset, length: before.length, note: p.note || "" });
  }
  // patches may not overlap (a later one would check bytes an earlier one already changed)
  const spans = plan.map((p) => [p.section, p.offset, p.offset + p.length]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (let i = 1; i < spans.length; i++) if (spans[i][0] === spans[i - 1][0] && spans[i][1] < spans[i - 1][2]) throw new ModError("Two of the mod's changes overlap.");
  for (const p of mod.patches) out.get(p.section).set(asBytes(p.after), p.offset);
  const errs = [...(mod.patches.some((p) => p.section === SECTIONS.app) ? checkApp(out.get(SECTIONS.app)) : []),
                ...(mod.patches.some((p) => p.section === SECTIONS.dsp) ? checkDsp(out.get(SECTIONS.dsp)) : [])];
  if (errs.length) throw new ModError("The modded firmware wouldn't start: " + errs.join("; "));
  const touched = new Set(mod.patches.map((p) => p.section));
  // sections: only what the mod changes (for a pedal already on Valeton's firmware); all: the whole image with
  // the mod in it (for a pedal running anything else: its DSP needs Valeton's sections back too)
  return { sections: [...out].filter(([t]) => touched.has(t)), all: sections.map(([t, d]) => [t, out.get(t) ?? d]),
           plan, bytes: plan.reduce((n, p) => n + p.length, 0) };
}
const PATCHABLE_TYPES = Object.fromEntries(Object.values(PATCHABLE).map((t) => [t, true]));

// Undo: Valeton's own sections from the user's original image. On a pedal running (modded) Valeton firmware
// only the patchable ones (app, presets, DSP program); otherwise the whole image.
export function stockSections(imageBytes, onStock) {
  const v = stockVersion(imageBytes);
  if (!v) throw new ModError("That isn't one of Valeton's original firmware files.");
  const all = inspect(imageBytes).sections;
  return onStock ? all.filter(([t]) => t in PATCHABLE_TYPES) : all;
}
