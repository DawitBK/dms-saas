// shared/components/ui/PaginationControls.tsx
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface PaginationControlsProps {
  page: number;
  onPageChange: (page: number) => void;
  hasPrevious: boolean;
  hasNext: boolean;
  totalPages?: number;
  isLoading?: boolean;
}

export function PaginationControls({
  page,
  onPageChange,
  hasPrevious,
  hasNext,
  totalPages,
  isLoading = false,
}: PaginationControlsProps) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 px-1">
      <button
        onClick={() => onPageChange(page - 1)}
        disabled={!hasPrevious || isLoading}
        aria-label="Previous page"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm font-medium text-text-secondary hover:text-text-primary hover:border-brand-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
      >
        <ChevronLeft className="h-4 w-4" />
        Previous
      </button>

      <span className="text-sm text-text-muted" aria-current="page">
        {totalPages != null ? `Page ${page} of ${totalPages}` : `Page ${page}`}
      </span>

      <button
        onClick={() => onPageChange(page + 1)}
        disabled={!hasNext || isLoading}
        aria-label="Next page"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm font-medium text-text-secondary hover:text-text-primary hover:border-brand-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
      >
        Next
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
