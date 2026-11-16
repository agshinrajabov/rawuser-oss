import { Skeleton } from "@/components/ui/Skeleton";
import type { PortfolioItem } from "@/types/api";
import Link from "next/link";
import { PortfolioCard } from "./PortfolioCard";

interface PortfolioGridProps {
  items: PortfolioItem[];
  loading: boolean;
}

function SkeletonCard() {
  return (
    <div className="bg-surface border border-border rounded-md">
      <div className="p-4 border-b border-border flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-36" />
        </div>
        <Skeleton className="h-5 w-16 rounded-pill" />
      </div>
      <div className="p-4">
        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col gap-1">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-10" />
          </div>
          <div className="flex flex-col gap-1">
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-3 w-14" />
          </div>
          <div className="flex flex-col gap-1">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-8" />
          </div>
        </div>
      </div>
      <div className="px-4 py-3 border-t border-border flex justify-start">
        <Skeleton className="h-7 w-36 rounded-sm" />
      </div>
    </div>
  );
}

export function PortfolioGrid({ items, loading }: PortfolioGridProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 border border-border rounded-sm text-center">
        <p className="text-sm text-fg-muted mb-1">No pilots active.</p>
        <p className="text-xs text-fg-faint">
          Use{" "}
          <Link href="/customers" className="underline underline-offset-2 hover:text-fg">
            /customers
          </Link>{" "}
          to onboard your first pilot.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
      {items.map((item) => (
        <PortfolioCard key={item.customer_id} item={item} />
      ))}
    </div>
  );
}
