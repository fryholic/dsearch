import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { Catalog, digest, type Collection } from '@dsearch/catalog';
import { DsearchError, type SearchRequest, type LiteralRequest } from '@dsearch/contracts';
import { KeywordComplete, LiteralComplete, type SearchDocument } from '@dsearch/contracts/search';
import { primaryIntersections, validateSourceMap, sourcePoint, type Passage, type SourceSpan } from '@dsearch/compiler';
import type { Progress } from '@dsearch/runtime';
import type { ReadLease } from './readers.js';
const label = (value: string, cap = 512): string => { if (value.length <= cap)
    return value; let cut = value.slice(0, cap - 1); if (/[\uD800-\uDBFF]$/.test(cut))
    cut = cut.slice(0, -1); return cut + '…'; };
const locator = (text: string, range: SourceSpan) => ({ kind: 'markdown' as const, start: sourcePoint(text, range.start), end: sourcePoint(text, range.end) });
export function excerptRange(text: string, primary: SourceSpan, match: SourceSpan) {
    let start = Math.max(primary.start, match.start - 160), end = Math.min(primary.end, start + 1600);
    const line = text.lastIndexOf('\n', match.start - 1) + 1;
    if (line >= start && line <= match.start)
        start = line;
    end = Math.min(primary.end, start + 1600);
    if (start > primary.start && /[\uDC00-\uDFFF]/.test(text[start]!))
        start++;
    if (end < primary.end && /[\uD800-\uDBFF]/.test(text[end - 1]!))
        end--;
    return { start, end };
}
export const quotedKeywords = (query: string): string => query.replace(/\s+/g, ' ').trim().split(' ').map(term => '"' + term.replaceAll('"', ' ') + '"').join(' ');
export class SourceSearch {
    constructor(readonly catalog: Catalog) { }
    validateCollections(ids: string[]): Collection[] { return ids.map(id => { let collection; try {
        collection = this.catalog.collection(id);
    }
    catch {
        throw new DsearchError('SCOPE_DENIED');
    } if (!collection.enabled)
        throw new DsearchError('SCOPE_DENIED'); return collection; }); }
    async keyword(request: SearchRequest, searchId: string, lease: ReadLease, signal: AbortSignal, onProgress: (p: Progress) => void): Promise<KeywordComplete> {
        if (request.mode !== 'lexical' || request.rerank)
            throw new DsearchError('INVALID_REQUEST', 'This alpha supports lexical and literal search');
        const selected = this.validateCollections(request.collections), reader = await lease.ready;
        for (const collection of selected)
            if (reader.scopes[collection.collection_id] !== collection.scope_fp)
                throw new DsearchError('NO_ACTIVE_GENERATION');
        const internal = selected.flatMap(c => ['s_', 'l_'].map(prefix => prefix + c.collection_id.replaceAll('-', ''))), query = quotedKeywords(request.query);
        const engine = await lease.run<{
            hits: {
                file: string;
                score: number;
            }[];
        }>('search', { ...request, query, collections: internal, limit: request.candidate_limit }, { signal, onProgress });
        const hits = engine.result.hits;
        const candidates = hits.map(hit => { const key = hit.file.replace(/^qmd:\/\//, ''); const passage = reader.mappings.get(key); if (!passage || !Number.isFinite(hit.score))
            throw new DsearchError('SOURCE_MAP_MISMATCH'); return { hit, passage }; });
        const located = await lease.run<{
            file: string;
            projectionSha256: string;
            ranges: SourceSpan[];
        }[]>('lexical_matches', { query, files: candidates.map(({ hit, passage }) => ({ file: hit.file, primaryRanges: passage.segments.flatMap(s => s.kind === 'source' && !s.context ? [{ start: s.projection_start, end: s.projection_end }] : []) })) }, { signal, onProgress });
        const locations = new Map(located.result.map(value => [value.file, value]));
        const sources = new Map<string, Promise<Awaited<ReturnType<Catalog['readDocument']>>>>();
        type Group = {
            score: number;
            document: SearchDocument;
            ranges: SourceSpan[];
        };
        const groups = new Map<string, Group>();
        let stale = 0, generatedOnly = 0;
        for (const { hit, passage: indexed } of candidates) {
            if (signal.aborted)
                throw new DsearchError('CANCELLED');
            const location = locations.get(hit.file);
            if (!location)
                throw new DsearchError('SOURCE_MAP_MISMATCH');
            if (location.projectionSha256 !== indexed.projection_sha256)
                throw new DsearchError('SOURCE_MAP_MISMATCH');
            if (!location.ranges.length) {
                generatedOnly++;
                continue;
            }
            let source;
            try {
                let pending = sources.get(indexed.doc_id);
                if (!pending) {
                    pending = this.catalog.readDocument(indexed.doc_id, indexed.revision_id);
                    sources.set(indexed.doc_id, pending);
                }
                source = await pending;
            }
            catch (e) {
                if (e instanceof DsearchError && ['STALE_REVISION', 'SCOPE_DENIED', 'SOURCE_PENDING', 'UNSUPPORTED_ENCODING', 'INVALID_METADATA', 'SCOPE_INCOMPLETE'].includes(e.code)) {
                    stale++;
                    continue;
                }
                throw e;
            }
            if (!request.collections.includes(source.collection.collection_id)) {
                stale++;
                continue;
            }
            const text = await readFile(join(reader.root, 'projection', indexed.engine_collection, indexed.engine_relative_path), 'utf8');
            if (digest(text) !== indexed.projection_sha256)
                throw new DsearchError('SOURCE_MAP_MISMATCH');
            const passage: Passage = { ...indexed, text };
            try {
                validateSourceMap(passage, source.text);
            }
            catch {
                throw new DsearchError('SOURCE_MAP_MISMATCH');
            }
            let group = groups.get(indexed.doc_id);
            if (!group) {
                group = { score: hit.score, document: { doc_id: indexed.doc_id, revision_id: indexed.revision_id, title: label(String(source.metadata.title ?? indexed.heading[0] ?? basename(source.document.relative_path))), collection_id: source.collection.collection_id, relative_path: source.document.relative_path, freshness: 'verified_at_read', evidence: [] }, ranges: [] };
                groups.set(indexed.doc_id, group);
            }
            else
                group.score = Math.max(group.score, hit.score);
            for (const match of location.ranges) {
                if (group.document.evidence.length >= 2)
                    break;
                const spans = primaryIntersections(passage, match.start, match.end);
                for (const matched of spans) {
                    const primary = passage.segments.find(s => s.kind === 'source' && !s.context && s.source_start <= matched.start && s.source_end >= matched.end);
                    if (!primary || primary.kind !== 'source')
                        throw new DsearchError('SOURCE_MAP_MISMATCH');
                    const range = excerptRange(source.text, { start: primary.source_start, end: primary.source_end }, matched);
                    if (group.ranges.some(r => range.start < r.end && range.end > r.start))
                        continue;
                    group.ranges.push(range);
                    group.document.evidence.push({ passage_id: indexed.passage_id, heading_path: indexed.heading.map(h => label(h)), locator: locator(source.text, range), excerpt: source.text.slice(range.start, range.end), excerpt_truncated: range.start > primary.source_start || range.end < primary.source_end });
                    break;
                }
            }
            if (!group.document.evidence.length) {
                groups.delete(indexed.doc_id);
                generatedOnly++;
            }
        }
        // Scope is checked again after asynchronous native and source operations.
        const current = this.validateCollections(request.collections);
        if (current.some(c => selected.find(s => s.collection_id === c.collection_id)!.scope_fp !== c.scope_fp))
            throw new DsearchError('SCOPE_DENIED');
        const ranked = [...groups.values()].sort((a, b) => b.score - a.score || (a.document.collection_id < b.document.collection_id ? -1 : a.document.collection_id > b.document.collection_id ? 1 : a.document.doc_id < b.document.doc_id ? -1 : 1));
        const results = ranked.slice(0, request.limit).map(g => g.document);
        return KeywordComplete.parse({ search_id: searchId, state: 'completed', purpose: 'find', requested_mode: 'lexical', effective_mode: 'lexical', rank_stage: 'bm25', degraded: false, generation_id: lease.snapshot.generation_id, epoch: lease.snapshot.epoch, profile_fp: lease.snapshot.profile_fp, persisted: false, query_plan: { query: request.query, lexical_query: query, derived_query: false, expansion_used: false }, counts: { retrieved_passages: hits.length, reranked_passages: 0, returned_documents: results.length, stale_omitted: stale, generated_only_omitted: generatedOnly }, results, supplemental_results: [], warnings: stale ? ['STALE_OMITTED'] : [], has_more: ranked.length > results.length });
    }
    async literal(request: LiteralRequest, searchId: string, signal: AbortSignal, onProgress: (p: Progress) => void, limits = { file: 8 * 1024 * 1024, total: 128 * 1024 * 1024, ms: 5000 }): Promise<LiteralComplete> {
        const selected = this.validateCollections(request.collections), deadline = Date.now() + limits.ms, query = request.query.replace(/\r\n?/g, '\n');
        const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), request.ignore_case ? 'giu' : 'gu');
        const matches: LiteralComplete['matches'] = [];
        let scanned = 0, skipped = 0, bytes = 0, stale = 0, reason: LiteralComplete['stop_reason'] = null;
        for (const collection of selected) {
            if (signal.aborted)
                throw new DsearchError('CANCELLED');
            if (Date.now() >= deadline) {
                reason = 'time_limit';
                break;
            }
            const report = await this.catalog.reconcile(collection.collection_id, { signal, budget: { maxBytesPerFile: limits.file, maxTotalBytes: Math.max(0, limits.total - bytes), deadline }, captureSources: true });
            bytes += report.read_bytes;
            skipped += report.skipped_files;
            reason ??= report.stop_reason;
            for (const { document, source } of report.captured_sources ?? []) {
                if (signal.aborted)
                    throw new DsearchError('CANCELLED');
                if (Date.now() >= deadline) {
                    reason = 'time_limit';
                    break;
                }
                scanned++;
                onProgress({ phase: 'literal-scanning', completed: scanned });
                pattern.lastIndex = 0;
                while (matches.length < request.limit) {
                    const found = pattern.exec(source.text);
                    if (!found)
                        break;
                    const match = { start: found.index, end: found.index + found[0].length }, range = excerptRange(source.text, { start: 0, end: source.text.length }, match);
                    matches.push({ doc_id: document.doc_id, revision_id: document.latest_revision_id!, title: label(String(source.metadata.title ?? basename(document.relative_path))), collection_id: collection.collection_id, relative_path: document.relative_path, locator: locator(source.text, range), match_locator: locator(source.text, match), excerpt: source.text.slice(range.start, range.end), excerpt_truncated: range.start > 0 || range.end < source.text.length });
                }
                if (matches.length >= request.limit) {
                    reason = 'match_limit';
                    break;
                }
            }
            const failures = report.documents.filter(d => d.present && ['unreadable', 'invalid_metadata', 'unsupported_encoding', 'pending'].includes(d.eligibility) && d.eligibility_reason !== 'literal_file_limit').length;
            if (failures || report.boundaries.some(b => b.incomplete)) {
                reason ??= 'unreadable_sources';
                skipped += failures;
            }
            if (report.stop_reason === 'time_limit' || matches.length >= request.limit || bytes >= limits.total || Date.now() >= deadline) {
                reason ??= bytes >= limits.total ? 'byte_limit' : 'time_limit';
                break;
            }
        }
        const current = this.validateCollections(request.collections);
        if (current.some(c => selected.find(s => s.collection_id === c.collection_id)!.scope_fp !== c.scope_fp))
            throw new DsearchError('SCOPE_DENIED');
        return LiteralComplete.parse({ search_id: searchId, state: 'completed', purpose: 'find', requested_mode: 'literal', effective_mode: 'literal', rank_stage: 'literal', persisted: false, query_plan: { query: request.query, ignore_case: request.ignore_case, regex: false, case_policy: 'unicode-simple-fold-v1', newline_policy: 'lf', unicode_normalization: 'none' }, matches, partial: reason !== null, stop_reason: reason, counts: { scanned_files: scanned, skipped_files: skipped, bytes_scanned: bytes, matches: matches.length, stale_omitted: stale } });
    }
}
