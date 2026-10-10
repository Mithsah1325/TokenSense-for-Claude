# TokenSense for Claude

A Chrome extension for claude.ai that scores each prompt's difficulty before it's
sent, switches the model picker to the cheapest tier that should handle it
(Haiku → Sonnet → Opus → Fable), and learns from your feedback and pattern.

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
| `shared/analyzer.js` | Pure heuristic scorer, 0–100. Uses benchmark-informed task floors: Haiku for routine lookup/extraction, Sonnet for ordinary coding/debugging, Opus for architecture/research/advanced reasoning, and Fable for exceptional long-horizon or frontier work. Length, pasted code, number of sub-tasks, and keyword signals refine the choice; the displayed score is raised into the selected capability band when necessary. Short lookups in hard domains are capped so "What is SIEM?" stays cheap. |
| `shared/config.js` | Tiers, mode thresholds, relative cost weights, DOM selectors. |
| `content/content.js` | Intercepts Enter / Send on claude.ai, scores, switches the model via the UI's picker, re-sends, shows the badge, records stats and feedback. |
| `popup/` | Mode picker, difficulty meter, savings, live "try a prompt", settings. |

Learning is deliberately simple: a on a tier lowers that tier's threshold by
3 points (it gets fewer hard prompts); a raises it by 1. Clamped to ±15.
"Estimated savings" compares relative cost weights (Haiku 1 / Sonnet 3 / Opus 15,
editable) against the currently selected baseline model and recalculates from the
routed model counts, so changing the baseline does not leave a stale percentage.

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

  ## Routing policy

  The policy follows Anthropic's model-selection guidance and public benchmark
  evidence rather than treating Fable as the default for every difficult prompt:

  - **Haiku:** short lookups, extraction, classification, translation, summaries,
    and other high-volume routine work.
  - **Sonnet:** normal coding, debugging, document work, and moderate
    long-context synthesis.
  - **Opus:** architecture, difficult debugging, research synthesis, advanced
    mathematics, and consequential analysis.
  - **Fable:** explicit long-horizon agentic work, novel/frontier reasoning, or
    unusually demanding multi-step tasks. It is a deliberate escalation because
    independent broad benchmarks do not consistently place it above Opus for
    every task.

  Sources: [Anthropic model overview](https://platform.claude.com/docs/en/models/overview),
  [choosing a model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model),
  [Sonnet 5.5 announcement](https://www.anthropic.com/claude-sonnet-5-5), and
  [Opus 5.5 announcement](https://www.anthropic.com/claude-opus-5-5).

## Roadmap ideas

- Optional classifier mode: send the prompt to Haiku via the API (user's own key)
  for a difficulty verdict when heuristics are unsure (score 30–60).
- Per-task-type stats (which signals led to) instead of a single threshold shift.
- Conversation-aware scoring: later turns in a hard thread shouldn't drop to Haiku.
- Auto-escalation: detect weak answers (very short, hedged, "I can't") and offer retry.
