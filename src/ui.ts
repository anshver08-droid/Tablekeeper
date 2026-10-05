import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedHtml: string | null = null;

export async function getUiHtml(): Promise<string> {
  if (cachedHtml) return cachedHtml;
  const cwdPath = join(process.cwd(), 'src', 'ui.html');
  const directPath = fileURLToPath(new URL('./ui.html', import.meta.url));
  const fallbackPath = fileURLToPath(new URL('../../src/ui.html', import.meta.url));
  const path = existsSync(cwdPath) ? cwdPath : existsSync(directPath) ? directPath : fallbackPath;
  cachedHtml = await readFile(path, 'utf8');
  return cachedHtml;
}

export const recentDevOtps: Array<{ email: string; code: string; timestamp: string }> = [];

export function recordDevOtp(email: string, code: string): void {
  recentDevOtps.push({ email, code, timestamp: new Date().toISOString() });
  if (recentDevOtps.length > 50) recentDevOtps.shift();
}
