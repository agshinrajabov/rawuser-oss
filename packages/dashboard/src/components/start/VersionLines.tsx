import { cn } from "@/lib/utils";
import { KEPT_FOOT, type VersionLines as Lines } from "@/lib/versions";

/**
 * The two quiet lines under the versions count on the Live screen (mock
 * design/mock/sales-readiness/pilot-gaps.html, screen 01): versions that
 * keep a part as on the page, versions not written yet. Each line is its
 * own summary and its last words open it. Never amber: neither asks the
 * customer for anything.
 */

const OPEN_WORD =
  "ml-0.5 whitespace-nowrap text-xs text-fg-muted underline decoration-dotted underline-offset-[3px]";

function Dot() {
  return (
    <span
      aria-hidden
      className="mt-1.5 inline-block h-[7px] w-[7px] flex-none rounded-full border-[1.5px] border-fg-faint"
    />
  );
}

/** "Which ones" closed, "Hide" open. */
function Opens({ closed }: { closed: string }) {
  return (
    <span className={OPEN_WORD}>
      <span className="group-open:hidden">{closed}</span>
      <span className="hidden group-open:inline">Hide</span>
    </span>
  );
}

const SUMMARY =
  "grid cursor-pointer list-none grid-cols-[7px_minmax(0,1fr)] gap-2 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] [&::-webkit-details-marker]:hidden";
const BODY =
  "ml-[15px] mt-2 rounded-sm border border-border bg-surface-muted px-3 py-2.5 text-[12.5px] leading-normal text-fg-muted";

function Name({ name, page }: { name: string; page: string | null }) {
  return (
    <b className="block font-medium text-fg">
      {name}
      {page && <span className="ml-1.5 font-mono text-xs font-normal text-fg-faint">{page}</span>}
    </b>
  );
}

export function VersionLines({
  lines,
  open,
  className,
}: {
  lines: Lines;
  /** For the tests: which disclosure is open on arrival. */
  open?: "kept" | "unwritten" | "both";
  className?: string;
}) {
  const { kept, unwritten } = lines;
  if (!kept && !unwritten) return null;
  const keptOpen = open === "kept" || open === "both";
  const unwrittenOpen = open === "unwritten" || open === "both";
  return (
    <div className={cn("mt-1.5 space-y-2 text-[13px] text-fg", className)} data-lines="versions">
      {kept && (
        <details className="group" open={keptOpen}>
          <summary className={SUMMARY}>
            <Dot />
            <span>
              {kept.line} <Opens closed="Which ones" />
            </span>
          </summary>
          <div className={BODY}>
            <ul className="max-h-64 space-y-2 overflow-y-auto">
              {kept.items.map((v) => (
                <li key={v.key}>
                  <Name name={v.name} page={v.page} />
                  {v.line}
                </li>
              ))}
            </ul>
            <p className="mt-2.5 border-t border-border pt-2">{KEPT_FOOT}</p>
          </div>
        </details>
      )}
      {unwritten &&
        (unwritten.items.length === 0 ? (
          <p className="grid grid-cols-[7px_minmax(0,1fr)] gap-2">
            <Dot />
            <span>{unwritten.line}</span>
          </p>
        ) : (
          <details className="group" open={unwrittenOpen}>
            <summary className={SUMMARY}>
              <Dot />
              <span>
                {unwritten.line}
                {unwritten.sees ? (
                  <span className="block text-fg-muted">
                    {unwritten.sees} <Opens closed="Details" />
                  </span>
                ) : (
                  <>
                    {" "}
                    <Opens closed="Details" />
                  </>
                )}
              </span>
            </summary>
            <div className={BODY}>
              <ul className="max-h-64 space-y-2 overflow-y-auto">
                {unwritten.items.map((v) => (
                  <li key={v.key}>
                    <Name name={v.name} page={v.page} />
                    {v.reason}
                    {v.reason && v.sees ? " " : ""}
                    {v.sees}
                  </li>
                ))}
              </ul>
            </div>
          </details>
        ))}
    </div>
  );
}
