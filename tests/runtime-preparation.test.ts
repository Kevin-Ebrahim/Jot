import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
test('runtime preparation copies only expected versioned assets and fails on version drift', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jot-runtime-test-'));
  const put = async (name: string, content: string) => {
    const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content);
  };
  try {
    for (const [name, version] of [['tesseract.js', '6.0.1'], ['tesseract.js-core', '6.1.2'],
      ['@tesseract.js-data/eng', '1.0.0'], ['onnxruntime-web', '1.31.0-dev.20260914-8d85527a0']]) {
      await put(`node_modules/${name}/package.json`, JSON.stringify({ version }));
    }
    const files = [
      'tesseract.js/dist/worker.min.js', 'tesseract.js/dist/worker.min.js.LICENSE.txt', 'tesseract.js-core/LICENSE',
      ...['tesseract-core.wasm.js', 'tesseract-core-simd.wasm.js', 'tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'].map(name => `tesseract.js-core/${name}`),
      '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
      ...['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'].map(name => `onnxruntime-web/dist/${name}`),
    ];
    for (const file of files) await put(`node_modules/${file}`, `fixture:${file}`);
    await run(process.execPath, [path.resolve('scripts/prepare-runtime.mjs')], { cwd: root });
    const worker = await readFile(path.join(root, 'public/runtime/tesseract-6.0.1/worker.min.js'), 'utf8');
    assert.equal(worker, 'fixture:tesseract.js/dist/worker.min.js');
    assert.equal(await readFile(path.join(root, 'public/runtime/tesseract-6.0.1/lang-eng-1.0.0/eng.traineddata.gz'), 'utf8'), 'fixture:@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz');
    assert.match(await readFile(path.join(root, 'public/runtime/THIRD_PARTY_NOTICES.txt'), 'utf8'), /ONNX Runtime Web/);
    await put('node_modules/tesseract.js/package.json', JSON.stringify({ version: '9.0.0' }));
    await assert.rejects(run(process.execPath, [path.resolve('scripts/prepare-runtime.mjs')], { cwd: root }), /Expected tesseract\.js@6\.0\.1/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
