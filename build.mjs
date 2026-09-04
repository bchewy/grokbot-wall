// Inlines vendor scripts + referral codes into a single self-contained dist/index.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const noCodes = process.argv.includes('--no-codes');

let html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');

html = html.replace(/<script src="([^"]+)" data-inline><\/script>/g, (_, src) => {
  let js = fs.readFileSync(path.join(ROOT, 'src', src), 'utf8');
  js = js.replace(/^console\.warn\('Scripts "build\/three\.js"[^']*'\)/, 'void 0');
  js = js.replace(/<\/script/g, '<\\/script');
  return `<script>\n${js}\n</script>`;
});

const codesFile = fs.existsSync(path.join(ROOT, 'data/codes.json')) ? 'data/codes.json' : 'data/codes.example.json';
const codes = JSON.parse(fs.readFileSync(path.join(ROOT, codesFile), 'utf8'));
const embedded = noCodes ? { A: [], B: [], labels: codes.labels } : codes;
html = html.replace('/*@codes*/null', JSON.stringify(embedded));

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist/index.html'), html);
console.log(`built dist/index.html (${(html.length / 1024).toFixed(0)} KB)${noCodes ? ' without codes' : ''}`);
