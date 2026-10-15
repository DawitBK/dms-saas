// Rasterizes the real letterhead artwork (assets/letterheads/
// examplecorp-group-letterhead.pdf) to a PNG the frontend can display directly
// (frontend/public/letterhead/) instead of a hand-drawn recreation of it —
// FillFormModal.tsx's letterhead preview crops this same file via CSS
// aspect-ratio + background-position.
//
// Re-run this (from backend/, `node scripts/rasterize-letterhead.mjs`)
// whenever the source PDF artwork changes; the PNG is a checked-in static
// asset, not generated at build time.
//
// Needs `canvas` (node-canvas, native) as pdfjs-dist's Node rendering target.
// Not a direct backend dependency — resolved via npm workspace hoisting from
// whatever else in this monorepo pulls it in transitively. If this script
// ever fails with a canvas resolution error, add `canvas` as an explicit
// backend devDependency.
import path from 'node:path';
import fs from 'node:fs';
import { createCanvas } from 'canvas';

const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

const srcPath = path.resolve(process.cwd(), 'assets/letterheads/examplecorp-group-letterhead.pdf');
const outPath = path.resolve(process.cwd(), '../frontend/public/letterhead/examplecorp-group-letterhead.png');

const data = new Uint8Array(fs.readFileSync(srcPath));
const doc = await pdfjsLib.getDocument({ data }).promise;
const page = await doc.getPage(1);

// Render at 3x the PDF's native 72dpi (~216dpi) — crisp enough for a header/
// footer crop shown at typical modal widths without shipping an oversized file.
const viewport = page.getViewport({ scale: 3 });
const canvas = createCanvas(viewport.width, viewport.height);
const ctx = canvas.getContext('2d');

await page.render({ canvasContext: ctx, viewport, canvas }).promise;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
console.log('Wrote', outPath, canvas.width, 'x', canvas.height);
