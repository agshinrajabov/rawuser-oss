/**
 * Per-intent user prompt builders.
 *
 * Each intent gets a prompt that explains:
 *   1. What this visitor intent means
 *   2. The structure plan (section order + emphasis + steering notes)
 *   3. The customer's per_intent_hints for this dim, if provided
 *   4. Exact output format instruction
 *
 * The cached DNA preamble (system prompt) already explains the schema and
 * quality rules — this user prompt focuses on the intent-specific shape.
 *
 * Source modifiers are APPENDED to this prompt by the orchestrator, not
 * baked in here, to keep this function pure and testable.
 */

import type { BusinessDNA, IntentDim, Manifest } from "@rawuser/shared";
import {
  LINE_CAP,
  LINE_FLOOR,
  parseTemplate,
  templateSlots,
  templateText,
} from "@rawuser/shared/template";
import {
  CTA_LANGUAGES,
  type CtaFacts,
  KEEP_OWN_ACTION,
  LABEL_SIGNATURE_MAX,
  ctaObjectsOf,
  describeKinds,
  isButtonLabelPath,
} from "../lint/cta-action.ts";
import {
  isSectionHeadingPath,
  keepSubjectLine,
  sectionSubjectsOf,
} from "../lint/section-subject.ts";
import { INTENT_STRUCTURES } from "./intent-structures.ts";

/**
 * Builds the per-intent user prompt for a variant generation call.
 *
 * @param intentDim - The intent dimension to generate for
 * @param dna - The customer's business DNA (for per_intent_hints injection)
 * @param customerId - Used to populate the output's customer_id field
 * @param manifest - Optional element manifest. When provided AND entries
 *   include original_char_length / original_word_count, per-section length
 *   constraints are injected so generated copy matches the existing layout.
 * @param ctas - What each button of the page does and which one is counted
 *   (orchestrator `ctasOf`): every label keeps its action.
 * @returns The user prompt string (no source modifier included — append separately)
 */
export function buildIntentPrompt(
  intentDim: IntentDim,
  dna: BusinessDNA,
  customerId: string,
  manifest?: Manifest,
  ctas?: ReadonlyMap<string, CtaFacts>,
): string {
  const fullStructure = INTENT_STRUCTURES[intentDim];
  const hint = dna.per_intent_hints?.[intentDim];
  const lengthConstraintsBlock = buildLengthConstraintsBlock(manifest);

  // When a manifest is supplied (Fix Pass A / QA-2), filter the structure plan
  // to ONLY include sections whose name appears as a prefix of at least one
  // manifest dot-path. This makes the prompt internally consistent: if the
  // manifest can't cover "social_proof.headline", the prompt shouldn't tell
  // the model to emit a social_proof section. Otherwise the model trusts the
  // explicit structure plan more than the abstract ALLOWED PATHS constraint
  // and emits sections we'll reject (observed regen failure 2026-05-31).
  const manifestKeys = manifest ? Object.keys(manifest) : [];
  const manifestActive = manifestKeys.length > 0;
  const allowedSectionPrefixes = new Set(
    manifestKeys.map((k) => k.split(".")[0]).filter((s): s is string => Boolean(s)),
  );
  const structure = manifestActive
    ? fullStructure.filter((s, i) => {
        const key = sectionKey(s.kind, i, intentDim);
        const prefix = key.split(".")[0] ?? key;
        return allowedSectionPrefixes.has(prefix);
      })
    : fullStructure;

  const structureBlock = structure
    .map((section, i) => {
      const key = sectionKey(section.kind, i, intentDim);
      const emphasisPct = Math.round(section.emphasis * 100);
      const noteLine = section.note ? `\n     Note: ${section.note}` : "";
      // When a manifest is active, tell the model the EXACT leaf fields this
      // section may carry (derived from the manifest), not just the section
      // name. Without this the model trusts a section's steering note over the
      // abstract ALLOWED PATHS list — e.g. a "pricing" section whose only
      // manifest leaf is `pricing.cta.label` still gets a headline + body
      // because the note says "full plan breakdown". Those extra leaves are
      // then pruned post-generation (R3), wasting tokens and de-cohering copy.
      // Naming the allowed fields inline keeps the section internally honest.
      const fields = manifestActive
        ? allowedLeavesForSection(key, manifestKeys).flatMap((f) =>
            f.endsWith("headline") || f.endsWith("body") ? [f, `${f}_alt`, `${f}_alt2`] : [f],
          )
        : [];
      const fieldsLine =
        manifestActive && fields.length > 0
          ? `\n     Emit ONLY these fields for this section: ${fields.join(", ")} (no other fields; the page has no element for them).`
          : "";
      return `  ${i + 1}. section key: "${key}"
     kind: "${section.kind}" | emphasis: ${emphasisPct}%${noteLine}${fieldsLine}`;
    })
    .join("\n\n");

  // A button outside the plan (2026-10-12, docs/specs/button-rewrite.md). A
  // button is in this manifest only because the operator turned its rewrite
  // on. The form's submit has no section in any plan and the pricing button
  // has one in two of six, so nothing above asks for them: on the pilot's site no
  // version of twenty wrote the form's label. One line asks.
  const planned = new Set(
    structure.flatMap((section, i) => {
      const key = sectionKey(section.kind, i, intentDim);
      return allowedLeavesForSection(key, manifestKeys).map((f) => (f === key ? f : `${key}.${f}`));
    }),
  );
  const unplanned = manifestActive
    ? manifestKeys.filter((k) => isButtonLabelPath(k) && !planned.has(k))
    : [];
  const unplannedBlock =
    unplanned.length > 0
      ? `
ALSO WRITE (buttons of this page that the plan above does not name; the customer asked for
their words to be written, so each gets its label, for this visitor, within its limit):
${unplanned.map((k) => `- ${k}`).join("\n")}
`
      : "";

  const hintBlock = hint
    ? `\nCUSTOMER HINT FOR THIS INTENT:\n${hint}\nHonor this hint when writing the hero and relevant sections.\n`
    : "";

  const intentDescriptions: Record<IntentDim, string> = {
    competitor: `The visitor is comparing this product against a named or implied competitor.
They are in decision mode: they have a shortlist and are making a final call.
Your job: help them see the honest difference clearly. Lead with the comparison
frame, anchor it with proof, and make the switch feel low-risk.`,

    evaluation: `The visitor is evaluating the category. They don't have a rival in mind yet,
they are doing research homework. They want criteria, transparency, and trust.
Your job: position this product as the most credible, transparent option for
someone who is systematically comparing tools. Do NOT over-sell. Evaluators
reward honesty.`,

    feature: `The visitor is interested in a specific capability. They arrived with technical
intent: they want to know if this product can do the thing they need.
Your job: validate their specific interest immediately, then go deep. Skip the
category-level pitch. This section benefits from real technical specifics.`,

    problem: `The visitor arrived with a problem they want solved. They are NOT evaluating
tools yet. They want to know if someone understands their situation.
Your job: lead with empathic problem validation. Name the problem in the
visitor's words before mentioning the product. A visitor who reads the hero and
thinks "yes, exactly that" is a successful hero for this intent.`,

    brand: `The visitor arrived directly or via brand recognition. This is the canonical
page impression. Some visitors may be new, some may be returning.
Your job: deliver the full brand narrative. Warm, aspirational, credible.
This is the most important variant. It IS the default experience.`,

    pricing: `The visitor arrived cost-first. They want to know what it costs and whether
it's worth it. They may be on a budget, or they may be comparing options.
Your job: lead with pricing transparency. Give them numbers and plan tiers
before making any other argument. Features sections justify the price.`,
  };

  const profileKey = `intent:${intentDim}`;
  const manifestConstraintBlock = buildManifestConstraintBlock(manifest, ctas, dna.target_language);

  return `Generate the "${intentDim}" intent variant.

VISITOR INTENT:
${intentDescriptions[intentDim]}
${hintBlock}
STRUCTURE PLAN (advisory: emphasize this intent's frame; the actual emitted paths are constrained below):
${structureBlock}
${unplannedBlock}${lengthConstraintsBlock}${manifestConstraintBlock}
OUTPUT REQUIREMENTS:
- customer_id: "${customerId}"
- profile_key: "${profileKey}"
- generated_at: ${Date.now()} (Unix ms timestamp)
- prompt_hash: "" (leave empty; the pipeline fills this)
- sections: an object whose leaf string paths are a STRICT SUBSET of the ALLOWED PATHS list above (when present).

All copy (headlines, body text, CTA labels) must be in the target language
specified in the system prompt. No English copy in visible fields unless the
target language IS English.

Output the JSON object now. No markdown, no commentary.`;
}

/**
 * Builds the manifest-keys constraint block.
 *
 * The customer's confirmed element manifest is the SOURCE OF TRUTH for which
 * dot-paths the snippet can actually swap on the page. Generating a variant
 * with paths the manifest doesn't cover means the snippet's all-or-nothing
 * pre-flight aborts (ADR 0017 D5.4) and the visitor sees the original page —
 * a silent personalization failure (QA-2 + QA-3 from the verification report).
 *
 * This block instructs the model to emit ONLY leaf paths that exist in the
 * manifest. The post-generation validator (parseAndValidate) rejects any
 * variant whose leaf paths are not a subset; the existing retry path then
 * fires a corrective prompt.
 *
 * Returns "" when the customer has no confirmed manifest — generation falls
 * back to the structure-plan-driven shape (legacy behavior).
 */
function buildManifestConstraintBlock(
  manifest?: Manifest,
  ctas?: ReadonlyMap<string, CtaFacts>,
  language?: string,
): string {
  if (!manifest) return "";

  const keys = Object.keys(manifest);
  if (keys.length === 0) return "";
  // The example names this page's own paths: a fixed "hero.cta.label" here
  // asked for a button on a page whose buttons stay as built.
  const nested = keys.find((k) => k.split(".").length > 2);

  return `
ALLOWED PATHS (the customer's confirmed element manifest. The snippet can ONLY swap these
paths on the customer's page. Emit ONLY values for leaf string paths within this list.
Do NOT invent additional paths. The pipeline will reject the variant if any leaf path is
not in this list.):
${keys.map((k) => `- ${k}`).join("\n")}

Each path is a dot-separated location inside your sections object. For example, the path
"${keys[0]}" means sections.${keys[0]}${nested ? `; the path "${nested}" means\nsections.${nested}` : ""}. The kind field is metadata and not subject to this constraint.
${hrefLine(keys)}${offButtonsLine(manifest, ctas)}
${buttonsBlock(manifest, ctas, language)}${sectionHeadingsBlock(manifest, language)}${emphasisBlock(manifest)}${twoLengthsBlock(manifest)}${templateBlock(manifest)}${moreBlock(manifest)}`;
}

/**
 * No link is asked for on a page we read (the first outside pilot, 2026-10-12: 19
 * of 20 bodies carried "#enroll", "#contact" or "#products", anchors the
 * page does not have). A button keeps the page's own link; the snippet
 * writes an href only on an element the page tags `data-rawuser="…href"`
 * and that has none, so on a manifest page an href is asked for only where
 * the manifest itself lists that path.
 */
export function hrefLine(manifestKeys: readonly string[]): string {
  const asked = manifestKeys.filter((k) => k.endsWith(".href"));
  return asked.length === 0
    ? "Emit no href field anywhere: every button keeps the page's own link, and the pipeline drops any href."
    : `Emit an href only for ${asked.join(", ")}; every other button keeps the page's own link.`;
}

/**
 * A button the operator did not turn on keeps the page's own words
 * (lib/button-rewrite.ts): it is not in the manifest a version is written
 * from, so its path is in no list here. One line says why no button is asked
 * for, without naming it: the cached preamble's schema shows a cta label on
 * every hero, and a model that follows it writes one that is then pruned.
 */
export function offButtonsLine(manifest: Manifest, ctas?: ReadonlyMap<string, CtaFacts>): string {
  if (!ctas || ![...ctas.keys()].some((p) => !(p in manifest))) return "";
  return `
A button that is not in the ALLOWED PATHS keeps the page's own words: emit no label for it.`;
}

/**
 * Every button keeps what it does (the measure-lab QA, 2026-10-05): the
 * counted "Start free" came back as "See how", and "See plans" as "Start
 * free", so the page showed two start buttons and counted one. The words may
 * change for this visitor; the action, read from the page's words and link,
 * may not, and no other button takes the counted button's words.
 *
 * A button whose action nobody could read (`unread`: the first outside pilot,
 * 2026-10-12) is named too, held to what its own label asks for; before,
 * the model was told nothing about it.
 */
export function buttonsBlock(
  manifest: Manifest,
  ctas?: ReadonlyMap<string, CtaFacts>,
  language?: string,
): string {
  if (!ctas) return "";
  const lang = language?.split("-")[0]?.toLowerCase() ?? "";
  const lines: string[] = [];
  let namesObject = false;
  // A counted button that stays as built is not in this manifest
  // (lib/button-rewrite.ts): the model never sees its path, so its words are
  // said here.
  const counted = [...ctas.entries()]
    .filter(([, f]) => f.counted)
    .map(([p, f]) => (p in manifest || !f.own ? p : `${p}, which keeps the page's "${f.own}"`));
  for (const [path, facts] of ctas) {
    if (!(path in manifest) || (facts.kinds.size === 0 && !facts.unread)) continue;
    const own = manifest[path]?.text?.[0];
    const said = own ? ` (the page's own says "${own}")` : "";
    const unread = facts.kinds.size === 0;
    const note = facts.counted
      ? unread
        ? " This is the counted button."
        : " This is the counted button: every version keeps it this kind of label."
      : counted.length > 0
        ? ` Never the words of the counted button (${counted.join(", ")}).`
        : "";
    // The object, from the page's own label alone (the first outside pilot, A1.6):
    // the same words the model already sees here, never the link or the
    // site map.
    const objects =
      own && own.length < LABEL_SIGNATURE_MAX && CTA_LANGUAGES.has(lang)
        ? ctaObjectsOf(own, lang)
        : [];
    const thing =
      objects.length > 0
        ? ` It opens what ${objects.map((o) => `"${o.word}"`).join(" or ")} names: keep that word in the label, in any form.`
        : "";
    if (thing) namesObject = true;
    lines.push(
      unread
        ? `- ${path}${said}: ${KEEP_OWN_ACTION}. No sign-up, contact, demo, buy or download label unless the page's own label is one.${note}${thing}`
        : `- ${path}${said}: ${describeKinds(facts.kinds)}.${note}${thing}`,
    );
  }
  if (lines.length === 0) return "";
  const object = namesObject
    ? `
A label keeps what it points at too. Where the page's label names a thing (its products, its
prices, a guide), the version names the same thing: the link still opens it. New words go
around that word, never in its place.`
    : "";
  return `
BUTTONS KEEP THEIR ACTION. A button's words may change for this visitor; what the button does
may not, because its link stays the page's own. A start button stays a start, a pricing
button stays pricing, a demo stays a demo, a reading link stays a reading link:
${lines.join("\n")}${object}
`;
}

/**
 * A heading that labels what is under it keeps its subject (the first outside
 * pilot, A3). The section heading over the product grid, "Sağlamlığınız üçün
 * əlavələr", came back as "Probleminizi necə həll edirik" and "Qiymətləndirmə
 * meyarları": the plan's note for the section steers the angle, and nothing
 * said that the content under the heading stays the page's own. The hero's
 * headline and the closing call to action's are not listed: they carry the
 * reason and the pitch.
 */
export function sectionHeadingsBlock(manifest: Manifest, language?: string): string {
  const lang = language?.split("-")[0]?.toLowerCase() ?? "";
  const lines: string[] = [];
  for (const [path, entry] of Object.entries(manifest)) {
    if (!isSectionHeadingPath(path) || entry.skip) continue;
    const own = entry.text?.[0];
    const subjects = sectionSubjectsOf(own, lang);
    if (subjects.length === 0) continue;
    lines.push(`- ${path} (the page's own says "${own}"): ${keepSubjectLine(subjects)}.`);
  }
  if (lines.length === 0) return "";
  return `
SECTION HEADINGS LABEL WHAT IS UNDER THEM. Under each of these headings sits content this
version does not change: a grid of products, a list, a form. So the heading still names that
content. Keep the word that names it and change the angle around it for this visitor; a
heading about something else leaves that content without its label:
${lines.join("\n")}
`;
}

/**
 * Two lengths for every headline: a character count cannot predict where
 * the page wraps (a Lovable test site, 2026-09-14: 26 characters took one line,
 * 30 took two). The snippet writes the first while the element is hidden,
 * measures its box against the original's, and keeps the one that holds
 * the line count.
 */
export function twoLengthsBlock(manifest: Manifest): string {
  const heads = Object.keys(manifest).filter((k) => k.endsWith("headline"));
  // Paragraphs too (2026-09-15): a paragraph whose last line is nearly full
  // gains a line on any growth. Three lengths since 2026-09-16: one near
  // the original, one on each side of it, so the page always has a
  // candidate to fall back to; asking the model to land exactly under or
  // over a count rejected a third of the versions.
  const bodies = Object.keys(manifest).filter(
    (k) => k.endsWith("body") && (manifest[k]?.original_char_length ?? 0) >= 40,
  );
  if (heads.length === 0 && bodies.length === 0) return "";
  const headLines = heads.map((h) => `- ${h}_alt and ${h}_alt2 next to ${h}`).join("\n");
  const bodyLines = bodies.map((b) => `- ${b}_alt and ${b}_alt2 next to ${b}`).join("\n");
  const headPart =
    heads.length > 0
      ? `For every headline also emit two more versions of the same idea: _alt
a little longer (between 105% and 115% of the original's count) and _alt2
clearly shorter (between 70% and 85%), each its own complete sentence, not
the first with a clause bolted on or cut off, and never a copy of the first:
${headLines}
`
      : "";
  const bodyPart =
    bodies.length > 0
      ? `For every paragraph also emit two more versions of the same idea: _alt
clearly shorter, between 75% and 90% of the original's count, and _alt2
in more, between 105% and 115%; drop or add a clause, never a fact or a
number, and never a copy of the first:
${bodyLines}
`
      : "";
  return `
THREE LENGTHS. ${headPart}${bodyPart}The page keeps whichever of the three holds its own line count. The short one is the
one the page can always fall back to on any screen, so it must really be short; write all
three to be shown.
`;
}

/**
 * More candidates for a headline the page measured (docs/specs/interactive-text.md
 * §3.4): code wraps every candidate at 1280, 768 and 390 px with the page's
 * own font and keeps the three that hold its lines. The model is not asked
 * to count; it is asked for variety.
 */
export function moreBlock(manifest: Manifest): string {
  const measured = Object.entries(manifest).filter(
    ([path, e]) => path.endsWith("headline") && e.metrics && !e.skip,
  );
  if (measured.length === 0) return "";
  const lines = measured
    .map(([path, e]) =>
      e.inline?.template
        ? `- ${path}_more: three more word lists, each shaped like ${path}`
        : `- ${path}_more: three more sentences`,
    )
    .join("\n");
  return `
MORE CANDIDATES. The page measures how these headlines wrap on a wide screen, a tablet and a
phone, and keeps the versions that hold its own lines there, so give it more to choose from.
Next to each, emit three more versions of the same idea in the same form: one clearly
shorter than the page's own headline (at most four fifths of its length), one about as
long, one a few words longer. Each complete and natural,
each in the brief's voice, never a copy of another version:
${lines}
`;
}

/**
 * Parts built word by word (docs/specs/template-writing.md §4.2): the model
 * writes a list of words per run and code places every token
 * (`fillTemplate`), so a version keeps the structure by construction. The
 * page's own words are not shown (shown them, the model returned them: 14 of
 * 30 on the first lab run); each line is described by its length, where its
 * sentence starts and ends, and the rotating slot by its size.
 */
export function templateBlock(manifest: Manifest): string {
  const slots = Object.entries(manifest).filter(
    ([, e]) => typeof e.inline?.template === "string" && !e.skip,
  );
  if (slots.length === 0) return "";
  const parts = slots.map(([path, e]) => describeTemplate(path, e.inline?.template ?? ""));
  return `
BUILT WORD BY WORD. These parts are built word by word on the page, with images, styled
words and line breaks the page places itself. Write each of them, and each of its other
lengths (_alt, _alt2), as a JSON array: one string per run below, in order, never one
sentence in a single string. The rotating word is the page's own: it is not in the list, and
the page keeps it. Each run about its number of words (one more or fewer is fine). Punctuate
your sentences inside the runs as they need, with a capital after a full stop, and end a run
with a full stop where a sentence ends at the end of a line; nothing right before the rotating
word. A price keeps its currency sign, as the brief writes it. _alt and _alt2 are other
wordings of the same idea, never the first list again: _alt one or two words more across its
runs, _alt2 one or two fewer.
${parts.join("\n")}
`;
}

function rotWords(template: string): string {
  const rot = parseTemplate(template).find((t) => t.t === "rot");
  return rot?.t === "rot" ? rot.alts.join(", ") : "";
}

/**
 * How the page leads into its rotating word: the last words before it
 * ("…they can" + "read"). Without it the model wrote a finished sentence and
 * the page's verb dangled after it ("who they are read", 2026-09-28).
 */
function rotHook(template: string): string {
  const tokens = parseTemplate(template);
  const at = tokens.findIndex((t) => t.t === "rot");
  const before = tokens
    .slice(0, at)
    .reverse()
    .find((t) => t.t === "text" && /[\p{L}\p{N}]/u.test(t.text));
  const words = before?.t === "text" ? before.text.trim().split(/\s+/) : [];
  const hook = words.slice(-1).join(" ");
  const first = rotWords(template).split(", ")[0] ?? "";
  if (!hook)
    return "Write the words before it so the line reads as a sentence ending on each of them.";
  return `The page's run before it ends on "${hook}", so "${hook} ${first}" reads: end your last run the same way, on a word that each rotating word follows as the end of one sentence ("${hook}", "to", "will" and the like), never on a finished sentence, and never write a rotating word yourself.`;
}

function describeTemplate(path: string, template: string): string {
  const slots = templateSlots(template);
  const lines = templateText(template).split("\n");
  // The page's headline as a reader sees it, for its grammar only: which
  // run carries the subject, where the sentence turns. Its words stay out of
  // the version (template-copy on the whole, on a line, on the rotating
  // words), and the tokens are placed by code, so this is shown as prose.
  const reads = parseTemplate(template)
    .map((t) =>
      t.t === "text"
        ? t.text
        : t.t === "br"
          ? " / "
          : t.t === "rot"
            ? `${t.alts[0]} (or ${t.alts.slice(1).join(", ")})`
            : "",
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const out: string[] = [
    `- ${path}, ${lines.length} line${lines.length > 1 ? "s" : ""}. The page's own reads "${reads}": write a different idea for this visitor in the same grammar, none of its words except small ones like "the", "you", "can".`,
  ];
  let n = 0;
  lines.forEach((text, li) => {
    const onLine = slots.map((s, i) => ({ s, i })).filter(({ s }) => s.line === li);
    const first = onLine[0]?.s;
    const opens = li === 0 ? "; the headline starts here, with a capital letter" : "";
    const runs = onLine
      .map(({ s }) => {
        if (s.kind === "run") n++;
        return s.kind === "run"
          ? `run ${n}, ${s.words} word${s.words > 1 ? "s" : ""}`
          : `then the page's own rotating word (${rotWords(template)}), which the page keeps. ${rotHook(template)}`;
      })
      .join("; ");
    // The windows the lint holds (templateLineMisses): a phone wraps a line
    // the way it wraps the page's only when it is near the page's length,
    // and the last line, with the page's longest rotating word, never over.
    const last = li === lines.length - 1;
    const lo = Math.ceil(text.length * LINE_FLOOR);
    const hi = last ? text.length : Math.floor(text.length * LINE_CAP);
    const longest = rotWords(template)
      .split(", ")
      .reduce((a, b) => (b.length > a.length ? b : a), "");
    const size =
      text.length < 8
        ? `about ${text.length} characters`
        : last && longest
          ? `${lo} to ${hi} characters counting the longest rotating word, "${longest}", never more`
          : `${lo} to ${hi} characters`;
    out.push(`  line ${li + 1} (${size}${opens}): ${runs}`);
  });
  const shape = slots.flatMap((s) =>
    s.kind === "run" ? [`"${Array(s.words).fill("…").join(" ")}"`] : [],
  );

  out.push(`  the form, not the words: "${path.split(".").pop()}": [${shape.join(", ")}]`);
  return out.join("\n");
}

/**
 * The page emphasises one phrase inside some parts (an italic, a coloured
 * span). The version keeps that design by marking one phrase of its own
 * (docs/specs/design-preserving-rewrite.md §2).
 */
export function emphasisBlock(manifest: Manifest): string {
  const slots = Object.entries(manifest).filter(
    ([, e]) => (e.inline?.emphasis ?? 0) >= 1 && !e.skip,
  );
  if (slots.length === 0) return "";
  const lines = slots
    .map(([path, e]) =>
      e.inline?.emphasis_phrase
        ? `- ${path} (the page emphasises "${e.inline.emphasis_phrase}")`
        : `- ${path}`,
    )
    .join("\n");
  return `
EMPHASIS. The page's design emphasises one phrase inside these parts:
${lines}
In each of them, wrap exactly one phrase of two to four words in asterisks, like
*this phrase*: the phrase a reader should notice first. One pair, never the whole
line, and no asterisks in any other part.
`;
}

/**
 * Builds the per-section length constraint block from the manifest.
 *
 * The customer's landing page IS the layout constraint. Generated copy
 * must fit within ±20% of the original element's character / word count so
 * the layout doesn't break (overflow, truncation, awkward wrapping).
 *
 * Returns "" when manifest is absent or has no length data — generation
 * falls back to default natural-length copy. Backward compatible with
 * legacy manifests detected before D6.2.
 */
function buildLengthConstraintsBlock(manifest?: Manifest): string {
  if (!manifest) return "";

  const lines: string[] = [];
  for (const [path, entry] of Object.entries(manifest)) {
    const charLen = entry.original_char_length;
    const wordCount = entry.original_word_count;
    if (charLen === undefined && wordCount === undefined) continue;

    // Upper bound for every part. Headlines and buttons also get a floor:
    // a version half the original's length takes one line where the
    // original took two and shifts the page (a Lovable test site, 2026-09-14,
    // CLS 0.025). The floor is a target, never a reason to clip a clause
    // (the bake-off of 2026-09-11 showed what a hard lower bound does).
    // Paragraphs get a narrower window (2026-09-14, the founder's ask): a
    // paragraph has many lines, so its character count predicts its line
    // count well, and an explanation half the page's length leaves a hole
    // in the design where the original filled it.
    const lineBound = LINE_BOUND_PATH.test(path);
    const cap =
      charLen !== undefined
        ? lineBound && charLen >= 20
          ? `between ${path.endsWith("headline") ? Math.round(charLen * 0.95) : Math.round(charLen * 0.85)} and ${path.endsWith("headline") ? Math.round(charLen * 1.05) : Math.round(charLen * 1.25)} characters (the page shows the original on a fixed number of lines; a shorter version changes that: on one page 24 characters took one line where 30 took two; a longer one wraps; the second and third lengths sit just either side)`
          : lineBound
            ? `at most ${Math.max(12, Math.round(charLen * 1.25))} characters (a button label; a longer one breaks its row on a phone)`
            : !lineBound && charLen >= PARAGRAPH_MIN_CHARS
              ? `between ${Math.round(charLen * PARAGRAPH_FLOOR)} and ${Math.round(charLen * PARAGRAPH_CAP)} characters (an explanation as long as the page's own keeps its lines; say the same amount)`
              : `at most ${Math.max(20, Math.round(charLen * 1.25))} characters`
        : wordCount !== undefined
          ? `at most ${Math.max(3, Math.round(wordCount * 1.25))} words`
          : null;
    if (cap) lines.push(`- ${path}: ${cap}`);
  }

  if (lines.length === 0) return "";

  return `
LENGTH LIMITS (the customer's page is the layout; longer copy breaks it.
Headlines and buttons stay close to the original's length so the line
count stays; a paragraph stays within about a tenth of the original's
length, so it fills the same space. Within the limits,
the shortest complete sentence wins; never pad with a clause):
${lines.join("\n")}
`;
}

/** Parts whose length sets a line count on the page: headlines and buttons. */
const LINE_BOUND_PATH = /\.(headline|label|submit_label)$/;
/** A paragraph this long or longer gets the narrow window; shorter ones keep the cap only. */
export const PARAGRAPH_MIN_CHARS = 40;
export const PARAGRAPH_FLOOR = 0.95;
export const PARAGRAPH_CAP = 1.05;

/**
 * Derives the section key for a given section position.
 *
 * Rules:
 * - Most sections use their kind as the key: "hero", "comparison", etc.
 * - The "feature" intent has two "features" sections, disambiguated as
 *   "features_core" and "features_integrations".
 * - All other duplicate kinds (rare) fall back to kind + index.
 */
function sectionKey(kind: string, index: number, intentDim: IntentDim): string {
  if (intentDim === "feature" && kind === "features") {
    return index === 1 ? "features_core" : "features_integrations";
  }
  return kind;
}

/**
 * Returns the leaf field names a given section may carry, derived from the
 * manifest. For section key "pricing" and manifest key "pricing.cta.label",
 * the leaf is "cta.label". For "hero" with hero.headline / hero.body /
 * hero.cta.label, the leaves are ["headline", "body", "cta.label"].
 *
 * This is the leaf-level counterpart to the section-prefix filter: the filter
 * decides WHICH sections survive; this decides WHICH fields each surviving
 * section may emit, so the prompt never asks for a field the manifest can't map.
 */
function allowedLeavesForSection(sectionKeyName: string, manifestKeys: string[]): string[] {
  const prefix = `${sectionKeyName}.`;
  return manifestKeys
    .filter((k) => k === sectionKeyName || k.startsWith(prefix))
    .map((k) => (k === sectionKeyName ? k : k.slice(prefix.length)));
}
