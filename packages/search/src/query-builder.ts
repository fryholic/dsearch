import { DsearchError, type Locator } from '@dsearch/contracts';
type MarkdownLocator = ReturnType<typeof Locator.parse>;
import { sourcePoint, type SourceSpan } from '@dsearch/compiler';
export function selectionRange(text: string, locator: MarkdownLocator): SourceSpan {
  const lines = text.split('\n'), starts = [0];for (let i = 0; i < lines.length; i++) starts.push(starts[i]! + lines[i]!.length + 1);
  const offset = (p: MarkdownLocator['start']) => {
    if (p.line === lines.length + 1 && p.column_utf16 === 0) return text.length;
    if (p.line > lines.length || p.column_utf16 > lines[p.line - 1]!.length) throw new DsearchError('INVALID_LOCATOR');
    return starts[p.line - 1]! + p.column_utf16;
  };
  const range = { start: offset(locator.start), end: offset(locator.end) };
  if (range.end <= range.start) throw new DsearchError('INVALID_QUERY');return range;
}
const loc = (text: string, s: SourceSpan): MarkdownLocator => ({ kind: 'markdown', start: sourcePoint(text, s.start), end: sourcePoint(text, s.end) });
/** Source-only query: heading path, first definition, explicit formula/identifier blocks, then remaining text.
 * Fit against the real embedding tokenizer. Every omission remains inspectable; no generated summary. */
export async function relatedQuery(text: string, selected: SourceSpan, tokens?: (query: string) => Promise<number>) {
  const headings: SourceSpan[] = [];
  for (const m of text.slice(0, selected.start).matchAll(/^#{1,6}[^\n]+/gm)) {
    const depth = m[0].match(/^#+/)![0].length;
    while (headings.length && text.slice(headings.at(-1)!.start, headings.at(-1)!.end).match(/^#+/)![0].length >= depth) headings.pop();
    headings.push({ start: m.index, end: m.index + m[0].length });
  }
  const blocks = [...text.slice(selected.start, selected.end).matchAll(/\S[\s\S]*?(?=\n\s*\n|$)/g)].filter(m => m[0].trim()).map(m => ({ start: selected.start + m.index, end: selected.start + m.index + m[0].trimEnd().length }));
  const prioritized = [...headings, ...blocks.slice(0, 1), ...blocks.slice(1).filter(b => /`|\$|\\\[/.test(text.slice(b.start, b.end))), ...blocks.slice(1)];
  const used: SourceSpan[] = [];
  for (const span of prioritized) {
    if (used.some(s => s.start === span.start)) continue;
    let end = Math.min(span.end, span.start + (tokens ? 2048 : 512));
    if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    if (used.length < 32) used.push({ start: span.start, end });
  }
  const query = () => used.map(s => text.slice(s.start, s.end)).join(' ').replace(/\s+/g, ' ').trim();
  while (used.length && (Buffer.byteLength(query()) > (tokens ? 8192 : 512) || (tokens && await tokens(query()) > 512))) {
    const last = used.at(-1)!;
    if (last.end - last.start > 64) { last.end = last.start + Math.floor((last.end - last.start) / 2);if (/[\uD800-\uDBFF]/.test(text[last.end - 1]!)) last.end--; }
    else used.pop();
  }
  if (!query()) throw new DsearchError('INVALID_QUERY');
  const included = used.filter(s => s.end > selected.start && s.start < selected.end).map(s => ({ start: Math.max(selected.start, s.start), end: Math.min(selected.end, s.end) })).sort((a,b) => a.start - b.start);
  const omitted: SourceSpan[] = [];let cursor = selected.start;
  for (const s of included) { if (s.start > cursor) omitted.push({ start: cursor, end: s.start });cursor = Math.max(cursor, s.end); }
  if (cursor < selected.end) omitted.push({ start: cursor, end: selected.end });
  return { query: query(), used_spans: used.map(s => loc(text, s)), omitted_spans: omitted.map(s => loc(text, s)) };
}
