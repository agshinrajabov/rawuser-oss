"use client";

import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { ApiError, apiFetch } from "@/lib/api";
import type { CustomerListItem } from "@/types/api";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

const SLUG_RE = /^[a-z0-9-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface CreateCustomerDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (customer: CustomerListItem) => void;
}

export function CreateCustomerDialog({ open, onClose, onCreated }: CreateCustomerDialogProps) {
  const [slug, setSlug] = useState("");
  const [domain, setDomain] = useState("");
  const [plan, setPlan] = useState("pilot");
  const [contactEmail, setContactEmail] = useState("");
  const [contactName, setContactName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSlug("");
      setDomain("");
      setPlan("pilot");
      setContactEmail("");
      setContactName("");
      setSubmitting(false);
      setApiError(null);
    }
  }, [open]);

  const slugError =
    slug.length === 0
      ? "Required"
      : !SLUG_RE.test(slug)
        ? "Lowercase letters, numbers, and hyphens only"
        : slug.length > 50
          ? "Maximum 50 characters"
          : null;

  const domainError =
    domain.length === 0 ? "Required" : domain.length > 253 ? "Maximum 253 characters" : null;

  const emailError =
    contactEmail.length === 0
      ? null
      : !EMAIL_RE.test(contactEmail.trim())
        ? "Not a valid email address"
        : contactEmail.length > 320
          ? "Too long"
          : null;

  const nameError = contactName.length > 200 ? "Maximum 200 characters" : null;

  const canSubmit = !slugError && !domainError && !emailError && !nameError && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setApiError(null);
    try {
      const body: Record<string, string> = { slug, domain, plan };
      if (contactEmail.trim()) body.contact_email = contactEmail.trim();
      if (contactName.trim()) body.contact_name = contactName.trim();
      const customer = await apiFetch<CustomerListItem>("/admin/customers/create", {
        method: "POST",
        body: JSON.stringify(body),
      });
      onCreated(customer);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setApiError("A customer with that slug already exists.");
        } else {
          const msg = err.message.replace(/^API error \d+:\s*/, "").trim();
          setApiError(msg || "Something went wrong. Please try again.");
        }
      } else {
        setApiError("Something went wrong. Please try again.");
      }
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create new customer</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cc-slug">
                Slug <span className="text-fg-faint">*</span>
              </Label>
              <Input
                id="cc-slug"
                placeholder="acme-shop"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
                aria-required="true"
              />
              {slug.length > 0 && slugError ? (
                <p className="text-xs text-state-err">{slugError}</p>
              ) : (
                <p className="text-xs text-fg-faint">
                  Used internally; lowercase letters, numbers, hyphens.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cc-domain">
                Domain <span className="text-fg-faint">*</span>
              </Label>
              <Input
                id="cc-domain"
                placeholder="acme.example"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
                aria-required="true"
              />
              {domain.length > 0 && domainError ? (
                <p className="text-xs text-state-err">{domainError}</p>
              ) : (
                <p className="text-xs text-fg-faint">The customer&apos;s primary website.</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cc-contact-name">Contact name</Label>
              <Input
                id="cc-contact-name"
                placeholder="Jane Smith"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              {contactName.length > 0 && nameError ? (
                <p className="text-xs text-state-err">{nameError}</p>
              ) : (
                <p className="text-xs text-fg-faint">Optional. The name you use in emails.</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cc-contact-email">Contact email</Label>
              <Input
                id="cc-contact-email"
                type="email"
                placeholder="jane@example.com"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              {contactEmail.length > 0 && emailError ? (
                <p className="text-xs text-state-err">{emailError}</p>
              ) : (
                <p className="text-xs text-fg-faint">
                  Optional. We use it to coordinate onboarding with you.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cc-plan">Plan</Label>
              <Select value={plan} onValueChange={setPlan}>
                <SelectTrigger id="cc-plan">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pilot">pilot</SelectItem>
                  <SelectItem value="trial">trial</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {apiError && <p className="text-xs text-state-err">{apiError}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {submitting ? <Loader2 size={13} className="animate-spin" /> : null}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
