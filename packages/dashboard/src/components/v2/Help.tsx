import { Card, PageHead } from "@/components/v2/parts";
import { SUPPORT_EMAIL, helpLine } from "@/lib/identity";

/** /help: one email address, or one line when the install was given none. */
export function Help() {
  if (!SUPPORT_EMAIL) return <PageHead title="Help" sub={helpLine()} />;
  return (
    <>
      <PageHead title="Help" sub="Write to us, we answer within a working day" />
      <Card className="mt-4 max-w-[560px]">
        <div className="grid grid-cols-1 gap-1 px-4 py-3.5 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-4 sm:px-[18px]">
          <span className="text-[12.5px] text-fg-muted">Email</span>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="text-[13.5px] underline decoration-dotted underline-offset-[3px]"
          >
            {SUPPORT_EMAIL}
          </a>
        </div>
      </Card>
    </>
  );
}
