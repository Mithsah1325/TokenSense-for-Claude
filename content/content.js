// Claude Smart Router — content script for claude.ai
// Flow: user presses send → intercept → score the prompt → switch model if needed
// → let the send through → badge with 👍/👎 → learn.

(function () {
  const CSR = globalThis.CSR;
  const LOG = (...a) => console.debug("[SmartRouter]", ...a);

  let settings = { ...CSR.DEFAULT_SETTINGS };
  let stats = JSON.parse(JSON.stringify(CSR.DEFAULT_STATS));
  let bypassNextSend = false;
  let busy = false;
  let last = null; // { prompt, tier, score, entryIndex }

  // ---------- storage ----------
  async function loadState() {
    const data = await chrome.storage.local.get(["settings", "stats"]);
    settings = { ...CSR.DEFAULT_SETTINGS, ...(data.settings || {}) };
    settings.adjust = { ...CSR.DEFAULT_SETTINGS.adjust, ...(settings.adjust || {}) };
    stats = { ...JSON.parse(JSON.stringify(CSR.DEFAULT_STATS)), ...(data.stats || {}) };
  }
  const saveSettings = () => chrome.storage.local.set({ settings });
  const saveStats = () => chrome.storage.local.set({ stats });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) settings = { ...CSR.DEFAULT_SETTINGS, ...changes.settings.newValue };
    if (changes.stats) stats = { ...stats, ...changes.stats.newValue };
  });

  // ---------- DOM helpers ----------
  const q = (list, root = document) => {
    for (const sel of list) { try { const el = root.querySelector(sel); if (el) return el; } catch (_) {} }
    return null;
  };
  const qa = (list) => {
    const out = [];
    for (const sel of list) { try { document.querySelectorAll(sel).forEach((el) => out.push(el)); } catch (_) {} }
    return out;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeout = 1500, step = 50) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
    return null;
  }
  const visible = (el) => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden");
  const txt = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const label = (el) => `${txt(el)} ${el?.getAttribute("aria-label") || ""} ${el?.getAttribute("title") || ""}`;

  function getComposer() { return q(CSR.SELECTORS.composer); }
  function getComposerText() {
    const el = getComposer();
    if (!el) return "";
    return el.tagName === "TEXTAREA" ? el.value : el.innerText;
  }
  function setComposerText(text) {
    const el = getComposer();
    if (!el) return false;
    el.focus();
    if (el.tagName === "TEXTAREA") { el.value = text; el.dispatchEvent(new Event("input", { bubbles: true })); }
    else { document.execCommand("selectAll", false, null); document.execCommand("insertText", false, text); }
    return true;
  }
  function getSendButton() { const el = q(CSR.SELECTORS.sendButton); return visible(el) ? el : null; }

  // Full pointer sequence: Radix/Headless menus sometimes ignore a bare .click().
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1 };
    const ev = (t) => new (t.startsWith("pointer") ? PointerEvent : MouseEvent)(t, o);
    ["pointerover", "pointerenter", "mouseover", "pointermove", "mousemove", "pointerdown", "mousedown"].forEach((t) => el.dispatchEvent(ev(t)));
    el.focus?.();
    ["pointerup", "mouseup", "click"].forEach((t) => el.dispatchEvent(ev(t)));
  }

  // ---------- model picker ----------
  function tierFromText(s) {
    s = (s || "").toLowerCase();
    for (const t of CSR.TIERS) if (s.includes(CSR.TIER_INFO[t].match)) return t;
    return null;
  }
  function getModelPickerButton() {
    const direct = q(CSR.SELECTORS.modelPickerButton);
    if (visible(direct)) return direct;
    const cands = [...document.querySelectorAll('button, [role="button"], [role="combobox"]')]
      .filter((el) => visible(el) && tierFromText(label(el)) && txt(el).length < 60 && !el.closest('[role="menu"], [role="listbox"]'));
    // Prefer elements that announce a popup, then ones nearest the composer.
    const comp = getComposer();
    const dist = (el) => (comp ? Math.abs(el.getBoundingClientRect().top - comp.getBoundingClientRect().top) : 0);
    cands.sort((a, b) => ((b.hasAttribute("aria-haspopup") | 0) - (a.hasAttribute("aria-haspopup") | 0)) || dist(a) - dist(b));
    return cands[0] || null;
  }
  function getCurrentTier() { const b = getModelPickerButton(); return b ? tierFromText(label(b)) : null; }
  function visibleMenuItems() {
    const items = qa(CSR.SELECTORS.modelMenuItem).filter(visible);
    if (!items.length) return null;
    // If several menus are open, keep the one(s) that actually mention a model family.
    const modelish = items.filter((el) => tierFromText(label(el)));
    if (modelish.length) {
      const containers = new Set(modelish.map((el) => el.closest('[role="menu"], [role="listbox"], [role="group"]') || el.parentElement));
      const scoped = items.filter((el) => [...containers].some((c) => c.contains(el)));
      return scoped.length ? scoped : items;
    }
    return items;
  }
  function rememberAvailable(items) {
    const found = CSR.TIERS.filter((t) => items.some((el) => label(el).toLowerCase().includes(CSR.TIER_INFO[t].match)));
    if (found.length <= 1 && (settings.availableTiers || []).length > found.length) return; // don't shrink on a partial view
    if (!found.length) return;
    if (found.join() !== (settings.availableTiers || []).join()) { settings.availableTiers = found; saveSettings(); LOG("available tiers", found); }
  }
  function closeMenus() { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); document.body.click(); }

  // Returns a trace of each step so failures are explainable.
  async function switchModel(tier) {
    const target = CSR.TIER_INFO[tier];
    const trace = [];
    const btn = getModelPickerButton();
    if (!btn) { trace.push("picker button: NOT FOUND"); throw Object.assign(new Error("model picker button not found"), { trace }); }
    trace.push(`picker button: "${txt(btn)}" (${btn.tagName.toLowerCase()}${btn.getAttribute("aria-haspopup") ? ", haspopup" : ""})`);
    if (tierFromText(label(btn)) === tier) { trace.push("already on target"); return { result: "already", trace }; }

    // Open the menu: real click, then plain click, then keyboard.
    let items = null;
    for (const open of [() => realClick(btn), () => btn.click(), () => { btn.focus(); btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }]) {
      open();
      items = await waitFor(visibleMenuItems, 900);
      if (items) break;
    }
    if (!items) { trace.push("menu: did not open"); throw Object.assign(new Error("model menu did not open"), { trace }); }
    trace.push(`menu: ${items.length} items → ${items.map((i) => `"${txt(i).slice(0, 30)}"`).join(", ")}`);
    // Structural dump of the whole open menu, including rows that aren't menu items
    // (e.g. greyed-out "upgrade to use" models), so missing models are explainable.
    const container = items[0].closest('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [data-radix-menu-content]') || items[0].parentElement?.parentElement;
    if (container) {
      const rows = [];
      container.querySelectorAll("*").forEach((el) => {
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
        if (!own) return;
        const flags = [el.getAttribute("role") && `role=${el.getAttribute("role")}`, el.getAttribute("aria-disabled") === "true" && "disabled", el.hasAttribute("data-disabled") && "data-disabled", el.tagName.toLowerCase() === "a" && `href=${el.getAttribute("href")}`].filter(Boolean).join(" ");
        rows.push(`<${el.tagName.toLowerCase()}${flags ? " " + flags : ""}> ${own.slice(0, 50)}`);
      });
      trace.push("menu structure:\n      " + rows.slice(0, 40).join("\n      "));
    }
    rememberAvailable(items);

    // Find a clickable row for the target model anywhere in an open menu/popover,
    // not only among role=menuitem elements.
    const MENU_ROOTS = '[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [data-radix-menu-content], [data-state="open"], [role="dialog"]';
    const pickerBtn = btn;
    function findRow(needle) {
      needle = needle.toLowerCase();
      const roots = [...document.querySelectorAll(MENU_ROOTS)].filter(visible);
      let best = null;
      for (const root of roots) {
        root.querySelectorAll("*").forEach((el) => {
          if (!visible(el) || el === pickerBtn || pickerBtn.contains(el)) return;
          const t = label(el).toLowerCase();
          if (!t.includes(needle) || t.length > 120) return;
          if (!best || el.textContent.length < best.textContent.length) best = el;
        });
      }
      if (!best) return null;
      return best.closest('[role^="menuitem"], [role="option"], button, a, [tabindex], [data-radix-collection-item]') || best;
    }
    const match = () => (visibleMenuItems()?.find((el) => label(el).toLowerCase().includes(target.match))) || findRow(target.match);
    let item = match();

    // Not visible yet? Expand "More models" (or similar) by text — it is often not a menu item.
    if (!item) {
      const expander = findRow("more models") || findRow("other models") || findRow("all models") || findRow("more");
      if (expander) {
        trace.push(`expanding: "${txt(expander).slice(0, 30)}"`);
        const r = expander.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, pointerType: "mouse" };
        ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"].forEach((t) => expander.dispatchEvent(new (t.startsWith("pointer") ? PointerEvent : MouseEvent)(t, o)));
        item = await waitFor(match, 700);
        if (!item) { realClick(expander); item = await waitFor(match, 900); }
        if (!item) { expander.focus?.(); expander.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); item = await waitFor(match, 700); }
        if (!item) { expander.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); item = await waitFor(match, 700); }
        const now = [...document.querySelectorAll(MENU_ROOTS)].filter(visible).flatMap((r) => [...r.querySelectorAll("*")]).filter((el) => visible(el) && tierFromText(txt(el)) && txt(el).length < 60);
        trace.push(`models visible after expanding: ${[...new Set(now.map((el) => txt(el).slice(0, 25)))].join(", ") || "none"}`);
        rememberAvailable(now);
      } else trace.push("no 'More models' entry found");
    }
    if (!item) { trace.push(`item for ${target.label}: NOT FOUND`); closeMenus(); throw Object.assign(new Error(`no menu item matching "${target.label}"`), { trace }); }
    trace.push(`item for ${target.label}: "${txt(item)}"`);

    const changed = () => tierFromText(label(getModelPickerButton() || pickerBtn)) === tier;
    // Attempt 1: pointer sequence. Attempt 2: plain click. Attempt 3: keyboard navigation.
    realClick(item);
    if (await waitFor(changed, 900)) { trace.push("switched via pointer events"); return { result: "switched", trace }; }
    item = match(); if (item) { item.click(); if (await waitFor(changed, 900)) { trace.push("switched via click"); return { result: "switched", trace }; } }
    if (visibleMenuItems()) {
      for (let i = 0; i < 12 && !changed(); i++) {
        const focused = document.activeElement;
        if (focused && label(focused).toLowerCase().includes(target.match)) { focused.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); break; }
        (focused || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        await sleep(60);
      }
      if (await waitFor(changed, 900)) { trace.push("switched via keyboard"); return { result: "switched", trace }; }
    }
    trace.push(`after clicking, picker still shows "${getCurrentTier() || "unknown"}"`);
    closeMenus();
    throw Object.assign(new Error("model did not change after click"), { trace });
  }

  // Optional effort/thinking control. Only runs when enabled AND a selector is set.
  async function applyEffort(effort) {
    if (!settings.controlThinking || !CSR.SELECTORS.thinkingControl.length) return;
    const ctl = q(CSR.SELECTORS.thinkingControl);
    if (!visible(ctl)) return;
    const wantOn = effort !== "low";
    const state = ctl.getAttribute("aria-checked") ?? ctl.getAttribute("aria-pressed");
    if (state !== null) { if ((state === "true") !== wantOn) realClick(ctl); return; }
    realClick(ctl);
    const items = await waitFor(visibleMenuItems, 1000);
    const item = items?.find((el) => label(el).toLowerCase().includes(effort));
    if (item) realClick(item); else closeMenus();
  }

  // ---------- routing ----------
  async function routeAndSend() {
    if (busy) return;
    busy = true;
    try {
      const prompt = getComposerText().trim();
      if (!prompt) return;
      const result = CSR.analyze(prompt, settings);
      LOG("score", result.score, "→", result.tier, result.reasons);
      let note = "";
      try { const r = await switchModel(result.tier); LOG(r.trace.join(" | ")); }
      catch (err) { note = `Couldn't switch model: ${err.message}. Sent with current selection. Run "Test model switch" in the popup for details.`; LOG(err.message, (err.trace || []).join(" | ")); }
      await applyEffort(result.effort);
      recordRoute(result, prompt);
      showBadge(result, note);
    } finally {
      bypassNextSend = true;
      const send = await waitFor(() => { const b = getSendButton(); return b && !b.disabled ? b : null; }, 1500);
      if (send) send.click();
      else getComposer()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      setTimeout(() => { bypassNextSend = false; busy = false; }, 400);
    }
  }

  function recordRoute(result, prompt) {
    const base = CSR.TIER_INFO[settings.baseline] || CSR.TIER_INFO.sonnet;
    stats.routed[result.tier] = (stats.routed[result.tier] || 0) + 1;
    stats.costSpent += CSR.TIER_INFO[result.tier].cost;
    stats.costBaseline += base.cost;
    stats.history.push({ t: Date.now(), score: result.score, tier: result.tier, ok: null });
    if (stats.history.length > 200) stats.history.shift();
    last = { prompt, tier: result.tier, score: result.score, entryIndex: stats.history.length - 1 };
    saveStats();
  }

  function recordFeedback(ok) {
    if (!last) return;
    const entry = stats.history[last.entryIndex];
    if (entry) entry.ok = ok;
    stats.feedback[ok ? "up" : "down"]++;
    // 👎 → that tier trusted with fewer hard prompts (-3); 👍 → slightly more (+1). ±15 clamp.
    if (last.tier in settings.adjust) {
      const cur = settings.adjust[last.tier] || 0;
      settings.adjust[last.tier] = Math.max(-15, Math.min(15, cur + (ok ? 1 : -3)));
      saveSettings();
    }
    saveStats();
  }

  function nextTier(tier) {
    const avail = settings.availableTiers?.length ? settings.availableTiers : CSR.TIERS;
    return CSR.TIERS.slice(CSR.TIERS.indexOf(tier) + 1).find((t) => avail.includes(t)) || null;
  }

  async function escalate() {
    if (!last) return;
    const next = nextTier(last.tier);
    if (!next) return;
    hideBadge();
    let note = `Retrying on ${CSR.TIER_INFO[next].label}.`;
    try { await switchModel(next); } catch (err) { note = `Couldn't switch to ${CSR.TIER_INFO[next].label}: ${err.message}`; }
    if (!setComposerText(last.prompt)) return;
    await sleep(100);
    const result = { score: last.score, tier: next, effort: CSR.EFFORT_FOR_SCORE(last.score), reasons: ["escalated after 👎"] };
    recordRoute(result, last.prompt);
    showBadge(result, note);
    bypassNextSend = true;
    const send = await waitFor(() => { const b = getSendButton(); return b && !b.disabled ? b : null; }, 1500);
    send?.click();
    setTimeout(() => (bypassNextSend = false), 400);
  }

  // ---------- send interception ----------
  function isSendClick(e) { const btn = e.target?.closest?.("button"); return btn && getSendButton() === btn; }
  function isSendKey(e) {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return false;
    const c = getComposer();
    return c && c.contains(e.target);
  }
  function intercept(e) {
    if (!settings.enabled || bypassNextSend) return;
    if (!(isSendClick(e) || isSendKey(e))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    routeAndSend();
  }
  document.addEventListener("keydown", intercept, true);
  document.addEventListener("click", intercept, true);

  // ---------- popup diagnostics ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "testSwitch") return;
    (async () => {
      const current = getCurrentTier();
      const avail = settings.availableTiers?.length ? settings.availableTiers : CSR.TIERS;
      const target = msg.tier || avail.find((t) => t !== current) || "sonnet";
      const report = { composerFound: !!getComposer(), sendButtonFound: !!getSendButton(), currentTier: current, target, trace: [], ok: false, error: null };
      try { const r = await switchModel(target); report.trace = r.trace; report.ok = true; report.result = r.result; }
      catch (err) { report.trace = err.trace || []; report.error = err.message; }
      report.buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible)
        .map((el) => ({ text: txt(el).slice(0, 40), aria: el.getAttribute("aria-label"), testid: el.getAttribute("data-testid"), haspopup: el.getAttribute("aria-haspopup") }))
        .filter((b) => b.text || b.aria).slice(0, 40);
      report.afterTier = getCurrentTier();
      sendResponse(report);
    })();
    return true;
  });

  // ---------- badge ----------
  let badge = null;
  function hideBadge() { badge?.remove(); badge = null; }
  function showBadge(result, note) {
    if (!settings.showBadge) return;
    hideBadge();
    const info = CSR.TIER_INFO[result.tier];
    badge = document.createElement("div");
    badge.className = "csr-badge csr-" + result.tier;
    badge.innerHTML = `
      <div class="csr-row">
        <span class="csr-dot"></span>
        <span class="csr-main">Routed to <b>${info.label}</b> <span class="csr-score">score ${result.score}</span></span>
        <button class="csr-x" title="Dismiss">×</button>
      </div>
      <div class="csr-row csr-why">${result.reasons.slice(0, 3).join(" · ") || "no strong signals"}</div>
      ${note ? `<div class="csr-row csr-note">${note}</div>` : ""}
      <div class="csr-row csr-actions">
        <span>Good enough?</span>
        <button class="csr-btn" data-fb="up">👍</button>
        <button class="csr-btn" data-fb="down">👎</button>
      </div>`;
    badge.querySelector(".csr-x").onclick = hideBadge;
    badge.querySelectorAll("[data-fb]").forEach((b) => {
      b.onclick = () => {
        const ok = b.dataset.fb === "up";
        recordFeedback(ok);
        const actions = badge.querySelector(".csr-actions");
        const next = nextTier(result.tier);
        if (ok || !next) {
          actions.textContent = ok ? "Noted — thanks." : `Noted. Nothing above ${info.label} to try.`;
          setTimeout(hideBadge, 1800);
        } else {
          actions.innerHTML = `<span>Noted.</span> <button class="csr-btn csr-retry">Retry with ${CSR.TIER_INFO[next].label}</button>`;
          actions.querySelector(".csr-retry").onclick = escalate;
        }
      };
    });
    document.body.appendChild(badge);
  }

  loadState().then(() => LOG("ready", settings));
})();
