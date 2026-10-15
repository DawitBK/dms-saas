import { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/shared/lib/cn';

const COLOR_STYLES: Record<string, string> = {
  brand: 'bg-brand-100 text-brand-700',
  success: 'bg-emerald-100 text-emerald-700',
  warning: 'bg-amber-100 text-amber-700',
  danger: 'bg-red-100 text-red-700',
  info: 'bg-blue-100 text-blue-700',
};

interface StatCardProps {
  label: string;
  value: string | number;
  delta?: number;
  deltaLabel?: string;
  icon: LucideIcon;
  color?: keyof typeof COLOR_STYLES;
  sparkline?: number[];
  hint?: string;
  href?: string;
}

export const StatCard = ({
  label,
  value,
  delta,
  deltaLabel,
  icon: Icon,
  color = 'brand',
  sparkline,
  hint,
  href,
}: StatCardProps) => {
  const Wrapper = href ? Link : 'div';
  const wrapperProps = href ? { href } : {};
  return (
    <Wrapper
      {...(wrapperProps as any)}
      className={cn(
        'bg-surface-card border border-border rounded-xl p-6 shadow-sm block',
        href && 'transition-shadow hover:shadow-md',
      )}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-text-secondary mb-1">{label}</p>
          <p className="text-3xl font-bold text-text-primary">{value}</p>
          {delta !== undefined && (
            <p
              className={cn(
                'text-sm mt-2',
                delta >= 0 ? 'text-emerald-600' : 'text-red-600',
              )}
            >
              {delta >= 0 ? '+' : ''}
              {delta}% {deltaLabel || 'vs last period'}
            </p>
          )}
          {hint && <p className="text-xs text-text-muted mt-1">{hint}</p>}
        </div>
        <div className={cn('p-3 rounded-lg', COLOR_STYLES[color])}>
          <Icon className="h-6 w-6" />
        </div>
      </div>
    </Wrapper>
  );
};
