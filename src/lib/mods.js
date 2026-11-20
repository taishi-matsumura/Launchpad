// Mods of Valeton's stock firmware. A mod is a list of byte patches against ONE exact stock version; Launchpad
// never ships Valeton's firmware or a patched copy of it. The user supplies their own stock image (from Valeton),
// Launchpad checks it is that exact version, checks every byte a patch expects, patches the sections on this
// computer and flashes only the sections the mod changes. Version strings stay stock (the pedal checks them).
//
// Mods come built in (MODS) or as files anyone can share (.gp5mod, JSON):
//   { "format": "gp5-mod", "version": 1, "id": "short-name", "title": "...", "summary": "...", "author": "...",
//     "base": "1.0.6", "warn": "optional: what playing through this is like, said again before it is written",
//     "patches": [ { "section": "app" | "presets" | "dsp", "offset": 1234 | "0x4d2", "before": "hex", "after": "hex",
//                    "note": "what this changes" } ] }
//
// "warn" is one sentence the pedal can't tell us and the summary may bury: the Mods screen's USB routing row shows
// it and says it again in the confirm, because switching there is one click and a few seconds.
//
// A mod's id is its name, and the list has one row per name: a file that carries a built-in mod's id is the same
// mod (Launchpad shows its own copy, whose words are the current ones) or a different mod that needs a new id.
// knownMod() below makes that call.
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
// The three routing mods below fill the choices there are: what the pedal sends over USB (Valeton's preset / the dry
// guitar) and what the outputs play (Valeton's mix / only what the computer sends back). Valeton's firmware is the
// pair that isn't a mod, and all three others are confirmed on a pedal. An experiment about choosing these without
// reflashing sits in EXPERIMENTS further down, as a file rather than a row. Every title gives both answers in the
// same order:
// "USB sends <the preset | the dry guitar>, the outputs play <the pedal | only what comes back>". The word
// "monitoring" is deliberately in no title, although it's the usual word for the second half: Valeton's own
// Monitor Level is the gain of what comes back over USB (the DSP's 2:I2S input gain at 0x2000201C), a knob anyone can
// turn, and these mods are not that: they are burned into the DSP program. Picking one of these means reflashing; the
// Mods screen's "USB routing" list (views/mods.js) flashes just the DSP section for it: 49,992 bytes, 2,632 packets,
// against 65,124 for the control processor's app. dspAlternatives() below is what belongs in that list.
// What the DSP does have, found in the disassembly (2026-11-19/20), is three built-in routing modes that replace
// the whole pipeline — Valeton's own reamp-style matrix — but on the stock program the gate to them is the state of
// the audio stream, and nothing a user can reach. The EXPERIMENTS mod below moves that gate onto a byte Valeton's
// own link commands write, hoping some app control sends one; it changes no routing on its own and is untested.
export const MODS = [
  {
    id: "usb-no-passthrough",
    title: "USB sends the preset, the outputs play only what comes back",
    summary: "The outputs play only what comes back over USB, not the guitar, so with nothing coming back they are " +
      "silent. The recording doesn't change: the pedal still sends its preset (two channels, no dry channel to pick " +
      "off)." + DSP_NOTE,
    warn: "With nothing coming back over USB the outputs are silent: the pedal makes no sound of its own.",
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
  // DSP's resident ROM, which isn't in any image we have), and whether the control processor reads the other half
  // anywhere else. What is proven now: the dry pack doesn't read the frame the output mix loop writes — with both
  // changes in ("usb-dry-out-and-return", on a pedal 2026-11-20) the USB still carries the dry guitar while the
  // outputs play only what the computer sends back.
  // The 0xB4C0 literal is shared with three test-mode handlers
  // (0xB114, 0xB1AA, 0xB220) that normal running never reaches; if they did run they would write over the pointer
  // array at 0x20002060, which sits right after the block (no room to spare).
  {
    id: "usb-dry-out",
    title: "USB sends the dry guitar, the outputs play the pedal",
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
    title: "USB sends the dry guitar, the outputs play only what comes back",
    summary: "The USB recording gets the dry guitar instead of the preset, and the outputs play only what comes back " +
      "over USB: with nothing coming back they are silent. Tried on a pedal: a DAW records a clean DI, and the " +
      "outputs stay quiet until the computer sends something back." + DSP_NOTE,
    warn: "With nothing coming back over USB the outputs are silent: the pedal makes no sound of its own.",
    base: "1.0.6",
    status: "ready",                                   // tried on a pedal, 2026-11-20
    // The other mod's two vmla -> vmul changes on top of the pack swaps above: the whole of what Valeton's own
    // interface mode looks like it wants, a DAW recording the dry guitar and the pedal playing back what the
    // computer sends. Four patches, two loops, no bytes shared (see above).
    // On a pedal (2026-11-20): the DAW records the dry guitar, and the outputs are silent with nothing coming back,
    // then play what the computer sends. So the dry pack doesn't read the frame the output mix loop writes: the two
    // loops stay independent, which was the open question above.
    patches: [
      { section: 0x63, offset: 0xB4C0, before: "601e0020", after: "601f0020", note: "dry pack: write to the second half (0x20001E60 -> 0x20001F60)" },
      { section: 0x63, offset: 0xB904, before: "601e0020", after: "601d0020", note: "preset pack: write to the first half (0x20001E60 -> 0x20001D60)" },
      { section: 0x63, offset: 0xB8A4, before: "00ee810a", after: "20ee810a", note: "left output: USB return only (vmla -> vmul)" },
      { section: 0x63, offset: 0xB8CE, before: "00ee810a", after: "20ee810a", note: "right output: USB return only (vmla -> vmul)" },
    ],
  },
];

// Experiments: mods born from the disassembly that don't promise one routing, so they don't take a built-in row in
// the Mods screen's routing list (that list answers both routing questions in fixed words). They travel as .gp5mod
// files that same screen can open; write-mod-files.mjs writes them out with the built-in mods. Nothing here claims
// "ready" before it has been on a pedal.
//
// valeton-rec-switch. The DSP program holds three built-in routing modes next to the normal pipeline, and a link
// command that can pick them; the two are simply not joined. Decoded on 2026-11-20 with a real disassembler over
// section 0x63 (in this section a code address is the file position + 0x4000, and a call that can't reach its
// target lands on a 10-byte movw/movt/bx island at 0xA700..0xA980 whose immediate is the address, so island
// 0xA836 -> address 0x63B5 -> file 0x23B4).
// The dispatch at 0xB0AC (the DSP's own audio routine, 0x708 bytes of frame) reads a byte at file 0xB0C2 — control
// block 0x20002060 +0x2c — and if it's zero goes to the normal path (0xB1B8 -> 0xB27A); otherwise it calls the
// island 0xA836, i.e. the getter at file 0x23B4 that reads parameter block 0x20002098 +0x170, and compares what it
// returns to 1, 2, 3 (0xB0D0..0xB0DA): bodies at 0xB0DE, 0xB168, 0xB1BC, and anything else goes to 0xB1BA. Those
// bodies are the two pack loops T1's mods change — 64 turns over the DSP's frame halves, writing through the
// pointers at 0x20001E60 and 0x20001C60 and the +0x100 half of the USB block — so which channel each mode routes is
// exactly what one flash and one command can answer; it isn't measured yet. All four ways out (0xB166, 0xB1B6,
// 0xB272, 0xB274) reach the same epilogue at 0xB9BA, so an unknown mode only skips the routing work.
// The command side: the DSP's link dispatcher is at 0x1C68 (payload = [cmd u16][len u16][args], cmd = group<<12 |
// index, a tbb over eight handler tables at 0x4DC0..0x4E5C; the platform notes knew this as "31 region-c handlers,
// dispatcher 0x5c68" — same count). Group 6's table at 0x4E5C: 0x6000 = version (file 0x1652; the query the
// platform sends and answers, so frames from a PC do reach this table), 0x6002 = a two-float query (0x167C), and
// between them 0x6001 -> 0x1604 stores the frame's argument byte into that +0x170 byte (through 0x23C0, which also
// marks +0x2E1) and a 1 or 3 into a mode byte at +0x2E0 (through 0x2084), while 0x6003 -> 0x1630 writes +0x2E0
// only. Seven places in this section call that setter (0x1324, 0x15E8, 0x15F0, 0x1614, 0x161C, 0x163E, 0x240E);
// nothing here reads +0x2E0 back. The +0x170 byte's only reader is the mode getter the dispatch calls.
// So the wire protocol is whole and the three modes are whole; what never fires them is that the dispatch looks at
// block +0x2c, whose only writer is a poll routine at 0xBB0C..0xBBCC that this section never calls.
// One change joins them: read the gate from the byte the command writes. The pool the ldr at 0xB0C0 reads (0xB4BC)
// is shared by 21 places, so the pool can't move — but the offset can, in the same 4-byte instruction: +0x2c ->
// +0x1A8, and 0x20002060 + 0x1A8 = 0x20002098 + 0x170. Gate and mode then come from one byte, so there is no
// half-open state: 0 is stock, 1/2/3 are the three modes. The replacement was assembled with clang for
// thumbv7em and read back with objdump (90f8a801), and applied to a copy of the section it disassembles clean.
// An earlier build of this mod moved the gate to +0x2E0 instead; that read 0x20002340, while the setter writes
// 0x20002378, and its second change (0xB1BA, retargeting a branch that only skipped a nop) did nothing. Neither was
// ever flashed.
// Valeton's control app (section 0x62) does hold those numbers: one movi of each in the Andes disassembly
// ($r0,#0x6001 at 0x46746, $r1,#0x6003 at 0x46A3A, both inside a routine five places call at 0x47900 — 0x20BCA,
// 0x20C26, 0x20C46, 0x21768, 0x217A0), and the raw 16-bit constants 32 and 29 times across the section, which is
// how much command and data look alike. The words "Both", "Input" and "BT/USB" (0x62's 0xBDDCC) sit in the middle
// of factory test strings — "P Test Audio", "P Test BT", "Test Finish" — so the page that offers them may be a test
// menu, not a user menu. Don't wait for Valeton's UI: after one flash, send 0x6001 with argument 1, 2, 3 and 0 from
// Launchpad itself and watch what the outputs and the DAW hear per mode. Start-up leaves +0x170 zero, so flashed
// alone this changes nothing audible.
export const EXPERIMENTS = [
  {
    id: "valeton-rec-switch",
    title: "Valeton's own recording command switches the routing, no reflashing",
    summary: "An experiment, untested on a pedal: nothing changes by itself. The DSP holds three routing modes " +
      "(dry out, return only, return + dry) and command 0x6001 stores a mode number, but the gate opening them " +
      "reads a byte nothing can write. This mod moves the gate onto that byte, so sending 0x6001 picks the " +
      "routing live: 1/2/3 a mode, 0 stock." + DSP_NOTE,
    warn: "Untested, and sending the command from Launchpad is still to be built. Safe to try: the pedal starts " +
      "and sounds stock, and Valeton's own row in the same list puts everything back.",
    base: "1.0.6",
    status: "untested",                                // from the disassembly, 2026-11-20; not tried on a pedal yet
    patches: [
      { section: 0x63, offset: 0xB0C2, before: "90f82c00", after: "90f8a801",
        note: "the routing modes' gate reads the byte command 0x6001 writes, not the audio stream state " +
          "(ldrb #0x2c -> #0x1a8; 0x20002060+0x1a8 = 0x20002098+0x170, which 0x6001 writes and the mode getter reads)" },
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
                warn: text(o.warn, 200), base: text(o.base, 12), status: "file", patches: [] };
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

// The changes a mod makes, as strings that compare: notes, titles and the order the file lists them in don't
// matter, only which bytes go where.
const changeSet = (mod) => new Set((mod.patches || []).map((p) => `${p.section}@${p.offset}:${hxBytes(asBytes(p.before))}>${hxBytes(asBytes(p.after))}`));
const hxBytes = (b) => Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");

// A mod file meeting the mods Launchpad already has a row for: the built-in ones, Valeton's own row, and the files
// already open (the screen passes those in, or one file would quietly replace another with the same id). A mod's id
// is its name, so the same id means the same thing, and files get shared around with names Launchpad stopped using:
//   "same"  the file changes exactly the bytes one of ours changes. Same mod, older words: show ours, whose name and
//           summary are the current ones, and don't add a second row that writes the same thing.
//   "clash" the same id with different changes: a different mod wearing another mod's name. No row could say what it
//           writes honestly, and one id in two rows would make the USB routing list ambiguous, so it doesn't go in.
//   null    a name Launchpad doesn't have: the file's mod is new and belongs in the list.
export function knownMod(mod, builtIn = BUILT_INS) {
  const known = builtIn.find((m) => m.id === mod.id);
  if (!known) return null;
  const ours = changeSet(known), theirs = changeSet(mod);
  const same = known.base === mod.base && ours.size === theirs.size && [...ours].every((k) => theirs.has(k));
  return { why: same ? "same" : "clash", mod: known };
}

// A mod file for a mod (for sharing / the tests).
export function modFile(mod) {
  const name = Object.fromEntries(Object.entries(PATCHABLE).map(([k, v]) => [v, k]));
  return new TextEncoder().encode(JSON.stringify({ format: MOD_FORMAT, version: 1, id: mod.id, title: mod.title, summary: mod.summary, author: mod.author || "", warn: mod.warn || "",
    base: mod.base, patches: mod.patches.map((p) => ({ section: name[p.section], offset: "0x" + p.offset.toString(16), before: hxBytes(asBytes(p.before)), after: hxBytes(asBytes(p.after)), note: p.note || "" })) }, null, 1) + "\n");
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

// Valeton's own DSP program on its own: going back to it in seconds, the same way the mods are switched, without
// the app and preset sections that Undo also writes. Mod files only ever change one part of the firmware, so for a
// pedal running Valeton's firmware that is all a routing switch needs; Undo is still there for a mod that changed
// the app, and it is the one that verifies every section of the image.
export const STOCK_DSP = { id: "stock", stockDsp: true, status: "ready", base: "1.0.6", title: "Valeton's original, no mods", patches: [] };

// What Launchpad has a row for before anyone opens a file: Valeton's own row and the built-in mods. A file's id is
// checked against these (plus whatever files are already open) by knownMod() below.
export const BUILT_INS = [STOCK_DSP, ...MODS];

// Check a stock image for a mod and build the sections to flash: [[type, data]] plus a readable plan.
// Throws ModError with a plain reason; nothing is changed unless every check passes.
export function buildMod(imageBytes, mod) {
  if (mod.status === "research" || !(mod.patches?.length || mod.stockDsp)) throw new ModError(`"${mod.title}" isn't ready to install yet.`);
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
                ...(mod.stockDsp || mod.patches.some((p) => p.section === SECTIONS.dsp) ? checkDsp(out.get(SECTIONS.dsp)) : [])];
  if (errs.length) throw new ModError("The modded firmware wouldn't start: " + errs.join("; "));
  const touched = new Set(mod.patches.map((p) => p.section));
  if (mod.stockDsp) touched.add(SECTIONS.dsp);            // Valeton's own program: rewritten as it is, changed by nothing
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

// ------------------------------------------------------------------ the DSP program's alternatives

// Mods that only change the DSP program (0x63): they all rewrite the same section from the stock image, so each one
// puts the others back and they are alternatives to pick between. Those go in the Mods screen's "USB routing" list,
// where picking one rewrites that section alone (2,632 packets of 19 bytes) instead of the whole firmware. Mods that
// also change the app or the presets stay out: putting one of those back would erase the user's presets.
// Built-in mods that are still being worked out (status "research") can't be installed, so they aren't listed.
export function dspAlternatives(mods) {
  const seen = new Set();
  return mods.filter((m) => m.status !== "research" && m.patches?.length && m.patches.every((p) => p.section === SECTIONS.dsp))
             .filter((m) => !seen.has(m.id) && seen.add(m.id));
}

// ------------------------------------------------------------------ what this Launchpad last wrote

// The pedal can't tell us what's in it now: nothing in Valeton's firmware or the factory loader reads flash back
// (the flashRead command 7E 05 belongs to the OpenGP5 platform, and the 12 30 state query answers four fixed bytes),
// and the GP-5 has no device id to key a record on. So the Mods screen only says what this computer last wrote:
// a hint, never part of the writing, which is always rebuilt from the user's stock image (buildMod) and so is
// idempotent. Storage: { id, title, at } with id "stock" for Valeton's original; null when nothing was written here.
export const LAST_WRITTEN_KEY = "mods-last-written-v1";

const readWritten = (storage) => {
  try { const o = JSON.parse(storage.getItem(LAST_WRITTEN_KEY) || "null"); return o && typeof o.id === "string" ? o : null; }
  catch { return null; }
};

export const lastWritten = (storage = typeof localStorage === "undefined" ? {} : localStorage) => readWritten(storage);

// Record what a flash put on the pedal (a mod, or Valeton's original). A mod file re-opened later with the same id
// still matches; one that has since changed is shown as no longer in the list.
export function markWritten(storage, { id, title, base }) {
  try { storage.setItem(LAST_WRITTEN_KEY, JSON.stringify({ id, title, base, at: new Date().toISOString() })); }
  catch { /* no storage: the hint is for this session only */ }
  return readWritten(storage);
}

export function forgetWritten(storage = typeof localStorage === "undefined" ? {} : localStorage) {
  try { storage.removeItem(LAST_WRITTEN_KEY); } catch { /* nothing to forget */ }
}

