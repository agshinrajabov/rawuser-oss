"use client";

import {
  LANGUAGES,
  languageName,
  sameAddressLine,
  sameAddressWhy,
  withPage,
} from "@/lib/languages";
import { cn } from "@/lib/utils";
import type { QuickstartResponse, StoredLanguage } from "@/types/api";
import { useState } from "react";
import { Tick } from "./Measure";

/**
 * The Look screen's language row (docs/specs/per-language.md). One language:
 * its name and where it was read from, with Change. Several, each on its own
 * address: a tick per language. A language on the same address (mock
 * design/mock/sales-readiness/pilot-gaps.html, screen 03): one sentence and
 * Why, nothing to tick, because nothing is written for it.
 */

const QUIET =
  "whitespace-nowrap text-xs text-fg-muted underline decoration-dotted underline-offset-[3px] hover:text-fg";

const SOURCE_WORDS: Record<QuickstartResponse["language_source"], string> = {
  "html-lang": "as the page declares.",
  "page-read": "as read from the text.",
  fallback: "a guess, please check.",
};

export function LanguageRow({
  languages,
  sameAddress,
  language,
  languageSource,
  enabled,
  onToggle,
  onLanguage,
  defaultWhy = false,
}: {
  /** The customer's or the quickstart's list; entries without a page are never ticked. */
  languages: readonly StoredLanguage[] | undefined;
  /** Language tags the site also serves on the same address. */
  sameAddress: string[];
  /** The brief's language, the one this page is written in. */
  language: string;
  languageSource: QuickstartResponse["language_source"];
  enabled: Set<string>;
  onToggle: (lang: string, on: boolean) => void;
  onLanguage: (lang: string) => void;
  /** For the tests: Why open on arrival. */
  defaultWhy?: boolean;
}) {
  const [change, setChange] = useState(false);
  const paged = withPage(languages);
  const several = paged.length > 1;
  const known = LANGUAGES.find((l) => l.value === language);
  const written = several
    ? paged.filter((l) => l.status === "primary" || enabled.has(l.lang)).map((l) => l.lang)
    : [language];
  const also = sameAddressLine(sameAddress, written);

  return (
    <div className="px-4 py-3" data-row="language">
      <div className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-3">
        <span className="mt-[3px] flex">
          <Tick
            warn={languageSource === "fallback" || paged.some((l) => l.status === "unreachable")}
          />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">
            {several ? `Your site is in ${paged.length} languages` : "Language"}
          </p>
          <p className="text-[13px] text-fg-muted">
            {several
              ? "Versions are written for each language you tick, from that page's own words. Nothing is translated."
              : `${known?.label ?? languageName(language)}, ${SOURCE_WORDS[languageSource] ?? SOURCE_WORDS.fallback}`}
          </p>
          {several && (
            <div className="mt-2 space-y-1.5 text-[13px]">
              {paged.map((l) => (
                <label key={l.lang} className="flex flex-wrap items-center gap-2 text-fg">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={l.status === "primary" || enabled.has(l.lang)}
                    disabled={l.status !== "ready"}
                    onChange={(e) => onToggle(l.lang, e.target.checked)}
                  />
                  <span>
                    {languageName(l.lang)}
                    <span className="text-fg-faint"> {l.path}</span>
                  </span>
                  <span className="text-xs text-fg-faint">
                    {l.status === "primary"
                      ? "this page"
                      : l.status === "ready"
                        ? `${l.parts} parts found${l.brief_drafted ? ", brief drafted" : ""}`
                        : "could not read this page, skipped"}
                  </span>
                </label>
              ))}
            </div>
          )}
          {also && (
            <details className="group" open={defaultWhy} data-line="same-address">
              <summary className="mt-0.5 block cursor-pointer list-none rounded-sm text-[13px] text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
                {also}{" "}
                <span className={cn(QUIET, "ml-0.5")}>
                  <span className="group-open:hidden">Why</span>
                  <span className="hidden group-open:inline">Hide</span>
                </span>
              </summary>
              <p className="mt-1.5 max-w-[58ch] rounded-sm border border-border bg-surface-muted px-2.5 py-2 text-[12.5px] leading-normal text-fg-muted">
                {sameAddressWhy(sameAddress)}
              </p>
            </details>
          )}
          {!several && change && (
            <select
              aria-label="Language of the page"
              value={language}
              onChange={(e) => onLanguage(e.target.value)}
              className="mt-2 h-7 rounded-md border border-border-strong bg-surface px-2 text-sm"
            >
              {!known && <option value={language}>{language}</option>}
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          )}
        </div>
        {!several && !change ? (
          <button type="button" className={cn(QUIET, "mt-0.5")} onClick={() => setChange(true)}>
            Change
          </button>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}
