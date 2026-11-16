"use client";

import { TagCopy } from "@/components/onboard/TagCopy";
import { HeldBox } from "@/components/readiness/SpecialCategory";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { CopyBlock } from "@/components/ui/CopyBlock";
import { signOff } from "@/lib/identity";
import { buildSnippet, isTag } from "@/lib/snippet-tag";
import type { CustomerListItem } from "@/types/api";
import { TagStatus } from "./TagStatus";

interface SnippetHandoffProps {
  customer: CustomerListItem;
  /** The page being connected; the probe reads that page (install-friction G4). */
  pagePath?: string;
  /**
   * The tag withheld (readiness-check.md, the privacy review's condition 2): this
   * line sits where the tag and the email would be.
   */
  held?: string | null;
}

export function SnippetHandoff({ customer, pagePath = "/", held = null }: SnippetHandoffProps) {
  const snippet = buildSnippet(customer.id);
  const email = buildEmail(customer, snippet);

  return (
    <Card>
      <CardHeader className="p-4 border-b border-border">
        <CardTitle className="text-md font-semibold">Hand off to the customer</CardTitle>
        <p className="text-xs text-fg-muted mt-1">
          Send the customer the snippet + an introduction email. They paste one line and you watch
          the events come in.
        </p>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        {held ? (
          <HeldBox>{held}</HeldBox>
        ) : (
          <>
            <TagStatus customer={customer} pagePath={pagePath} />
            <TagCopy label="Tag (first line inside <head>, no async)" content={snippet} />
            {isTag(snippet) && <CopyBlock label="Email template" content={email} multiline />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** The introduction the operator sends with the tag. */
export function buildEmail(customer: CustomerListItem, snippet: string): string {
  const greeting = customer.contact_name?.trim() ? `Hi ${customer.contact_name},` : "Hi there,";

  return `${greeting}

Your personalization variants are ready. Paste this one line into your site's <head>:

${snippet}

Let me know when it's deployed. I'll watch the first traffic come through and send you a quick read at the end of week 1.

${signOff()}`;
}
