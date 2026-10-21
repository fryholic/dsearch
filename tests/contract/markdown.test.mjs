import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {Markdown} from '../../apps/web/dist/markdown.js';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),{createElement}=require('react'),{renderToStaticMarkup}=require('react-dom/server');
test('source Markdown is rendered through an explicit allowlist without executing HTML, images or unsafe URLs',()=>{
 const input='# Heading\n\n<script>alert(1)</script>\n\n![private](https://invalid.example/pixel)\n\n[bad](javascript:alert(1)) [good](https://example.com)\n\n$$\na+b\n$$\n\n```js\n<script>\n```\n\n| A | B |\n|---|---|\n| one | two |';
 const html=renderToStaticMarkup(createElement(Markdown,{text:input}));assert.ok(html.includes('<h2>Heading</h2>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!/<script|<img|<iframe|href="javascript:/i.test(html));assert.ok(html.includes('rel="noopener noreferrer"'));assert.ok(html.includes('referrerPolicy="no-referrer"'));assert.ok(html.includes('class="formula"'));assert.ok(html.includes('<table>'));
});
