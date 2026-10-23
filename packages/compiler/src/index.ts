export { normalizeMetadata, type SearchMetadata } from "./metadata.js";
import { createHash } from "node:crypto";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
export { compileDocument, validateSourceMap, primaryIntersections, type CompiledDocument, type Passage, type MapSegment, type ProjectionCheck, type ProjectionInspector, type SourceSpan, type CoverageBlock } from "./production.js";
export { sourceHeadingPath } from './headings.js';

type Node = { type: string; depth?: number; children?: Node[]; value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } } };
export type ProbeProjection = {
  text: string; title: string; heading: string[]; lexicalOnly: boolean;
  sourceStart: number; sourceEnd: number; projectionStart: number; projectionEnd: number;
};
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const textOf = (node: Node): string => node.value ?? node.children?.map(textOf).join("") ?? "";
export function normalizeSource(bytes: Uint8Array): { text: string; rawSha256: string; textSha256: string } {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  return { text, rawSha256: hash(bytes), textSha256: hash(text) };
}
/** Source-boundary compatibility compiler. Production indexing uses compileDocument. */
export function compileProbeDocument(text: string, title: string): ProbeProjection[] {
  const children = (parser.parse(text) as Node).children ?? [];
  const projections: ProbeProjection[] = [];
  let heading: string[] = [], section: Node[] = [];
  const emitSection = () => {
    if (!section.length) return;
    const units: { start: number; end: number }[] = [];
    for (let i = 0; i < section.length; i++) {
      const node = section[i]!;
      let start = node.position!.start.offset!, end = node.position!.end.offset!;
      if (["math", "table", "code"].includes(node.type)) {
        if (section[i - 1]?.type === "paragraph" && units.length) start = units.pop()!.start;
        if (section[i + 1]?.type === "paragraph") end = section[++i]!.position!.end.offset!;
      }
      units.push({ start, end });
    }
    const prefix = "# " + title + (heading.length ? " / " + heading.join(" / ") : "") + "\n\n";
    const emit = (start: number, end: number) => {
      const projection = prefix + text.slice(start, end);
      projections.push({ text: projection, title, heading: [...heading], lexicalOnly: projection.length > 2400,
        sourceStart: start, sourceEnd: end, projectionStart: prefix.length, projectionEnd: projection.length });
    };
    let packed: { start: number; end: number } | undefined;
    for (const unit of units) {
      if (packed && prefix.length + unit.end - packed.start > 2400) { emit(packed.start, packed.end); packed = undefined; }
      if (!packed) packed = { ...unit }; else packed.end = unit.end;
    }
    if (packed) emit(packed.start, packed.end);
    section = [];
  };
  for (const node of children) {
    if (node.type === "heading") {
      emitSection(); heading = heading.slice(0, (node.depth ?? 1) - 1); heading.push(textOf(node));
    }
    section.push(node);
  }
  emitSection();
  return projections;
}
/** Return only the source intersection; generated headings never become source evidence. */
export function sourceIntersection(projection: ProbeProjection, start: number, end: number): { start: number; end: number } | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > projection.text.length) throw new Error("INVALID_LOCATOR");
  const from = Math.max(start, projection.projectionStart), to = Math.min(end, projection.projectionEnd);
  if (from >= to) return null;
  return { start: projection.sourceStart + from - projection.projectionStart, end: projection.sourceStart + to - projection.projectionStart };
}
export function sourcePoint(text: string, offset: number): { line: number; column_utf16: number } {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) throw new Error("INVALID_LOCATOR");
  const before = text.slice(0, offset), last = before.lastIndexOf("\n");
  return { line: before.split("\n").length, column_utf16: offset - last - 1 };
}
