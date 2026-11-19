// The mod patcher: mod files, and building a modded firmware from Valeton's own image. Uses the local stock file
// if there is one (never committed); the patch here is a test-only text change, never flashed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readModFile, modFile, buildMod, stockVersion, stockSections, MODS } from "../src/lib/mods.js";
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

// where a section's data starts in the container (for making a modified copy in memory)
function findSection(img, type) {
  const count = img[0x22], baseOff = 0x38 + 16 * count;
  for (let i = 0; i < count; i++) {
    const o = 0x38 + 16 * i;
    if (img[o + 3] === type) return baseOff + (img[o + 8] | (img[o + 9] << 8) | (img[o + 10] << 16) | (img[o + 11] << 24));
  }
  throw new Error("no section");
}
