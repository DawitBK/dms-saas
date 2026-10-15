// shared/components/ui/MetricCard.tsx
import type { ReactNode } from 'react';
import Link from 'next/link';

interface MetricCardProps {
  label: string;
  value: string | number;
  icon?: ReactNode;
  toneClassName?: string;
  trend?: {
    value: string;
    direction: 'up' | 'down' | 'neutral';
  };
  href?: string;
}

export function MetricCard({ label, value, icon, toneClassName = '', trend, href }: MetricCardProps) {
  const content = (
    <>
      <div className="flex items-start justify-between mb-3">
        <p className="ui-metric-label uppercase tracking-wider">{label}</p>
        {icon && (
          <span
            className="flex items-center justify-center rounded-lg"
            style={{ color: 'var(--text-muted)', opacity: 0.5, width: 32, height: 32 }}
          >
            {icon}
          </span>
        )}
      </div>
      <div className="flex items-end justify-between gap-2">
        <span className="ui-metric-value">{value}</span>
        {trend && (
          <span
            className={
              trend.direction === 'up'
                ? 'ui-metric-delta-up'
                : trend.direction === 'down'
                ? 'ui-metric-delta-down'
                : 'text-text-muted text-xs font-semibold'
            }
            style={{ marginBottom: 2 }}
          >
            {trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : '→'} {trend.value}
          </span>
        )}
      </div>
    </>
  );

  if (href) {
    return (
      <Link href={href} className={`ui-metric ${toneClassName} block transition-shadow hover:shadow-md`}>
        {content}
      </Link>
    );
  }
  return <div className={`ui-metric ${toneClassName}`}>{content}</div>;
}
