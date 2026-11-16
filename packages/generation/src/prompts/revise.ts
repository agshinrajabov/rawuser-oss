/**
 * One revise pass, driven by the lint (docs/specs/generation-quality.md).
 * The critique is the deterministic flag list, not an open-ended self
 * review: rule critiques improve constrained copy, self-grading is biased.
 */

import { CLAIMS_LOCK_RULES_SET } from "../lint/claims-lock.ts";
import type { LintFlag } from "../lint/index.ts";

/**
 * The claims lock's lines (docs/specs/claims-lock.md), added only when one of
 * its flags is in the list: any other customer's revise prompt is unchanged.
 */
const CLAIMS_LOCK_LINES = `
- health-addressed: the string states or asks about the reader's own body,
  health, symptoms, condition or diagnosis (the quoted phrase). Say nothing
  of it; write about the product and the company instead.
- claim-added: the quoted claim, dose, certificate, approval or number is
  not in the page's own text. Drop it, or say only what the page says.
  Never substitute another claim or number.
- name-changed: the page's own text of this part names the quoted product
  or brand; keep that name, spelled exactly as the page spells it.`;

export function buildRevisePrompt(originalJson: string, flags: readonly LintFlag[]): string {
  const list = flags
    .map((f) => `- ${f.path}: ${f.rule}${f.excerpt ? ` ("${f.excerpt}")` : ""}`)
    .join("\n");
  const lock = flags.some((f) => CLAIMS_LOCK_RULES_SET.has(f.rule)) ? CLAIMS_LOCK_LINES : "";
  return `Revise the JSON object below. Change ONLY the strings listed under
FLAGS; keep every other string byte-identical, keep every key and the
structure exactly as they are.

FLAGS (rule, then the offending text):
${list}

How to fix each rule:
- number-not-in-brief: remove the number, or replace the sentence with one
  that states only what the brief says. Never substitute another number.
- number-unit-mismatch: the brief uses this number with another unit (e.g.
  "4 years", not "4 weeks"). Restate exactly what the brief says or drop it.
- turkish-in-az / wrong-script / wrong-language: rewrite the string in the
  brief's language (an Azerbaijani sentence on an English page is wrong
  even though both use Latin letters).
- source-addressed: the string speaks about where the reader came from or
  what they did before arriving (the quoted phrase). Say nothing of it: no
  AI or assistant, no search, no social app, no community, no "you asked",
  "you searched", "you saw us on". State the same point as a plain sentence
  about the product or the reader's need.
- section-subject-changed: this heading labels the content under it (a
  grid, a list, a form), and the version does not change that content. Keep
  the word the flag quotes, in any form, so the heading still names what is
  under it; change the angle around it for this visitor.
- dash: replace with a period, a comma or two sentences.
- banned:*: replace the word with a plain, specific one.
- question-stack: one declarative headline, no questions.
- headline-over-12-words: cut to one idea, under twelve words.
- colon-reveal: write it as one plain sentence.
- binary-contrast: state the positive claim directly.
- fragments: join into complete sentences.
- alt-not-longer: the _alt headline must be the same idea, a little
  longer than the first (the range is in the flag), a complete sentence.
- alt-not-shorter: the _alt paragraph must be the same idea in fewer
  characters than the first; drop a clause, never a fact or a number.
- alt-copies: this length repeats another word for word, so the page has
  one candidate fewer; write the same idea in other words, in the range
  the flag gives, its own complete sentence.
- paragraph-over-original: every length of this paragraph is longer than
  the page's own; write the _alt with at most the count in the flag (the
  page can only keep its lines when one length does not exceed it).
- bracket-missing: every length of this part sits on the same side of the
  page's own count; write the _alt2 in the range the flag gives so one is
  under and one is over.
- alt2-not-shorter / alt2-not-longer: the third headline must be shorter
  than the first, the third paragraph longer, each close to the page's
  own count (the page picks by line count, so a length far off it is
  never chosen).
- same-as-original: the page already says exactly this; write the same
  idea in other words for this kind of visitor, same length.
- length-drift: the version's length is off the original's and changes
  the page's line count (a headline too short; a button too short or too
  long, a long label wraps the row; a paragraph too short or too long). Write complete sentences in the range the flag
  gives, saying more or less of the same idea; never pad with a clause.
- emphasis-missing: wrap one phrase of two to four words in asterisks.
- emphasis-count / emphasis-unexpected / emphasis-unbalanced: exactly one
  *phrase* in the parts that ask for one, none anywhere else.
- slot-duplicate / sentence-reuse: give that part its own words; no two
  parts of the page say the same thing.
- A part built word by word is a JSON array (one string per run; the
  rotating word is the page's own and not in it): keep it an array of the
  same length and change only its words. A flag on it (template-*) names what to fix; the page's
  structure in the flag shows each run as _ per word.
- template-copy: the words are the page's own, or one line is; write new
  words for this visitor, none of the page's own lines.
- template-stop: end that line's last run with a full stop.
- template-line-length: rewrite that line's runs to the character count the
  flag gives (count every letter and space; the last line counts the
  longest rotating word); keep the idea, change words, add or drop one.
- rotator-doubled: the last run repeats the page's rotating word; end it on
  the word that leads into the rotating word instead.
- rotator-dangling: the last run ends on a finished phrase and the page's
  rotating verb hangs after it; rewrite the last run so it ends on a word a
  verb follows ("can", "to", "will", "they"), and the line reads with each
  rotating word.
- currency-missing: write the price with its currency, as the brief does.
- cta-action-changed: the button's link stays the page's own, so its label
  keeps its action: write the kind of label the flag names (a start stays a
  start, pricing stays pricing), in this visitor's words, within the count.
- cta-object-changed: the label names another thing than the page's own
  label does, and the button still opens what the page's label names; keep
  the word the flag quotes, in any form, and change the words around it.
- cta-duplicates-counted: two buttons say the same thing and only one is
  counted; give the flagged button its own words for its own action.${lock}

Output JSON only. No fences, no commentary. Start with { and end with }.

${originalJson}`;
}
