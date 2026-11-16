/**
 * A heading that labels what is under it keeps its subject (A3 of
 * docs/specs/pilot-gaps.md).
 *
 * Live on the pilot's site the section heading "Sağlamlığınız üçün əlavələr" sits over
 * the product grid. Versions wrote "Probleminizi necə həll edirik",
 * "Qiymətləndirmə meyarları", "Sifarişdə etibarlıq və səriştə" over the
 * same grid. A version changes the heading's words; it does not change the
 * grid, the list or the form under it, so the heading must still name them.
 *
 * The subject is read like a button's object (lint/cta-action.ts, A1.6): the
 * content words of the page's own heading, each as a stem ("əlavələr" is
 * "əlavə", "Sağlamlığınız" is "sağlamlığ"). A version keeps the subject when
 * one of its words begins with one of the stems; the angle around it is
 * free. Only in en, az, ru and tr, where there is a stop list.
 *
 * Which headings: the `*.headline` of every section but two. The hero's
 * headline carries the reason the visitor came and is meant to change. The
 * closing call to action's headline ("Ready to start?") is a pitch above a
 * button, not a label of content.
 *
 * Soft: the count is measured on real rows before it may refuse anything.
 */

import {
  type CtaObject,
  LABEL_SIGNATURE_MAX,
  contentWordsOf,
  keepsCtaObject,
} from "./cta-action.ts";

/** Words a heading is built with that are not its subject. */
const HEADING_STOPS: Readonly<Record<string, readonly string[]>> = {
  en: ["why", "how", "about", "without", "which", "can", "will", "does", "should", "not"],
  az: ["niyə", "necə", "haqqında", "üzrə", "nədir", "kimdir", "hansı", "bəs", "yox", "deyil"],
  ru: ["почему", "как", "про", "без", "какой", "какая", "какие", "ли", "нет"],
  tr: ["neden", "nasıl", "hakkında", "hangi", "ve", "ile", "için", "bir", "bu", "değil"],
};

/** True for a heading that labels the content under it. */
export function isSectionHeadingPath(path: string): boolean {
  if (!path.endsWith(".headline")) return false;
  const section = path.split(".")[0] ?? "";
  return section !== "hero" && section !== "cta";
}

/**
 * The subject of a section heading: its content words with their stems.
 * `signature` is the manifest's text signature, forty characters at most;
 * at that length its last word may be cut and is not read.
 */
export function sectionSubjectsOf(signature: string | undefined | null, lang: string): CtaObject[] {
  if (!signature) return [];
  const primary = lang.split("-")[0]?.toLowerCase() ?? lang;
  const whole =
    signature.length < LABEL_SIGNATURE_MAX
      ? signature
      : signature.slice(0, Math.max(0, signature.lastIndexOf(" ")));
  return contentWordsOf(whole, primary, {
    dropActions: false,
    alsoStop: HEADING_STOPS[primary] ?? [],
  });
}

/** True when the version's heading still names one of the page heading's subjects. */
export function keepsSectionSubject(text: string, subjects: readonly CtaObject[]): boolean {
  return keepsCtaObject(text, subjects);
}

/** The words to keep, as the page writes them: `"sağlamlığınız" or "əlavələr"`. */
export function subjectWords(subjects: readonly CtaObject[]): string {
  return subjects.map((s) => `"${s.word}"`).join(" or ");
}

/** The instruction, in the flag, the prompt and the revise pass. */
export function keepSubjectLine(subjects: readonly CtaObject[]): string {
  return `keep ${subjectWords(subjects)}, in any form of the word, and change the angle around it`;
}
