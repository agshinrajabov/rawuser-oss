/**
 * The audit terms as /audit/terms/ shows them. They are the words of whoever
 * runs an install, so none ship with the code: write yours here, as an
 * opening sentence and a list of numbered terms (a title with a paragraph, a
 * list, or both). With an empty list the page shows the opening sentence
 * alone.
 */

import type { AuditTerm } from "@/components/audit/legal-blocks";

export const TERMS_INTRO = "The operator of this install has not published audit terms yet.";

export const TERMS: AuditTerm[] = [];
