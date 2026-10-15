// One-off script: generates public/icons/* from an inline SVG (no source logo
// exists for DMS yet). Run manually (`node scripts/generate-pwa-icons.mjs`);
// not wired into npm run build/CI. Requires sharp — install for the one-off
// run only (`npm install --no-save sharp`), don't persist it in package.json.
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const iconsDir = path.join(publicDir, "icons");

const BRAND = "#6366f1";
const INITIALS = "DMS";

function iconSvg(size, { rounded }) {
  const radius = rounded ? Math.round(size * 0.18) : 0;
  const fontSize = Math.round(size * 0.34);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" rx="${radius}" fill="${BRAND}"/>
    <text x="50%" y="54%" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${INITIALS}</text>
  </svg>`;
}

async function makeIcon(size, outPath) {
  await sharp(Buffer.from(iconSvg(size, { rounded: true }))).png().toFile(outPath);
}

async function makeMaskable(size, outPath) {
  // Maskable icons get clipped to arbitrary shapes by the OS — keep content
  // within the ~80% safe zone and fill the full canvas so nothing is cut to
  // transparent.
  const safeSize = Math.round(size * 0.7);
  const fontSize = Math.round(safeSize * 0.4);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" fill="${BRAND}"/>
    <text x="50%" y="54%" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${INITIALS}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

async function makeAppleTouchIcon(outPath) {
  const size = 180;
  await sharp(Buffer.from(iconSvg(size, { rounded: true })))
    .flatten({ background: BRAND })
    .png()
    .toFile(outPath);
}

async function main() {
  fs.mkdirSync(iconsDir, { recursive: true });

  await makeIcon(192, path.join(iconsDir, "icon-192.png"));
  await makeIcon(512, path.join(iconsDir, "icon-512.png"));
  await makeMaskable(192, path.join(iconsDir, "icon-maskable-192.png"));
  await makeMaskable(512, path.join(iconsDir, "icon-maskable-512.png"));
  await makeAppleTouchIcon(path.join(iconsDir, "apple-touch-icon.png"));
  await makeIcon(32, path.join(iconsDir, "favicon.png"));

  console.log("Generated PWA icons in", iconsDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
