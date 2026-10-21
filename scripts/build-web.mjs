import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),out=resolve(root,'apps/web/dist-web');
await mkdir(out,{recursive:true});
await build({entryPoints:[resolve(root,'apps/web/src/main.tsx')],outfile:resolve(out,'app.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',jsx:'automatic',minify:true,sourcemap:true});
await writeFile(resolve(out,'index.html'),'<!doctype html><html lang="ko" data-theme="light" data-appearance="sage"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dsearch</title><link rel="stylesheet" href="app.css"><script type="module" src="app.js"></script></head><body><div id="root"></div></body></html>\n');
console.log('React entry built; product routes remain scheduled for P2/P3.');
