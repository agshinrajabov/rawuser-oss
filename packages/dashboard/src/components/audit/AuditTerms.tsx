"use client";

/**
 * /audit/terms/: the audit terms the sign-up's tick and the first-run strip
 * link to. The words are the operator's (src/hosted/audit-terms.ts); an
 * install that has published none shows one line and no list.
 */

import { TERMS, TERMS_INTRO } from "@/hosted/audit-terms";
import { LedgerColumn, LedgerHeadline, LedgerInline } from "./ledger";

export function AuditTermsView() {
  return (
    <LedgerColumn kicker="Rawuser · free audit">
      <LedgerHeadline>Audit terms</LedgerHeadline>
      <p className="mt-6 text-[15px] leading-[1.6] text-[#525252]">{TERMS_INTRO}</p>
      {TERMS.length > 0 && (
        <ol className="mt-8 border-t border-[#d4d4d4]">
          {TERMS.map((t) => (
            <li key={t.title} className="border-b border-[#d4d4d4] py-5">
              <p className="text-[15px] font-medium text-[#171717]">{t.title}</p>
              {t.text && (
                <p className="mt-1.5 text-[14.5px] leading-[1.6] text-[#525252]">
                  <LedgerInline text={t.text} />
                </p>
              )}
              {t.list && (
                <ol className="mt-1.5 list-decimal space-y-2 pl-5 text-[14.5px] leading-[1.6] text-[#525252]">
                  {t.list.map((x) => (
                    <li key={x}>
                      <LedgerInline text={x} />
                    </li>
                  ))}
                </ol>
              )}
            </li>
          ))}
        </ol>
      )}
    </LedgerColumn>
  );
}
