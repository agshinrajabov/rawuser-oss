"use client";

import { CopyBlock } from "@/components/ui/CopyBlock";
import { isTag } from "@/lib/snippet-tag";
import type { ComponentProps } from "react";

/**
 * A tag with its Copy. On a build that was given no edge address there is no
 * tag to copy, only the one line that says so (lib/identity.ts).
 */
export function TagCopy(props: ComponentProps<typeof CopyBlock>) {
  if (!isTag(props.content)) {
    return (
      <p data-tag-unset className="text-[13px] leading-relaxed text-fg-muted">
        {props.content}
      </p>
    );
  }
  return <CopyBlock {...props} />;
}
