/**
 * The pilot invite's email (docs/specs/invite-email.md §7): the optional
 * field in the form, the payload (email only when typed), and the one line
 * under the link for every answer. Bodies rendered to markup; the worker is
 * a stubbed fetch.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PilotInviteBody,
  type PilotInviteState,
} from "../../src/components/applications/InviteDialog";
import { AuditInviteBody } from "../../src/components/audit/AuditInviteDialog";
import { Dialog } from "../../src/components/ui/Dialog";
import {
  EMAIL_HELP,
  FAILED_LINE,
  LIMIT_LINE,
  RECIPIENT_LINE,
  emailLine,
  inviteBody,
} from "../../src/lib/invite";
import type { InviteEmailError, PilotApplicationInvite } from "../../src/types/api";

const noop = () => undefined;
const LINK = "https://app.example.com/apply/#t=q7Hv2LmX9cRw4TbN";

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function render(state: PilotInviteState): string {
  return renderToStaticMarkup(
    h(
      Dialog,
      { open: true },
      h(PilotInviteBody, {
        state,
        onName: noop,
        onSite: noop,
        onEmail: noop,
        onSubmit: noop,
        onClose: noop,
      }),
    ),
  );
}

function made(extra: Partial<PilotApplicationInvite>, email: string): string {
  return render({
    kind: "made",
    email,
    invite: { id: "i", kind: "pilot", link: LINK, expires_at: Date.UTC(2026, 10, 9), ...extra },
  });
}

function rules(html: string) {
  expect(text(html)).not.toMatch(/[–—]/);
}

describe("the email field", () => {
  const html = render({ kind: "form", name: "", site: "", email: "" });
  it("sits below Site with its label, placeholder and help line", () => {
    const t = text(html);
    expect(t).toContain("Site Email (optional)");
    expect(t).toContain(EMAIL_HELP);
    expect(EMAIL_HELP).toBe("We email them the link. The address is not stored.");
    expect(html).toMatch(/id="invite-email"[^>]*>/);
    expect(html).toContain('placeholder="name@example.com"');
    expect(html).toContain('type="email"');
    expect(html.indexOf('id="invite-site"')).toBeLessThan(html.indexOf('id="invite-email"'));
    rules(html);
  });
  it("is not in the audit link dialog", () => {
    const audit = renderToStaticMarkup(
      h(
        Dialog,
        { open: true },
        h(AuditInviteBody, {
          state: { kind: "form", name: "", site: "" },
          summary: { open: 1, max: 10, invites_on: true },
          onName: noop,
          onSite: noop,
          onSubmit: noop,
          onClose: noop,
        }),
      ),
    );
    expect(audit).not.toContain("Email (optional)");
    expect(audit).not.toContain('type="email"');
    expect(audit).not.toContain(EMAIL_HELP);
  });
});

describe("the payload", () => {
  it("sends email only when typed, trimmed", () => {
    expect(inviteBody("", "", "")).toEqual({});
    expect(inviteBody(" Northwind ", "northwind-app.test", "   ")).toEqual({
      name: "Northwind",
      site: "northwind-app.test",
    });
    expect(inviteBody("", "", " rina@northwind.example ")).toEqual({
      email: "rina@northwind.example",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("posts it in the JSON body, never in the URL", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({ id: "i", kind: "pilot", link: LINK, expires_at: 1, emailed: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const { makePilotInvite } = await import("../../src/lib/invite");
    const email = "rina@northwind.example";
    const answer = await makePilotInvite(inviteBody("Northwind", "", email));
    expect(answer.emailed).toBe(true);
    expect(calls).toHaveLength(1);
    const c = calls[0] as { url: string; init: RequestInit };
    expect(c.url).toMatch(/\/admin\/applications\/invite$/);
    expect(c.url).not.toContain(email);
    expect(c.init.method).toBe("POST");
    expect(JSON.parse(String(c.init.body))).toEqual({ name: "Northwind", email });
  });
});

describe("the line under the link", () => {
  const email = "rina@northwind.example";

  it("emailed: Sent to the address, with the link and Copy kept", () => {
    const html = made({ emailed: true }, email);
    const t = text(html);
    expect(t).toContain(`Sent to ${email}.`);
    expect(t).toContain(LINK);
    expect(t).toContain("Copy");
    rules(html);
  });

  it("limit", () => {
    expect(LIMIT_LINE).toBe("Daily email limit reached. Copy the link and send it yourself.");
    expect(text(made({ emailed: false, email_error: "limit" }, email))).toContain(LIMIT_LINE);
  });

  it("recipient", () => {
    expect(RECIPIENT_LINE).toBe("That address refused the email. Copy the link instead.");
    expect(text(made({ emailed: false, email_error: "recipient" }, email))).toContain(
      RECIPIENT_LINE,
    );
  });

  it.each(["unavailable", "sender", "quota", "failed"] as InviteEmailError[])(
    "%s reads as the plain did-not-go-out line",
    (word) => {
      expect(FAILED_LINE).toBe("The email did not go out. Copy the link and send it yourself.");
      const t = text(made({ emailed: false, email_error: word }, email));
      expect(t).toContain(FAILED_LINE);
      expect(t).not.toContain(word);
      expect(t).not.toContain(`Sent to ${email}`);
    },
  );

  it("no line when no address was given", () => {
    const t = text(made({ emailed: false }, ""));
    expect(t).not.toContain("Sent to");
    expect(t).not.toContain(FAILED_LINE);
    expect(emailLine({ emailed: false }, "")).toBeNull();
  });

  it("an answer with no emailed field still says it did not go out", () => {
    expect(emailLine({}, email)).toEqual({ text: FAILED_LINE, ok: false });
  });

  it("every line keeps clear of dashes", () => {
    for (const l of [LIMIT_LINE, RECIPIENT_LINE, FAILED_LINE, EMAIL_HELP]) {
      expect(l).not.toMatch(/[–—]/);
    }
  });
});
