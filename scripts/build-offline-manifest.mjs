import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Build-time inventory allows the service worker to precache lazy editor chunks,
// not only the JavaScript requested on the first online visit.
const root = path.resolve('.next/static');
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(full));
    else if (entry.isFile() && !entry.name.endsWith('.map')) result.push(`/_next/static/${path.relative(root, full).split(path.sep).join('/')}`);
  }
  return result;
}
await writeFile('public/offline-assets.json', JSON.stringify({ version: 1, assets: (await files(root)).sort() }));
