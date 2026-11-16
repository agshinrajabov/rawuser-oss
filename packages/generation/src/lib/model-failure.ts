/**
 * Why a model call failed, as one word the person who runs the install can
 * act on. The model layer's own messages are for the log; this reads them
 * and never passes them on, so nothing a provider wrote reaches a screen.
 */

export type ModelFailure =
  /** No endpoint, model id or key is set. */
  | "model_not_configured"
  /** The answer was cut at its limit with nothing written: a reasoning model that spent it all thinking. */
  | "model_empty"
  /** The endpoint refused the key. */
  | "model_refused"
  /** No answer, or an error from the endpoint. */
  | "model_silent";

export function modelFailure(message: string): ModelFailure | null {
  if (/is not configured/i.test(message)) return "model_not_configured";
  if (/truncated at max_tokens=\d+ \(content 0 chars\)/i.test(message)) return "model_empty";
  if (/request failed: HTTP (401|403)\b/i.test(message)) return "model_refused";
  if (/request failed|timed? ?out|timeout|aborted|did not answer/i.test(message))
    return "model_silent";
  return null;
}
