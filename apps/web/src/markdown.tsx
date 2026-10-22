import { useMemo, type ReactNode } from 'react';
import { unified } from 'unified';
import parse from 'remark-parse';
import gfm from 'remark-gfm';
import math from 'remark-math';
import frontmatter from 'remark-frontmatter';
import { renderToString } from 'katex';
type Node = {
    type: string;
    value?: string;
    url?: string;
    alt?: string;
    depth?: number;
    ordered?: boolean;
    start?: number | null;
    children?: Node[];
};
const processor = unified().use(parse).use(gfm).use(math).use(frontmatter, ['yaml']);
const safeURL = (value: string) => { try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
}
catch {
    return null;
} };
/** Render an allowlist of AST nodes as React text. HTML, images, embeds and unsafe URLs never execute. */
function nodes(items: Node[] = [], budget = { formulas: 0 }): ReactNode[] {
    return items.map((node, key) => {
        const children = nodes(node.children, budget);
        switch (node.type) {
            case 'text': return node.value;
            case 'paragraph': return <p key={key}>{children}</p>;
            case 'heading': {
                const Tag = ([null, 'h2', 'h3', 'h4', 'h5', 'h6', 'h6'] as const)[node.depth ?? 2] ?? 'h3';
                return <Tag key={key}>{children}</Tag>;
            }
            case 'emphasis': return <em key={key}>{children}</em>;
            case 'strong': return <strong key={key}>{children}</strong>;
            case 'delete': return <del key={key}>{children}</del>;
            case 'inlineCode': return <code key={key}>{node.value}</code>;
            case 'inlineMath':
            case 'math': {
                if (++budget.formulas > 32 || (node.value?.length ?? 0) > 8000) return <code key={key} className="formula">{node.value}</code>;
                try { const markup = renderToString(node.value ?? '', { output: 'mathml', displayMode: node.type === 'math', trust: false, throwOnError: true, strict: 'ignore', maxExpand: 128, maxSize: 10, macros: Object.create(null) });
                    return <span key={key} className={node.type === 'math' ? 'formula math-display' : 'math-inline'} dangerouslySetInnerHTML={{ __html: markup }}/>;
                } catch { return <code key={key} className="formula">{node.value}</code>; }
            }
            case 'code':
            case 'yaml':
            case 'html': return <pre key={key}><code>{node.value}</code></pre>;
            case 'blockquote': return <blockquote key={key}>{children}</blockquote>;
            case 'list': return node.ordered ? <ol key={key} start={node.start ?? 1}>{children}</ol> : <ul key={key}>{children}</ul>;
            case 'listItem': return <li key={key}>{children}</li>;
            case 'link': {
                const href = safeURL(node.url ?? '');
                return href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a> : <span key={key}>{children}</span>;
            }
            case 'image': return <span key={key}>[이미지: {node.alt ?? ''}]</span>;
            case 'break': return <br key={key}/>;
            case 'thematicBreak': return <hr key={key}/>;
            case 'table': return <div key={key} className="table-scroll"><table><tbody>{children}</tbody></table></div>;
            case 'tableRow': return <tr key={key}>{children}</tr>;
            case 'tableCell': return <td key={key}>{children}</td>;
            default: return <span key={key}>{node.value ?? children}</span>;
        }
    });
}
export function Markdown({ text }: {
    text: string;
}) { const tree = useMemo(() => processor.parse(text) as Node, [text]); return <div className="markdown">{nodes(tree.children)}</div>; }
