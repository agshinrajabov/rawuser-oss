-- The schema as one file: every migration up to 0053, folded.
-- Later migrations follow under their own numbers.

CREATE TABLE customers (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  domain      TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'pilot',
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL
, contact_email TEXT, contact_name TEXT, tag_seen_at INTEGER, preview_seen_at INTEGER, live_at INTEGER, languages TEXT, holdout_percent INTEGER, holdout_since INTEGER, served_intents TEXT, served_reasons TEXT, site_map_off INTEGER NOT NULL DEFAULT 0, audit_from INTEGER, audit_to INTEGER, audit_ends_at INTEGER, audit_terms_at INTEGER, audit_consent_banner INTEGER NOT NULL DEFAULT 0, audit_spend_usd REAL NOT NULL DEFAULT 0, audit_rewrites INTEGER NOT NULL DEFAULT 0, audit_ended_at INTEGER, audit_delete_at INTEGER, pilot_terms_at INTEGER, audit_start_written INTEGER, audit_start_total INTEGER, sensitive INTEGER NOT NULL DEFAULT 0, kept_sections TEXT, special_category INTEGER, special_category_at INTEGER, keyword_lexicon TEXT, keyword_lexicon_at INTEGER, keyword_off INTEGER NOT NULL DEFAULT 0, country_off INTEGER NOT NULL DEFAULT 0, auto_approve INTEGER NOT NULL DEFAULT 0, first_set TEXT, direct_insights_off INTEGER NOT NULL DEFAULT 0, page_one_off INTEGER NOT NULL DEFAULT 0, learned_default_off INTEGER NOT NULL DEFAULT 0, market_versions_off INTEGER NOT NULL DEFAULT 0, markets TEXT, choice_on INTEGER NOT NULL DEFAULT 0, choice_killed INTEGER NOT NULL DEFAULT 0, choice TEXT, choice_draft TEXT, remember_off INTEGER NOT NULL DEFAULT 0);

CREATE TABLE business_dna (
  customer_id     TEXT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  product         TEXT NOT NULL,
  icp             TEXT NOT NULL,
  brand_voice           TEXT,
  prompt_cache_id TEXT,
  updated_at      INTEGER NOT NULL
, value_props      TEXT NOT NULL DEFAULT '[]', differentiators  TEXT NOT NULL DEFAULT '[]', proof_points     TEXT NOT NULL DEFAULT '[]', target_market    TEXT, target_language  TEXT NOT NULL DEFAULT 'en', per_intent_hints TEXT NOT NULL DEFAULT '{}', draft INTEGER NOT NULL DEFAULT 0);

CREATE TABLE intent_profiles (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT REFERENCES customers(id) ON DELETE CASCADE,
  profile_key     TEXT NOT NULL,
  label           TEXT NOT NULL,
  trigger_signals TEXT NOT NULL,
  dimensions      TEXT NOT NULL,
  structure_plan  TEXT NOT NULL,
  lead_prob_base  REAL NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  UNIQUE (customer_id, profile_key)
);

CREATE TABLE variants (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  profile_id    TEXT NOT NULL REFERENCES intent_profiles(id) ON DELETE CASCADE,
  kv_key        TEXT NOT NULL,
  model         TEXT NOT NULL,
  prompt_hash   TEXT NOT NULL,
  generated_at  INTEGER NOT NULL,
  cost_usd      REAL NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ready'
, error_reason TEXT, lint_flags TEXT, body_id TEXT, pending_body_id TEXT, pending_at INTEGER);

CREATE TABLE events (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  ts           INTEGER NOT NULL,
  profile_id   TEXT REFERENCES intent_profiles(id) ON DELETE SET NULL,
  event_type   TEXT NOT NULL,
  properties   TEXT
, variant_key      TEXT, intent_dim       TEXT, source_dim       TEXT, page_path        TEXT, conversion_label TEXT, cohort TEXT, dark_social INTEGER NOT NULL DEFAULT 0, language_mismatch INTEGER NOT NULL DEFAULT 0, carried INTEGER NOT NULL DEFAULT 0, visit TEXT, arm TEXT, body_id TEXT, source_name TEXT, tagged INTEGER, found_by TEXT, country TEXT, device_class TEXT, web_view INTEGER);

CREATE TABLE superadmin_users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'superadmin',
  created_at      INTEGER NOT NULL
, customer_id TEXT REFERENCES customers(id) ON DELETE CASCADE);

CREATE TABLE superadmin_sessions (
  token_hash      TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES superadmin_users(id) ON DELETE CASCADE,
  expires_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  user_agent      TEXT,
  last_seen_at    INTEGER
, scope TEXT NOT NULL DEFAULT 'full');

CREATE TABLE conversion_targets (
  id               TEXT    NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  customer_id      TEXT    NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  section_path     TEXT    NOT NULL,
  label            TEXT    NOT NULL,
  conversion_label TEXT    NOT NULL DEFAULT 'other',
  enabled          INTEGER NOT NULL DEFAULT 1,
  css_selectors        TEXT NOT NULL,
  text_selectors       TEXT NOT NULL,
  structural_selector  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL, goes TEXT,
  PRIMARY KEY (id),
  UNIQUE (customer_id, section_path)
);

CREATE TABLE customer_setup_tokens (
  token_hash      TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES superadmin_users(id) ON DELETE CASCADE,
  expires_at      INTEGER NOT NULL,
  consumed_at     INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE snippet_status (
  customer_id    TEXT    PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  last_probed_at INTEGER,
  snippet_in_html INTEGER NOT NULL DEFAULT 0,
  last_event_at  INTEGER,
  status         TEXT    NOT NULL DEFAULT 'unknown',
  status_reason  TEXT
, tag_form TEXT, csp_verdict TEXT, platform TEXT, tag_position TEXT, tag_flags TEXT, csp_blocks_since INTEGER, tag_found_at INTEGER, pre_state TEXT, pre_hash TEXT, pre_policy TEXT);

CREATE TABLE "analytics_aggregates" (
  customer_id              TEXT    NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  window                   TEXT    NOT NULL,
  computed_at              INTEGER NOT NULL,
  total_visits             INTEGER NOT NULL DEFAULT 0,
  personalized_visits      INTEGER NOT NULL DEFAULT 0,
  passthrough_visits       INTEGER NOT NULL DEFAULT 0,
  conversions              INTEGER NOT NULL DEFAULT 0,
  personalized_conversions INTEGER NOT NULL DEFAULT 0,
  passthrough_conversions  INTEGER NOT NULL DEFAULT 0,
  prev_total_visits        INTEGER NOT NULL DEFAULT 0,
  prev_conversions         INTEGER NOT NULL DEFAULT 0,
  per_variant              TEXT NOT NULL,
  per_intent               TEXT NOT NULL,
  time_series              TEXT,
  per_cohort               TEXT,
  window_start             INTEGER,
  skipped_visits           INTEGER DEFAULT 0,
  skipped_conversions      INTEGER DEFAULT 0,
  holdout_visits           INTEGER DEFAULT 0,
  holdout_conversions      INTEGER DEFAULT 0,
  holdout_lift             REAL,
  holdout_lift_ci_lower    REAL,
  holdout_lift_ci_upper    REAL,
  holdout_significance     TEXT,
  natural_lift             REAL,
  natural_lift_ci_lower    REAL,
  natural_lift_ci_upper    REAL,
  natural_significance     TEXT
, per_source TEXT, per_page TEXT, tagged TEXT);

CREATE TABLE "element_manifests" (
  customer_id   TEXT    NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  page_path     TEXT    NOT NULL DEFAULT '/',
  manifest      TEXT    NOT NULL,
  source_url    TEXT    NOT NULL,
  generated_at  INTEGER NOT NULL,
  confirmed_at  INTEGER,
  cost_usd      REAL    NOT NULL DEFAULT 0, language TEXT,
  PRIMARY KEY (customer_id, page_path)
);

CREATE TABLE pilot_requests (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  site_url   TEXT,
  note       TEXT,
  created_at INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'new'
, status_at INTEGER);

CREATE TABLE ua_token_counts (
  week            TEXT    NOT NULL,
  customer_bucket TEXT    NOT NULL,
  token           TEXT    NOT NULL,
  count           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (week, customer_bucket, token)
);

CREATE TABLE signal_token_counts (
  week            TEXT    NOT NULL,
  customer_bucket TEXT    NOT NULL,
  kind            TEXT    NOT NULL,
  token           TEXT    NOT NULL,
  count           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (week, customer_bucket, kind, token)
);

CREATE TABLE business_dna_i18n (
  customer_id     TEXT    NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  language        TEXT    NOT NULL,
  product         TEXT    NOT NULL,
  icp             TEXT    NOT NULL,
  value_props     TEXT    NOT NULL DEFAULT '[]',
  differentiators TEXT    NOT NULL DEFAULT '[]',
  proof_points    TEXT    NOT NULL DEFAULT '[]',
  brand_voice     TEXT    NOT NULL DEFAULT '',
  target_market   TEXT,
  draft           INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (customer_id, language)
);

CREATE TABLE manifest_health (
  customer_id TEXT NOT NULL,
  page_path   TEXT NOT NULL,
  checked_at  INTEGER NOT NULL,
  missing     TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (customer_id, page_path)
);

CREATE TABLE pilot_applications (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT UNIQUE NOT NULL,
  status        TEXT NOT NULL,
  created_at    INTEGER,
  expires_at    INTEGER,
  invited_name  TEXT,
  invited_site  TEXT,
  reads         INTEGER DEFAULT 0,
  submitted_at  INTEGER,
  contact_name  TEXT,
  contact_email TEXT,
  site_url      TEXT,
  customer_id   TEXT,
  answers       TEXT,
  archived_at   INTEGER
, kind TEXT NOT NULL DEFAULT 'pilot');

CREATE TABLE holdout_tests (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  percent        INTEGER NOT NULL,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  read_date      TEXT,
  read_fixed_at  INTEGER,
  created_at     INTEGER NOT NULL
, started_by TEXT, started_actor TEXT, end_reason TEXT, ended_actor TEXT);

CREATE TABLE version_bodies (
  body_id      TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  page_path    TEXT NOT NULL,
  intent_dim   TEXT NOT NULL,
  source_dim   TEXT NOT NULL,
  language     TEXT,
  model        TEXT NOT NULL,
  prompt_hash  TEXT NOT NULL,
  lint_flags   TEXT,
  body_json    TEXT NOT NULL,
  live_from    INTEGER NOT NULL,
  retired_at   INTEGER
, discarded_at INTEGER);

CREATE TABLE exposure_outcomes (
  customer_id               TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  day                       TEXT NOT NULL,
  arm                       TEXT NOT NULL,
  page_path                 TEXT NOT NULL,
  intent_dim                TEXT NOT NULL DEFAULT 'none',
  source_dim                TEXT NOT NULL DEFAULT 'none',
  body_id                   TEXT NOT NULL DEFAULT '',
  visits                    INTEGER NOT NULL,
  converting_visits         INTEGER NOT NULL,
  applied_visits            INTEGER NOT NULL DEFAULT 0,
  skipped_visits            INTEGER NOT NULL DEFAULT 0,
  applied_converting_visits INTEGER NOT NULL DEFAULT 0,
  conversions_by_label      TEXT,
  computed_at               INTEGER NOT NULL, lp_visits INTEGER NOT NULL DEFAULT 0, lp_converting_visits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (customer_id, day, arm, page_path, intent_dim, source_dim, body_id)
);

CREATE TABLE exposure_rollup_days (
  customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  day           TEXT NOT NULL,
  computed_at   INTEGER NOT NULL,
  mixed_visits  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (customer_id, day)
);

CREATE TABLE source_days (
  customer_id        TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  day                TEXT NOT NULL,
  source_dim         TEXT NOT NULL,
  source_name        TEXT NOT NULL DEFAULT '',
  visits             INTEGER NOT NULL,
  conversions        INTEGER NOT NULL,
  tagged_visits      INTEGER NOT NULL DEFAULT 0,
  tagged_conversions INTEGER NOT NULL DEFAULT 0,
  computed_at        INTEGER NOT NULL,
  PRIMARY KEY (customer_id, day, source_dim, source_name)
);

CREATE TABLE site_paths (
  customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  path          TEXT NOT NULL CHECK (length(path) BETWEEN 2 AND 200),
  lang          TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('price', 'vs', 'compare', 'proof', 'features',
                  'docs', 'how', 'learn', 'start', 'about', 'none')),
  confidence    TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'model', 'operator')),
  label         TEXT CHECK (label IS NULL OR length(label) <= 40),
  found_on      TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  missing_since INTEGER,
  PRIMARY KEY (customer_id, path),
  CHECK (kind != 'none' OR confidence = 'operator')
);

CREATE TABLE auth_failures (
  key           TEXT    NOT NULL,
  window_start  INTEGER NOT NULL,
  failures      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE user_mfa (
  user_id       TEXT    PRIMARY KEY REFERENCES superadmin_users(id) ON DELETE CASCADE,
  secret_enc    TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending',
  last_counter  INTEGER,
  created_at    INTEGER NOT NULL,
  enabled_at    INTEGER
);

CREATE TABLE mfa_recovery_codes (
  code_hash     TEXT    PRIMARY KEY,
  user_id       TEXT    NOT NULL REFERENCES superadmin_users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  used_at       INTEGER
);

CREATE TABLE mfa_challenges (
  token_hash    TEXT    PRIMARY KEY,
  user_id       TEXT    NOT NULL REFERENCES superadmin_users(id) ON DELETE CASCADE,
  expires_at    INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE audit_reports (
  customer_id   TEXT    NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  window_start  INTEGER NOT NULL,
  window_end    INTEGER NOT NULL,
  state         TEXT    NOT NULL CHECK (state IN ('full', 'counts', 'too_few')),
  report        TEXT    NOT NULL,
  built_at      INTEGER NOT NULL,
  released_at   INTEGER,
  token_hash    TEXT    UNIQUE,
  expires_at    INTEGER,
  revoked_at    INTEGER,
  PRIMARY KEY (customer_id, window_start)
);

CREATE TABLE page_days (
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  day         TEXT NOT NULL,
  page_path   TEXT NOT NULL,
  loads       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (customer_id, day, page_path)
);

CREATE TABLE page_groups (
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  pattern     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (customer_id, pattern)
);

CREATE TABLE learned_weights (
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  set_id       TEXT NOT NULL,
  page_path    TEXT NOT NULL,
  weights      TEXT NOT NULL,
  counts       TEXT NOT NULL,
  computed_at  INTEGER NOT NULL,
  live_from    INTEGER NOT NULL,
  PRIMARY KEY (customer_id, set_id, page_path)
);

CREATE INDEX idx_intent_profiles_lookup
  ON intent_profiles(profile_key, customer_id);

CREATE INDEX idx_variants_customer ON variants(customer_id, profile_id);

CREATE INDEX idx_variants_status ON variants(status, generated_at);

CREATE INDEX idx_superadmin_sessions_user_id    ON superadmin_sessions(user_id);

CREATE INDEX idx_superadmin_sessions_expires_at ON superadmin_sessions(expires_at);

CREATE INDEX idx_events_customer_ts        ON events(customer_id, ts DESC);

CREATE INDEX idx_events_customer_type_ts   ON events(customer_id, event_type, ts);

CREATE INDEX idx_events_customer_variant   ON events(customer_id, variant_key)
  WHERE variant_key IS NOT NULL;

CREATE INDEX idx_conversion_targets_customer ON conversion_targets(customer_id, enabled);

CREATE INDEX idx_conversion_targets_path     ON conversion_targets(customer_id, section_path);

CREATE INDEX idx_superadmin_users_customer ON superadmin_users(customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX idx_customer_setup_tokens_user ON customer_setup_tokens(user_id);

CREATE INDEX idx_events_customer_cohort_ts ON events(customer_id, cohort, ts)
  WHERE cohort IS NOT NULL;

CREATE INDEX idx_analytics_aggregates_computed ON analytics_aggregates(computed_at);

CREATE UNIQUE INDEX idx_analytics_aggregates_unique
  ON analytics_aggregates(customer_id, window, window_start);

CREATE INDEX idx_element_manifests_confirmed
  ON element_manifests(customer_id, page_path, confirmed_at);

CREATE INDEX idx_pilot_requests_created ON pilot_requests (created_at DESC);

CREATE INDEX idx_ua_token_counts_week_token ON ua_token_counts(week, token);

CREATE INDEX idx_signal_token_counts_week_kind ON signal_token_counts(week, kind, token);

CREATE INDEX idx_events_customer_visit ON events(customer_id, visit);

CREATE INDEX idx_pilot_applications_created ON pilot_applications (created_at DESC);

CREATE INDEX idx_holdout_tests_customer ON holdout_tests (customer_id, started_at);

CREATE INDEX idx_version_bodies_cell
  ON version_bodies (customer_id, page_path, intent_dim, source_dim, live_from);

CREATE INDEX idx_events_customer_arm_ts ON events (customer_id, arm, ts)
  WHERE arm IS NOT NULL;

CREATE INDEX idx_auth_failures_window ON auth_failures(window_start);

CREATE INDEX idx_mfa_recovery_codes_user ON mfa_recovery_codes(user_id);

CREATE INDEX idx_mfa_challenges_user ON mfa_challenges(user_id);

CREATE INDEX idx_mfa_challenges_expires ON mfa_challenges(expires_at);

CREATE INDEX idx_customers_plan_status ON customers (plan, status);

CREATE INDEX idx_learned_weights_customer ON learned_weights (customer_id, computed_at);

INSERT INTO "intent_profiles" ("id", "customer_id", "profile_key", "label", "trigger_signals", "dimensions", "structure_plan", "lead_prob_base", "version") VALUES ('vec_03bad3a7eb2e08ec39ec', NULL, 'intent:competitor', 'Intent — competitor', '{"kind":"intent","dim":"competitor"}', '{"section_count":4}', '["hero","comparison","social_proof","cta"]', 0.5, 1);
INSERT INTO "intent_profiles" ("id", "customer_id", "profile_key", "label", "trigger_signals", "dimensions", "structure_plan", "lead_prob_base", "version") VALUES ('vec_7d43eff46e59ace5a951', NULL, 'intent:evaluation', 'Intent — evaluation', '{"kind":"intent","dim":"evaluation"}', '{"section_count":5}', '["hero","features","social_proof","faq","cta"]', 0.5, 1);
INSERT INTO "intent_profiles" ("id", "customer_id", "profile_key", "label", "trigger_signals", "dimensions", "structure_plan", "lead_prob_base", "version") VALUES ('vec_8518d67de64b9b70c82d', NULL, 'intent:feature', 'Intent — feature', '{"kind":"intent","dim":"feature"}', '{"section_count":4}', '["hero","features","social_proof","cta"]', 0.5, 1);
INSERT INTO "intent_profiles" ("id", "customer_id", "profile_key", "label", "trigger_signals", "dimensions", "structure_plan", "lead_prob_base", "version") VALUES ('vec_122f697e3e9bc026fd3d', NULL, 'intent:problem', 'Intent — problem', '{"kind":"intent","dim":"problem"}', '{"section_count":4}', '["hero","features","social_proof","cta"]', 0.5, 1);
INSERT INTO "intent_profiles" ("id", "customer_id", "profile_key", "label", "trigger_signals", "dimensions", "structure_plan", "lead_prob_base", "version") VALUES ('vec_93b4afb85ec109867f67', NULL, 'intent:brand', 'Intent — brand', '{"kind":"intent","dim":"brand"}', '{"section_count":3}', '["hero","social_proof","cta"]', 0.5, 1);
INSERT INTO "intent_profiles" ("id", "customer_id", "profile_key", "label", "trigger_signals", "dimensions", "structure_plan", "lead_prob_base", "version") VALUES ('vec_408bfbc5280c482d6f13', NULL, 'intent:pricing', 'Intent — pricing', '{"kind":"intent","dim":"pricing"}', '{"section_count":4}', '["hero","pricing","faq","cta"]', 0.5, 1);
INSERT INTO "intent_profiles" ("id", "customer_id", "profile_key", "label", "trigger_signals", "dimensions", "structure_plan", "lead_prob_base", "version") VALUES ('vec_b10a27035a3d86a8b58a', NULL, 'source:ai', 'Source — ai', '{"kind":"source","dim":"ai"}', '{"tone_note":"Visitor arrived from an AI tool. They are research-mode or citation-following. Be precise, cite data, avoid fluff. Acknowledge the AI workflow without being sycophantic."}', '[]', 0.5, 1);
INSERT INTO "intent_profiles" ("id", "customer_id", "profile_key", "label", "trigger_signals", "dimensions", "structure_plan", "lead_prob_base", "version") VALUES ('vec_9ca761801fdfe55727a6', NULL, 'source:social', 'Source — social', '{"kind":"source","dim":"social"}', '{"tone_note":"Visitor arrived from social media. They may be in discovery mode — short attention, scroll-first. Lead with a single sharp hook. Social proof and visual momentum matter more than copy depth."}', '[]', 0.5, 1);
INSERT INTO "intent_profiles" ("id", "customer_id", "profile_key", "label", "trigger_signals", "dimensions", "structure_plan", "lead_prob_base", "version") VALUES ('vec_dff8565197a35ac52907', NULL, 'source:community', 'Source — community', '{"kind":"source","dim":"community"}', '{"tone_note":"Visitor arrived from a developer community (Reddit, HN, Discord). Technical depth is expected. Skip marketing fluff. Show the implementation, the architecture, the trade-offs. Earn credibility before asking for action."}', '[]', 0.5, 1);
INSERT INTO "intent_profiles" ("id", "customer_id", "profile_key", "label", "trigger_signals", "dimensions", "structure_plan", "lead_prob_base", "version") VALUES ('vec_2ab5c3ee2c759042043f', NULL, 'source:paid', 'Source — paid', '{"kind":"source","dim":"paid"}', '{"tone_note":"Visitor arrived via a paid ad. They clicked a specific promise — honour it immediately above the fold. Urgency is appropriate (they''re in a buying session). Don''t make them re-state the problem."}', '[]', 0.5, 1);
INSERT INTO "intent_profiles" ("id", "customer_id", "profile_key", "label", "trigger_signals", "dimensions", "structure_plan", "lead_prob_base", "version") VALUES ('vec_fd5962fe19e9dd0b4c41', NULL, 'source:organic', 'Source — organic', '{"kind":"source","dim":"organic"}', '{"tone_note":"Visitor arrived via organic search or a comparison site. They were looking for something — reflect their query language. Problem-aware tone. Build trust before asking for commitment."}', '[]', 0.5, 1);
INSERT INTO "intent_profiles" ("id", "customer_id", "profile_key", "label", "trigger_signals", "dimensions", "structure_plan", "lead_prob_base", "version") VALUES ('vec_8b89a1eda83b4e4ef4ea', NULL, 'source:direct', 'Source — direct', '{"kind":"source","dim":"direct"}', '{"tone_note":"Visitor arrived directly (typed URL or bookmark). They already know the product. Skip the introduction. Focus on new value, re-engagement, or advancing to the next action (trial, upgrade, docs)."}', '[]', 0.5, 1);
