// Turbopack's resolveAlias needs a real module to point `canvas` at (unlike
// webpack's `canvas: false`) — see next.config.ts. pdfjs-dist (via react-pdf)
// only touches `canvas` on its optional Node.js rendering path; the browser
// bundle never calls into it, so an empty module is a safe stand-in.
export {};
