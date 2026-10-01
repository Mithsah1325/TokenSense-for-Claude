# Claude Smart Router

A Chrome extension for claude.ai that scores each prompt's difficulty before it's
sent, switches the model picker to the cheapest tier that should handle it
(Haiku → Sonnet → Opus → Fable), and learns from your.

The extension reads your model menu the first time it switches and remembers which
tiers your plan actually offers. A tier you don't have (e.g. Fable) falls back to
the next one down, so routing never targets a model that isn't in your picker.

## Install (unpacked)

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → pick this folder.
3. Open claude.ai, type a prompt, press Enter. A badge appears bottom-right
   showing where it was routed and why. Rate it; offers "Retry with <next tier>".
4. Click the toolbar icon for modes (Saver / Balanced / Quality), savings, and a
   box where you can paste any prompt to see where it would land.

## How it works

| File | Role |
| --- | --- |
| `shared/analyzer.js` | Pure heuristic scorer, 0–100. Length, pasted code, number of sub-tasks, and keyword signals (definition/proofread/translate pull down; analyze/design/prove/optimize/trade-offs push up). Short lookups in hard domains are capped so "What is SIEM?" stays cheap. |
| `shared/config.js` | Tiers, mode thresholds, relative cost weights, DOM selectors. |
| `content/content.js` | Intercepts Enter / Send on claude.ai, scores, switches the model via the UI's picker, re-sends, shows the badge, records stats and feedback. |
| `popup/` | Mode picker, difficulty meter, savings, live "try a prompt", settings. |

Learning is deliberately simple: a on a tier lowers that tier's threshold by
3 points (it gets fewer hard prompts); a raises it by 1. Clamped to ±15.
"Estimated savings" compares relative cost weights (Haiku 1 / Sonnet 3 / Opus 15,
editable) against the model you'd otherwise leave selected.

## If the model doesn't switch

Open the popup on a claude.ai tab and click **Test model switch**. It tries to
flip the picker to a different model right now and prints a step-by-step trace:
whether the picker button was found and what it says, whether the menu opened,
which items it saw, and whether the click took. Click **Copy report** and share
it; the fix is usually one or two selector lines in `shared/config.js`.

## Things to expect

- **If switching fails, the console tells you why.** Open DevTools → Console on
  claude.ai and look for a `[SmartRouter] DIAGNOSTICS` group. It lists every
  visible button (text, aria-label, data-testid) and any menu elements on screen.
  That's everything needed to fix the selectors.
- **Selectors are the fragile part.** claude.ai's markup changes without notice. If
  the badge says it couldn't switch, open DevTools, inspect the model picker
  button and its menu items, and update `CSR.SELECTORS` in `shared/config.js`.
  The picker is also found by text as a fallback (any visible button whose label
  contains "Haiku", "Sonnet", or "Opus"), so it often survives markup changes.
- **Model names vary by plan.** Matching is by family substring, so "Sonnet 5.5"
  matches the `sonnet` tier. If your plan lacks a tier, the switch fails gracefully
  and the prompt goes to whatever is selected.
- **Extended thinking control is off by default.** `CSR.SELECTORS.thinkingControl`
  is empty until you've identified the control in your UI; then enable it in
  Settings. The code handles both a toggle (`aria-checked`/`aria-pressed`) and a
  menu with low/medium/high/max items.
- **"Retry with …" sends a new message** on the higher model rather than
  regenerating in place. Simpler and robust; regenerate-in-place can come later.
- Tokens aren't reduced by switching models — cost and compute are. That's the
  objective here.

## Roadmap ideas

- Optional classifier mode: send the prompt to Haiku via the API (user's own key)
  for a difficulty verdict when heuristics are unsure (score 30–60).
- Per-task-type stats (which signals led to) instead of a single threshold shift.
- Conversation-aware scoring: later turns in a hard thread shouldn't drop to Haiku.
- Auto-escalation: detect weak answers (very short, hedged, "I can't") and offer retry.
