// Mods: changes to Valeton's stock firmware, built in or from shared .gp5mod files, installed from the user's own
// stock image (lib/mods.js). Undo = put Valeton's original back from the same file.
import * as F from "../lib/gp5flash.js";
import { MODS, buildMod, readModFile, stockSections, stockVersion, dspAlternatives, lastWritten, markWritten } from "../lib/mods.js";
import { changeFirmware } from "../lib/change.js";
import { catalogFromImage, saveCatalog, loadSavedCatalog } from "../lib/stockcat.js";
import { backupNow } from "./backups.js";

const ui = { result: null, log: [], progress: null, loaded: [] };
const SECTION = { 0x62: "app", 0x65: "presets", 0x63: "DSP" };
const DSP = "DSP program (49,992 bytes)";
const STOCK_TILE = { id: "stock", title: "Valeton's original, no mods", base: "1.0.6" };
const raw = (b) => (typeof b === "string" ? b.replace(/\s+/g, "").match(/../g).map((x) => parseInt(x, 16)) : Array.from(b));
const changed = (p) => { const a = raw(p.before), b = raw(p.after); return a.filter((v, i) => v !== b[i]).length; };

function card(ctx, m, fromFile) {
  const { esc, icon, state } = ctx, ready = m.status !== "research";
  const changes = ready ? m.patches.length : 0, bytes = m.patches.reduce((n, p) => n + changed(p), 0);
  return `<section class="card w-mods"><div class="stack">
    <div class="card-head" style="margin-bottom:0"><h2>${icon("puzzle", 18)} ${esc(m.title)}</h2>
      <span class="row" style="gap:6px">${m.status === "untested" ? '<span class="pill">not yet tested on a pedal</span>' : ""}<span class="pill world">${ready ? `for Valeton V${esc(m.base)}` : "in research"}</span></span></div>
    ${m.summary ? `<p class="muted">${esc(m.summary)}</p>` : ""}
    ${ready ? `<p class="faint" style="font-size:12.5px">${fromFile ? `From a file${m.author ? ` by ${esc(m.author)}` : ""} · ` : ""}${changes} change${changes === 1 ? "" : "s"}, ${bytes} byte${bytes === 1 ? "" : "s"}</p>` : ""}
    ${fromFile ? `
      ${m.patches.some((p) => p.note) ? `<ul class="muted" style="font-size:12.5px;margin:0 0 0 18px">${m.patches.filter((p) => p.note).slice(0, 8).map((p) => `<li>${esc(SECTION[p.section])} @ 0x${p.offset.toString(16)}: ${esc(p.note)}</li>`).join("")}</ul>` : ""}
      <div class="note warn">${icon("alert-triangle", 16)}<span>A mod file can change anything in the firmware it patches. Only install mods from people you trust. Recovery always works: hold the foot switch and PARA while plugging in.</span></div>` : ""}
    ${ready ? `<div class="row"><button class="btn primary" data-mod="${esc(m.id)}" data-file="${fromFile ? 1 : 0}" ${state.pedal && !state.busy ? "" : "disabled"}>${icon("download")} Install</button>
        ${fromFile ? `<button class="btn ghost" data-drop="${esc(m.id)}">Remove from the list</button>` : ""}</div>`
      : `<div class="note">${icon("info-circle", 16)}<span>Not available yet.</span></div>`}
  </div></section>`;
}

// The alternatives that only change the DSP program, plus Valeton's original as the choice that is not a mod.
const variants = (loaded) => [STOCK_TILE, ...dspAlternatives([...MODS, ...loaded])];

// One row of the USB routing list. The pill marks what this computer last wrote (lib/mods.js says why that's all
// Launchpad can know); picking a row rewrites the DSP section from the user's stock image, so what's written is
// right whatever the pill says.
function altTile(ctx, m, cur, onStock, busy) {
  const { esc, icon } = ctx;
  const here = cur === m.id;
  const stock = m.id === "stock";
  const sub = stock ? "Valeton's own DSP program, and the app and preset parts back too: the pedal works on its own."
    : `${m.patches.length} change${m.patches.length === 1 ? "" : "s"} to Valeton V${esc(m.base)}`;
  return `<div class="item tall${here ? " sel" : ""}"><span class="main">
      <span class="name">${esc(m.title)}${here ? ' <span class="pill now">written here</span>' : ""}</span><span class="sub">${sub}</span></span>
    <button class="btn ${here ? "ghost" : "primary"}" data-alt="${esc(m.id)}" ${onStock && !busy ? "" : "disabled"}
      title="${onStock ? (stock ? `Valeton's own ${DSP}, plus the app and preset parts, from your Valeton file: presets and settings stay`
                                : `Rewrite the whole ${DSP} from your Valeton file: presets and settings stay`)
                        : "Only for a pedal running Valeton's firmware"}">${icon("arrows-exchange", 15)} ${here ? "Write again" : "Switch"}</button></div>`;
}

function routing(ctx, loaded) {
  const { esc, icon, state } = ctx;
  const alts = variants(loaded), onStock = state.pedal?.mode === F.MODE_STOCK, wrote = lastWritten();
  const cur = wrote && (wrote.id === "stock" || alts.some((m) => m.id === wrote.id)) ? wrote.id : null;
  return `<section class="card"><div class="card-head"><h2>${icon("arrows-exchange", 18)} USB routing</h2>
      <span class="pill world">${alts.length} choices</span></div>
    <p class="muted">Which of these the pedal runs is decided by its DSP program, not by a setting: Valeton's own
      settings and app only have levels. Picking a mod rewrites the ${DSP} from Valeton's file on this computer, a few
      seconds, and leaves the presets and settings alone; the Valeton row also rewrites the app and preset parts, so
      nothing a mod changed anywhere is left. The pedal can't say what it runs now, so Launchpad only says what it
      wrote here itself${wrote ? `, ${esc(String(wrote.at || "").slice(0, 10))}` : ""}.</p>
    ${onStock ? "" : `<div class="note warn">${icon("info-circle", 16)}<span>Pick one of these when the pedal is running Valeton's firmware${state.pedal ? " — this one isn't, so its whole firmware would have to be rewritten, which is what the buttons below do" : ""}.</span></div>`}
    <div class="list" style="margin-top:10px">${alts.map((m) => altTile(ctx, m, cur, onStock, state.busy)).join("")}</div></section>`;
}

export default {
  id: "mods", title: "Mods", icon: "puzzle", world: "w-mods",
  render(ctx) {
    const { esc, icon, state } = ctx, all = [...MODS, ...ui.loaded];
    return ctx.banner("w-mods", "puzzle", "Mods", "",
        { chips: [`${all.length} mod${all.length === 1 ? "" : "s"}`, `${all.filter((m) => m.status !== "research").length} ready`,
                  `${dspAlternatives(all).length} DSP routing choices`],
          actions: `<button class="btn" data-act="file">${icon("file-import", 16)} Open a mod file</button>` }) + `
      <p class="muted" style="margin:0 0 10px">Mods that change the same part of the firmware are alternatives: installing one puts the others back.</p>
      <div class="stack">${routing(ctx, ui.loaded)}${MODS.map((m) => card(ctx, m, false)).join("")}${ui.loaded.map((m) => card(ctx, m, true)).join("")}
        ${ui.progress ? `<div class="card"><p class="muted" style="font-size:13px;margin-bottom:6px">${esc(ui.progress.label)}</p><progress max="1" value="${ui.progress.f}"></progress></div>` : ""}
        ${ui.result ? `<div class="note ${ui.result.ok ? "good" : "bad"}">${icon(ui.result.ok ? "circle-check" : "alert-triangle", 16)}<span style="white-space:pre-wrap">${esc(ui.result.text)}</span></div>` : ""}
        ${ui.log.length ? `<div class="log">${esc(ui.log.join("\n"))}</div>` : ""}
        <section class="card"><div class="card-head"><h2>${icon("restore", 18)} Undo mods</h2></div>
          <p class="muted">Puts Valeton's original firmware back. Valeton's presets stay. To swap the DSP program alone, use the Valeton row in the list above.</p>
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
    // Valeton's own sections: the same thing the Undo card does, from the same file. The DSP program is what decides
    // the USB routing; the app and preset sections come along so that nothing another mod changed is left behind.
    const backToStock = async (fromRouting) => {
      const f = await pickStock("1.0.6");
      if (!f) return;
      let sections;
      try { sections = stockSections(f.bytes, state.pedal?.mode === F.MODE_STOCK); } catch (e) { ui.result = { ok: false, text: e.message }; ctx.render(); return; }
      const v = `Valeton's firmware V${stockVersion(f.bytes)} from your file`;
      const what = sections.length < 5 ? " (its app, preset and DSP program parts)" : "";
      const why = fromRouting ? "\n\nIts DSP program goes back to Valeton's own, which is what decides the USB routing. The app and preset parts come along, so a mod that changed those is put back too. Your presets and settings stay; the two bigger parts take a few minutes, then the pedal restarts." : "";
      if (!(await ctx.confirm("Put Valeton's original back?", `${v}${what}.${why}`, "Restore"))) return;
      if (await flashIt(sections, { kind: "stock", title: "Valeton's firmware" }, "Valeton's original firmware is back.")) mark(STOCK_TILE);
    };
    // The USB routing list: rebuild one alternative and rewrite the DSP section alone. Always from the stock image
    // (buildMod), so writing what is already there again is harmless: the pedal can't tell us what it runs, and the
    // pill above each row only records what this computer last wrote.
    const writeAlt = async (mod) => {
      const f = await pickStock(mod.base);
      if (!f) return;
      let built;
      try { built = buildMod(f.bytes, mod); } catch (e) { ui.result = { ok: false, text: e.message }; ctx.render(); return; }
      if (!(await ctx.confirm(`Write "${mod.title}" into the pedal?`,
            `${built.plan.length} change${built.plan.length === 1 ? "" : "s"} (${built.bytes} byte${built.bytes === 1 ? "" : "s"}) to Valeton's firmware V${mod.base}, checked against your file.\n\n` +
            `Launchpad rewrites the whole ${DSP} from your file, and the pedal restarts when it is done. Valeton's presets and settings stay.`, "Write"))) return;
      if (await flashIt(built.sections, { kind: "stock", title: `Valeton's firmware with "${mod.title}"` }, `"${mod.title}" is in the pedal's DSP program.`)) mark(mod);
    };
    root.querySelector('[data-act="file"]').onclick = async () => {
      const f = await ctx.openFile("Open a mod file", [{ name: "GP-5 mod", extensions: ["gp5mod"] }]);
      if (!f) return;
      try {
        const m = readModFile(f.bytes);
        ui.loaded = [...ui.loaded.filter((x) => x.id !== m.id), m];
        ui.result = null;
      } catch (e) { ui.result = { ok: false, text: e.message }; }
      ctx.render();
    };
    root.querySelectorAll("[data-drop]").forEach((b) => b.onclick = () => { ui.loaded = ui.loaded.filter((m) => m.id !== b.dataset.drop); ctx.render(); });
    root.querySelectorAll("[data-alt]").forEach((b) => b.onclick = async () => {
      const m = variants(ui.loaded).find((x) => x.id === b.dataset.alt);
      if (!m || state.busy || state.pedal?.mode !== F.MODE_STOCK) return;
      await (m.id === "stock" ? backToStock(true) : writeAlt(m));
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
        (onStock ? `Launchpad flashes ${sections.map(([t]) => SECTION[t]).join(" and ")} only. Valeton's presets stay.`
                 : "The pedal isn't running Valeton's firmware, so Launchpad flashes the whole firmware (with the mod)."), "Install");
      if (!ok) return;
      if (await flashIt(sections, { kind: "stock", title: `Valeton's firmware with "${mod.title}"` }, `"${mod.title}" is installed.`)) mark(mod);
    });
    root.querySelector('[data-act="undo"]').onclick = () => backToStock(false);
  },
};
