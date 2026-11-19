// Changing firmware (lib/change.js) on the simulated pedal: the storage is wiped for another firmware, kept for the
// same one, and left ready for Valeton's firmware (erased presets, order table 0..99).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SimPedal, fastTiming } from "../src/lib/sim.js";
import * as F from "../src/lib/gp5flash.js";
import { locate, identify } from "../src/lib/device.js";
import { writeFile } from "../src/lib/gp5files.js";
import { changeFirmware } from "../src/lib/change.js";
import { imageKind } from "../src/lib/storage.js";
import { fourcc } from "../src/lib/gp5store.js";

fastTiming();
const FW = (f) => new Uint8Array(readFileSync(new URL(`../src/firmware/${f}`, import.meta.url)));

async function setup() {
  const p = new SimPedal({ firmware: "nam", platform: "0.5.0", identity: true });
  const name = (await locate(p)).name, link = await p.open(name);
  const state = { pedal: { name, mode: F.MODE_OPEN, firmware: await identify(link) }, link, busy: null };
  const ctx = { state, answer: "flash",
    choose: async () => ctx.answer, confirm: async () => true,
    withLink: async (_l, fn) => fn(state.link),
    withPorts: async (_l, fn) => { const r = await fn(p); state.pedal = { name: (await locate(p)).name, mode: r, firmware: null }; return r; } };
  await writeFile(link, fourcc("AMPB"), "tone-01", new Uint8Array(4448).fill(7));
  p.flash[0x170000] = 3; p.flash[0x185000] = 9;
  return { p, ctx };
}
const areaBlank = (p) => p.flash.subarray(0x13F000, 0x18A000).every((v) => v === 0xFF);

test("image kinds", () => {
  assert.equal(imageKind(FW("GP-5_dreamcatcher.bin")).kind, "dreamcatcher");
  assert.equal(imageKind(FW("GP-5_tuner.bin")).kind, "tuner");
});

test("another firmware: asked, then everything wiped", async () => {
  const { p, ctx } = await setup();
  const r = await changeFirmware(ctx, { imageBytes: FW("GP-5_dreamcatcher.bin"), sections: F.inspect(FW("GP-5_dreamcatcher.bin")).sections, backupNow: async () => true, say: () => {} });
  assert.equal(r.wiped, true);
  assert.ok(areaBlank(p));
});

test("cancel: nothing happens", async () => {
  const { p, ctx } = await setup();
  ctx.answer = "cancel";
  assert.equal(await changeFirmware(ctx, { imageBytes: FW("GP-5_dreamcatcher.bin"), sections: [], backupNow: async () => true, say: () => {} }), null);
  assert.equal(p.flash[0x170000], 3);
});

test("back to Valeton: area wiped, order table 0..99", async () => {
  const { p, ctx } = await setup();
  const r = await changeFirmware(ctx, { target: { kind: "stock", title: "Valeton's firmware" }, sections: F.inspect(FW("GP-5_tuner.bin")).sections.filter(([t]) => t === 0x63),
    backupNow: async () => true, say: () => {} });
  assert.equal(r.wiped, true);
  assert.deepEqual(Array.from(p.flash.subarray(0x170000, 0x170064)), Array.from({ length: 100 }, (_, i) => i));
  assert.ok(p.flash.subarray(0x170064, 0x18A000).every((v) => v === 0xFF));
  assert.ok(p.flash.subarray(0x13F000, 0x170000).every((v) => v === 0xFF));
});

// The Mods screen's USB routing list: rewriting the DSP program alone, on a pedal already running Valeton's
// firmware, changes no ownership, so nothing is asked and nothing is wiped (views/mods.js relies on that).
test("the same firmware again: no question, no wipe, one section written", async () => {
  const p = new SimPedal({ mode: F.MODE_STOCK });
  const [name] = await p.names(), state = { pedal: { name, mode: F.MODE_STOCK, firmware: null }, link: null, busy: null };
  const ctx = { state, asked: 0,
    choose: async () => { ctx.asked++; return "flash"; },
    withPorts: async (_l, fn) => fn(p) };
  const dsp = new Uint8Array(0x800).fill(0x11); dsp[0x100] = 0x22;
  const r = await changeFirmware(ctx, { sections: [[0x63, dsp]], target: { kind: "stock", title: "Valeton's firmware with a mod" },
    backupNow: async () => true, say: () => {}, progress: () => {} });
  assert.equal(ctx.asked, 0, "the same firmware doesn't lose anything: nothing to ask");
  assert.equal(r.wiped, false);
  assert.equal(r.mode, F.MODE_STOCK);
  assert.deepEqual(Array.from(p.written[0x63]), Array.from(dsp));
  assert.equal(p.written[0x62], undefined, "only the DSP section went over MIDI");
  assert.equal(Object.keys(p.written).length, 1);
});
