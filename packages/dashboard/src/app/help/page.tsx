"use client";

/** /help: one email address (dashboard v2, section 00). Never a repository. */

import { AppShell } from "@/components/shell/AppShell";
import { Help } from "@/components/v2/Help";

export default function HelpPage() {
  return (
    <AppShell>
      <Help />
    </AppShell>
  );
}
