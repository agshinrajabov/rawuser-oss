"use client";

import { Marked } from "@/components/ui/Marked";
import type { VariantBody } from "@rawuser/shared";

interface MockLandingProps {
  variant: VariantBody;
  compact?: boolean;
}

export function MockLanding({ variant, compact }: MockLandingProps) {
  const { sections } = variant;
  const hero = sections.hero;
  const cta = sections.cta;
  const socialProof = sections.social_proof;
  const features = sections.features ?? sections.features_core;
  const comparison = sections.comparison;
  const pricing = sections.pricing;
  const faq = sections.faq;

  return (
    <div className="font-sans text-fg bg-bg rounded-sm border border-border overflow-hidden text-sm">
      {hero && (
        <div className="px-5 py-6 bg-bg border-b border-border">
          {hero.headline && (
            <h2 className="font-sans font-semibold text-fg leading-tight tracking-tight mb-2 text-xl">
              <Marked text={hero.headline} />
            </h2>
          )}
          {hero.body && (
            <p className="text-fg-muted leading-relaxed mb-4 text-sm">
              <Marked text={hero.body} />
            </p>
          )}
          {hero.cta && (
            <div className="inline-flex items-center bg-cta-bg text-cta-fg rounded-sm font-medium px-3 py-1.5 text-xs">
              <Marked text={hero.cta.label} />
            </div>
          )}
        </div>
      )}

      {socialProof && (
        <div className="px-5 py-4 bg-surface-muted border-b border-border">
          {socialProof.headline && (
            <p className="font-mono text-xs uppercase tracking-[0.08em] text-fg-muted mb-1">
              <Marked text={socialProof.headline} />
            </p>
          )}
          {socialProof.body && (
            <p
              className={["text-fg-muted leading-relaxed", compact ? "text-xs" : "text-sm"].join(
                " ",
              )}
            >
              <Marked text={socialProof.body} />
            </p>
          )}
        </div>
      )}

      {features && (
        <div className="px-5 py-4 border-b border-border">
          {features.headline && (
            <h3 className="font-sans font-medium text-fg mb-1 text-sm">
              <Marked text={features.headline} />
            </h3>
          )}
          {features.body && (
            <p
              className={["text-fg-muted leading-relaxed", compact ? "text-xs" : "text-sm"].join(
                " ",
              )}
            >
              <Marked text={features.body} />
            </p>
          )}
        </div>
      )}

      {comparison && (
        <div className="px-5 py-4 border-b border-border">
          {comparison.headline && (
            <h3 className="font-sans font-medium text-fg mb-1 text-sm">
              <Marked text={comparison.headline} />
            </h3>
          )}
          {comparison.body && (
            <p
              className={["text-fg-muted leading-relaxed", compact ? "text-xs" : "text-sm"].join(
                " ",
              )}
            >
              <Marked text={comparison.body} />
            </p>
          )}
        </div>
      )}

      {pricing && (
        <div className="px-5 py-4 border-b border-border">
          {pricing.headline && (
            <h3 className="font-sans font-medium text-fg mb-1 text-sm">
              <Marked text={pricing.headline} />
            </h3>
          )}
          {pricing.body && (
            <p
              className={["text-fg-muted leading-relaxed", compact ? "text-xs" : "text-sm"].join(
                " ",
              )}
            >
              <Marked text={pricing.body} />
            </p>
          )}
        </div>
      )}

      {faq && (
        <div className="px-5 py-4 border-b border-border">
          {faq.headline && (
            <h3 className="font-sans font-medium text-fg mb-1 text-sm">
              <Marked text={faq.headline} />
            </h3>
          )}
          {faq.body && (
            <p
              className={["text-fg-muted leading-relaxed", compact ? "text-xs" : "text-sm"].join(
                " ",
              )}
            >
              <Marked text={faq.body} />
            </p>
          )}
        </div>
      )}

      {cta && cta !== hero && (
        <div className="px-5 py-5 bg-surface-muted">
          {cta.headline && (
            <h3 className="font-sans font-medium text-fg mb-1 text-sm">{cta.headline}</h3>
          )}
          {cta.body && (
            <p
              className={[
                "text-fg-muted mb-3 leading-relaxed",
                compact ? "text-xs" : "text-sm",
              ].join(" ")}
            >
              {cta.body}
            </p>
          )}
          {cta.cta && (
            <div className="inline-flex items-center bg-cta-bg text-cta-fg rounded-sm font-medium px-3 py-1.5 text-xs">
              {cta.cta.label}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
