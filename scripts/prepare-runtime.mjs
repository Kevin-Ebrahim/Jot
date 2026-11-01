import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// These outputs are generated from lockfile-pinned npm packages, not vendored.
// Versioned paths let existing tabs continue using their old runtime after upgrades.
const packages = [
  ['tesseract.js', '6.0.1'],
  ['tesseract.js-core', '6.1.2'],
  ['@tesseract.js-data/eng', '1.0.0'],
  ['onnxruntime-web', '1.31.0-dev.20260914-8d85527a0'],
];
for (const [name, expected] of packages) {
  const manifest = JSON.parse(await readFile(path.join('node_modules', name, 'package.json'), 'utf8'));
  if (manifest.version !== expected) throw new Error(`Expected ${name}@${expected}, found ${manifest.version}; update runtime paths deliberately.`);
}
const assets = [
  ['tesseract.js/dist/worker.min.js', 'tesseract-6.0.1/worker.min.js'],
  ...['tesseract-core.wasm.js', 'tesseract-core-simd.wasm.js', 'tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js']
    .map(name => [`tesseract.js-core/${name}`, `tesseract-6.0.1/core-6.1.2/${name}`]),
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'tesseract-6.0.1/lang-eng-1.0.0/eng.traineddata.gz'],
  ...['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']
    .map(name => [`onnxruntime-web/dist/${name}`, `onnx-1.31.0-dev.20260914-8d85527a0/${name}`]),
];
// Fail before writing any outputs when a required package asset is absent.
await Promise.all(assets.map(([source]) => access(path.join('node_modules', source))));
for (const [source, target] of assets) {
  const destination = path.join('public/runtime', target);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await copyFile(path.join('node_modules', source), temporary);
  await rename(temporary, destination);
}
const [apache, workerNotices] = await Promise.all([
  readFile('node_modules/tesseract.js-core/LICENSE', 'utf8'),
  readFile('node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt', 'utf8'),
]);
const onnxMit = `MIT License\n\nCopyright (c) Microsoft Corporation\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`;
await writeFile('public/runtime/THIRD_PARTY_NOTICES.txt',
  `Tesseract.js, Tesseract.js-core, and upstream English trained data (Apache-2.0)\n${apache}\n\nThe @tesseract.js-data/eng@1.0.0 npm package declares MIT in its metadata; its metadata lists Balearica as author and jeromewu as a contributor. Its traineddata is derived from tessdata_best, licensed Apache-2.0 above.\n\nTesseract.js worker bundled dependency notices\n${workerNotices}\n\nONNX Runtime Web (MIT)\n${onnxMit}`);
console.log(`Prepared ${assets.length} versioned same-origin runtime assets.`);
