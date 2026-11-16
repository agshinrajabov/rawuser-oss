import { DnaTabs } from "@/components/dna/DnaTabs";
import { NextStepsBanner } from "@/components/journey/NextStepsBanner";
import { AppShell } from "@/components/shell/AppShell";
import { Suspense } from "react";

export default function DnaPage() {
  return (
    <AppShell>
      <Suspense>
        <div className="mb-5">
          <h1 className="text-lg font-semibold tracking-[-0.005em] text-fg">Product brief</h1>
          <p className="mt-0.5 text-[12.5px] text-fg-muted">
            What Rawuser knows about your product. Every version is written from it.
          </p>
        </div>
        <NextStepsBanner screen="dna" />
        <DnaTabs />
      </Suspense>
    </AppShell>
  );
}
