// Mods: changes to Valeton's stock firmware, built in or from shared .gp5mod files, installed from the user's own
// stock image (lib/mods.js). Undo = put Valeton's original back from the same file.
import * as F from "../lib/gp5flash.js";
import { MODS, STOCK_DSP, BUILT_INS, buildMod, readModFile, stockSections, stockVersion, dspAlternatives, knownMod, lastWritten, markWritten } from "../lib/mods.js";
import { changeFirmware } from "../lib/change.js";
import { catalogFromImage, saveCatalog, loadSavedCatalog } from "../lib/stockcat.js";
import { readGlobals, command } from "../lib/stockpresets.js";
import { cmd } from "../lib/device.js";
import * as P from "../lib/linkprobe.js";
import { backupNow } from "./backups.js";

const ui = { result: null, log: [], progress: null, loaded: [] };
const pr = { vals: null, log: [], watch: false, timer: null, ticking: false };   // the DSP link probe console
const SECTION = { 0x62: "app", 0x65: "presets", 0x63: "DSP" };
const DSP = "DSP program (49,992 bytes)";
const raw = (b) => (typeof b === "string" ? b.replace(/\s+/g, "").match(/../g).map((x) => parseInt(x, 16)) : Array.from(b));
const changed = (p) => { const a = raw(p.before), b = raw(p.after); return a.filter((v, i) => v !== b[i]).length; };

// What a mod changes, and the way back when it isn't in the routing list; the routing list itself is the one that
// picks between the mods that only change the DSP program, so on a pedal running Valeton's firmware its Install
// button would only be a slower way of pressing the row above.
function card(ctx, m, fromFile, alts) {
  const { esc, icon, state } = ctx, ready = m.status !== "research";
  const changes = ready ? m.patches.length : 0, bytes = m.patches.reduce((n, p) => n + changed(p), 0);
  const onStock = state.pedal?.mode === F.MODE_STOCK;
  const viaRouting = onStock && alts.some((x) => x.id === m.id);
  const remove = `<button class="btn ghost" data-drop="${esc(m.id)}">Remove from the list</button>`;
  const buttons = !ready ? `<div class="note">${icon("info-circle", 16)}<span>Not available yet.</span></div>`
    : viaRouting ? (fromFile ? `<div class="row">${remove}</div>` : "")
    : `<div class="row"><button class="btn primary" data-mod="${esc(m.id)}" data-file="${fromFile ? 1 : 0}" ${state.pedal && !state.busy ? "" : "disabled"}>${icon("download")} Install</button>${fromFile ? ` ${remove}` : ""}</div>`;
  return `<section class="card w-mods"><div class="stack">
    <div class="card-head" style="margin-bottom:0"><h2>${icon("puzzle", 18)} ${esc(m.title)}</h2>
      <span class="row" style="gap:6px">${m.status === "untested" ? '<span class="pill">not yet tested on a pedal</span>' : ""}<span class="pill world">${ready ? `for Valeton V${esc(m.base)}` : "in research"}</span>${viaRouting ? `<span class="pill">${icon("arrows-exchange", 13)} USB routing</span>` : ""}</span></div>
    ${m.summary ? `<p class="muted">${esc(m.summary)}</p>` : ""}
    ${ready ? `<p class="faint" style="font-size:12.5px">${fromFile ? `From a file${m.author ? ` by ${esc(m.author)}` : ""} · ` : ""}${changes} change${changes === 1 ? "" : "s"}, ${bytes} byte${bytes === 1 ? "" : "s"}</p>` : ""}
    ${fromFile ? `
      ${m.warn ? `<p class="muted">${esc(m.warn)}</p>` : ""}
      ${m.patches.some((p) => p.note) ? `<ul class="muted" style="font-size:12.5px;margin:0 0 0 18px">${m.patches.filter((p) => p.note).slice(0, 8).map((p) => `<li>${esc(SECTION[p.section])} @ 0x${p.offset.toString(16)}: ${esc(p.note)}</li>`).join("")}</ul>` : ""}
      <div class="note warn">${icon("alert-triangle", 16)}<span>A mod file can change anything in the firmware it patches. Only install mods from people you trust. Recovery always works: hold the foot switch and PARA while plugging in.</span></div>` : ""}
    ${viaRouting ? `<p class="faint" style="font-size:12.5px">Switch this one in the USB routing list above: a few seconds for the ${DSP}, presets and settings stay. Install is here for a pedal that isn't running Valeton's firmware, where the whole firmware has to be rewritten instead.</p>` : ""}
    ${buttons}
  </div></section>`;
}

// The alternatives that only change the DSP program, plus Valeton's own DSP program as the choice that isn't a mod.
const variants = (loaded) => [STOCK_DSP, ...dspAlternatives([...MODS, ...loaded])];

// One row of the USB routing list. The pill marks what this computer last wrote (lib/mods.js says why that's all
// Launchpad can know); picking a row rewrites the DSP section from the user's stock image, so what's written is
// right whatever the pill says. A row can also be a mod somebody shared as a file, which Launchpad has never seen
// running: that's a pill of its own, and the mod's warn line (lib/mods.js) goes in the row too, because this button
// is one click and a few seconds.
function altTile(ctx, m, cur, onStock, busy, fromFile) {
  const { esc, icon } = ctx;
  const here = cur === m.id, stock = !!m.stockDsp;
  const sub = stock ? "USB sends the preset, the outputs play the pedal and what comes back: Valeton's own. Picking it "
                    + "puts any of these back, in the same few seconds."
    : [`${m.patches.length} change${m.patches.length === 1 ? "" : "s"} to Valeton V${esc(m.base)}`, m.warn && esc(m.warn)]
        .filter(Boolean).join(" · ");
  const pill = here ? '<span class="pill now">written here</span>'
    : fromFile ? `<span class="pill">${icon("file-import", 13)} from a file${m.author ? ` by ${esc(m.author)}` : ""}</span>`
    : m.status === "untested" ? '<span class="pill">not yet tested on a pedal</span>' : "";
  return `<div class="item tall${here ? " sel" : ""}"><span class="main">
      <span class="name">${esc(m.title)}</span>${pill ? `<span class="row" style="gap:6px;margin-top:3px">${pill}</span>` : ""}
      <span class="sub clamp2">${sub}</span></span>
    <button class="btn ${here ? "ghost" : "primary"}" data-alt="${esc(m.id)}" ${onStock && !busy ? "" : "disabled"}
      title="${onStock ? `Rewrite the whole ${DSP} from your Valeton file: presets and settings stay` : "Only for a pedal running Valeton's firmware"}">${icon("arrows-exchange", 15)} ${here ? "Write again" : "Switch"}</button></div>`;
}

function routing(ctx, loaded) {
  const { esc, icon, state } = ctx;
  const alts = variants(loaded), onStock = state.pedal?.mode === F.MODE_STOCK, wrote = lastWritten();
  const cur = wrote && (wrote.id === "stock" || alts.some((m) => m.id === wrote.id)) ? wrote.id : null;
  return `<section class="card"><div class="card-head"><h2>${icon("arrows-exchange", 18)} USB routing</h2>
      <span class="pill world">${alts.length} choices</span></div>
    <p class="muted">Which of these the pedal runs is decided by its DSP program, not by a setting: Valeton's own
      settings and app only have levels. Every name says the two things that differ: what the pedal sends over USB
      (its preset, or the dry guitar) and what the outputs play (the pedal, or only what the computer sends back).
      Picking one rewrites the ${DSP} from Valeton's file on this computer: a few
      seconds, and the presets and settings stay. Where one needs saying — that the outputs go quiet until the
      computer sends something back — the row says it, and says it again before writing; a row that came from
      somebody's file is marked as one. The Valeton row writes Valeton's own program back the same way, so
      it puts any of these back; the Undo below also rewrites the app and preset parts, for a mod that changed those.
      The pedal can't say what it runs now, so Launchpad only says what it wrote here itself${wrote ? `, ${esc(String(wrote.at || "").slice(0, 10))}` : ""}.</p>
    ${onStock ? "" : `<div class="note warn">${icon("info-circle", 16)}<span>Pick one of these when the pedal is running Valeton's firmware${state.pedal ? " — this one isn't, so its whole firmware would have to be rewritten, which is what the buttons below do" : ""}.</span></div>`}
    <div class="list" style="margin-top:10px">${alts.map((m) => altTile(ctx, m, cur, onStock, state.busy, loaded.some((x) => x.id === m.id))).join("")}</div></section>`;
}

// The DSP link probe console (T2 research): Valeton's DSP has USB routing modes and its app firmware keeps the
// mode in one saved byte, pushed to the DSP as link frame 0x6001 — by a screen inside the pedal and at power-on,
// never from USB (lib/linkprobe.js says what the disassembly showed and what this console can still ask).
function probeConsole(ctx) {
  const { esc, icon, state } = ctx, live = !!state.link && !state.busy;
  const rows = P.PROBE_RECORDS.map((r) => {
    const v = pr.vals ? pr.vals.get(r.id) : undefined;
    return `<div class="item"><span class="main"><span class="name">${esc(P.recName(r.id))}${v !== undefined ? ` = ${esc(P.fmtValue(v))}` : " (not read yet)"}</span>
        ${r.note ? `<span class="sub">${esc(r.note)}</span>` : ""}</span>
      <span class="row" style="gap:6px"><select data-rec="${r.id}" aria-label="value for record ${esc(P.recName(r.id))}">${
        [0, 1, 2, 3].map((x) => `<option value="${x}"${x === r.def ? " selected" : ""}>${x}</option>`).join("")}</select>
        <button class="btn" data-set="${r.id}" ${live ? "" : "disabled"}>${icon("upload", 15)} Write</button></span></div>`;
  }).join("");
  const frames = [...P.MODE_FRAMES, P.DSP_PING].map((f, i) =>
    `<button class="btn ghost" data-frame="${i}" ${live ? "" : "disabled"} title="7E 00 ${esc(P.hex(f.payload.slice(2)))} — only OpenGP5 firmware bridges this">${esc(f.label)}</button>`).join("");
  return `<section class="card w-mods"><div class="stack">
    <div class="card-head" style="margin-bottom:0"><h2>${icon("ripple", 18)} DSP link probe</h2>
      <span class="row" style="gap:6px"><span class="pill world">research</span>${pr.watch ? '<span class="pill now">listening</span>' : ""}</span></div>
    <p class="muted">Valeton's DSP does have USB routing modes 0-3, and its app firmware keeps the mode in one saved
      byte: a screen inside the pedal switches it — which Valeton's own menus never name — and the app then sends
      frame 0x6001 with the mode to the DSP over the link between the two chips, at power-on and when that screen
      changes. Nothing on USB asks for it. This console tries the doors USB does leave open: it writes the global
      records no Valeton app maps and reads them back — did the pedal keep the value, and do you hear the routing
      change? — and it listens for records the pedal writes by itself, which is how you'd catch that screen being
      used. The link-frame buttons are only answered by OpenGP5's firmware; on Valeton's they send and nothing
      answers, and nothing changes.</p>
    <div class="list" style="margin-top:6px">${rows}</div>
    <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:8px">
      <button class="btn" data-act="recs" ${live ? "" : "disabled"}>${icon("list", 15)} Read the records</button>
      <button class="btn ghost" data-act="defaults" ${live ? "" : "disabled"}>${icon("restore", 15)} Restore the captured values</button>
      <label class="row" style="gap:6px;margin-left:auto;font-size:13px;cursor:pointer"><input type="checkbox" id="prwatch" ${pr.watch ? "checked" : ""}> Listen for writes</label>
    </div>
    <div class="row" style="margin-top:12px;flex-wrap:wrap;gap:8px;align-items:center">
      <span class="muted" style="font-size:12.5px">DSP link frames, OpenGP5 firmware only:</span>${frames}
      <input type="text" id="prhex" placeholder="7e 00 01 60 08 00 01 00 00 00" aria-label="payload to send, in hex"
        style="flex:1;min-width:220px;font-family:var(--mono,monospace)"><button class="btn ghost" data-act="raw" ${live ? "" : "disabled"}>Send payload</button></div>
    ${pr.log.length ? `<div class="log">${esc(pr.log.join("\n"))}</div>` : ""}
  </div></section>`;
}

// Opening a .gp5mod file. A mod's id is its name, so a file that carries one Launchpad already has doesn't join the
// list as another row: with the same changes it is the same mod under another (often older) name, and Launchpad's
// own row is the one that shows and writes it; with different changes it is a different mod that has to say so in a
// new id, because a row can't promise bytes it doesn't write. Returns { mod, note }: the mod to add, and what to
// say instead of adding it. The files already open count as ones Launchpad has: without them, opening a second file
// with the same id would swap the first out without a word.
export function loadModFile(bytes, loaded = []) {
  const m = readModFile(bytes), known = knownMod(m, [...BUILT_INS, ...loaded]);
  if (!known) return { mod: m, note: null };
  return { mod: null, note: known.why === "same"
    ? { ok: true, text: `Launchpad already has this mod: "${known.mod.title}". The file changes the same bytes, so it is the same mod under another name: nothing to add to the list, and its row above writes it.` }
    : { ok: false, text: `Launchpad already has a row called "${m.id}" (${known.mod.title}), and this file changes different bytes. One name can't stand for two sets of changes: the file needs a different id.` } };
}

export default {
  id: "mods", title: "Mods", icon: "puzzle", world: "w-mods",
  render(ctx) {
    const { esc, icon, state } = ctx, all = [...MODS, ...ui.loaded], alts = variants(ui.loaded);
    return ctx.banner("w-mods", "puzzle", "Mods", "",
        { chips: [`${all.length} mod${all.length === 1 ? "" : "s"}`, `${all.filter((m) => m.status !== "research").length} ready`,
                  `${alts.length} USB routing choices`],
          actions: `<button class="btn" data-act="file">${icon("file-import", 16)} Open a mod file</button>` }) + `
      <p class="muted" style="margin:0 0 10px">Mods that change the same part of the firmware are alternatives: picking one puts the others back.</p>
      <div class="stack">${routing(ctx, ui.loaded)}${state.pedal?.mode === F.MODE_STOCK ? probeConsole(ctx) : ""}${MODS.map((m) => card(ctx, m, false, alts)).join("")}${ui.loaded.map((m) => card(ctx, m, true, alts)).join("")}
        ${ui.progress ? `<div class="card"><p class="muted" style="font-size:13px;margin-bottom:6px">${esc(ui.progress.label)}</p><progress max="1" value="${ui.progress.f}"></progress></div>` : ""}
        ${ui.result ? `<div class="note ${ui.result.ok ? "good" : "bad"}">${icon(ui.result.ok ? "circle-check" : "alert-triangle", 16)}<span style="white-space:pre-wrap">${esc(ui.result.text)}</span></div>` : ""}
        ${ui.log.length ? `<div class="log">${esc(ui.log.join("\n"))}</div>` : ""}
        <section class="card"><div class="card-head"><h2>${icon("restore", 18)} Undo mods</h2></div>
          <p class="muted">Puts Valeton's original firmware back: the app, preset and DSP program parts, a few minutes.
            Valeton's presets and settings stay. To go back to Valeton's DSP program alone, in seconds, use its row above.</p>
          <div class="row" style="margin-top:10px"><button class="btn" data-act="undo" ${state.pedal && !state.busy ? "" : "disabled"}>${icon("restore", 16)} Restore Valeton's original</button></div></section>
      </div>`;
  },
  mount(root, ctx) {
    const { state } = ctx;
    const flashIt = async (sections, target, done) => {
      ui.log = []; ui.result = null; ui.progress = { label: "Starting", f: 0 }; ctx.render();
      let ok = false;
      try {
        const r = await changeFirmware(ctx, { sections, target, backupNow: () => backupNow(ctx),
          say: (t) => ui.log.push(t),
          progress: (name, n, total) => { ui.progress = { label: `Writing ${name}: ${n} of ${total}`, f: n / total }; const p = document.querySelector("progress"); if (p) p.value = n / total; } });
        ok = !!r;
        if (r) ui.result = { ok: true, text: done };
      } catch (e) { ui.result = { ok: false, text: e.message }; }
      ui.progress = null; ctx.render();
      return ok;                                                   // cancelled or failed: nothing to remember
    };
    const mark = (m) => markWritten(localStorage, m);
    const pickStock = async (base) => {
      const f = base === "1.0.6" ? await ctx.stockImage({ why: "The mod is applied to it on this computer." })
        : await ctx.openFile(`Choose Valeton's firmware V${base}`, [{ name: "GP-5 firmware", extensions: ["bin", "hfw"] }]);
      if (f && !loadSavedCatalog()) { try { saveCatalog(catalogFromImage(f.bytes), f.name); } catch { /* not a stock file: the mod check says so */ } }
      return f;
    };
    // Valeton's own app, preset and DSP program sections from the user's file: what the Undo card does.
    const backToStock = async () => {
      const f = await pickStock("1.0.6");
      if (!f) return;
      let sections;
      try { sections = stockSections(f.bytes, state.pedal?.mode === F.MODE_STOCK); } catch (e) { ui.result = { ok: false, text: e.message }; ctx.render(); return; }
      const what = sections.length < 5 ? " (its app, preset and DSP program parts)" : "";
      if (!(await ctx.confirm("Put Valeton's original back?",
            `Launchpad flashes Valeton's firmware V${stockVersion(f.bytes)} from your file${what}. Your presets and settings stay; the app and preset parts take a few minutes, then the pedal restarts.`, "Restore"))) return;
      if (await flashIt(sections, { kind: "stock", title: "Valeton's firmware" }, "Valeton's original firmware is back.")) mark(STOCK_DSP);
    };
    // The USB routing list: rewrite one alternative's DSP program alone. Always rebuilt from the stock image
    // (buildMod), so writing what is already there again is harmless: the pedal can't tell us what it runs, and the
    // pill above each row only records what this computer last wrote. Valeton's own row (STOCK_DSP, no patches) goes
    // through the same door and writes that section back unchanged.
    const writeAlt = async (mod) => {
      const f = await pickStock(mod.base);
      if (!f) return;
      let built;
      try { built = buildMod(f.bytes, mod); } catch (e) { ui.result = { ok: false, text: e.message }; ctx.render(); return; }
      const changes = mod.stockDsp ? `This is Valeton's firmware V${mod.base} as it came, checked against your file.`
        : `${built.plan.length} change${built.plan.length === 1 ? "" : "s"} (${built.bytes} byte${built.bytes === 1 ? "" : "s"}) to Valeton's firmware V${mod.base}, checked against your file.`;
      if (!(await ctx.confirm(`Write "${mod.title}" into the pedal?`,
            `${changes}\n\n` + (mod.warn ? `${mod.warn}\n\n` : "") +
            `Launchpad rewrites the whole ${DSP} from your file, and the pedal restarts when it is done. Valeton's presets and settings stay.`, "Write"))) return;
      if (await flashIt(built.sections, { kind: "stock", title: `Valeton's firmware with "${mod.title}"` }, `"${mod.title}" is in the pedal's DSP program.`)) mark(mod);
    };
    root.querySelector('[data-act="file"]').onclick = async () => {
      const f = await ctx.openFile("Open a mod file", [{ name: "GP-5 mod", extensions: ["gp5mod"] }]);
      if (!f) return;
      try {
        const r = loadModFile(f.bytes, ui.loaded);
        if (r.mod) ui.loaded = [...ui.loaded.filter((x) => x.id !== r.mod.id), r.mod];
        ui.result = r.note;
      } catch (e) { ui.result = { ok: false, text: e.message }; }
      ctx.render();
    };
    root.querySelectorAll("[data-drop]").forEach((b) => b.onclick = () => { ui.loaded = ui.loaded.filter((m) => m.id !== b.dataset.drop); ctx.render(); });
    root.querySelectorAll("[data-alt]").forEach((b) => b.onclick = async () => {
      const m = variants(ui.loaded).find((x) => x.id === b.dataset.alt);
      if (!m || state.busy || state.pedal?.mode !== F.MODE_STOCK) return;
      await writeAlt(m);
    });
    root.querySelectorAll("[data-mod]").forEach((b) => b.onclick = async () => {
      const mod = (b.dataset.file === "1" ? ui.loaded : MODS).find((m) => m.id === b.dataset.mod);
      const f = await pickStock(mod.base);
      if (!f) return;
      let built;
      try { built = buildMod(f.bytes, mod); } catch (e) { ui.result = { ok: false, text: e.message }; ctx.render(); return; }
      const onStock = state.pedal?.mode === F.MODE_STOCK;
      const sections = onStock ? built.sections : built.all;
      const ok = await ctx.confirm(`Install "${mod.title}"?`,
        `${built.plan.length} change${built.plan.length === 1 ? "" : "s"} (${built.bytes} byte${built.bytes === 1 ? "" : "s"}) to Valeton's firmware V${mod.base}, checked against your file.\n\n` +
        (mod.warn ? `${mod.warn}\n\n` : "") +
        (onStock ? `Launchpad flashes ${sections.map(([t]) => SECTION[t]).join(" and ")} only. Valeton's presets stay.`
                 : "The pedal isn't running Valeton's firmware, so Launchpad flashes the whole firmware (with the mod)."), "Install");
      if (!ok) return;
      if (await flashIt(sections, { kind: "stock", title: `Valeton's firmware with "${mod.title}"` }, `"${mod.title}" is installed.`)) mark(mod);
    });
    root.querySelector('[data-act="undo"]').onclick = () => backToStock(false);

    // The DSP link probe console: what each byte asks, and what the disassembly already answered, is in
    // lib/linkprobe.js. All of it goes through ctx.linkQuiet, so it waits its turn behind the pedal's polling.
    const prSay = (t) => { pr.log.push(`${new Date().toTimeString().slice(0, 8)}  ${t}`); if (pr.log.length > 200) pr.log.splice(0, pr.log.length - 200); ctx.render(); };
    const readRecs = async (reportId) => {
      try {
        pr.vals = await ctx.linkQuiet((link) => readGlobals(link, 1500));
        if (reportId !== undefined) { const v = pr.vals.get(reportId); prSay(`read back: ${P.recName(reportId)} = ${v === undefined ? "no such record" : P.fmtValue(v)}`); }
      } catch (e) { prSay(`the records didn't answer: ${e.message}`); }
      ctx.render();
    };
    if (root.querySelector('[data-act="recs"]')) {
      root.querySelector('[data-act="recs"]').onclick = () => readRecs();
      root.querySelectorAll("[data-set]").forEach((b) => b.onclick = async () => {
        const id = +b.dataset.set, v = +root.querySelector(`select[data-rec="${id}"]`).value;
        prSay(`writing ${P.recName(id)} = ${v} — listen at the outputs and the DAW for the routing changing`);
        try {
          const kept = await ctx.linkQuiet((link) => command(link, P.setGlobal(id, v), 3000));
          prSay(kept ? `${P.recName(id)} = ${v} was accepted` : `${P.recName(id)} = ${v} was refused`);
        } catch (e) { prSay(`${P.recName(id)} = ${v}: ${e.message}`); }
        await readRecs(id);
      });
      root.querySelector('[data-act="defaults"]').onclick = async () => {
        for (const r of P.PROBE_RECORDS) {
          try { await ctx.linkQuiet((link) => command(link, P.setGlobal(r.id, r.def), 3000)); }
          catch (e) { prSay(`${P.recName(r.id)} back to ${r.def}: ${e.message}`); }
        }
        prSay("the values captured from the real pedal are written back");
        await readRecs();
      };
      const sendFrame = async (payload, label) => {
        try {
          const reply = await ctx.linkQuiet((link) => cmd(link, payload, 900));
          prSay(`${label}: sent ${P.hex(payload)} → ${reply ? P.describeMessage(reply) : "nothing answered"}`);
        } catch (e) { prSay(`${label}: ${e.message}`); }
      };
      root.querySelectorAll("[data-frame]").forEach((b) => b.onclick = () => { const f = [...P.MODE_FRAMES, P.DSP_PING][+b.dataset.frame]; sendFrame(f.payload, f.label); });
      root.querySelector('[data-act="raw"]').onclick = () => {
        const bytes = raw(root.querySelector("#prhex").value);
        if (!bytes.length || bytes.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return prSay("the box wants the payload as hex bytes, like 7e 00 01 60 08 00");
        sendFrame(bytes, "custom");
      };
      const stopWatch = () => { if (pr.timer) clearInterval(pr.timer); pr.timer = null; pr.watch = false; };
      const tick = async () => {
        if (state.view !== "mods" || state.pedal?.mode !== F.MODE_STOCK || !state.link) { stopWatch(); ctx.render(); return; }
        if (pr.ticking) return; pr.ticking = true;
        try {
          const msgs = await ctx.linkQuiet(async (link) => { const out = []; let m; while ((m = await link.recv(20)) !== null) out.push(m); return out; });
          for (const m of msgs) { const p = F.parseSysex(m); pr.log.push(`${new Date().toTimeString().slice(0, 8)}  heard  ${p && p.ok ? P.describeMessage(p.payload) : P.hex(m)}`); }
          if (msgs.length) ctx.render();
        } catch { stopWatch(); } finally { pr.ticking = false; }
      };
      root.querySelector("#prwatch").onchange = (e) => {
        pr.watch = e.target.checked;
        if (pr.watch && !pr.timer) pr.timer = setInterval(tick, 600);
        if (!pr.watch) { if (pr.timer) clearInterval(pr.timer); pr.timer = null; }
        ctx.render();
      };
      if (pr.watch && !pr.timer) pr.timer = setInterval(tick, 600);
      if (!pr.vals) readRecs();
    }
  },
};
