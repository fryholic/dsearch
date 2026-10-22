import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkFrontmatter from 'remark-frontmatter';
import type { SourceSpan } from './production.js';

type Heading = { type: string; depth?: number; position?: { start: { offset: number }; end: { offset: number } } };
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkFrontmatter, ['yaml']);

/** Real Markdown ancestry only: fenced code, YAML and quoted headings are not section parents. */
export function sourceHeadingPath(text: string, before: number): SourceSpan[] {
  const path: (SourceSpan & { depth: number })[] = [];
  for (const node of (parser.parse(text).children as Heading[])) {
    if (node.type !== 'heading' || !node.position || node.position.end.offset > before) continue;
    const depth = node.depth!;
    while (path.length && path.at(-1)!.depth >= depth) path.pop();
    path.push({ start: node.position.start.offset, end: node.position.end.offset, depth });
  }
  return path.map(({ start, end }) => ({ start, end }));
}
