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
export type CompiledDocument = { compiler_version: "projection-v1"; title: string; passages: Passage[]; coverage: CoverageBlock[]; metadata_range: SourceSpan | null };
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkFrontmatter, ["yaml"]);
const span = (node: Node): SourceSpan => ({ start: node.position!.start.offset!, end: node.position!.end.offset! });
const textOf = (node: Node): string => node.value ?? node.children?.map(textOf).join("") ?? "";
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const boundedTitle = (text: string): string => [...text.replace(/\s+/g, " ").trim()].slice(0, 160).join("") || "문서";
type Unit = SourceSpan & { nodes: Node[]; atomic: boolean };
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
  for (const key of ["role", "type", "status", "topics"]) if (metadata[key] !== undefined) qmdMetadata[key] = metadata[key];
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
  const render = (section: Section, from: number, to: number, headingPrimary = false) => {
    let text = prefix;const segments: MapSegment[] = [{ projection_start: 0, projection_end: prefix.length, kind: "generated" }];
    for (const heading of section.headings) {
      const range = span(heading.node);
      if (headingPrimary && range.start === from && range.end === to) continue;
      const start = text.length;text += input.text.slice(range.start, range.end);
      segments.push({ kind: "source", projection_start: start, projection_end: text.length, source_start: range.start, source_end: range.end, context: true });
      const separator = text.length;text += "\n\n";segments.push({ kind: "generated", projection_start: separator, projection_end: text.length });
    }
    const start = text.length;text += input.text.slice(from, to);
    segments.push({ kind: "source", projection_start: start, projection_end: text.length, source_start: from, source_end: to, context: false });
    return { text, segments };
  };
  const preflight = async (section: Section, from: number, to: number, headingPrimary = false) => {
    await checkCancel();const projection = render(section, from, to, headingPrimary);
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
  const split = async (section: Section, unit: Unit): Promise<void> => {
    if (unit.atomic || unit.nodes.length !== 1 || unit.nodes[0]!.type !== "paragraph") { emit(section, unit, await preflight(section, unit.start, unit.end));return; }
    const boundaries = new Set<number>([unit.end]);
    for (const child of unit.nodes[0]!.children ?? []) {
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
      const end = low >= 0 ? ends[low]! : start;
      if (end <= start) { const tail = { ...unit, start };emit(section, tail, await preflight(section, start, unit.end));break; }
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
    const spans = block.passages.map(id => byId.get(id)!).flatMap(p => p.segments.flatMap(s => s.kind === "source" && s.source_start < block.end && s.source_end > block.start ? [{ start: Math.max(s.source_start, block.start), end: Math.min(s.source_end, block.end) }] : [])).sort((a, b) => a.start - b.start);
    let end = block.start;for (const range of spans) { if (range.start > end) throw new Error("SOURCE_MAP_MISMATCH");end = Math.max(end, range.end); }
    if (end !== block.end) throw new Error("SOURCE_MAP_MISMATCH");
  }
  return { compiler_version: "projection-v1", title, passages, coverage, metadata_range: metadataNode ? span(metadataNode) : null };
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
