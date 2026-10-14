## 🛠️ Under the Hood

Here is a quick map of how the codebase is structured:

*   **`shared/analyzer.js`**: The brain. This is a pure heuristic scorer (0–100) that evaluates your prompt before it sends. It looks at prompt length, pasted code blocks, sub-tasks, and specific keyword signals. It uses benchmark-informed task floors (e.g., short lookups like "What is SIEM?" are capped so they stay cheap on Haiku).
*   **`shared/config.js`**: The control center. This houses the routing tiers, mode thresholds, relative cost weights, and the DOM selectors.
*   **`content/content.js`**: The interceptor. It catches your "Enter/Send" action on `claude.ai`, scores the prompt, physically switches the model via the UI picker, re-sends the message, and updates the badge stats.
*   **`popup/`**: The dashboard. Contains the UI for the mode picker, the live difficulty meter, your savings stats, and extension settings.

**How the routing learns:** 
The feedback loop is deliberately simple so it doesn't overfit. A thumbs-down on a tier lowers its threshold by 3 points (meaning it will receive fewer hard prompts). A thumbs-up raises it by 1 point. Adjustments are strictly clamped to ±15. 

The "Estimated Cost" calculator compares relative cost weights (Haiku = 1, Sonnet = 3, Opus = 15, which you can edit) against your currently selected baseline model to show you exactly how much compute you are saving.

## 🐛 Troubleshooting & What to Expect

Because this extension interacts directly with the DOM, it is vulnerable to UI updates. Here is what you need to know:

*   **Selectors are the fragile part.** `claude.ai`'s markup changes without notice. The extension tries to find the picker by text ("Haiku", "Sonnet", etc.) as a fallback, which usually survives updates. But if the badge says it couldn't switch, you likely need to update `CSR.SELECTORS` in `shared/config.js`.
*   **If switching fails, check the console.** Open DevTools → Console on `claude.ai` and look for the `[SmartRouter] DIAGNOSTICS` group. It lists every visible button and menu element on the screen so you know exactly what to update the selector to.
*   **Test Model Switch:** Open the extension popup on a Claude tab and click **Test model switch**. It will attempt to flip the picker and print a step-by-step trace of what worked and what failed. Click **Copy report** to share it in an Issue or use it to fix the selector yourself.
*   **Missing Models:** Matching relies on family substrings (e.g., "Sonnet 5.5" matches the `sonnet` tier). If your current subscription plan lacks a specific tier, the switch fails gracefully and just sends the prompt to your currently selected model.
*   **Extended Thinking is off by default.** The selector for this (`CSR.SELECTORS.thinkingControl`) is empty by default until you identify the control in your specific UI. Once found, you can enable it in the Settings.
*   **"Retry with..." behavior:** Hitting retry sends a brand new message on the higher model rather than regenerating in place. It is just simpler and more robust for now.
*   **A quick reminder:** TokenSense doesn't reduce your actual *token count*—it reduces your *compute cost* by routing those tokens intelligently.

## 🚦 The Routing Policy

The logic isn't random; it follows Anthropic's own model-selection guidance and public benchmark evidence. We don't just treat Fable as the default for every hard prompt. 

*   **Haiku:** Short lookups, text extraction, basic classification, translation, summaries, and high-volume routine work.
*   **Sonnet:** Your daily driver. Normal coding, debugging, drafting documents, and moderate context synthesis.
*   **Opus:** The heavy lifter. Complex architecture, deep debugging, research synthesis, advanced math, and consequential analysis.
*   **Fable:** The frontier. Explicit long-horizon agentic work, novel reasoning, or unusually demanding multi-step tasks. Fable is a deliberate escalation, as independent benchmarks do not consistently place it above Opus for every standard task.

*(Sources: [Anthropic Model Overview](https://platform.claude.com/docs/en/models/overview), [Choosing a Model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model), [Sonnet 5.5 Announcement](https://www.anthropic.com/claude-sonnet-5-5), [Opus 5.5 Announcement](https://www.anthropic.com/claude-opus-5-5))*

## 🗺️ Roadmap (Pull Requests Welcome!)

Here is what is planned next for TokenSense. If you want to tackle one of these, fork the repo!

*   **Optional API Classifier Mode:** Allow users to plug in their own Anthropic API key to send ambiguous prompts (score 30–60) to Haiku for a rapid "difficulty verdict" when the local heuristics are unsure.
*   **Granular Stats:** Track per-task-type performance (e.g., which specific signals led to a thumbs-down) instead of just relying on a single global threshold shift.
*   **Conversation-Aware Scoring:** Ensure that later turns deep inside a highly complex thread don't accidentally get dropped down to Haiku.
*   **Auto-Escalation:** Detect weak or hedged answers (e.g., very short replies or "I can't do that") and automatically offer a one-click retry on a smarter tier.
