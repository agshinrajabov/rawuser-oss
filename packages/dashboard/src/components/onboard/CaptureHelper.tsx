"use client";

import { Button } from "@/components/ui/Button";
import { API_ORIGIN, apiFetch } from "@/lib/api";
import type { CaptureStatusResponse, CaptureTokenResponse } from "@/types/api";
import { Check, Copy, Loader2, MousePointerClick } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface CaptureHelperProps {
  customerId: string;
  sourceUrl: string;
  /** Notified when a capture lands so the parent can suggest re-detecting. */
  onCaptured?: (pagePath: string) => void;
}

/**
 * Builds the bookmarklet the operator drags to their bookmarks bar (or runs
 * from the console). It clones the RENDERED DOM — what a client-side-rendered
 * app actually shows — strips non-content markup, and POSTs it to the public
 * capture endpoint with the one-time token. No credentials, no visitor data:
 * the operator captures their own public page.
 */
function buildCaptureScript(token: string): string {
  return `(function(){var d=document.documentElement.cloneNode(true);d.querySelectorAll("script,style,noscript,svg,iframe").forEach(function(n){n.remove()});fetch("${API_ORIGIN}/onboard/capture",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:"${token}",url:location.href,html:d.outerHTML.slice(0,500000)})}).then(function(r){return r.json()}).then(function(j){alert(j.ok?"Rawuser: page captured ("+j.bytes+" bytes). Return to the dashboard.":"Rawuser: "+(j.error||"capture failed"))}).catch(function(){alert("Rawuser: capture failed (network)")})})()`;
}

function buildBookmarklet(token: string): string {
  return `javascript:${encodeURIComponent(buildCaptureScript(token))}`;
}

/**
 * React refuses `javascript:` hrefs passed through JSX (it rewrites them to a
 * throwing stub as an XSS precaution), which silently breaks the drag-to-
 * bookmarks link. Setting the attribute imperatively through the DOM opts out
 * for this one deliberate bookmarklet. Verified live on the deployed
 * dashboard, 2026-08-07.
 */
function BookmarkletLink({ token }: { token: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  // Must be an <a>: the operator DRAGS it to the bookmarks bar (buttons
  // aren't draggable as bookmarklets). Both the javascript: href and the
  // click-blocker are attached imperatively — React rewrites javascript:
  // hrefs in JSX, and an inline onClick trips the useValidAnchor rule.
  // The copy-script button next to it is the accessible path.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.setAttribute("href", buildBookmarklet(token));
    const block = (e: MouseEvent) => e.preventDefault();
    el.addEventListener("click", block);
    return () => el.removeEventListener("click", block);
  }, [token]);
  return (
    <a
      ref={ref}
      href="#capture-bookmarklet"
      className="font-mono text-fg underline decoration-dotted"
      title="Drag me to your bookmarks bar"
    >
      Capture for Rawuser
    </a>
  );
}

/**
 * T2 operator-browser DOM capture (element-detection-v2).
 *
 * For sites built with Lovable/v0/Bolt (client-side rendered), the server
 * fetch sees an empty <div id="root"> — detection finds nothing. This helper
 * mints a one-time token, hands the operator a bookmarklet, and polls until
 * the rendered DOM arrives. The next Detect click then uses the captured DOM.
 */
export function CaptureHelper({ customerId, sourceUrl, onCaptured }: CaptureHelperProps) {
  const [tokenResp, setTokenResp] = useState<CaptureTokenResponse | null>(null);
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captured, setCaptured] = useState(false);
  const [copied, setCopied] = useState(false);
  const onCapturedRef = useRef(onCaptured);
  onCapturedRef.current = onCaptured;

  async function handleStart() {
    setError(null);
    setMinting(true);
    setCaptured(false);
    try {
      const data = await apiFetch<CaptureTokenResponse>("/admin/onboard/capture-token", {
        method: "POST",
        body: JSON.stringify({ customer_id: customerId, source_url: sourceUrl }),
      });
      setTokenResp(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start capture. Try again.");
    } finally {
      setMinting(false);
    }
  }

  // Poll capture-status every 3s while a token is outstanding and nothing
  // has landed yet. Stops on capture or when the component unmounts.
  useEffect(() => {
    if (tokenResp === null || captured) return;
    let cancelled = false;
    const interval = setInterval(() => {
      apiFetch<CaptureStatusResponse>(
        `/admin/onboard/capture-status?customer_id=${encodeURIComponent(customerId)}&page_path=${encodeURIComponent(tokenResp.page_path)}`,
      )
        .then((data) => {
          if (cancelled || !data.captured) return;
          setCaptured(true);
          onCapturedRef.current?.(data.page_path);
        })
        .catch(() => {});
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tokenResp, captured, customerId]);

  if (captured) {
    return (
      <p className="text-state-success text-sm flex items-center gap-1.5">
        <Check className="h-4 w-4" />
        Page captured. Click Detect elements to run detection on the real rendered page.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {tokenResp === null ? (
        <>
          <p className="text-xs text-fg-muted">
            Site built with Lovable, v0, or Bolt? Those render in the browser, so detection may see
            an empty page. Capture the rendered page from your own browser instead.
          </p>
          <Button type="button" variant="ghost" onClick={handleStart} disabled={minting}>
            {minting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <MousePointerClick className="h-4 w-4" />
            )}
            Capture rendered page
          </Button>
        </>
      ) : (
        <div className="space-y-2">
          <ol className="text-xs text-fg-muted list-decimal pl-4 space-y-1">
            <li>
              Drag this link to your bookmarks bar: <BookmarkletLink token={tokenResp.token} />
              {", or "}
              <button
                type="button"
                className="inline-flex items-center gap-1 font-mono text-fg underline decoration-dotted"
                onClick={() => {
                  navigator.clipboard
                    .writeText(buildCaptureScript(tokenResp.token))
                    .then(() => setCopied(true))
                    .catch(() => {});
                }}
              >
                <Copy className="h-3 w-3" />
                {copied ? "copied" : "copy the script"}
              </button>{" "}
              to paste into the browser console on your page.
            </li>
            <li>
              Open <span className="font-mono break-all">{sourceUrl}</span> in a normal (logged-out)
              tab and click the bookmark (or run the copied script in DevTools console) there.
            </li>
            <li>Come back here. This panel updates automatically.</li>
          </ol>
          <p className="text-xs text-fg-faint flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            Waiting for capture… link expires in {Math.round(tokenResp.expires_in_s / 60)} minutes.
          </p>
        </div>
      )}
      {error && <p className="text-state-err text-sm">{error}</p>}
    </div>
  );
}
