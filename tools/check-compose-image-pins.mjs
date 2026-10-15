import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const composeFiles = ['docker-compose.dev.yml', 'docker-compose.prod.yml'];
const mutableTags = new Set(['latest', 'main', 'master', 'edge', 'stable']);
const failures = [];

for (const file of composeFiles) {
  const content = readFileSync(resolve(file), 'utf8');
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*image:\s*([^\s#]+)(?:\s+#.*)?$/);
    if (!match) continue;

    const image = match[1].replace(/["']/g, '');
    const tag = image.includes('@') ? null : image.slice(image.lastIndexOf(':') + 1);
    if (!image.includes('@') && (!image.includes(':') || mutableTags.has(tag))) {
      failures.push(`${file}:${index + 1} has an unpinned image: ${image}`);
    }
  }
}

if (failures.length) {
  console.error('Compose image pinning check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Compose image pinning check passed for ${composeFiles.join(', ')}.`);
