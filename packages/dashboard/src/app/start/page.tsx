import { FirstRun } from "@/components/start/FirstRun";
import { Suspense } from "react";

/**
 * /start — the guided first run (docs/specs/first-run.md). No sidebar,
 * three steps, one button each. Customers land here until their site is
 * live; operators reach it from a customer's next step.
 */
export default function StartPage() {
  return (
    <Suspense>
      <FirstRun />
    </Suspense>
  );
}
