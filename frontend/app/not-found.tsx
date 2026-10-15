// app/not-found.tsx — shown for any unmatched route (typo'd URL, a stale
// bookmark, a link to something since removed). Previously absent, so this
// case fell through to Next's generic unbranded 404 boilerplate — the one
// page in the app with zero DMS chrome, no way back in, and no indication
// whether the problem was a bad link or something actually broken.
import { FileQuestion, Home } from 'lucide-react';
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <div
          className="mx-auto flex items-center justify-center rounded-full"
          style={{ width: 56, height: 56, background: 'var(--surface-raised)', border: '1px solid var(--border)' }}
        >
          <FileQuestion className="h-6 w-6" style={{ color: 'var(--text-muted)' }} />
        </div>
        <h1 className="mt-4 text-lg font-bold text-text-primary">Page not found</h1>
        <p className="mt-2 text-sm text-text-muted">
          The page you&apos;re looking for doesn&apos;t exist, or may have been moved.
        </p>
        <div className="mt-6">
          <Link href="/dashboard" className="ui-btn ui-btn-primary">
            <Home className="h-3.5 w-3.5" />
            Go to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
