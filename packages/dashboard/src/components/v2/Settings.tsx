"use client";

/**
 * Settings (design/mock/dashboard-v2/app.html, section 05): Install, Product
 * brief, Campaign links, Account. Nothing a superadmin uses (test size,
 * rebuilds, the sensitive flag, checks) appears here; those stay on the
 * superadmin's own screens. Every flow is the one it was: the tag and the
 * platform steps of Connect (held while the readiness question is open), the
 * brief editor on /dna, the tagged link of Results, the sign-in section of
 * Account, and the country switch (lib/country.ts).
 */

import { AccountSignIn, AccountSkeleton } from "@/components/account/AccountSignIn";
import { YourAdsForCustomer } from "@/components/links/AdLinks";
import {
  type RecentLinkEntry,
  loadRecentLinks,
  saveRecentLink,
} from "@/components/links/RecentList";
import { TagStatus } from "@/components/onboard/TagStatus";
import { useReadiness } from "@/components/readiness/useReadiness";
import { useCurrentUser } from "@/components/shell/CurrentUserContext";
import { useCustomerList } from "@/components/shell/CustomerListContext";
import { PlatformSteps } from "@/components/start/PlatformSteps";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { adsReduced } from "@/lib/ad-links";
import { AUTO_LINES, type AutoApprove, getAutoApprove, setAutoApprove } from "@/lib/approval";
import { COUNTRY_LINES, setCountryOff } from "@/lib/country";
import {
  type DirectSwitchName,
  type DirectSwitches,
  SWITCH_LINES,
  getSwitches,
  marketsLine,
  setDirectInsights,
  setSwitch,
} from "@/lib/direct";
import { kindOf, pageName, reasonLabel, regionName } from "@/lib/kinds";
import {
  SETTINGS_TABS,
  SETTINGS_TAB_LABEL,
  type SettingsTab,
  parseSettingsTab,
  withCustomer,
} from "@/lib/routes";
import { buildSnippet } from "@/lib/snippet-tag";
import { ABOUT, SHARE_PLACES, homeUrl, taggedLink } from "@/lib/tagged-link";
import { cn } from "@/lib/utils";
import { livePages } from "@/lib/your-versions";
import type { BusinessDNA, ManifestsAllResponse, ProbeResponse } from "@/types/api";
import type { IntentDim } from "@rawuser/shared";
import { Check, Copy, Loader2, PenLine } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Card, CardHead, How, PageHead, Pill, Seg, TONE, useJson } from "./parts";

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-4 sm:px-[18px] sm:py-3.5 [&+&]:border-t [&+&]:border-border">
      <span className="pt-px text-[12.5px] text-fg-muted">{k}</span>
      <div className="min-w-0 text-[13.5px] leading-[1.55]">{children}</div>
    </div>
  );
}

const Sub = ({ children }: { children: React.ReactNode }) => (
  <span className="mt-0.5 block text-xs text-fg-muted">{children}</span>
);

const LINK = "text-fg underline decoration-dotted underline-offset-[3px] hover:no-underline";

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

function InstallTab({ customerId, superadmin }: { customerId: string; superadmin: boolean }) {
  const { customers } = useCustomerList();
  const customer = customers.find((c) => c.id === customerId);
  const readiness = useReadiness(customerId);
  const [probe, setProbe] = useState<ProbeResponse | null>(null);
  const manifests = useJson<ManifestsAllResponse>(
    `/admin/onboard/manifest?customer_id=${encodeURIComponent(customerId)}&all=true`,
  );
  const pages = livePages(manifests.data?.manifests ?? null);
  const withheld = readiness.answer?.tag_withheld === true;
  const link = (href: string) => (superadmin ? withCustomer(href, customerId) : href);

  return (
    <div className="mt-4 flex max-w-[820px] flex-col gap-3">
      <Card>
        <Row k="Your tag">
          {readiness.state === "loading" ? (
            <span className="text-fg-muted">Reading</span>
          ) : withheld ? (
            <p className="text-fg-muted">
              One question comes before the tag.{" "}
              <Link href={link("/start")} className={LINK}>
                Answer it
              </Link>
            </p>
          ) : customer ? (
            <div className="-mt-5 [&>section]:border-t-0">
              <PlatformSteps
                probe={probe}
                tag={buildSnippet(customerId)}
                adsReduced={adsReduced(readiness.answer)}
              >
                <TagStatus customer={customer} pagePath="/" onProbe={setProbe} />
              </PlatformSteps>
            </div>
          ) : (
            <span className="text-fg-muted">Reading</span>
          )}
        </Row>
        <Row k="Pages with versions">
          {manifests.loading ? (
            <span className="text-fg-muted">Reading</span>
          ) : pages.length === 0 ? (
            <span className="text-fg-muted">None yet</span>
          ) : (
            pages.map(pageName).join(", ")
          )}
          <Sub>
            Add a page on{" "}
            <Link href={link("/start")} className={LINK}>
              the Pages card
            </Link>
            , read them on{" "}
            <Link href={link("/versions")} className={LINK}>
              Versions
            </Link>
            .
          </Sub>
        </Row>
        <Row k="By hand">
          <Link href={link("/onboard")} className={LINK}>
            Pick the parts of a page yourself
          </Link>
          <Sub>For a page Rawuser read wrong.</Sub>
        </Row>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Product brief
// ---------------------------------------------------------------------------

function list(xs: string[] | undefined): string | null {
  const v = (xs ?? []).filter(Boolean);
  return v.length ? v.join(". ").replace(/\.\./g, ".") : null;
}

function BriefTab({ customerId, superadmin }: { customerId: string; superadmin: boolean }) {
  const dna = useJson<BusinessDNA>(`/admin/dna/get?customer_id=${encodeURIComponent(customerId)}`);
  const d = dna.data;
  const rows: [string, string | null][] = [
    ["What you sell", d?.product ?? null],
    ["Who it is for", d?.icp ?? null],
    ["What makes you different", list(d?.differentiators)],
    ["Proof", list(d?.proof_points)],
    ["How you sound", d?.brand_voice ?? null],
  ];
  const editHref = superadmin ? withCustomer("/dna", customerId) : "/dna";
  return (
    <div className="mt-4 flex max-w-[820px] flex-col gap-3">
      <Card>
        {dna.loading ? (
          <Row k="Brief">
            <span className="text-fg-muted">Reading</span>
          </Row>
        ) : !d ? (
          <Row k="Brief">
            <span className="text-fg-muted">No brief yet.</span>
          </Row>
        ) : (
          rows.map(([k, v]) => (
            <Row key={k} k={k}>
              {v ?? <span className="text-fg-faint">Not filled in</span>}
            </Row>
          ))
        )}
      </Card>
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={editHref}
          className={cn(buttonVariants({ variant: "secondary" }), "bg-surface")}
        >
          <PenLine size={14} aria-hidden />
          Edit brief
        </Link>
        <span className="text-xs text-fg-muted">Saving it rewrites your versions.</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Campaign links
// ---------------------------------------------------------------------------

function ago(ts: number, now: number): string {
  const d = Math.floor((now - ts) / 86_400_000);
  if (d <= 0) return "today";
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** "Visitors from this link see the Social version." */
export function linkSees(source: string, intent: string): string {
  const k = kindOf(source === "direct" ? "default" : source);
  return k
    ? `Visitors from this link see the ${k.short} version.`
    : `Visitors from this link see the version for ${reasonLabel(intent).toLowerCase()}.`;
}

function LinksTab({ domain }: { domain: string }) {
  const [page, setPage] = useState(homeUrl(domain));
  const [placeId, setPlaceId] = useState(SHARE_PLACES[0]?.id ?? "linkedin");
  const [about, setAbout] = useState<IntentDim>("problem");
  const [copied, setCopied] = useState(false);
  const [recent, setRecent] = useState<RecentLinkEntry[]>([]);
  useEffect(() => setRecent(loadRecentLinks()), []);
  useEffect(() => setPage(homeUrl(domain)), [domain]);
  const place = SHARE_PLACES.find((p) => p.id === placeId) ?? SHARE_PLACES[0];
  const built = useMemo(
    () => (place ? taggedLink(page, place, about) : null),
    [page, place, about],
  );

  function copy() {
    if (!built || !place) return;
    void navigator.clipboard.writeText(built.url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      setRecent(
        saveRecentLink({
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          base_url: page.trim(),
          intent_target: about,
          source_target: place.source,
          generated_url: built.url,
          classified_intent: built.intent,
          classified_source: built.source,
          ts: Date.now(),
        }),
      );
    });
  }

  const select =
    "h-input w-full rounded-sm border border-border-strong bg-surface px-2.5 text-[13px] text-fg";
  const now = Date.now();
  return (
    <div className="mt-4 flex max-w-[820px] flex-col gap-3">
      <Card>
        <CardHead title="Make a link for a post, an ad or a newsletter" />
        <div className="grid grid-cols-1 gap-3 px-4 pb-4 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] sm:px-[18px]">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="cl-page" className="text-[12.5px] font-medium">
              Page
            </label>
            <Input
              id="cl-page"
              value={page}
              onChange={(e) => setPage(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-[12.5px]"
            />
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium">Where you will share it</span>
            <select className={select} value={placeId} onChange={(e) => setPlaceId(e.target.value)}>
              {SHARE_PLACES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium">What it is about</span>
            <select
              className={select}
              value={about}
              onChange={(e) => setAbout(e.target.value as IntentDim)}
            >
              {ABOUT.map((a) => (
                <option key={a.intent} value={a.intent}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mx-4 mb-4 rounded-sm border border-border bg-surface-muted p-3 sm:mx-[18px]">
          {built ? (
            <>
              <p className="break-all font-mono text-xs">{built.url}</p>
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-fg-muted">
                <Check size={14} aria-hidden className="text-state-success" />
                {linkSees(built.source, built.intent)}
              </p>
              <Button type="button" size="sm" className="mt-2.5" onClick={copy}>
                {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                {copied ? "Copied" : "Copy link"}
              </Button>
            </>
          ) : (
            <p className="text-xs text-fg-muted">Enter a page address, starting with https://</p>
          )}
        </div>
      </Card>
      <Card>
        <CardHead title="Your recent links" side="This browser only" />
        {recent.length === 0 ? (
          <p className="border-t border-border px-4 py-3 text-[13px] text-fg-muted sm:px-[18px]">
            None yet. A copied link shows here.
          </p>
        ) : (
          <ul className="m-0 list-none p-0">
            {recent.slice(0, 8).map((r) => {
              let path = r.base_url;
              try {
                path = pageName(new URL(r.base_url).pathname);
              } catch {
                // keep the stored address
              }
              return (
                <li
                  key={r.id}
                  className="flex items-start justify-between gap-3 border-t border-border px-4 py-2.5 text-[13px] sm:px-[18px]"
                >
                  <span className="min-w-0">
                    <span className="block truncate">{path}</span>
                    <span className="block text-[11.5px] text-fg-muted">{ago(r.ts, now)}</span>
                  </span>
                  <span className="whitespace-nowrap font-mono text-[12.5px]">
                    {kindOf(r.classified_source)?.short ?? "General"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <div className="mt-3">
        <YourAdsForCustomer />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/** What the Visitors answer says about the two recording switches. */
interface RecordingRead {
  data: { country_recording?: "on" | "off"; direct?: { recording?: "on" | "off" } } | null;
  loading: boolean;
}

function CountryRow({ customerId, state }: { customerId: string; state: RecordingRead }) {
  const [off, setOff] = useState<boolean | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const read = state.data?.country_recording;
  const isOff = off ?? (read === undefined ? null : read === "off");

  async function flip(next: boolean) {
    setBusy(true);
    setSaid(null);
    const out = await setCountryOff(customerId, next);
    setBusy(false);
    setAsking(false);
    if (out.kind === "ok") setOff(out.answer.off);
    else setSaid(out.message);
  }

  return (
    <Row k={COUNTRY_LINES.label}>
      {isOff === null ? (
        <span className="text-fg-muted">{state.loading ? "Reading" : "Not available yet"}</span>
      ) : (
        <span className="flex flex-wrap items-center gap-3">
          {isOff ? <Pill>{COUNTRY_LINES.off}</Pill> : <Pill tone="ok">{COUNTRY_LINES.on}</Pill>}
          <button
            type="button"
            className={cn(LINK, "text-[12.5px] disabled:opacity-50")}
            disabled={busy}
            onClick={() => (isOff ? void flip(false) : setAsking(true))}
          >
            {busy && !asking ? "Saving" : isOff ? COUNTRY_LINES.turnOn : COUNTRY_LINES.turnOff}
          </button>
        </span>
      )}
      <Sub>
        {isOff
          ? COUNTRY_LINES.offSub
          : `${COUNTRY_LINES.sub} Turning it off removes it from past visits too.`}
      </Sub>
      {said && <p className={cn("mt-1 text-[12.5px]", TONE.WARN_TEXT)}>{said}</p>}
      {asking && (
        <Dialog open onOpenChange={(o) => !o && !busy && setAsking(false)}>
          <DialogContent className="w-[calc(100%-2rem)] max-w-[400px] p-5">
            <DialogTitle className="pr-7 text-[15px] tracking-[-0.005em]">
              {COUNTRY_LINES.confirmTitle}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-[13.5px] leading-relaxed">
              {COUNTRY_LINES.confirmLine}
            </DialogDescription>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => setAsking(false)}
              >
                {COUNTRY_LINES.keep}
              </Button>
              <Button type="button" size="sm" disabled={busy} onClick={() => void flip(true)}>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                {COUNTRY_LINES.turnOff}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </Row>
  );
}

/** "Publish new versions without asking" (versions-approval.md §4), default off. */
function AutoApproveRow({ customerId }: { customerId: string }) {
  const [state, setState] = useState<AutoApprove | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getAutoApprove(customerId).then((a) => !cancelled && setState(a));
    return () => {
      cancelled = true;
    };
  }, [customerId]);
  // A worker without the switch: no row.
  if (state === null) return null;

  async function flip(on: boolean) {
    setBusy(true);
    setSaid(null);
    const out = await setAutoApprove(customerId, on);
    setBusy(false);
    if (out.kind === "ok") setState(out.state);
    else setSaid(out.message);
  }

  const on = state?.on === true;
  return (
    <Row k={AUTO_LINES.label}>
      {state === undefined ? (
        <span className="text-fg-muted">Reading</span>
      ) : (
        <span className="flex flex-wrap items-center gap-3">
          {on ? <Pill tone="ok">{AUTO_LINES.on}</Pill> : <Pill>{AUTO_LINES.off}</Pill>}
          <button
            type="button"
            role="switch"
            aria-checked={on}
            className={cn(LINK, "text-[12.5px] disabled:opacity-50")}
            disabled={busy}
            onClick={() => void flip(!on)}
          >
            {busy ? "Saving" : on ? AUTO_LINES.turnOff : AUTO_LINES.turnOn}
          </button>
        </span>
      )}
      <Sub>{on ? AUTO_LINES.subOn : AUTO_LINES.subOff}</Sub>
      {said && <p className={cn("mt-1 text-[12.5px]", TONE.WARN_TEXT)}>{said}</p>}
    </Row>
  );
}

/** The details behind a switch: its lines, then the sentence for the privacy notice. */
function More({ lines, notice }: { lines: readonly string[]; notice: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <How summary="More" className="mt-1.5">
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
      <p className="mt-1 font-medium text-fg">For your privacy notice</p>
      <p>{notice}</p>
      <button
        type="button"
        className={cn(LINK, "mt-0.5 inline-flex items-center gap-1 self-start text-xs")}
        onClick={() =>
          void navigator.clipboard?.writeText(notice).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          })
        }
      >
        {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
        {copied ? "Copied" : "Copy"}
      </button>
    </How>
  );
}

/** On or off, the flip, one line, the details. */
function SwitchValue({
  on,
  busy,
  notHere,
  onFlip,
}: {
  on: boolean;
  busy: boolean;
  notHere?: boolean;
  onFlip: () => void;
}) {
  if (notHere) return <Pill>{SWITCH_LINES.notHere}</Pill>;
  return (
    <span className="flex flex-wrap items-center gap-3">
      {on ? <Pill tone="ok">{SWITCH_LINES.on}</Pill> : <Pill>{SWITCH_LINES.off}</Pill>}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={cn(LINK, "text-[12.5px] disabled:opacity-50")}
        disabled={busy}
        onClick={onFlip}
      >
        {busy ? SWITCH_LINES.saving : on ? SWITCH_LINES.turnOff : SWITCH_LINES.turnOn}
      </button>
    </span>
  );
}

/** ADR 0038 part 1: the device word and the in-app bit. Off clears past visits too. */
function DirectInsightsRow({ customerId, state }: { customerId: string; state: RecordingRead }) {
  const L = SWITCH_LINES.insights;
  const [on, setOn] = useState<boolean | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const read = state.data?.direct?.recording;
  const isOn = on ?? (read === undefined ? null : read === "on");
  // A worker without the direct block: no row.
  if (isOn === null && !state.loading && state.data && !state.data.direct) return null;

  async function flip(next: boolean) {
    setBusy(true);
    setSaid(null);
    const out = await setDirectInsights(customerId, next);
    setBusy(false);
    setAsking(false);
    if (out.kind === "ok") setOn(out.value.on);
    else setSaid(out.message);
  }

  return (
    <Row k={L.label}>
      {isOn === null ? (
        <span className="text-fg-muted">{state.loading ? "Reading" : "Not available yet"}</span>
      ) : (
        <SwitchValue
          on={isOn}
          busy={busy && !asking}
          onFlip={() => (isOn ? setAsking(true) : void flip(true))}
        />
      )}
      <Sub>{L.sub}</Sub>
      <More lines={L.more} notice={L.notice} />
      {said && <p className={cn("mt-1 text-[12.5px]", TONE.WARN_TEXT)}>{said}</p>}
      {asking && (
        <Dialog open onOpenChange={(o) => !o && !busy && setAsking(false)}>
          <DialogContent className="w-[calc(100%-2rem)] max-w-[400px] p-5">
            <DialogTitle className="pr-7 text-[15px] tracking-[-0.005em]">
              {L.confirmTitle}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-[13.5px] leading-relaxed">
              {L.confirmLine}
            </DialogDescription>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => setAsking(false)}
              >
                {L.keep}
              </Button>
              <Button type="button" size="sm" disabled={busy} onClick={() => void flip(false)}>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                {SWITCH_LINES.turnOff}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </Row>
  );
}

const PART_SWITCHES: DirectSwitchName[] = [
  "page_one",
  "learned_default",
  "market_versions",
  "remember",
];

/** ADR 0038 parts 3 to 5: three switches, one read. A worker without them: no rows. */
function DirectSwitchRows({ customerId }: { customerId: string }) {
  const [state, setState] = useState<DirectSwitches | null | undefined>(undefined);
  const [busy, setBusy] = useState<DirectSwitchName | null>(null);
  const [said, setSaid] = useState<{ name: DirectSwitchName; text: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getSwitches(customerId).then((a) => !cancelled && setState(a));
    return () => {
      cancelled = true;
    };
  }, [customerId]);
  if (state === null) return null;

  async function flip(name: DirectSwitchName, on: boolean) {
    setBusy(name);
    setSaid(null);
    const out = await setSwitch(customerId, name, on);
    setBusy(null);
    if (out.kind === "ok") setState(out.value);
    else setSaid({ name, text: out.message });
  }

  return (
    <>
      {PART_SWITCHES.map((name) => {
        const L = SWITCH_LINES[name];
        const allowed = name === "remember" ? state?.remember_allowed : state?.allowed;
        return (
          <Row key={name} k={L.label}>
            {state === undefined ? (
              <span className="text-fg-muted">Reading</span>
            ) : (
              <SwitchValue
                on={state[name]}
                busy={busy === name}
                notHere={!allowed}
                onFlip={() => void flip(name, !state[name])}
              />
            )}
            <Sub>
              {state && !allowed ? SWITCH_LINES.notHereMore : L.sub}
              {name === "market_versions" &&
                state?.allowed &&
                state.market_versions &&
                ` ${marketsLine(state.markets, regionName)}`}
            </Sub>
            <More lines={L.more} notice={L.notice} />
            {said?.name === name && (
              <p className={cn("mt-1 text-[12.5px]", TONE.WARN_TEXT)}>{said.text}</p>
            )}
          </Row>
        );
      })}
    </>
  );
}

function AccountTab({ customerId, openCodes }: { customerId: string; openCodes: boolean }) {
  const { user } = useCurrentUser();
  const recording = useJson<RecordingRead["data"] & object>(
    customerId
      ? `/admin/analytics/visitors?customer_id=${encodeURIComponent(customerId)}&window=24h`
      : null,
  );
  return (
    <div className="mt-4 flex max-w-[820px] flex-col gap-3">
      <Card>
        <Row k="Email">{user?.email ?? ""}</Row>
        {customerId && <AutoApproveRow customerId={customerId} />}
        {customerId && <CountryRow customerId={customerId} state={recording} />}
      </Card>
      {customerId && (
        <>
          <h2 className="mt-4 text-[15px] font-semibold tracking-[-0.005em]">
            Visits with nothing to go on
          </h2>
          <p className="-mt-1.5 text-[12.5px] text-fg-muted">
            Many visits come with no link or source. These decide what they see.
          </p>
          <Card>
            <DirectInsightsRow customerId={customerId} state={recording} />
            <DirectSwitchRows customerId={customerId} />
          </Card>
        </>
      )}
      <h2 className="mt-4 text-[15px] font-semibold tracking-[-0.005em]">Sign-in</h2>
      {user ? <AccountSignIn email={user.email} openCodes={openCodes} /> : <AccountSkeleton />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function Settings({
  customerId,
  superadmin,
  host,
}: {
  customerId: string;
  superadmin: boolean;
  host: string;
}) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = parseSettingsTab(params.get("tab"));
  const setTab = (t: SettingsTab) => {
    const next = new URLSearchParams(params.toString());
    next.set("tab", t);
    next.delete("codes");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const needsCustomer = tab !== "account" && !customerId;
  return (
    <div className="flex flex-col animate-fade-in">
      <PageHead title="Settings" sub={host || undefined} />
      <Seg
        className="mt-4 self-start"
        label="Settings section"
        values={SETTINGS_TABS}
        labels={SETTINGS_TAB_LABEL}
        value={tab}
        onChange={setTab}
      />
      {needsCustomer ? (
        <p className="mt-6 text-sm text-fg-muted">Choose a customer from the top bar.</p>
      ) : tab === "install" ? (
        <InstallTab customerId={customerId} superadmin={superadmin} />
      ) : tab === "brief" ? (
        <BriefTab customerId={customerId} superadmin={superadmin} />
      ) : tab === "links" ? (
        <LinksTab domain={host} />
      ) : (
        <AccountTab customerId={customerId} openCodes={params.get("codes") === "new"} />
      )}
    </div>
  );
}
