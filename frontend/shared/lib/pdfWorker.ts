'use client';

// Single source of truth for react-pdf's worker setup, loaded eagerly (at
// dynamic-import-factory time, not inside a useEffect) by every PDF preview
// component.
//
// FIX (2026-09-22): two components each set `pdfjs.GlobalWorkerOptions.
// workerSrc` independently inside their own `useEffect(() => { import(
// 'react-pdf').then(...) }, [])` — a *parent* effect racing an async import.
// react-pdf's own <Document> is mounted as a CHILD of that same component and
// calls `pdfjs.getDocument()` synchronously from its own mount effect
// (react-pdf's Document.js), and React fires child effects before parent
// effects. On the very first PDF preview in a session (before any earlier
// mount had already set the global), `getDocument()` could fire while
// `workerSrc` was still unset, sending pdf.js down a slower worker-init path
// during which `WorkerTransport.messageHandler` is briefly null — if a
// `Page`'s `getPage()` call landed in that window, pdf.js threw
// `TypeError: Cannot read properties of null (reading 'sendWithPromise')`.
// Reproduced live 2026-09-21/22 on a fresh page load's first document
// preview. Setting `workerSrc` inside the `dynamic()` factory itself (which
// React/Next resolves BEFORE the lazy component is ever mounted, not after)
// closes the race instead of narrowing it.
export const pdfDocumentImport = () =>
  import('react-pdf').then((m) => {
    m.pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
    return m.Document;
  });

export const pdfPageImport = () => import('react-pdf').then((m) => m.Page);
