const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
// The .web build leaves bare ONNX imports for a bundler. Use the complete ESM
// browser bundle and ship its matching WASM runtime inside the extension.
const source = path.join(root, 'node_modules/@huggingface/transformers/dist/transformers.js');
const outputDirectory = path.join(root, 'vendor');
fs.mkdirSync(outputDirectory, { recursive: true });
fs.copyFileSync(source, path.join(outputDirectory, 'transformers.js'));
for (const filename of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  fs.copyFileSync(path.join(root, 'node_modules/onnxruntime-web/dist', filename), path.join(outputDirectory, filename));
}
fs.copyFileSync(path.join(root, 'node_modules/@huggingface/transformers/LICENSE'), path.join(outputDirectory, 'TRANSFORMERS-LICENSE.txt'));
console.log('Built local Transformers.js and ONNX WASM runtime in vendor/.');
