/**
 * @rawuser/signals/intent: from a visit's signals to why the visitor came.
 *
 * The source is in ../../shared/src (classify, vector, select); this file is
 * the package's second door. `classify` turns signals into a vector over six
 * intents, six sources and six contexts; `selectVariantKey` names the
 * strongest intent and source. Pure functions: no storage, no network, and
 * nothing here knows who the visitor is.
 */

export { extractSignals } from "../../shared/src/signals/extract.ts";
export type { CfProperties, ExtractInput } from "../../shared/src/signals/extract.ts";
export {
  hasMeaningfulSignal,
  hasSourceSignal,
} from "../../shared/src/signals/meaningful.ts";

export { classify, isOffhours } from "../../shared/src/classify/index.ts";
export {
  PATH_INTENT_TABLE,
  pathCarriesIntent,
  pathContextDims,
  pathIntentDims,
} from "../../shared/src/classify/path-intent.ts";
export { selectVariantKey } from "../../shared/src/select/index.ts";

export {
  CONTEXT_DIMENSIONS,
  INTENT_DIMENSIONS,
  SOURCE_DIMENSIONS,
} from "../../shared/src/vector/dimensions.ts";
export type {
  ContextDim,
  IntentDim,
  SourceDim,
} from "../../shared/src/vector/dimensions.ts";

export type { IntentVector, Signals, VariantSelection } from "../../shared/src/types.ts";
