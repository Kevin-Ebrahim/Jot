import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Precache the public app shell, including ordinary lazy editor chunks, but not
// the optional speech model's large WASM/runtime. The service worker may cache
// those same-origin files later, only after the user starts transcription.
const root = path.resolve('.next/static');
let shell = null;
try { shell = await readFile('.next/server/app/index.html', 'utf8'); } catch { /* keep JS chunks if shell dependencies cannot be determined */ }
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { result.push(...await files(full)); continue; }
    if (!entry.isFile() || entry.name.endsWith('.map')) continue;
    const relative = path.relative(root, full).split(path.sep).join('/');
    const url = `/_next/static/${relative}`;
    if (/^media\/(?:ort-wasm-|ort\.webgpu|transcription-worker\.)/i.test(relative)) continue;
    if (shell !== null && relative.startsWith('chunks/') && relative.endsWith('.js') && !shell.includes(relative)) {
      const text = await readFile(full, 'utf8');
      if (text.includes('Xenova/whisper-tiny.en')) continue;
    }
    result.push(url);
  }
  return result;
}
await writeFile('public/offline-assets.json', JSON.stringify({ version: 1, assets: (await files(root)).sort() }));
