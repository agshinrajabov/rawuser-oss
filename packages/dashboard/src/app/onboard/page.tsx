import { NextStepsBanner } from "@/components/journey/NextStepsBanner";
import { OnboardFlow } from "@/components/onboard/OnboardFlow";
import { AppShell } from "@/components/shell/AppShell";
import { Suspense } from "react";

export default function OnboardPage() {
  return (
    <AppShell>
      <div className="mb-5">
        <h1 className="text-lg font-semibold tracking-[-0.005em] text-fg">Connect page</h1>
        <p className="mt-0.5 text-[12.5px] text-fg-muted">
          Set up a page by hand: the tag, the parts of the page, go live.
        </p>
      </div>
      <Suspense>
        <NextStepsBanner screen="onboard" />
      </Suspense>
      <Suspense>
        <OnboardFlow />
      </Suspense>
    </AppShell>
  );
}
