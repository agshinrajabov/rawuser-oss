"use client";

import { Separator } from "@/components/ui/Separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/Table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { useState } from "react";
import { DimDrawer } from "./DimDrawer";

export type Axis = "intent" | "source" | "context";

export interface DimDef {
  name: string;
  axis: Axis;
  description: string;
  signals: string[];
  exampleVariant?: string;
}

export const INTENT_DEFS: DimDef[] = [
  {
    name: "competitor",
    axis: "intent",
    description:
      'Visitor is comparing you to a specific named rival. They typed "vs Salesforce" or clicked a "{competitor} alternative" ad. They already know the category; they\'re deciding which winner to pick.',
    signals: [
      "utm_campaign matches /vs|alternative$|alternatives-to/",
      "Lead probability bump: +comparison-site if referrer also matches",
    ],
    exampleVariant: "Why teams switch from [Competitor], and what they gain in the first 30 days.",
  },
  {
    name: "evaluation",
    axis: "intent",
    description:
      "Visitor is shopping the category without a rival in mind. They arrived from G2, Capterra, or a 'best X for Y' search. They're mapping options, not selecting one yet.",
    signals: [
      "utm_campaign matches /comparison|review|alternatives|best/",
      "Referrer host is a comparison site (g2.com, capterra.com, producthunt.com…)",
    ],
    exampleVariant: "The clear-headed comparison: what matters when evaluating [category] tools.",
  },
  {
    name: "feature",
    axis: "intent",
    description:
      "Visitor has deep capability interest: a specific integration, API, or enterprise feature. They know the category; they want proof you can do the specific thing.",
    signals: ["utm_campaign matches /enterprise|security|api|integration|features/"],
    exampleVariant: "Every integration, every API endpoint, built for engineering teams.",
  },
  {
    name: "problem",
    axis: "intent",
    description:
      'Visitor arrived pain-first. They searched "how do I…" or "why is X broken", or clicked a citation from an AI answer. They have a problem, not a product preference. Make the pain real, then solve it.',
    signals: [
      "utm_campaign matches /how|why|problem|tutorial|guide/",
      "AI source detected (source.ai bump also applies)",
      "Community/social referrer (Reddit, HN, LinkedIn…)",
      "Organic search referrer",
    ],
    exampleVariant: "Stop wrestling with [pain]. Here's how teams like yours solved it in a week.",
  },
  {
    name: "brand",
    axis: "intent",
    description:
      "Direct arrival: a bookmark, a typed URL, or a forwarded link. No UTM keyword, no referrer, no AI. Visitor already knows you. Focus on depth and trust, not category education.",
    signals: ["No utm_campaign intent keyword", "No referrer host", "No AI source"],
    exampleVariant: "Everything you need, exactly where you left off.",
  },
  {
    name: "pricing",
    axis: "intent",
    description:
      "Visitor's primary concern is cost: free tier, plan comparison, indie-friendly pricing. Show price transparency and value anchoring before anything else.",
    signals: ["utm_campaign matches /pricing|free|plan|cost|cheap|indie/"],
    exampleVariant: "No hidden fees. Pick the plan that fits your team today.",
  },
];

export const SOURCE_DEFS: DimDef[] = [
  {
    name: "ai",
    axis: "source",
    description:
      "Arrived from an AI tool: ChatGPT, Claude, Perplexity, or a similar citation click. High-intent signal: the AI gave an answer and they clicked to verify or act on it.",
    signals: [
      "User-Agent matches known AI bot list",
      "Referrer host is an AI tool (chatgpt.com, perplexity.ai, claude.ai…)",
    ],
  },
  {
    name: "social",
    axis: "source",
    description:
      "Arrived from social media: a LinkedIn post, a Twitter/X thread, an Instagram story. Likely warm but passive; they were scrolling, not searching.",
    signals: [
      "utm_medium contains 'social'",
      "utm_source is twitter, linkedin, instagram, tiktok, facebook",
      "Referrer host is a social platform",
    ],
  },
  {
    name: "community",
    axis: "source",
    description:
      "Arrived from a developer community: Reddit, Hacker News, Discord, Lobsters. Likely technical and skeptical; show proof, not pitch.",
    signals: ["Referrer host is reddit.com, news.ycombinator.com, lobste.rs, discord.com"],
  },
  {
    name: "paid",
    axis: "source",
    description:
      "Arrived via a paid campaign: Google Ads, Meta Ads, CPC/PPC. High intent signal when combined with a specific campaign keyword.",
    signals: [
      "utm_medium is cpc, paid, ppc, or ad",
      "utm_source is google-ads, facebook-ads, gads",
    ],
  },
  {
    name: "organic",
    axis: "source",
    description:
      "Arrived via organic search or a comparison/review site. The referrer is a search engine or a category discovery platform.",
    signals: [
      "Referrer host is google.com, bing.com, duckduckgo.com…",
      "Referrer host is a comparison site (treated as organic discovery)",
    ],
  },
  {
    name: "direct",
    axis: "source",
    description:
      "No channel signal: typed the URL, used a bookmark, or came through a channel that strips referrers. Treat them like a returning visitor.",
    signals: ["No utm_medium", "No utm_source", "No referrer host", "No AI source"],
  },
];

export const CONTEXT_DEFS: DimDef[] = [
  {
    name: "price_sensitivity",
    axis: "context",
    description:
      "Visitor is actively signalling cost concern: free/cheap/indie/startup UTM terms. Anchor price early, show free tier prominently.",
    signals: ["utm_campaign matches /free|cheap|indie|bootstrap|startup/"],
  },
  {
    name: "technical_depth",
    axis: "context",
    description:
      "Visitor is technically evaluating. They arrived from GitHub, StackOverflow, or a developer community. Show architecture, API docs, and engineering credibility.",
    signals: [
      "Community referrer (Reddit, HN…)",
      "Technical referrer host (github.com, stackoverflow.com…)",
      "utm_campaign matches /api|integration|sdk|developer/",
    ],
  },
  {
    name: "urgency",
    axis: "context",
    description:
      "Visitor is ready to act: demo/trial/now/today UTM terms. These are NOT evaluation intent (category shoppers); they've decided to try. Reduce friction, not information.",
    signals: [
      "utm_campaign matches /demo|trial|now|today|launch|asap|deadline/",
      "CRITICAL: demo/trial -> urgency, not evaluation intent",
    ],
  },
  {
    name: "trust_need",
    axis: "context",
    description:
      "Visitor is risk-averse: security/compliance/enterprise UTM or a comparison-site referrer. Show SOC2, GDPR stance, data handling, and customer logos before the CTA.",
    signals: [
      "utm_campaign matches /security|compliance|enterprise|gdpr|soc2/",
      "Comparison-site referrer also bumps trust_need",
    ],
  },
  {
    name: "mobile_context",
    axis: "context",
    description:
      "Visitor is on a mobile device. Prioritize the single most important CTA; reduce cognitive load.",
    signals: ["User-Agent device classification: mobile"],
  },
  {
    name: "offhours_context",
    axis: "context",
    description:
      "Visit is outside 09:00-18:00 in the visitor's local timezone. Likely a self-directed research session, not a work task. Tone can be warmer.",
    signals: [
      "Derived from Cloudflare cf.timezone + current hour",
      "Falls back to UTC when timezone is unavailable",
    ],
  },
];

/** First sentence of a description, for the one-line summary in the table. */
export function leadSentence(description: string): string {
  const match = description.match(/^.*?[.!?](?=\s|$)/);
  return (match ? match[0] : description).trim();
}

const ALL_DEFS: Record<Axis, DimDef[]> = {
  intent: INTENT_DEFS,
  source: SOURCE_DEFS,
  context: CONTEXT_DEFS,
};

interface DimTableProps {
  variantCounts: Record<string, number>;
}

function DimRows({
  defs,
  variantCounts,
  onRowClick,
}: {
  defs: DimDef[];
  variantCounts: Record<string, number>;
  onRowClick: (def: DimDef) => void;
}) {
  return (
    <>
      {defs.map((def) => (
        <TableRow key={def.name} className="cursor-pointer" onClick={() => onRowClick(def)}>
          <TableCell className="py-2.5 align-top">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-fg">{def.name.replace(/_/g, " ")}</span>
              <p className="text-xs text-fg-muted leading-snug line-clamp-2">
                {leadSentence(def.description)}
              </p>
            </div>
          </TableCell>
          <TableCell className="py-2.5 align-top text-right">
            <span className="font-mono text-xs tabular-nums text-fg-muted">
              {def.signals.length}
            </span>
          </TableCell>
          <TableCell className="py-2.5 align-top text-right">
            <span className="font-mono text-xs tabular-nums text-fg-muted">
              {variantCounts[def.name] ?? 0}
            </span>
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

export function DimTable({ variantCounts }: DimTableProps) {
  const [activeDim, setActiveDim] = useState<DimDef | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  function openDrawer(def: DimDef) {
    setActiveDim(def);
    setDrawerOpen(true);
  }

  return (
    <>
      <Tabs defaultValue="intent">
        <TabsList>
          <TabsTrigger value="intent">Intent</TabsTrigger>
          <TabsTrigger value="source">Source</TabsTrigger>
          <TabsTrigger value="context">Context</TabsTrigger>
        </TabsList>

        {(["intent", "source", "context"] as Axis[]).map((axis) => (
          <TabsContent key={axis} value={axis} className="mt-0">
            <Separator />
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dimension</TableHead>
                  <TableHead className="text-right w-20">Triggers</TableHead>
                  <TableHead className="text-right w-20">Examples</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <DimRows
                  defs={ALL_DEFS[axis]}
                  variantCounts={variantCounts}
                  onRowClick={openDrawer}
                />
              </TableBody>
            </Table>
          </TabsContent>
        ))}
      </Tabs>

      <DimDrawer
        dim={activeDim}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        variantCount={activeDim ? (variantCounts[activeDim.name] ?? 0) : 0}
      />
    </>
  );
}
