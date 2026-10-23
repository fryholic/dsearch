import { normalizeMetadata } from "./metadata.js";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkFrontmatter from "remark-frontmatter";

type Node = { type: string; depth?: number; value?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
export type SourceSpan = { start: number; end: number };
type Heading = { depth: number; text: string; node: Node };
export type ProjectionCheck = { embeddingTokens: number; embeddingChunks: number; searchChunks: number; safe: boolean; actualTitle?: string };
export type ProjectionInspector = (text: string, title: string, file: string) => Promise<ProjectionCheck>;
export type MapSegment = { projection_start: number; projection_end: number; kind: "generated" }
  | { projection_start: number; projection_end: number; kind: "source"; source_start: number; source_end: number; context: boolean };
export type Passage = {
  passage_id: string; doc_id: string; revision_id: string; heading: string[]; kind: "semantic" | "lexical_only";
  reason: string | null; text: string; projection_sha256: string; segments: MapSegment[]; embedding_tokens: number | null;
};
export type CoverageBlock = SourceSpan & { type: string; state: "semantic" | "lexical_only" | "excluded_navigation" | "failed"; reason: string | null; passages: string[] };
export type CompiledDocument = { compiler_version: "projection-v3"; title: string; passages: Passage[]; coverage: CoverageBlock[]; metadata_range: SourceSpan | null };
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkFrontmatter, ["yaml"]);
const span = (node: Node): SourceSpan => ({ start: node.position!.start.offset!, end: node.position!.end.offset! });
const textOf = (node: Node): string => node.value ?? node.children?.map(textOf).join("") ?? "";
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const boundedTitle = (text: string): string => [...text.replace(/\s+/g, " ").trim()].slice(0, 160).join("") || "문서";
type Unit = SourceSpan & { nodes: Node[]; atomic: boolean; before?: SourceSpan[]; after?: SourceSpan[] };
type Section = { headings: Heading[]; nodes: Node[]; navigation: boolean };

function atomicUnits(nodes: Node[]): Unit[] {
  const groups: { first: number; last: number; atomic: boolean }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const atomic = ["math", "code", "table"].includes(nodes[i]!.type);
    let first = i, last = i;
    if (atomic) {
      if (nodes[i - 1]?.type === "paragraph") first--;
      while (nodes[last + 1]?.type === "math") last++;
      if (nodes[last + 1]?.type === "paragraph") last++;
    }
    groups.push({ first, last, atomic });
  }
  groups.sort((a, b) => a.first - b.first);
  const merged: typeof groups = [];
  for (const group of groups) {
    const prior = merged.at(-1);
    if (prior && group.first <= prior.last) { prior.last = Math.max(prior.last, group.last);prior.atomic ||= group.atomic; }
    else merged.push({ ...group });
  }
  return merged.map(g => ({ start: span(nodes[g.first]!).start, end: span(nodes[g.last]!).end, nodes: nodes.slice(g.first, g.last + 1), atomic: g.atomic }));
}

/** Actual tokenizer/chunker inspection is injected by the isolated engine adapter. */
export async function compileDocument(input: {
  doc_id: string; revision_id: string; text: string; fallback_title: string; metadata?: Record<string, unknown>;
  navigation_headings?: string[]; signal?: AbortSignal;
}, inspect: ProjectionInspector): Promise<CompiledDocument> {
  let tree: Node;
  try { tree = parser.parse(input.text) as Node; }
  catch { throw Object.assign(new Error("PARSE_ERROR"), { code: "PARSE_ERROR" }); }
  const nodes = tree.children ?? [];
  const metadata = input.metadata ?? {}, firstHeading = nodes.find(n => n.type === "heading");
  const title = boundedTitle(typeof metadata.title === "string" ? metadata.title : firstHeading ? textOf(firstHeading) : input.fallback_title);
  const qmdMetadata: Record<string, unknown> = { document_key: input.doc_id };
  Object.assign(qmdMetadata, normalizeMetadata(metadata).values);
  const prefix = "---\nqmd:\n  metadata: " + JSON.stringify(qmdMetadata) + "\n---\n# " + title + "\n\n";
  const metadataNode = nodes.find(n => n.type === "yaml"), coverage: CoverageBlock[] = nodes.filter(n => n.type !== "yaml").map(n => ({ ...span(n), type: n.type, state: "failed", reason: "not_compiled", passages: [] }));
  const blocks = new Map(coverage.map(b => [b.start, b]));
  const sections: Section[] = [];let headings: Heading[] = [], body: Node[] = [];
  const flush = () => { if (body.length) sections.push({ headings: [...headings], nodes: body, navigation: headings.some(h => input.navigation_headings?.includes(h.text)) });body = []; };
  for (const node of nodes) {
    if (node.type === "yaml") continue;
    if (node.type === "heading") {
      flush();while (headings.length && headings.at(-1)!.depth >= node.depth!) headings.pop();
      headings.push({ depth: node.depth!, text: textOf(node), node });
    } else body.push(node);
  }
  flush();
  const passages: Passage[] = [], occurrences = new Map<string, number>();let operations = 0;
  const checkCancel = async () => { if (++operations % 8 === 0) await setImmediate();if (input.signal?.aborted) throw Object.assign(new Error("CANCELLED"), { code: "CANCELLED" }); };
  const render = (section: Section, from: number, to: number, headingPrimary = false, context?: Pick<Unit, "before" | "after">) => {
    let text = prefix;const segments: MapSegment[] = [{ projection_start: 0, projection_end: prefix.length, kind: "generated" }];
    for (const heading of section.headings) {
      const range = span(heading.node);
      if (headingPrimary && range.start === from && range.end === to) continue;
      const start = text.length;text += input.text.slice(range.start, range.end);
      segments.push({ kind: "source", projection_start: start, projection_end: text.length, source_start: range.start, source_end: range.end, context: true });
      const separator = text.length;text += "\n\n";segments.push({ kind: "generated", projection_start: separator, projection_end: text.length });
    }
    const append = (range: SourceSpan, repeated: boolean) => {
      const start = text.length;text += input.text.slice(range.start, range.end);
      segments.push({ kind: "source", projection_start: start, projection_end: text.length, source_start: range.start, source_end: range.end, context: repeated });
    };
    for (const range of context?.before ?? []) append(range, true);
    append({ start: from, end: to }, false);
    for (const range of context?.after ?? []) {
      if (!text.endsWith("\n")) { const start = text.length;text += "\n";segments.push({ kind: "generated", projection_start: start, projection_end: text.length }); }
      append(range, true);
    }
    return { text, segments };
  };
  const preflight = async (section: Section, from: number, to: number, headingPrimary = false, context?: Pick<Unit, "before" | "after">) => {
    await checkCancel();const projection = render(section, from, to, headingPrimary, context);
    if (projection.text.length > 2400) return { projection, check: null, safe: false };
    const check = await inspect(projection.text, title, "projection.md");
    if (!Number.isSafeInteger(check.embeddingTokens) || check.embeddingTokens < 0) throw Object.assign(new Error("COMPATIBILITY_FAILED"), { code: "COMPATIBILITY_FAILED" });
    return { projection, check, safe: check.safe && check.embeddingTokens <= 800 && check.embeddingChunks === 1 && check.searchChunks === 1 };
  };
  type Checked = Awaited<ReturnType<typeof preflight>>;
  const emit = (section: Section, unit: Unit, checked: Checked) => {
    const stem = JSON.stringify([input.doc_id, section.headings.map(h => h.text), input.text.slice(unit.start, unit.end)]), ordinal = occurrences.get(stem) ?? 0;occurrences.set(stem, ordinal + 1);
    const id = hash(stem + "\0" + ordinal), kind = checked.safe ? "semantic" : "lexical_only";
    const reason = checked.safe ? null : checked.projection.text.length > 2400 ? "projection_utf16_overflow" : checked.check!.embeddingTokens > 800 ? "embedding_token_overflow" : "engine_chunk_split";
    const passage: Passage = { passage_id: id, doc_id: input.doc_id, revision_id: input.revision_id, heading: section.headings.map(h => h.text), kind, reason, text: checked.projection.text, projection_sha256: hash(checked.projection.text), segments: checked.projection.segments, embedding_tokens: checked.check?.embeddingTokens ?? null };
    passages.push(passage);
    for (const node of [...section.headings.map(h => h.node), ...unit.nodes]) {
      const block = blocks.get(span(node).start);if (!block) continue;
      const alreadyLexical = block.state === "lexical_only", mixed = block.passages.length > 0 && block.state !== kind;
      block.passages.push(id);block.state = alreadyLexical || kind === "lexical_only" ? "lexical_only" : "semantic";
      block.reason = block.state === "semantic" ? null : mixed ? "partially_lexical_only" : reason ?? block.reason;
    }
  };
  const inspectUnit = (section: Section, unit: Unit) => preflight(section, unit.start, unit.end, false, unit);
  // Fragments partition primary source bytes. Repeated table headers/fences are context only.
  const splitBoundaries = async (section: Section, unit: Unit, boundaries: number[], header?: SourceSpan, footer?: SourceSpan): Promise<void> => {
    const ends = [...new Set(boundaries.filter(end => end > unit.start && end <= unit.end))].sort((a, b) => a - b);
    let start = unit.start, cursor = 0;
    while (start < unit.end) {
      while (ends[cursor] !== undefined && ends[cursor]! <= start) cursor++;
      if (cursor >= ends.length) throw Object.assign(new Error("SOURCE_MAP_MISMATCH"), { code: "SOURCE_MAP_MISMATCH" });
      const part = (end: number): Unit => ({ ...unit, start, end,
        ...(header && start > unit.start ? { before: [header] } : {}),
        ...(footer && end < unit.end ? { after: [footer] } : {}) });
      let low = cursor - 1, high = ends.length;
      while (low + 1 < high) {
        const mid = Math.floor((low + high) / 2), check = await inspectUnit(section, part(ends[mid]!));
        if (check.safe && check.check!.embeddingTokens <= 600) low = mid;else high = mid;
      }
      // A single indivisible row/line may fit the hard cap even when above the packing target.
      const end = ends[low >= cursor ? low : cursor]!, fragment = part(end);
      emit(section, fragment, await inspectUnit(section, fragment));start = end;
    }
  };
  const split = async (section: Section, unit: Unit): Promise<void> => {
    if (unit.nodes.some(node => node.type === "math")) { emit(section, unit, await inspectUnit(section, unit));return; }
    if (unit.nodes.length > 1) {
      // Oversized presentation groups can separate at AST boundaries; equations retain atomic context.
      for (const [index, node] of unit.nodes.entries()) {
        const single = { start: span(node).start, end: unit.nodes[index + 1] ? span(unit.nodes[index + 1]!).start : unit.end, nodes: [node], atomic: ["code", "table"].includes(node.type) }, checked = await inspectUnit(section, single);
        if (checked.safe) emit(section, single, checked);else await split(section, single);
      }
      return;
    }
    const node = unit.nodes[0]!;
    if (node.type === "table" && (node.children?.length ?? 0) > 1) {
      const rows = node.children!.slice(1), header = { start: unit.start, end: span(rows[0]!).start };
      await splitBoundaries(section, unit, [...rows.slice(1).map(row => span(row).start), unit.end], header);return;
    }
    if (node.type === "code") {
      const source = input.text.slice(unit.start, span(node).end), opening = /^( {0,3})(`{3,}|~{3,})[^\n]*\n/.exec(source);
      if (opening) {
        const closingStart = source.lastIndexOf("\n") + 1, closing = source.slice(closingStart), fence = opening[2]!;
        if (new RegExp("^ {0,3}" + fence[0] + "{" + fence.length + ",}[ \t]*$").test(closing) && closingStart >= opening[0].length) {
          const header = { start: unit.start, end: unit.start + opening[0].length }, footer = { start: unit.start + closingStart, end: span(node).end };
          const ends = [...source.matchAll(/\n/g)].map(match => unit.start + match.index + 1).filter(end => end > header.end && end < footer.start);
          await splitBoundaries(section, unit, [...ends, unit.end], header, footer);return;
        }
      }
      emit(section, unit, await inspectUnit(section, unit));return;
    }
    if (node.type !== "paragraph") { emit(section, unit, await inspectUnit(section, unit));return; }
    const boundaries = new Set<number>([unit.end]);
    for (const child of node.children ?? []) {
      const range = span(child);
      if (child.type === "text") { for (const match of input.text.slice(range.start, range.end).matchAll(/\s+/g)) boundaries.add(range.start + match.index + match[0].length); }
      else boundaries.add(range.end);
    }
    const ends = [...boundaries].sort((a, b) => a - b);let start = unit.start;
    while (start < unit.end) {
      let low = -1, high = ends.length;
      while (low + 1 < high) {
        const mid = Math.floor((low + high) / 2), end = ends[mid]!;
        if (end <= start) { low = mid;continue; }
        const result = await preflight(section, start, end);
        if (result.safe && result.check!.embeddingTokens <= 600) low = mid;else high = mid;
      }
      let end = low >= 0 ? ends[low]! : start;
      if (end <= start) {
        // A long unspaced text run is split only at grapheme boundaries, never inside inline math/code/links.
        const child = node.children?.find(child => child.type === "text" && span(child).start <= start && span(child).end > start);
        if (child) {
          const candidates: number[] = [];
          for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(input.text.slice(start, span(child).end))) {
            const boundary = start + segment.index + segment.segment.length;if (boundary - start > 8192) break;candidates.push(boundary);
          }
          let left = -1, right = candidates.length;
          while (left + 1 < right) { const mid = Math.floor((left + right) / 2), check = await preflight(section, start, candidates[mid]!);if (check.safe && check.check!.embeddingTokens <= 600) left = mid;else right = mid; }
          if (left >= 0) end = candidates[left]!;
        }
        if (end <= start) { const tail = { ...unit, start };emit(section, tail, await preflight(section, start, unit.end));break; }
      }
      const part = { ...unit, start, end };emit(section, part, await preflight(section, start, end));start = end;
    }
  };

  for (const section of sections) {
    if (section.navigation) {
      for (const node of [...section.headings.map(h => h.node), ...section.nodes]) { const block = blocks.get(span(node).start);if (block && !block.passages.length) { block.state = "excluded_navigation";block.reason = "navigation_heading"; } }
      continue;
    }
    let packed: Unit | undefined, packedCheck: Checked | undefined;
    for (const unit of atomicUnits(section.nodes)) {
      const combined = packed ? { start: packed.start, end: unit.end, nodes: [...packed.nodes, ...unit.nodes], atomic: packed.atomic || unit.atomic } : unit;
      const result = await preflight(section, combined.start, combined.end);
      if (result.safe && result.check!.embeddingTokens <= 600) { packed = combined;packedCheck = result;continue; }
      if (packed && packedCheck) { emit(section, packed, packedCheck);packed = undefined;packedCheck = undefined; }
      const alone = combined === unit ? result : await preflight(section, unit.start, unit.end);
      if (alone.safe) emit(section, unit, alone);else await split(section, unit);
    }
    if (packed && packedCheck) emit(section, packed, packedCheck);
  }
  // Empty sections still retain a source-backed heading rather than silently disappearing.
  for (const node of nodes.filter(n => n.type === "heading" && blocks.get(span(n).start)?.reason === "not_compiled")) {
    const section: Section = { headings: [], nodes: [node], navigation: input.navigation_headings?.includes(textOf(node)) ?? false }, range = span(node);
    if (section.navigation) { const b = blocks.get(range.start)!;b.state = "excluded_navigation";b.reason = "navigation_heading"; }
    else emit(section, { ...range, nodes: [node], atomic: true }, await preflight(section, range.start, range.end, true));
  }
  for (const passage of passages) validateSourceMap(passage, input.text);
  if (coverage.some(b => b.reason === "not_compiled")) throw Object.assign(new Error("SOURCE_MAP_MISMATCH"), { code: "SOURCE_MAP_MISMATCH" });
  const byId = new Map(passages.map(p => [p.passage_id, p]));
  for (const block of coverage.filter(b => b.state !== "excluded_navigation")) {
    const spans = block.passages.map(id => byId.get(id)!).flatMap(p => p.segments.flatMap(s => s.kind === "source" && (block.type === "heading" || !s.context) && s.source_start < block.end && s.source_end > block.start ? [{ start: Math.max(s.source_start, block.start), end: Math.min(s.source_end, block.end) }] : [])).sort((a, b) => a.start - b.start);
    let end = block.start;for (const range of spans) { if (range.start > end) throw new Error("SOURCE_MAP_MISMATCH");end = Math.max(end, range.end); }
    if (end !== block.end) throw new Error("SOURCE_MAP_MISMATCH");
  }
  return { compiler_version: "projection-v3", title, passages, coverage, metadata_range: metadataNode ? span(metadataNode) : null };
}

export function validateSourceMap(passage: Passage, source: string): void {
  let end = 0, primary = false;
  for (const segment of passage.segments) {
    if (segment.projection_start !== end || segment.projection_end < end || segment.projection_end > passage.text.length) throw new Error("SOURCE_MAP_MISMATCH");
    end = segment.projection_end;
    if (segment.kind === "source") {
      if (segment.source_start < 0 || segment.source_end > source.length || segment.source_end < segment.source_start || passage.text.slice(segment.projection_start, segment.projection_end) !== source.slice(segment.source_start, segment.source_end)) throw new Error("SOURCE_MAP_MISMATCH");
      primary ||= !segment.context && segment.source_end > segment.source_start;
    }
  }
  if (end !== passage.text.length || !primary || hash(passage.text) !== passage.projection_sha256) throw new Error("SOURCE_MAP_MISMATCH");
}
export function primaryIntersections(passage: Passage, start: number, end: number): SourceSpan[] {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > passage.text.length) throw new Error("INVALID_LOCATOR");
  return passage.segments.flatMap(segment => {
    if (segment.kind !== "source" || segment.context) return [];
    const from = Math.max(start, segment.projection_start), to = Math.min(end, segment.projection_end);
    return from < to ? [{ start: segment.source_start + from - segment.projection_start, end: segment.source_start + to - segment.projection_start }] : [];
  });
}
