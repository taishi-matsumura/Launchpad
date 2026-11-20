// The T2 probe console's bytes (src/lib/linkprobe.js), checked against what the disassembly and a real GP-5's
// 0x10 reply showed, and end to end against the simulated stock pedal: write a record, read it back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SimPedal } from "../src/lib/sim.js";
import { readGlobals, command } from "../src/lib/stockpresets.js";
import { MODE_STOCK } from "../src/lib/gp5flash.js";
import { recId, recName, setGlobal, GLOBALS_READ, linkFrame, linkInject, pushedSetGlobal, describeMessage, fmtValue, PROBE_RECORDS } from "../src/lib/linkprobe.js";

async function pedal() {
  const sim = new SimPedal({ mode: MODE_STOCK });
  const [name] = await sim.names();
  return { sim, link: await sim.open(name) };
}

test("the global-record frames are Valeton's own", () => {
  assert.deepEqual(GLOBALS_READ, [0x12, 0x10]);
  // [11 11 a b 00 00 u32le], the shape a real SET_GLOBAL had (brief §13).
  assert.deepEqual(setGlobal(recId(7, 4), 2), [0x11, 0x11, 0x07, 0x04, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]);
  assert.deepEqual(pushedSetGlobal(Uint8Array.from(setGlobal(recId(4, 4), 3))), { id: recId(4, 4), value: 3 });
  assert.equal(pushedSetGlobal(Uint8Array.from([0x12, 0x43, 0, 0])), null);
});

test("the DSP link frame is cmd, length 8, arg — little-endian", () => {
  assert.deepEqual(linkFrame(0x6001, 2), [0x01, 0x60, 0x08, 0x00, 0x02, 0x00, 0x00, 0x00]);
  assert.deepEqual(linkInject(linkFrame(0x6001, 0)), [0x7e, 0x00, 0x01, 0x60, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
});

test("probe records are the ones no Valeton app maps, keyed (a,b) as u16", () => {
  assert.deepEqual(PROBE_RECORDS.map((p) => p.id), [recId(7, 4), recId(4, 4), recId(3, 4), recId(2, 1), recId(1, 2)]);
  assert.equal(recName(recId(7, 4)), "(7, 4)");
  assert.equal(fmtValue(new Uint8Array([3, 0])), "03 00");       // (7,4) is 2 bytes on the real pedal
});

test("describeMessage names what arrives on the wire", () => {
  assert.match(describeMessage(Uint8Array.from(setGlobal(recId(7, 4), 1))), /^record \(7, 4\) = 1 — written by the pedal/);
  assert.match(describeMessage(Uint8Array.from([0x14, 0x08, 0x00])), /^acknowledged/);
  assert.match(describeMessage(Uint8Array.from([0x14, 0x08, 0x01])), /refused, status 1/);
  assert.equal(fmtValue(42), "42");
});

test("the simulated stock pedal keeps what the console writes, and readGlobals shows it back", async () => {
  const { link } = await pedal();
  const g0 = await readGlobals(link);
  assert.equal(fmtValue(g0.get(recId(7, 4))), "03 00");          // the values captured from a real pedal
  assert.equal(fmtValue(g0.get(recId(4, 4))), "01");             // 1 byte, as on the real pedal
  assert.equal(await command(link, setGlobal(recId(7, 4), 2)), true);   // the pedal acknowledges
  assert.equal((await readGlobals(link)).get(recId(7, 4)), 2);          // and keeps the write as int32
  assert.equal(fmtValue((await readGlobals(link)).get(recId(4, 4))), "01");   // neighbours untouched
  link.close();
});
