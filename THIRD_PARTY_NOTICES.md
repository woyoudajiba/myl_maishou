# Third-Party Notices

- `vendor/transformers.js` is the complete ESM browser bundle from `@huggingface/transformers` 4.3.1, licensed under Apache-2.0; its license is included as `vendor/TRANSFORMERS-LICENSE.txt`. Rebuild packaged runtimes with `npm ci` and `npm run build:vision`.
- The bundle includes ONNX Runtime Web, and `vendor/ort-wasm-simd-threaded.asyncify.mjs` / `.wasm` come from the matching `onnxruntime-web` 1.31.0-dev.20260914-8d85527a0 dependency, licensed under MIT. Execution files are bundled locally.
- The optional local inference weights are `Marqo/marqo-fashionCLIP`, Apache-2.0, loaded from Hugging Face on first use. The extension downloads model assets only; inference runs locally in the browser.
- `taobao-search.js` adapts the Taobao image-search flow from [gggann/image_search_taobao](https://github.com/gggann/image_search_taobao). Its README declares the MIT license; the source does not include a separate license file. This notice preserves the declared grant and attribution for the adaptation.

## MIT license (gggann/image_search_taobao)

Copyright (c) gggann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## ONNX Runtime MIT license

Copyright (c) Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the Software), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED AS IS, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
