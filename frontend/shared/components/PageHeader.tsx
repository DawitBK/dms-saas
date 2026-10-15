import Link from 'next/link';

interface Breadcrumb {
  label: string;
  href?: string;
}

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  breadcrumbs?: Breadcrumb[];
}

export const PageHeader = ({
  title,
  subtitle,
  actions,
  breadcrumbs
}: PageHeaderProps) => {
  return (
    <div className="mb-6">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav className="mb-2" aria-label="Breadcrumb">
          <ol className="flex items-center space-x-2">
            {breadcrumbs.map((crumb, index) => (
              <li key={index} className="flex items-center">
                {index > 0 && (
                  <span className="mx-2 text-text-muted">/</span>
                )}
                {crumb.href ? (
                  <Link
                    href={crumb.href}
                    className="text-sm font-medium text-text-secondary hover:text-brand-600"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="text-sm font-medium text-text-primary">
                    {crumb.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="h-8 w-1 bg-brand-600 rounded-full" />
            <h1 className="text-2xl font-bold text-text-primary">{title}</h1>
          </div>
          {subtitle && (
            <p className="mt-1 text-text-secondary ml-4">{subtitle}</p>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-3">{actions}</div>
        )}
      </div>
    </div>
  );
};
