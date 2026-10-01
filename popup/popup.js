(async function () {
  const CSR = globalThis.CSR;
  const $ = (id) => document.getElementById(id);

  const HINTS = {
    saver: "Haiku whenever plausible. Upgrades only on clear complexity.",
    balanced: "Cheapest model that's likely to answer well.",
    quality: "Sonnet or Opus whenever difficulty is uncertain.",
  };

  let settings, stats;

  async function load() {
    const d = await chrome.storage.local.get(["settings", "stats"]);
    settings = { ...CSR.DEFAULT_SETTINGS, ...(d.settings || {}) };
    settings.adjust = { ...CSR.DEFAULT_SETTINGS.adjust, ...(settings.adjust || {}) };
    stats = { ...JSON.parse(JSON.stringify(CSR.DEFAULT_STATS)), ...(d.stats || {}) };
  }
  const saveSettings = () => chrome.storage.local.set({ settings });
  const saveStats = () => chrome.storage.local.set({ stats });

  function bounds() {
    const m = CSR.MODES[settings.mode];
    const a = settings.adjust;
    const h = Math.max(0, Math.min(100, m.haikuMax + (a.haiku || 0)));
    const s = Math.max(h, Math.min(100, m.sonnetMax + (a.sonnet || 0)));
    const o = Math.max(s, Math.min(100, m.opusMax + (a.opus || 0)));
    return { h, s, o };
  }

  function render() {
    $("enabled").checked = settings.enabled;
    document.querySelectorAll(".mode").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === settings.mode)));
    $("modeHint").textContent = HINTS[settings.mode];

    const { h, s, o } = bounds();
    $("bandHaiku").style.flexBasis = h + "%";
    $("bandSonnet").style.flexBasis = (s - h) + "%";
    $("bandOpus").style.flexBasis = (o - s) + "%";
    $("bandFable").style.flexBasis = (100 - o) + "%";
    const avail = settings.availableTiers;
    for (const t of CSR.TIERS) {
      const el = $("band" + CSR.TIER_INFO[t].label);
      el.classList.toggle("unavailable", !!(avail?.length && !avail.includes(t)));
    }

    // Marker: live "try" prompt if present, else the last real route.
    const tryText = $("tryPrompt").value.trim();
    const lastReal = stats.history[stats.history.length - 1];
    let mark = null;
    if (tryText) { const r = CSR.analyze(tryText, settings); mark = { score: r.score, tier: r.tier, label: "this prompt" }; }
    else if (lastReal) mark = { score: lastReal.score, tier: lastReal.tier, label: "last prompt" };
    if (mark) {
      $("marker").hidden = false;
      $("marker").style.left = mark.score + "%";
      $("markerTag").textContent = `${mark.label} · ${mark.score}`;
    } else $("marker").hidden = true;

    if (tryText) {
      const r = CSR.analyze(tryText, settings);
      $("tryOut").innerHTML = `Would route to <b>${CSR.TIER_INFO[r.tier].label}</b> at <b>${r.effort}</b> effort · ${r.reasons.slice(0, 3).join(", ") || "no strong signals"}`;
    } else $("tryOut").textContent = "";

    const total = CSR.TIERS.reduce((n, t) => n + (stats.routed[t] || 0), 0);
    const saved = stats.costBaseline > 0 ? Math.round((1 - stats.costSpent / stats.costBaseline) * 100) : null;
    $("savings").textContent = saved === null ? "—" : (saved >= 0 ? `${saved}%` : `+${-saved}%`);
    $("savings").style.color = saved === null ? "" : saved >= 0 ? "var(--haiku)" : "var(--opus)";
    $("baselineName").textContent = CSR.TIER_INFO[settings.baseline].label;
    $("cHaiku").textContent = stats.routed.haiku || 0;
    $("cSonnet").textContent = stats.routed.sonnet || 0;
    $("cOpus").textContent = stats.routed.opus || 0;
    $("cFable").textContent = stats.routed.fable || 0;
    $("avail").textContent = avail?.length
      ? `Your picker offers: ${avail.map((t) => CSR.TIER_INFO[t].label).join(", ")}. Faded bands fall back to the next one down.`
      : "Models in your picker aren't detected yet — they're read the first time a switch happens.";

    const fb = stats.feedback;
    const fmt = (n) => (n > 0 ? `+${n}` : `${n || 0}`);
    const a = settings.adjust;
    $("learn").textContent = total === 0
      ? "Send a few prompts on claude.ai and this fills in."
      : `${fb.up + fb.down} ratings (${fb.up} 👍 · ${fb.down} 👎). Learned shift: Haiku ${fmt(a.haiku)}, Sonnet ${fmt(a.sonnet)}, Opus ${fmt(a.opus)} points.`;

    $("baseline").value = settings.baseline;
    $("showBadge").checked = settings.showBadge;
    $("controlThinking").checked = settings.controlThinking;
  }

  await load();
  render();

  $("enabled").onchange = (e) => { settings.enabled = e.target.checked; saveSettings(); render(); };
  document.querySelectorAll(".mode").forEach((b) => (b.onclick = () => { settings.mode = b.dataset.mode; saveSettings(); render(); }));
  $("tryPrompt").oninput = render;
  $("baseline").onchange = (e) => { settings.baseline = e.target.value; saveSettings(); render(); };
  $("showBadge").onchange = (e) => { settings.showBadge = e.target.checked; saveSettings(); };
  $("controlThinking").onchange = (e) => { settings.controlThinking = e.target.checked; saveSettings(); };
  $("resetLearning").onclick = () => { settings.adjust = { haiku: 0, sonnet: 0, opus: 0 }; saveSettings(); render(); };
  $("resetStats").onclick = () => { stats = JSON.parse(JSON.stringify(CSR.DEFAULT_STATS)); saveStats(); render(); };

  let lastReport = "";
  $("testSwitch").onclick = async () => {
    const out = $("report"); out.hidden = false; $("copyReport").hidden = true;
    out.textContent = "Testing on the active claude.ai tab…";
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url?.startsWith("https://claude.ai/")) { out.textContent = "Open a claude.ai tab first, then run this test from there."; return; }
      const r = await chrome.tabs.sendMessage(tab.id, { type: "testSwitch" });
      const lines = [
        `composer found: ${r.composerFound}   send button found: ${r.sendButtonFound}`,
        `picker shows: ${r.currentTier || "unknown"} → trying: ${r.target}`,
        ...r.trace.map((t) => "  " + t),
        r.ok ? `RESULT: switched (picker now shows ${r.afterTier})` : `RESULT: FAILED — ${r.error}`,
        "", "visible buttons on page:",
        ...r.buttons.map((b) => `  ${JSON.stringify(b)}`),
      ];
      lastReport = lines.join("\n");
      out.innerHTML = lines.map((l) => l.startsWith("RESULT: switched") ? `<span class="ok">${l}</span>` : l.startsWith("RESULT: FAILED") ? `<span class="bad">${l}</span>` : l.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))).join("\n");
      $("copyReport").hidden = false;
      await load(); render();
    } catch (err) {
      out.textContent = `Couldn't reach the page script (${err.message}). Reload the claude.ai tab after installing the extension, then try again.`;
    }
  };
  $("copyReport").onclick = () => navigator.clipboard.writeText(lastReport).then(() => { $("copyReport").textContent = "Copied"; setTimeout(() => ($("copyReport").textContent = "Copy report"), 1500); });

  chrome.storage.onChanged.addListener(async () => { await load(); render(); });
})();
