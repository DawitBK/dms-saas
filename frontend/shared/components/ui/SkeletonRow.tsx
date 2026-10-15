// shared/components/ui/SkeletonRow.tsx

interface SkeletonRowProps {
  cols?: number;
  className?: string;
}

export function SkeletonRow({ cols = 4, className = '' }: SkeletonRowProps) {
  return (
    <tr className={`border-b border-border ${className}`}>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <div
            className="ui-skeleton h-4"
            style={{ width: i === 0 ? '60%' : i === cols - 1 ? '40%' : '80%' }}
          />
        </td>
      ))}
    </tr>
  );
}

interface SkeletonCardProps {
  lines?: number;
  className?: string;
}

export function SkeletonCard({ lines = 3, className = '' }: SkeletonCardProps) {
  return (
    <div className={`ui-card space-y-3 ${className}`}>
      <div className="ui-skeleton h-5 w-1/3" />
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className={`ui-skeleton h-4 ${i === lines - 1 ? 'w-2/3' : 'w-full'}`} />
      ))}
    </div>
  );
}
