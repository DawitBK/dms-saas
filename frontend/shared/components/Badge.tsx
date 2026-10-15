import { cn } from "@/shared/lib/cn";

const STATUS_STYLES: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-600 border-slate-200',
  IN_REVIEW: 'bg-amber-50 text-amber-700 border-amber-200',
  ACTIVE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  PUBLISHED: 'bg-brand-50 text-brand-700 border-brand-200',
  ARCHIVED: 'bg-slate-50 text-slate-500 border-slate-100',
  PURGED: 'bg-red-50 text-red-600 border-red-200',
  // Security
  PUBLIC: 'bg-emerald-50 text-emerald-700',
  INTERNAL: 'bg-blue-50 text-blue-700',
  CONFIDENTIAL: 'bg-amber-50 text-amber-700',
  RESTRICTED: 'bg-red-50 text-red-700',
};

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  type?: keyof typeof STATUS_STYLES;
}

export const Badge = ({ type = 'DRAFT', className, ...props }: BadgeProps) => {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
        STATUS_STYLES[type] || STATUS_STYLES.DRAFT,
        className
      )}
      {...props}
    />
  );
};
