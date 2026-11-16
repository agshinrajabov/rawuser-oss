/**
 * Fixture-driven test cases for the vector intent classifier.
 *
 * Each Case exercises extractSignals → classify → vector output.
 * The expect block carries per-axis range assertions [min, max] for the
 * dims we care about, plus the expected selection (intent_dim, source_dim).
 *
 * Cases MUST cover:
 *   - All 6 intent dims as dominant
 *   - All 6 source dims as dominant
 *   - Multi-strong: AI source + competitor UTM → both dims ≥ 0.5
 *   - Trial/demo UTM → context.urgency ≥ 0.5, intent.evaluation ≤ 0.2
 *   - Competitor vs evaluation distinction
 *   - Bot → lead_probability = 0
 *   - Determinism
 *   - Privacy: referrer never echoed with path/query
 */

export interface VectorExpect {
  intent?: Partial<Record<string, [min: number, max: number]>>;
  source?: Partial<Record<string, [min: number, max: number]>>;
  context?: Partial<Record<string, [min: number, max: number]>>;
  meta?: {
    confidence?: [min: number, max: number];
    lead_probability?: [min: number, max: number];
  };
  selection?: {
    intent_dim: string;
    source_dim: string;
  };
  // Signal-level assertions
  referrerHost?: string | null;
  isBot?: boolean;
  aiSource?: string | null;
}

export interface VectorCase {
  name: string;
  request: {
    url: string;
    headers: Record<string, string>;
    cf?: { country?: string; timezone?: string };
  };
  expect: VectorExpect;
}

export const CLASSIFY_CASES: VectorCase[] = [
  // -----------------------------------------------------------------------
  // All 6 intent dims as dominant
  // -----------------------------------------------------------------------
  {
    name: "intent.competitor dominant: vs-salesforce UTM campaign",
    request: {
      url: "https://rawuser.test/?utm_campaign=vs-salesforce",
      headers: {},
    },
    expect: {
      intent: {
        competitor: [0.5, 1.0],
        evaluation: [0, 0.3],
      },
      selection: { intent_dim: "competitor", source_dim: "direct" },
    },
  },
  {
    name: "intent.evaluation dominant: g2.com referrer",
    request: {
      url: "https://rawuser.test/",
      headers: { referer: "https://g2.com/products/rawuser/reviews" },
    },
    expect: {
      intent: {
        evaluation: [0.5, 1.0],
        competitor: [0, 0.3],
      },
      referrerHost: "g2.com",
      selection: { intent_dim: "evaluation", source_dim: "organic" },
    },
  },
  {
    name: "intent.feature dominant: enterprise UTM campaign",
    request: {
      url: "https://rawuser.test/?utm_campaign=enterprise",
      headers: {},
    },
    expect: {
      intent: {
        feature: [0.5, 1.0],
      },
      selection: { intent_dim: "feature", source_dim: "direct" },
    },
  },
  {
    name: "intent.problem dominant: how-to UTM campaign",
    request: {
      url: "https://rawuser.test/?utm_campaign=how-to-get-started",
      headers: {},
    },
    expect: {
      intent: {
        problem: [0.5, 1.0],
      },
      selection: { intent_dim: "problem", source_dim: "direct" },
    },
  },
  {
    name: "intent.brand dominant: naked direct visit",
    request: {
      url: "https://rawuser.test/",
      headers: { "user-agent": "Mozilla/5.0 Chrome/120" },
    },
    expect: {
      intent: {
        brand: [0.5, 1.0],
      },
      isBot: false,
      aiSource: null,
      selection: { intent_dim: "brand", source_dim: "direct" },
    },
  },
  {
    name: "intent.pricing dominant: pricing UTM campaign",
    request: {
      url: "https://rawuser.test/?utm_campaign=pricing",
      headers: {},
    },
    expect: {
      intent: {
        pricing: [0.5, 1.0],
      },
      selection: { intent_dim: "pricing", source_dim: "direct" },
    },
  },

  // -----------------------------------------------------------------------
  // All 6 source dims as dominant
  // -----------------------------------------------------------------------
  {
    name: "source.ai dominant: chatgpt.com referrer",
    request: {
      url: "https://rawuser.test/",
      headers: { referer: "https://chatgpt.com/c/some-chat" },
    },
    expect: {
      source: {
        ai: [0.9, 1.0],
      },
      aiSource: "chatgpt",
      isBot: false,
      selection: { intent_dim: "problem", source_dim: "ai" },
    },
  },
  {
    name: "source.social dominant: LinkedIn utm_source + organic-social utm_medium",
    request: {
      url: "https://rawuser.test/?utm_source=linkedin&utm_medium=organic-social",
      headers: {},
    },
    expect: {
      source: {
        social: [0.5, 1.0],
      },
      selection: { intent_dim: "brand", source_dim: "social" },
    },
  },
  {
    name: "source.community dominant: HN referrer",
    request: {
      url: "https://rawuser.test/",
      headers: { referer: "https://news.ycombinator.com/item?id=12345" },
    },
    expect: {
      source: {
        community: [0.5, 1.0],
      },
      referrerHost: "news.ycombinator.com",
      selection: { intent_dim: "problem", source_dim: "community" },
    },
  },
  {
    name: "source.paid dominant: utm_medium=cpc",
    request: {
      url: "https://rawuser.test/?utm_medium=cpc",
      headers: {},
    },
    expect: {
      source: {
        paid: [0.5, 1.0],
      },
      selection: { intent_dim: "brand", source_dim: "paid" },
    },
  },
  {
    name: "source.organic dominant: google.com referrer",
    request: {
      url: "https://rawuser.test/",
      headers: { referer: "https://google.com/search?q=rawuser" },
    },
    expect: {
      source: {
        organic: [0.5, 1.0],
      },
      referrerHost: "google.com",
      selection: { intent_dim: "problem", source_dim: "organic" },
    },
  },
  {
    name: "source.direct dominant: no UTM no referrer no AI",
    request: {
      url: "https://rawuser.test/",
      headers: { "user-agent": "Mozilla/5.0 Chrome/120" },
    },
    expect: {
      source: {
        direct: [0.5, 1.0],
      },
      selection: { intent_dim: "brand", source_dim: "direct" },
    },
  },

  // -----------------------------------------------------------------------
  // Multi-strong: AI source + competitor UTM → BOTH dims ≥ 0.5
  // Source NEVER overrides intent: competitor wins on intent axis.
  // -----------------------------------------------------------------------
  {
    name: "multi-strong: AI source + competitor UTM → both ≥ 0.5, selection (competitor, ai)",
    request: {
      url: "https://rawuser.test/?utm_campaign=vs-salesforce",
      headers: { referer: "https://chatgpt.com/c/chat" },
    },
    expect: {
      intent: {
        competitor: [0.5, 1.0],
      },
      source: {
        ai: [0.5, 1.0],
      },
      aiSource: "chatgpt",
      selection: { intent_dim: "competitor", source_dim: "ai" },
    },
  },

  // -----------------------------------------------------------------------
  // Trial/demo UTM → context.urgency, NOT intent.evaluation
  // This is the critical invariant from the user spec.
  // -----------------------------------------------------------------------
  {
    name: "trial/demo UTM → urgency context, NOT evaluation intent",
    request: {
      url: "https://rawuser.test/?utm_campaign=demo",
      headers: {},
    },
    expect: {
      intent: {
        evaluation: [0, 0.2],
      },
      context: {
        urgency: [0.5, 1.0],
      },
      selection: { intent_dim: "brand", source_dim: "direct" },
    },
  },
  {
    name: "trial UTM → urgency context, NOT evaluation intent",
    request: {
      url: "https://rawuser.test/?utm_campaign=trial",
      headers: {},
    },
    expect: {
      intent: {
        evaluation: [0, 0.2],
      },
      context: {
        urgency: [0.5, 1.0],
      },
      selection: { intent_dim: "brand", source_dim: "direct" },
    },
  },

  // -----------------------------------------------------------------------
  // Competitor vs evaluation distinction
  // -----------------------------------------------------------------------
  {
    name: "competitor wins: utm_campaign=salesforce-alternative → competitor",
    request: {
      url: "https://rawuser.test/?utm_campaign=salesforce-alternative",
      headers: {},
    },
    expect: {
      intent: {
        competitor: [0.5, 1.0],
        evaluation: [0, 0.3],
      },
      selection: { intent_dim: "competitor", source_dim: "direct" },
    },
  },
  {
    name: "evaluation wins: utm_campaign=comparison → evaluation",
    request: {
      url: "https://rawuser.test/?utm_campaign=comparison",
      headers: {},
    },
    expect: {
      intent: {
        evaluation: [0.5, 1.0],
        competitor: [0, 0.2],
      },
      selection: { intent_dim: "evaluation", source_dim: "direct" },
    },
  },
  {
    name: "evaluation wins: referrer=g2.com → evaluation",
    request: {
      url: "https://rawuser.test/",
      headers: { referer: "https://g2.com/some-list" },
    },
    expect: {
      intent: {
        evaluation: [0.5, 1.0],
        competitor: [0, 0.2],
      },
      referrerHost: "g2.com",
    },
  },

  // -----------------------------------------------------------------------
  // Bot UA → lead_probability = 0
  // -----------------------------------------------------------------------
  {
    name: "bot UA: GPTBot → lead_probability = 0, isBot = true",
    request: {
      url: "https://rawuser.test/",
      headers: { "user-agent": "GPTBot/1.2" },
    },
    expect: {
      isBot: true,
      meta: {
        lead_probability: [0, 0],
      },
    },
  },
  {
    name: "bot UA: Googlebot → lead_probability = 0",
    request: {
      url: "https://rawuser.test/",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      },
    },
    expect: {
      isBot: true,
      meta: {
        lead_probability: [0, 0],
      },
    },
  },

  // -----------------------------------------------------------------------
  // Determinism — checked in the test loop via calling classify twice
  // -----------------------------------------------------------------------
  {
    name: "determinism: same input twice = same vector",
    request: {
      url: "https://rawuser.test/?utm_campaign=enterprise",
      headers: { referer: "https://chatgpt.com/" },
    },
    expect: {
      // Existence check only; determinism verified in test body
      intent: {},
      source: { ai: [0.9, 1.0] },
    },
  },

  // -----------------------------------------------------------------------
  // Privacy: referrer URL with query/path strips to host only
  // -----------------------------------------------------------------------
  {
    name: "privacy: referrer URL with ?email= strips to host only",
    request: {
      url: "https://rawuser.test/",
      headers: { referer: "https://example.com/secret?email=a@b.test" },
    },
    expect: {
      referrerHost: "example.com",
    },
  },

  // -----------------------------------------------------------------------
  // Citation-click UA → high lead_probability
  // -----------------------------------------------------------------------
  {
    name: "citation-click: ChatGPT-User UA → high lead_probability",
    request: {
      url: "https://rawuser.test/",
      headers: { "user-agent": "ChatGPT-User/1.0" },
    },
    expect: {
      aiSource: "chatgpt",
      isBot: false,
      meta: {
        lead_probability: [0.4, 0.95],
      },
    },
  },

  // -----------------------------------------------------------------------
  // Subdomain referrer match
  // -----------------------------------------------------------------------
  {
    name: "subdomain referrer: www.g2.com matches g2.com (evaluation intent)",
    request: {
      url: "https://rawuser.test/",
      headers: { referer: "https://www.g2.com/products/rawuser" },
    },
    expect: {
      intent: {
        evaluation: [0.5, 1.0],
      },
      referrerHost: "www.g2.com",
    },
  },

  // -----------------------------------------------------------------------
  // Entry-path intent signal (L1, ADR 0023). The request URL's pathname
  // stands in as the entry path (see makeSignals in classify.test.ts).
  // -----------------------------------------------------------------------
  {
    name: "entry-path: naked direct /pricing → pricing intent, brand suppressed",
    request: {
      url: "https://rawuser.test/pricing",
      headers: { "user-agent": "Mozilla/5.0 Chrome/120" },
    },
    expect: {
      intent: {
        pricing: [0.5, 1.0],
        brand: [0, 0.2],
      },
      context: {
        price_sensitivity: [0.4, 1.0],
      },
      selection: { intent_dim: "pricing", source_dim: "direct" },
    },
  },
  {
    name: "entry-path: nested /docs/quickstart → feature intent + technical_depth",
    request: {
      url: "https://rawuser.test/docs/quickstart",
      headers: { "user-agent": "Mozilla/5.0 Chrome/120" },
    },
    expect: {
      intent: {
        feature: [0.5, 1.0],
        brand: [0, 0.2],
      },
      context: {
        technical_depth: [0.5, 1.0],
      },
      selection: { intent_dim: "feature", source_dim: "direct" },
    },
  },
  {
    name: "entry-path: /pricing + competitor UTM → UTM dominates (competitor wins)",
    request: {
      url: "https://rawuser.test/pricing?utm_campaign=vs-salesforce",
      headers: { "user-agent": "Mozilla/5.0 Chrome/120" },
    },
    expect: {
      intent: {
        competitor: [0.5, 1.0],
        pricing: [0.5, 1.0],
      },
      // competitor (0.75 UTM) beats pricing (0.6 path) in the argmax snap.
      selection: { intent_dim: "competitor", source_dim: "direct" },
    },
  },
  {
    name: "entry-path: naked direct /demo → urgency context only, stays brand",
    request: {
      url: "https://rawuser.test/demo",
      headers: { "user-agent": "Mozilla/5.0 Chrome/120" },
    },
    expect: {
      // demo is context-only: it must NOT raise an intent dim, so brand still
      // fires (naked arrival) and the visit is not gate-qualifying.
      intent: {
        brand: [0.5, 1.0],
        evaluation: [0, 0.2],
      },
      context: {
        urgency: [0.5, 1.0],
      },
      selection: { intent_dim: "brand", source_dim: "direct" },
    },
  },
  {
    name: "entry-path: /Pricing/ normalizes to /pricing (case + trailing slash)",
    request: {
      url: "https://rawuser.test/Pricing/",
      headers: { "user-agent": "Mozilla/5.0 Chrome/120" },
    },
    expect: {
      intent: {
        pricing: [0.5, 1.0],
      },
      selection: { intent_dim: "pricing", source_dim: "direct" },
    },
  },
  {
    name: "entry-path: bot on /pricing still lead_probability 0 (bot path wins)",
    request: {
      url: "https://rawuser.test/pricing",
      headers: { "user-agent": "GPTBot/1.2" },
    },
    expect: {
      isBot: true,
      meta: { lead_probability: [0, 0] },
    },
  },

  // -----------------------------------------------------------------------
  // L2 source recovery: in-app browser marker and click-id names
  // -----------------------------------------------------------------------
  {
    name: "source.social dominant: Instagram in-app browser, referrer stripped",
    request: {
      url: "https://rawuser.test/",
      headers: {
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21E236 Instagram 328.0.0.29.85 (iPhone15,2; iOS 17_4_1; en_US; en; scale=3.00; 1179x2556; 583283064)",
      },
    },
    expect: {
      source: {
        social: [0.7, 1.0],
        direct: [0, 0.2],
      },
      referrerHost: null,
      aiSource: null,
      context: { mobile_context: [0.9, 1.0] },
      selection: { intent_dim: "problem", source_dim: "social" },
    },
  },
  {
    name: "source.paid dominant: gclid name forwarded by the snippet, no UTM, no referrer",
    request: {
      url: "https://rawuser.test/?clk=gclid",
      headers: {},
    },
    expect: {
      source: {
        paid: [0.8, 1.0],
        direct: [0, 0.2],
      },
      referrerHost: null,
      selection: { intent_dim: "brand", source_dim: "paid" },
    },
  },
  {
    name: "source.social dominant: fbclid present, referrer stripped",
    request: {
      url: "https://rawuser.test/?fbclid=IwAR0notreadbyus",
      headers: {},
    },
    expect: {
      source: {
        social: [0.7, 1.0],
        direct: [0, 0.2],
      },
      selection: { intent_dim: "problem", source_dim: "social" },
    },
  },
];
