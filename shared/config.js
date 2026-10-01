// Shared configuration for Claude Smart Router.
// Loaded by both the content script and the popup (plain globals, no modules).

const CSR = (globalThis.CSR = globalThis.CSR || {});

// The three capability tiers the router chooses between.
// `match` is the substring looked for in claude.ai's model picker (case-insensitive),
// so this keeps working across versions like "Haiku 4.5" or "Sonnet 5.5".
CSR.TIERS = ["haiku", "sonnet", "opus", "fable"];

CSR.TIER_INFO = {
  haiku:  { label: "Haiku",  match: "haiku",  cost: 1 },
  sonnet: { label: "Sonnet", match: "sonnet", cost: 3 },
  opus:   { label: "Opus",   match: "opus",   cost: 15 },
  fable:  { label: "Fable",  match: "fable",  cost: 30 },
};
// Not every plan offers every tier. The content script reads the model menu the
// first time it opens and stores the tiers it actually found in
// settings.availableTiers; the analyzer then falls back to the nearest available
// tier (Fable → Opus, missing Haiku → Sonnet). null means "not detected yet".
// `cost` is a rough relative weight (roughly API price ratios) used only for the
// "estimated savings" figure. Edit freely; it changes nothing about routing.

// Difficulty score is 0–100. Each mode sets the upper bound for Haiku, Sonnet and
// Opus; anything above the Opus bound goes to Fable (if available).
CSR.MODES = {
  saver:    { label: "Saver",    haikuMax: 55, sonnetMax: 85, opusMax: 97 },
  balanced: { label: "Balanced", haikuMax: 35, sonnetMax: 70, opusMax: 92 },
  quality:  { label: "Quality",  haikuMax: 20, sonnetMax: 55, opusMax: 85 },
};

// Effort suggested per tier (used only if thinking control is enabled and a
// selector for it is configured — see SELECTORS below).
CSR.EFFORT_FOR_SCORE = (score) => {
  if (score < 30) return "low";
  if (score < 60) return "medium";
  if (score < 85) return "high";
  return "max";
};

CSR.DEFAULT_SETTINGS = {
  enabled: true,
  mode: "balanced",
  baseline: "sonnet",      // model you'd otherwise leave selected; savings are measured against it
  controlThinking: false,  // off until you've confirmed a working selector for your UI
  showBadge: true,
  // Learning: per-tier threshold adjustment in score points, clamped to ±15.
  // Positive = that tier is trusted with harder prompts; negative = less trusted.
  adjust: { haiku: 0, sonnet: 0, opus: 0 },
  availableTiers: null,    // detected from the picker; see TIER_INFO note
};

CSR.DEFAULT_STATS = {
  routed: { haiku: 0, sonnet: 0, opus: 0, fable: 0 },
  feedback: { up: 0, down: 0 },
  costSpent: 0,     // sum of cost weights of models actually used
  costBaseline: 0,  // sum of cost weights if the baseline model had been used every time
  history: [],      // last 200 {t, score, tier, ok}
};

// DOM selectors for claude.ai. These are the fragile part — claude.ai's markup
// changes without notice. Each entry is a list; the first one that matches wins.
// Adjust these in DevTools if routing stops switching models.
CSR.SELECTORS = {
  // The editable prompt box.
  composer: [
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea',
  ],
  // The send button.
  sendButton: [
    'button[aria-label*="Send" i]',
    'button[data-testid*="send" i]',
    'button[type="submit"]',
  ],
  // The button that opens the model picker. Resolved by text match (TIER_INFO.match)
  // if none of these hit.
  modelPickerButton: [
    'button[data-testid*="model" i]',
    'button[aria-label*="model" i]',
  ],
  // Items inside the opened model menu.
  modelMenuItem: [
    '[role="menuitem"]',
    '[role="option"]',
    '[role="menuitemradio"]',
  ],
  // Optional: control for extended thinking / effort. Left empty on purpose;
  // fill in once you've inspected your UI. Expected to be a toggle or a menu button.
  thinkingControl: [],
};
