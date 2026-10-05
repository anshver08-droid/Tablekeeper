import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Ensure dist/src exists
mkdirSync(resolve(root, 'dist/src'), { recursive: true });

// Copy ui.html to dist/src/
if (existsSync(resolve(root, 'src/ui.html'))) {
  cpSync(resolve(root, 'src/ui.html'), resolve(root, 'dist/src/ui.html'));
  console.log('✅ Copied src/ui.html -> dist/src/ui.html');
}

// Copy migrations/ to dist/migrations/
if (existsSync(resolve(root, 'migrations'))) {
  cpSync(resolve(root, 'migrations'), resolve(root, 'dist/migrations'), { recursive: true });
  console.log('✅ Copied migrations/ -> dist/migrations/');
}
