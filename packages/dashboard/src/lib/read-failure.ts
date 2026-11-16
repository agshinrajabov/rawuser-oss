/**
 * What the first-run screen says when reading the page fails. The API tells
 * whoever runs the install which kind of model fault it was; a customer gets
 * no reason and reads the plain line. Never the API's own text.
 */

const LINES: Record<string, string> = {
  model_not_configured:
    "No model is set. Add your model's endpoint, id and key to this install's settings.",
  model_empty:
    "The model wrote nothing: it spent its whole answer on reasoning. Turn its reasoning off (MODEL_EXTRA_BODY) and open your page again.",
  model_refused: "The model refused the key. Check MODEL_API_KEY, then open your page again.",
  model_silent: "The model did not answer. Open your page again in a minute.",
};

export const READ_FAILED = "Reading the page failed. Open your page again.";

/** Words of the API that are for code, with the line a person reads in their place. */
const CODES: Record<string, string> = {
  no_capture: "The look at your page has expired. Open your page again.",
  "Element detection failed": READ_FAILED,
};

/** The line for a failed read, from the error apiFetch throws. */
export function readFailureLine(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const json = /\{[\s\S]*\}/.exec(message)?.[0];
  if (!json) return READ_FAILED;
  try {
    const body = JSON.parse(json) as { reason?: unknown; error?: unknown };
    if (typeof body.reason === "string" && LINES[body.reason]) return LINES[body.reason] as string;
    if (typeof body.error !== "string" || body.error === "") return READ_FAILED;
    if (CODES[body.error]) return CODES[body.error] as string;
    // A sentence the API wrote for a person is shown as written; a bare word is not.
    if (!body.error.includes(" ")) return READ_FAILED;
    return body.error.endsWith(".") ? body.error : `${body.error}.`;
  } catch {
    return READ_FAILED;
  }
}
