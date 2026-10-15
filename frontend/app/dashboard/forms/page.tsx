'use client';

// The old single-page Forms blob was split into features/forms/ + three
// routes (templates/fill/submissions) behind the sidebar's Forms dropdown.
// This redirect keeps any existing bookmark/link to /dashboard/forms working.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function FormsIndexRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/dashboard/forms/templates');
  }, [router]);
  return null;
}
