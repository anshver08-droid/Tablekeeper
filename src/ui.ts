import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

let cachedHtml: string | null = null;

export async function getUiHtml(): Promise<string> {
  if (cachedHtml) return cachedHtml;
  const path = fileURLToPath(new URL('./ui.html', import.meta.url));
  cachedHtml = await readFile(path, 'utf8');
  return cachedHtml;
}

export const recentDevOtps: Array<{ email: string; code: string; timestamp: string }> = [];

export function recordDevOtp(email: string, code: string): void {
  recentDevOtps.push({ email, code, timestamp: new Date().toISOString() });
  if (recentDevOtps.length > 50) recentDevOtps.shift();
}
