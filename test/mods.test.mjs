// The mod patcher: mod files, and building a modded firmware from Valeton's own image. Uses the local stock file
// if there is one (never committed); the patch here is a test-only text change, never flashed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readModFile, modFile, buildMod, stockVersion, stockSections, MODS, STOCK_DSP, dspAlternatives, knownMod, lastWritten, markWritten } from "../src/lib/mods.js";
import { inspect } from "../src/lib/gp5flash.js";

const IMG = fileURLToPath(new URL("../../../firmware/GP-5_USB_V1.0.6_20250626.bin", import.meta.url));
const have = existsSync(IMG), image = have ? new Uint8Array(readFileSync(IMG)) : null;
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const base = { format: "gp5-mod", version: 1, id: "t", title: "Test", base: "1.0.6" };
// "GP-5 Audio" in the app (the change the 2026-11-06 hardware test made), here only as test data
const TEXT = { section: "app", offset: "0x102aec", before: "47502d3520417564696f", after: "54657374696e67203132", note: "test" };

test("mod files: read, write, refuse what isn't allowed", () => {
  const m = readModFile(enc({ ...base, patches: [TEXT] }));
  assert.equal(m.patches[0].offset, 0x102AEC);
  assert.deepEqual(readModFile(modFile(m)).patches[0].after, m.patches[0].after);
  assert.equal(m.warn, "", "a file that says nothing extra about playing through it");
  assert.equal(readModFile(modFile(MODS[0])).warn, MODS[0].warn, "a mod's warn line travels in the file");
  const bad = (patches, re, extra = {}) => assert.throws(() => readModFile(enc({ ...base, ...extra, patches })), re);
  bad([TEXT], /doesn't know/, { base: "9.9" });
  bad([], /changes nothing/);
  bad([{ ...TEXT, section: "models" }], /only change the app, the presets or the DSP/);
  bad([{ ...TEXT, after: "00" }], /length/);
  bad([{ ...TEXT, before: "zz" }], /hex/);
  assert.throws(() => readModFile(enc({ ...base, version: 2, patches: [TEXT] })), /newer/);
  assert.throws(() => readModFile(new TextEncoder().encode("hello")), /isn't a GP-5 mod/);
});

test("the USB-audio mod: two bytes of the DSP program, only there", { skip: !have && "no local stock firmware" }, () => {
  const mod = MODS.find((m) => m.id === "usb-no-passthrough");
  const built = buildMod(image, mod);
  assert.deepEqual(built.sections.map(([t]) => t), [0x63]);
  const orig = inspect(image).sections.find(([t]) => t === 0x63)[1], dsp = built.sections[0][1];
  const diffs = []; for (let i = 0; i < orig.length; i++) if (orig[i] !== dsp[i]) diffs.push(i);
  assert.deepEqual(diffs, [0xB8A4, 0xB8CE]);
  assert.ok(diffs.every((i) => orig[i] === 0x00 && dsp[i] === 0x20));
  // the DSP program's header / vector table is off limits
  assert.throws(() => buildMod(image, readModFile(enc({ ...base, patches: [{ section: "dsp", offset: 0x10, before: Buffer.from(orig.subarray(0x10, 0x12)).toString("hex"), after: "0000" }] }))), /start-up/);
  assert.deepEqual(stockSections(image, true).map(([t]) => t).sort((a, b) => a - b), [0x62, 0x63, 0x65]);
});

test("built-in mods survive being written to a mod file and read back", () => {
  for (const m of MODS) {
    const back = readModFile(modFile(m));
    assert.equal(back.title, m.title);
    assert.equal(back.summary, m.summary, `"${m.id}" tells too much for a mod file to hold`);
    assert.deepEqual(back.patches.map((p) => [p.section, p.offset, Buffer.from(p.after).toString("hex")]),
                     m.patches.map((p) => [p.section, p.offset, p.after]));
  }
});

test("built-in mods in research can't be installed", () => {
  for (const m of MODS.filter((x) => x.status === "research")) assert.throws(() => buildMod(new Uint8Array(10), m), /isn't ready/);
});

const dspMod = (id) => { const b = buildMod(image, MODS.find((m) => m.id === id)); assert.deepEqual(b.sections.map(([t]) => t), [0x63]); return b.sections[0][1]; };
const stock63 = have ? inspect(image).sections.find(([t]) => t === 0x63)[1] : null;
const changed = (b) => { const at = []; for (let i = 0; i < stock63.length; i++) if (stock63[i] !== b[i]) at.push(i); return at; };

test("the dry guitar mod: the two pack words, and nothing else", { skip: !have && "no local stock firmware" }, () => {
  const m = dspMod("usb-dry-out");
  assert.deepEqual(m.subarray(0xB4C0, 0xB4C4), new Uint8Array([0x60, 0x1f, 0x00, 0x20]));   // 0x20001F60
  assert.deepEqual(m.subarray(0xB904, 0xB908), new Uint8Array([0x60, 0x1d, 0x00, 0x20]));   // 0x20001D60
  assert.deepEqual(changed(m), [0xB4C1, 0xB905]);
  assert.equal(stock63[0xB4C1], 0x1e); assert.equal(stock63[0xB905], 0x1e);
  for (const at of [0xB8A4, 0xB8CE]) assert.deepEqual(m.subarray(at, at + 4), stock63.subarray(at, at + 4));  // Valeton's outputs
});

test("the dry guitar with quiet outputs: what the other two mods change, added up", { skip: !have && "no local stock firmware" }, () => {
  const dry = dspMod("usb-dry-out"), quiet = dspMod("usb-no-passthrough"), both = dspMod("usb-dry-out-and-return");
  assert.deepEqual(changed(both), [0xB4C1, 0xB8A4, 0xB8CE, 0xB905]);
  for (let i = 0; i < stock63.length; i++) {
    const changedByOne = dry[i] !== stock63[i] || quiet[i] !== stock63[i], hex = "0x" + i.toString(16);
    if (changedByOne) assert.notEqual(both[i], stock63[i], `${hex}: one of the two changes it, so this one must too`);
    else assert.equal(both[i], stock63[i], `${hex}: neither of the two touches it, so this one must not`);
    assert.ok(both[i] === dry[i] || both[i] === quiet[i], `${hex}: not a byte either of the other mods puts there`);
  }
});

// going back to Valeton's own DSP program the same way as switching between mods: that one section, as it is
test("Valeton's own DSP program: the fast way back, the same door as the mods", { skip: !have && "no local stock firmware" }, () => {
  const built = buildMod(image, STOCK_DSP);
  assert.deepEqual(built.sections.map(([t]) => t), [0x63]);
  assert.deepEqual(Array.from(built.sections[0][1]), Array.from(stock63), "nothing changed in it");
  assert.equal(built.plan.length, 0);
  assert.equal(built.all.length, 5, "Undo still has the whole image behind it");
  assert.ok(!dspAlternatives([STOCK_DSP, ...MODS]).includes(STOCK_DSP), "it isn't a mod: the screen puts the row in itself");
  assert.throws(() => buildMod(image, { ...STOCK_DSP, stockDsp: false }), /isn't ready/, "only that row may write an unchanged section");
});

test("building a mod from Valeton's image", { skip: !have && "no local stock firmware" }, () => {
  assert.equal(stockVersion(image), "1.0.6");
  const m = readModFile(enc({ ...base, patches: [TEXT] }));
  const built = buildMod(image, m);
  assert.deepEqual(built.sections.map(([t]) => t), [0x62]);
  assert.equal(built.all.length, 5);
  const app = built.sections[0][1];
  assert.equal(new TextDecoder().decode(app.subarray(0x102AEC, 0x102AF6)), "Testing 12");
  const orig = inspect(image).sections.find(([t]) => t === 0x62)[1];
  let diff = 0; for (let i = 0; i < orig.length; i++) if (orig[i] !== app[i]) diff++;
  assert.equal(diff, 10);
  assert.equal(new TextDecoder().decode(orig.subarray(0x102AEC, 0x102AF6)), "GP-5 Audio");     // the user's file is untouched
  assert.equal(built.all.find(([t]) => t === 0x62)[1], app);
  // checks
  assert.throws(() => buildMod(image, readModFile(enc({ ...base, patches: [{ ...TEXT, before: "00".repeat(10) }] }))), /doesn't contain/);
  assert.throws(() => buildMod(image, readModFile(enc({ ...base, patches: [{ ...TEXT, offset: 8, before: Buffer.from(orig.subarray(8, 10)).toString("hex"), after: "0000" }] }))), /start-up/);
  assert.throws(() => buildMod(image, readModFile(enc({ ...base, patches: [TEXT, { ...TEXT, offset: "0x102aed", before: "502d", after: "0000" }] }))), /overlap/);
  assert.throws(() => buildMod(new Uint8Array(100), m), /isn't a GP-5 firmware/);
  // a modded image isn't "Valeton's original": no mod on a mod, and no undo from it
  const modded = image.slice(), off = findSection(image, 0x62) + 0x102AEC;
  modded.set(new TextEncoder().encode("Testing 12"), off);
  assert.equal(stockVersion(modded), null);
  assert.deepEqual(stockSections(image, true).map(([t]) => t).sort((a, b) => a - b), [0x62, 0x63, 0x65]);
  assert.equal(stockSections(image, false).length, 5);
});

// the Mods screen's "USB routing" list: everything that only rewrites the DSP program can be swapped for another
// there, in seconds; mods that touch the app or the user's presets can't.
const alt = (id, status, patches) => ({ id, title: id, status, base: "1.0.6", patches });
test("the DSP program's alternatives: what may be swapped in the USB routing list", () => {
  const only = (id) => alt(id, "ready", [{ section: 0x63, offset: 8, before: "00", after: "01" }]);
  const mix = alt("app-and-dsp", "ready", [{ section: 0x63, offset: 8, before: "00", after: "01" }, { section: 0x62, offset: 0x200, before: "00", after: "01" }]);
  const presets = alt("preset-level", "ready", [{ section: 0x65, offset: 0x2000, before: "00", after: "01" }]);
  const got = dspAlternatives([only("one"), mix, only("two"), alt("later", "research", [{ section: 0x63, offset: 8, before: "00", after: "01" }]),
                               alt("try", "untested", [{ section: 0x63, offset: 8, before: "00", after: "01" }]), presets, only("one")]);
  assert.deepEqual(got.map((m) => m.id), ["one", "two", "try"]);
  assert.deepEqual(dspAlternatives(MODS).map((m) => m.id),
                   MODS.filter((m) => m.status !== "research").map((m) => m.id), "the built-in mods are USB routing choices");
});

// The routing list reads as two questions, because every title answers them in the same words: what the USB gets,
// and what the outputs play. "monitoring" is in none of them on purpose (lib/mods.js says why: Valeton's own
// Monitor Level is the gain of what comes back over USB, a knob anyone can turn, and these mods are not that).
test("the USB routing titles: both answers, in the same words, and no routing twice", () => {
  const shape = /^USB sends (the preset|the dry guitar), the outputs play (the pedal|only what comes back)$/;
  const cells = new Set();
  for (const m of dspAlternatives(MODS)) {
    const two = shape.exec(m.title);
    assert.ok(two, `"${m.title}" doesn't give both answers in the same words`);
    cells.add(`${two[1]} -> ${two[2]}`);
  }
  assert.deepEqual([...cells].sort(), ["the dry guitar -> only what comes back", "the dry guitar -> the pedal",
                                       "the preset -> only what comes back"]);
  assert.ok(!cells.has("the preset -> the pedal"), "that one is Valeton's own, which isn't a mod: the screen's Valeton row says it");
});

// Two of those three leave the outputs playing nothing but what the computer sends back, which is the one thing a
// player can be caught out by: switching is one click and a few seconds, and unplugging the USB cable doesn't undo
// it. So the mod says it once in its own words (lib/mods.js "warn"), and the screen repeats that in the routing row
// and in the confirm, where the click happens.
test("the mods that leave the pedal silent say so, and the one that doesn't stays quiet", () => {
  for (const m of dspAlternatives(MODS)) {
    const silent = /only what comes back$/.test(m.title);
    if (silent) assert.match(m.warn || "", /silent|quiet/, `"${m.title}": the row and the confirm warn, because the pedal makes no sound on its own`);
    else assert.ok(!m.warn, `"${m.title}": the outputs still play the pedal, so there is nothing to warn about`);
  }
});

// One mod, one row. A mod's id is its name, so a shared .gp5mod file that carries a built-in mod's id is either the
// same mod under older words (then Launchpad's own copy is the one to show: its name is the current one, and two
// rows would only be two ways of writing the same bytes) or a different mod wearing another mod's name (then it
// doesn't go in the list: its row would promise bytes it doesn't write, and the USB routing list couldn't say which
// one its row writes). Files on other people's computers can't bring back a name Launchpad stopped using.
test("a mod file Launchpad already has: the same mod, or a name that's taken", () => {
  const json = (o) => new TextEncoder().encode(JSON.stringify(o));
  const fileOf = (m) => JSON.parse(new TextDecoder().decode(modFile(m)));
  for (const m of MODS) {
    const k = knownMod(readModFile(modFile(m)));
    assert.equal(k.why, "same", `${m.id}: read back from a file it is the same mod, whatever the file calls it`);
    assert.equal(k.mod, m, "and it is Launchpad's own row that shows");
  }
  const one = fileOf(MODS[0]);
  assert.equal(knownMod(readModFile(json({ ...one, patches: one.patches.slice(0, 1) }))).why, "clash", "one change short is another mod");
  assert.equal(knownMod(readModFile(json({ ...one, patches: [...one.patches].reverse(), title: "An old name", summary: "older words", author: "someone" }))).why,
               "same", "only the bytes count, not the order or the words");
  assert.equal(knownMod({ ...MODS[0], base: "1.0.5" }, MODS).why, "clash", "the same bytes on another Valeton version is another mod");
  assert.equal(knownMod(readModFile(enc({ ...base, patches: [TEXT] }))), null, "a name Launchpad doesn't have: the file belongs in the list");
  assert.equal(knownMod(readModFile(enc({ ...base, id: "stock", patches: [{ section: "dsp", offset: "0x200", before: "00", after: "01" }] }))).mod.id,
               "stock", "Valeton's own row keeps its name too");
  assert.deepEqual(MODS.map((m) => m.id), [...new Set(MODS.map((m) => m.id))], "built-in mods have one name each");
  assert.ok(MODS.every((m) => m.id !== STOCK_DSP.id), "and none of them is Valeton's own row");
});

// The Mods screen makes that call when a file is opened (views/mods.js loadModFile): nothing joins the list, and the
// message says why in the words Launchpad uses now. This is the whole point of the merge: someone with a file from
// before the names changed gets one row, with the current name, not two rows with a stale one.
test("opening a mod file the Mods screen already has: one row, Launchpad's name", async () => {
  const { loadModFile } = await import("../src/views/mods.js");
  const bytes = (o) => new TextEncoder().encode(JSON.stringify(o));
  const old = { ...JSON.parse(new TextDecoder().decode(modFile(MODS[1]))), title: "USB sends the dry guitar", summary: "older words", author: "a friend" };
  const same = loadModFile(bytes(old));
  assert.equal(same.mod, null, "no second row for a mod Launchpad already lists");
  assert.ok(same.note.ok, "that isn't an error, so it reads as news");
  assert.ok(same.note.text.includes(MODS[1].title), "the row that stays has Launchpad's current name, not the file's older one");
  const clash = loadModFile(bytes({ ...old, patches: [old.patches[0]] }));
  assert.equal(clash.mod, null, "and a different mod wearing the same id is not quietly accepted either");
  assert.equal(clash.note.ok, false);
  assert.match(clash.note.text, /different id/);
  const fresh = loadModFile(enc({ ...base, id: "quiet", title: "Quiet", patches: [TEXT] }));
  assert.equal(fresh.mod.id, "quiet", "a mod Launchpad doesn't know still joins the list");
  assert.equal(fresh.note, null, "with nothing to explain");
  const other = loadModFile(enc({ ...JSON.parse(new TextDecoder().decode(modFile(fresh.mod))), patches: [{ ...TEXT, after: "54657374696e67203133" }] }), [fresh.mod]);
  assert.equal(other.mod, null, "a second file with that id doesn't swap the first out without a word");
  assert.equal(other.note.ok, false, "and it's the same clash as with a built-in mod");
  const twice = loadModFile(enc({ ...base, id: "quiet", title: "Quiet under another name", patches: [TEXT] }), [fresh.mod]);
  assert.equal(twice.mod, null, "the same file opened twice is one row");
  assert.ok(twice.note.ok, "said as news, not as an error");
  assert.match(twice.note.text, /Quiet(?! under)/, "the row that stays is the one already open, not the file's newer name");
});

// what this computer last wrote (the screen's only hint: the pedal can't tell us, lib/mods.js says why)
const memStore = () => { const map = new Map(); return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) }; };
test("what this Launchpad last wrote: a hint, kept on this computer", () => {
  const s = memStore();
  assert.equal(lastWritten(s), null);
  const one = { id: "usb-dry-out", title: "USB sends the dry guitar, the outputs play the pedal", base: "1.0.6" };
  markWritten(s, one);
  assert.equal(lastWritten(s).id, "usb-dry-out");
  assert.ok(lastWritten(s).at, "it says when");
  markWritten(s, { id: "stock", title: "Valeton's original", base: "1.0.6" });
  assert.equal(lastWritten(s).id, "stock");
  s.setItem("mods-last-written-v1", "{ not json");
  assert.equal(lastWritten(s), null);
  const broken = { getItem: () => { throw new Error("no storage"); }, setItem: () => { throw new Error("no storage"); }, removeItem: () => {} };
  assert.equal(lastWritten(broken), null);
  assert.equal(markWritten(broken, one), null, "writing is never stopped by a broken hint");
  assert.equal(lastWritten(), null, "no localStorage in the environment: no hint, no error");
});

// where a section's data starts in the container (for making a modified copy in memory)
function findSection(img, type) {
  const count = img[0x22], baseOff = 0x38 + 16 * count;
  for (let i = 0; i < count; i++) {
    const o = 0x38 + 16 * i;
    if (img[o + 3] === type) return baseOff + (img[o + 8] | (img[o + 9] << 8) | (img[o + 10] << 16) | (img[o + 11] << 24));
  }
  throw new Error("no section");
}
