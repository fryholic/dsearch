import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {Markdown} from '../../apps/web/dist/markdown.js';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),{createElement}=require('react'),{renderToStaticMarkup}=require('react-dom/server');
test('source Markdown is rendered through an explicit allowlist without executing HTML, images or unsafe URLs',()=>{
 const input='# Heading\n\n<script>alert(1)</script>\n\n![private](https://invalid.example/pixel)\n\n[bad](javascript:alert(1)) [good](https://example.com)\n\n$$\na+b\n$$\n\n```js\n<script>\n```\n\n| A | B |\n|---|---|\n| one | two |';
 const html=renderToStaticMarkup(createElement(Markdown,{text:input}));assert.ok(html.includes('<h2>Heading</h2>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!/<script|<img|<iframe|href="javascript:/i.test(html));assert.ok(html.includes('rel="noopener noreferrer"'));assert.ok(html.includes('referrerPolicy="no-referrer"'));assert.ok(html.includes('<math '));assert.ok(html.includes('class="formula math-display"'));assert.ok(html.includes('<table>'));
});

test('mathematical source renders as bounded MathML without trusted HTML, URL or macro side effects',()=>{
 const render=text=>renderToStaticMarkup(createElement(Markdown,{text}));
 const fraction=render('$$\\frac{a+b}{c}\\quad \\text{공개키}$$');assert.ok(fraction.includes('<mfrac>'));assert.ok(fraction.includes('공개키'));
 for(const formula of ['\\href{javascript:alert(1)}{click}','\\includegraphics{https://invalid.example/pixel}','\\htmlClass{unsafe}{x}','\\def\\a{\\a}\\a']){const html=render('$$'+formula+'$$');assert.ok(!/<img|<script|<iframe|href="javascript:|class="unsafe"/i.test(html));}
 const many=render(Array.from({length:40},()=>'$x$').join(' '));assert.ok((many.match(/<math /g)??[]).length<=32);assert.ok(many.includes('<code class="formula">'));
});
