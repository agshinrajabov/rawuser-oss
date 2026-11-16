/**
 * @rawuser/signals: where a visit came from, read from one request.
 *
 * The source is in ../../shared/src/signals; this file is the package's
 * door. Everything here is a pure function or a table: no storage, no
 * network, no cookie, nothing that identifies a visitor.
 */

export { extractSignals } from "../../shared/src/signals/extract.ts";
export type { CfProperties, ExtractInput } from "../../shared/src/signals/extract.ts";

export { detectAiSource } from "../../shared/src/signals/ai-source.ts";
export type { AiSourceResult } from "../../shared/src/signals/ai-source.ts";
export { detectAppSource } from "../../shared/src/signals/app-source.ts";
export {
  CLICK_ID_PARAM_NAMES,
  isPaidClickId,
  isSocialClickId,
  parseClickId,
} from "../../shared/src/signals/click-id.ts";
export type { ClickIdResult } from "../../shared/src/signals/click-id.ts";
export { classifyDevice } from "../../shared/src/signals/device.ts";
export { parseReferrer, parseReferrerHost } from "../../shared/src/signals/referrer.ts";
export type { ReferrerInfo } from "../../shared/src/signals/referrer.ts";
export { parseUtm } from "../../shared/src/signals/utm.ts";

export {
  SOURCE_NAMES,
  SOURCE_NAME_LABELS,
  isSourceName,
  matchAppPackage,
  matchReferrerHost,
  matchUtmMedium,
  matchUtmSource,
  paidAdKind,
  sourceNameFor,
} from "../../shared/src/signals/source-vocabulary.ts";
export type {
  AppPackage,
  Channel,
  SourceMatch,
  SourceName,
} from "../../shared/src/signals/source-vocabulary.ts";

export {
  AI_BOT_UAS,
  AI_REFERRER_HOSTS,
  AI_USER_UAS,
  APP_UAS,
  BOT_UA_SUBSTRINGS,
  COMPARISON_REFERRER_HOSTS,
} from "../../shared/src/signals/tables.ts";
export type {
  AiBotEntry,
  AiReferrerEntry,
  AiUserEntry,
  AppUaEntry,
} from "../../shared/src/signals/tables.ts";

export type { AiSource, AppSource, Signals } from "../../shared/src/types.ts";
