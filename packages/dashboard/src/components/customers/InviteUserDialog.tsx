"use client";

/**
 * InviteUserDialog — invite a customer user to their scoped dashboard view.
 *
 * POSTs /admin/customer-users/create { customer_id, email } and shows the
 * returned one-time setup_url. The raw setup token appears ONCE in that
 * response and is never stored server-side, so the dialog switches to a
 * copy-this-now state and warns that the link cannot be recovered.
 */

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
import { Check, Copy, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface InviteUserDialogProps {
  open: boolean;
  onClose: () => void;
  customers: CustomerListItem[];
}

interface InviteResponse {
  user_id: string;
  setup_url: string;
}

export function InviteUserDialog({ open, onClose, customers }: InviteUserDialogProps) {
  const [customerId, setCustomerId] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [setupUrl, setSetupUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setCustomerId("");
      setEmail("");
      setSubmitting(false);
      setApiError(null);
      setSetupUrl(null);
      setCopied(false);
    }
  }, [open]);

  const emailError =
    email.length === 0 ? null : !EMAIL_RE.test(email.trim()) ? "Not a valid email address" : null;

  const canSubmit = customerId !== "" && email.length > 0 && !emailError && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setApiError(null);
    try {
      const resp = await apiFetch<InviteResponse>("/admin/customer-users/create", {
        method: "POST",
        body: JSON.stringify({ customer_id: customerId, email: email.trim() }),
      });
      setSetupUrl(resp.setup_url);
    } catch (err) {
      setApiError(
        err instanceof ApiError && err.status === 409
          ? "A user with that email already exists."
          : "Couldn't create the invite. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function copyUrl() {
    if (!setupUrl) return;
    try {
      await navigator.clipboard.writeText(setupUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — the URL is selectable in the input below.
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
          <DialogTitle>Invite user</DialogTitle>
        </DialogHeader>

        {setupUrl ? (
          <div className="space-y-3">
            <p className="text-sm text-fg">
              Invite created. Send this setup link to the customer. They open it and choose their
              own password.
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={setupUrl} onFocus={(e) => e.currentTarget.select()} />
              <Button size="sm" variant="secondary" onClick={copyUrl}>
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-xs text-fg-muted">
              This link is shown once and expires; it cannot be recovered later. If it is lost,
              create a new invite.
            </p>
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="invite-customer">Customer</Label>
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger id="invite-customer">
                  <SelectValue placeholder="Choose a customer" />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.slug} · {c.domain}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="invite-email">Their email</Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {emailError && <p className="text-xs text-state-err">{emailError}</p>}
            </div>

            <p className="text-xs text-fg-muted">
              They see this customer&rsquo;s Overview, Visitors, Versions, Test and Settings. Admin
              screens stay hidden.
            </p>

            {apiError && <p className="text-sm text-state-err">{apiError}</p>}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {submitting && <Loader2 size={13} className="animate-spin" />}
                Create invite
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
