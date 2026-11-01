import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
test('offline shell excludes opt-in speech runtime and lazy worker chunks', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'jot-manifest-test-'));
  try {
    await mkdir(path.join(directory, '.next/static/chunks'), { recursive: true });
    await mkdir(path.join(directory, '.next/static/media'), { recursive: true });
    await mkdir(path.join(directory, '.next/server/app'), { recursive: true });
    await mkdir(path.join(directory, 'public'), { recursive: true });
    await writeFile(path.join(directory, '.next/server/app/index.html'), '<script src="/_next/static/chunks/shell.js"></script>');
    await writeFile(path.join(directory, '.next/static/chunks/shell.js'), 'shell');
    await writeFile(path.join(directory, '.next/static/chunks/worker.js'), 'Xenova/whisper-tiny.en');
    await writeFile(path.join(directory, '.next/static/media/ort-wasm-big.wasm'), 'large');
    await writeFile(path.join(directory, '.next/static/media/ort.webgpu.bundle.mjs'), 'runtime');
    await writeFile(path.join(directory, '.next/static/media/pdf.worker.mjs'), 'pdf');
    await run(process.execPath, [path.resolve('scripts/build-offline-manifest.mjs')], { cwd: directory });
    const manifest = JSON.parse(await readFile(path.join(directory, 'public/offline-assets.json'), 'utf8')) as { assets: string[] };
    assert.ok(manifest.assets.includes('/_next/static/chunks/shell.js'));
    assert.ok(manifest.assets.includes('/_next/static/media/pdf.worker.mjs'));
    assert.equal(manifest.assets.some(item => /worker\.js$|ort-wasm|ort\.webgpu/.test(item)), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
