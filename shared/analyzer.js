// Prompt difficulty analyzer.
// Pure function: text + settings → { score, tier, effort, reasons }.
// Heuristic by design: no network, no API key, runs in <1 ms.
// Scores are 0–100 and are deliberately conservative on the hard end — a 👎 later
// nudges the thresholds, so false "simple" calls are recoverable.

(function () {
  const CSR = globalThis.CSR;

  // Signals that pull the score DOWN (routine, well-defined tasks).
  const SIMPLE = [
    [/^\s*(what|who|when|where)\s+(is|are|was|were)\b/i, -18, "lookup question"],
    [/\b(define|definition of|meaning of|what does .{1,40} mean)\b/i, -16, "definition"],
    [/\b(proofread|fix (the )?(grammar|typos|spelling)|correct (my|the) (grammar|spelling))\b/i, -20, "proofreading"],
    [/\b(rewrite|reword|rephrase|paraphrase|make (this|it) (shorter|concise|clearer|formal|casual))\b/i, -14, "rewrite"],
    [/\b(translate|in (spanish|french|german|japanese|chinese|italian|portuguese))\b/i, -14, "translation"],
    [/\b(summari[sz]e|tl;?dr|give me the gist)\b/i, -8, "summary"],
    [/\b(convert|format|reformat) .{0,30}(to|into|as) (json|csv|markdown|yaml|a table|a list)\b/i, -12, "formatting"],
    [/\b(regex|one[- ]liner|snippet|quick (question|one))\b/i, -8, "small snippet"],
    [/\b(thanks|thank you|hello|hi there|good (morning|evening))\b/i, -10, "conversational"],
    [/\b(list|name) (some|a few|\d+) /i, -8, "simple list"],
    [/\b(explain like i'?m (5|five)|eli5|in simple terms|briefly)\b/i, -10, "brief explanation"],
  ];

  // Signals that push the score UP (open-ended reasoning, multi-step work, judgment).
  const HARD = [
    [/\b(analy[sz]e|analysis|evaluate|assess|critique|audit|review)\b/i, 10, "analysis"],
    [/\b(design|architect|architecture|propose|strategy|roadmap|plan for)\b/i, 12, "design / strategy"],
    [/\b(prove|proof|theorem|lemma|rigorous|derive|derivation)\b/i, 16, "formal reasoning"],
    [/\b(optimi[sz]e|refactor|performance|scal(e|ing|ability)|concurrenc|race condition|deadlock)\b/i, 10, "optimization / systems"],
    [/\b(debug|why (does|is|isn'?t|doesn'?t) .{0,60}(fail|crash|break|work|hang|leak))\b/i, 9, "debugging"],
    [/\b(trade[- ]?offs?|pros and cons|compare and contrast|which (is|would be) (better|best))\b/i, 9, "judgment / comparison"],
    [/\b(detection gaps?|threat model|attack (surface|paths?|tree|chain)|mitre|att&ck|kill chain|exploit chain|incident response|detection strategy|telemetry)\b/i, 12, "security reasoning"],
    [/\b(initial access|privilege escalation|lateral movement|persistence|exfiltration|command and control|c2)\b/i, 10, "attack lifecycle"],
    [/\b(containment|remediation|eradication|what logs|which logs|logs (i|we) should|investigat(e|ing|ion)|forensic|triage|indicators? of compromise|ioc)\b/i, 10, "incident handling"],
    [/\b(false positives?|prioriti[sz]ed?|map(ping)? .{1,40} to|cover(ing)? .{1,60}, .{1,60}, and)\b/i, 8, "structured multi-part output"],
    [/^\s*(you are|act as|imagine you are|as an? (senior|expert|lead))\b/i, 5, "expert role framing"],
    [/\b(comprehensive|in[- ]depth|thorough|detailed report|white ?paper|literature review|research)\b/i, 10, "long-form / research"],
    [/\b(multi[- ]step|step[- ]by[- ]step reasoning|chain of|edge cases?|corner cases?|think (carefully|hard|deeply))\b/i, 10, "explicit reasoning request"],
    [/\b(implement|build|write) (a|an|the) (full|complete|entire|production)/i, 12, "large implementation"],
    [/\b(game theory|bayesian|stochastic|differential equations?|topology|category theory|np[- ]hard|complexity class)\b/i, 12, "advanced technical domain"],
    [/\b(legal|contract|compliance|regulat|liabilit)/i, 6, "legal / compliance"],
    [/\b(ambiguous|unclear|open[- ]ended|philosoph|ethic)/i, 7, "open-ended"],
  ];

  function countMatches(re, text) {
    const m = text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
    return m ? m.length : 0;
  }

  function analyze(text, settings) {
    settings = settings || CSR.DEFAULT_SETTINGS;
    const raw = (text || "").trim();
    const reasons = [];
    let score = 30; // neutral starting point

    if (!raw) return { score: 0, tier: "haiku", effort: "low", reasons: ["empty prompt"] };

    const words = raw.split(/\s+/).filter(Boolean).length;
    const lines = raw.split(/\n/).length;
    const hasCodeFence = /```/.test(raw);
    const codeish = countMatches(/\b(function|def |class |import |const |let |SELECT |#include|public static|=>|\{\s*$)/m, raw);
    const sentences = raw.split(/[.?!]\s+|\n+/).filter((s) => s.trim().length > 3).length;
    const questions = countMatches(/\?/, raw);
    const imperatives = countMatches(/\b(then|and then|also|after that|next,|finally|additionally|as well as)\b/i, raw);

    // Length: longer prompts usually carry more context and more asks.
    if (words < 12) { score -= 12; reasons.push("very short"); }
    else if (words < 40) { score -= 4; reasons.push("short"); }
    else if (words > 400) { score += 18; reasons.push("very long prompt"); }
    else if (words > 150) { score += 10; reasons.push("long prompt"); }

    // Pasted material (code, logs, documents) to reason over.
    if (hasCodeFence || codeish >= 3) { score += 8; reasons.push("contains code"); }
    if (lines > 25) { score += 6; reasons.push("many lines pasted"); }

    // Multiple asks in one prompt.
    if (imperatives >= 3 || questions >= 3) { score += 12; reasons.push("several sub-tasks"); }
    else if (imperatives >= 1 || questions === 2) { score += 5; reasons.push("compound request"); }

    // Keyword signals (each fires at most once).
    for (const [re, delta, why] of SIMPLE) if (re.test(raw)) { score += delta; reasons.push(why); }
    let hardHits = 0;
    for (const [re, delta, why] of HARD)   if (re.test(raw)) { score += delta; reasons.push(why); hardHits++; }
    // Many distinct hard signals at once = a genuinely demanding brief, not just vocabulary.
    if (hardHits >= 5) { score += 15; reasons.push("many demanding signals"); }
    else if (hardHits >= 3) { score += 8; }

    // Explicit asks for brevity are a strong signal the user wants a cheap answer.
    if (/\b(in|within) (\d+|two|three|a few) (simple |short )?(sentences?|words|lines)\b/i.test(raw) && words < 40) { score -= 10; reasons.push("brevity requested"); }

    // A trivial question about a hard domain is still trivial: if it's a short
    // lookup, cap how much the domain words can raise it.
    const isLookup = /^\s*(what|who|when|where)\s+(is|are|was|were)\b/i.test(raw) && words < 25 && !hasCodeFence;
    if (isLookup && score > 40) { score = 40; reasons.push("short lookup caps score"); }

    score = Math.max(0, Math.min(100, Math.round(score)));

    const mode = CSR.MODES[settings.mode] || CSR.MODES.balanced;
    const adj = settings.adjust || {};
    const haikuMax  = mode.haikuMax  + (adj.haiku  || 0);
    const sonnetMax = mode.sonnetMax + (adj.sonnet || 0);
    const opusMax   = mode.opusMax   + (adj.opus   || 0);

    let ideal = "fable";
    if (score <= haikuMax) ideal = "haiku";
    else if (score <= sonnetMax) ideal = "sonnet";
    else if (score <= opusMax) ideal = "opus";

    const tier = nearestAvailable(ideal, settings.availableTiers);
    if (tier !== ideal) reasons.push(`${CSR.TIER_INFO[ideal].label} not in your picker`);

    return { score, tier, ideal, effort: CSR.EFFORT_FOR_SCORE(score), reasons, words };
  }

  // Step down to the closest cheaper tier the user's plan offers; if nothing cheaper
  // exists, step up. `available` null/empty = not detected yet → assume all.
  function nearestAvailable(tier, available) {
    if (!available || !available.length) return tier;
    if (available.includes(tier)) return tier;
    const i = CSR.TIERS.indexOf(tier);
    for (let j = i - 1; j >= 0; j--) if (available.includes(CSR.TIERS[j])) return CSR.TIERS[j];
    for (let j = i + 1; j < CSR.TIERS.length; j++) if (available.includes(CSR.TIERS[j])) return CSR.TIERS[j];
    return tier;
  }

  CSR.analyze = analyze;
  CSR.nearestAvailable = nearestAvailable;
})();
