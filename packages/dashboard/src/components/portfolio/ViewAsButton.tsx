"use client";

import { Button } from "@/components/ui/Button";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";

interface ViewAsButtonProps {
  customerId: string;
}

/**
 * Navigates to /analytics?as_customer=<id>.
 * AppShell detects the `as_customer` param and renders the
 * "Viewing as <slug> — exit" banner. No re-implementation here.
 */
export function ViewAsButton({ customerId }: ViewAsButtonProps) {
  const router = useRouter();

  function handleClick() {
    router.push(`/analytics?as_customer=${encodeURIComponent(customerId)}`);
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={handleClick}
      aria-label={`View analytics as ${customerId}`}
    >
      View as customer
      <ArrowRight size={12} />
    </Button>
  );
}
