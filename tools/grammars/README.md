# tools/grammars

Prebuilt tree-sitter grammars aislop loads at runtime. They are published with the
package (see the `files` entry in `package.json`) and resolved from the package
root, so a global install finds them without a download step.

## tree-sitter-c_sharp.wasm

The C# grammar used by the C# arm of `ai-slop/test-wall-clock-assertion`, which
has to know whether an `.Elapsed*` receiver is a `Stopwatch` before it can call
the read a clock read.

- Source: the `tree-sitter-c_sharp.wasm` shipped at the root of the npm package
  `tree-sitter-c-sharp@0.23.5`.
- SHA-256: `6f69e1cae44e1c32c1eccc170dc5a9778fb94ff716f71113fe1f8c4299aa2f40`
- Loaded through `web-tree-sitter`, which is listed in `deps.neverBundle` in
  `tsdown.config.ts` so its own runtime `.wasm` stays resolvable next to the
  package rather than being inlined into `dist/`.

To refresh it, download the same file from a newer release of that package,
confirm `web-tree-sitter` still loads it (the grammar's `dylink.0` section must
match the runtime's ABI), and update the checksum above.

## License

The compiled `tree-sitter-c_sharp.wasm` grammar is vendored from upstream
`tree-sitter-c-sharp` under the MIT License:

```
The MIT License (MIT)

Copyright (c) 2014-2023 Max Brunsfeld, Damien Guard, Amaan Qureshi, and contributors.

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
```
