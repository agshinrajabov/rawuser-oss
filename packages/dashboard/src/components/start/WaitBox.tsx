"use client";

import { Button } from "@/components/ui/Button";
import type { WaitLine } from "@/lib/install";
import { cn } from "@/lib/utils";
import { WARN_WASH } from "./tones";

/**
 * Connect, step 2, after 45 seconds without a capture (install-friction
 * mock, section 3): one amber line naming the likely cause from the last
 * probe, and the read from the address as the next step. The capture poll
 * keeps running behind it.
 */
export function WaitBox({
  wait,
  captureLink,
  domain,
  onRead,
}: {
  wait: WaitLine;
  captureLink: string;
  domain: string;
  onRead: () => void;
}) {
  return (
    <div
      className={cn(
        "mt-3 rounded-md border border-[color-mix(in_srgb,var(--state-warn)_40%,transparent)] px-3.5 py-3 text-[13px] leading-relaxed text-fg",
        WARN_WASH,
      )}
      aria-live="polite"
    >
      <p>{wait.text}</p>
      {wait.showLink && <p className="font-mono text-xs mt-1.5 break-all text-fg">{captureLink}</p>}
      <div className="mt-2.5">
        <Button type="button" size="sm" variant="secondary" onClick={onRead}>
          Read {domain} from its address
        </Button>
      </div>
    </div>
  );
}
