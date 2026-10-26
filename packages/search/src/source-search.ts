import { selectionRange, relatedQuery } from './query-builder.js';
import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { Catalog, canonicalJSON, digest, type Collection } from '@dsearch/catalog';
import { DsearchError, SearchRequest, type RelatedRequest, type CompareRequest, type LiteralRequest } from '@dsearch/contracts';
import { KeywordComplete, LiteralComplete, CompareComplete, type SearchDocument } from '@dsearch/contracts/search';
import { primaryIntersections, validateSourceMap, sourcePoint, type Passage, type SourceSpan } from '@dsearch/compiler';
import type { CandidateReceipt } from '@dsearch/engine-qmd';
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
/** An opt-in in-process evaluation sink; never included in public search results or persisted. */
export type CandidateSnapshot = {
    search_id: string;
    generation_id: string;
    epoch: number;
    profile_fp: string;
    requested_mode: SearchRequest['mode'];
    effective_mode: SearchRequest['mode'];
    stage: CandidateReceipt['stage'];
    budget: number;
    candidates: { doc_id: string; revision_id: string; passage_id: string; rank: number; score: number }[];
};
export class SourceSearch {
    constructor(readonly catalog: Catalog, readonly options: { onCandidates?: (receipt: CandidateSnapshot) => void } = {}) { }
    validateCollections(ids: string[]): Collection[] { return ids.map(id => { let collection; try {
        collection = this.catalog.collection(id);
    }
    catch {
        throw new DsearchError('SCOPE_DENIED');
    } if (!collection.enabled)
        throw new DsearchError('SCOPE_DENIED'); return collection; }); }
    async keyword(request: SearchRequest, searchId: string, lease: ReadLease, signal: AbortSignal, onProgress: (p: Progress) => void): Promise<KeywordComplete> {
        const selected = this.validateCollections(request.collections), reader = await lease.ready;
        for (const collection of selected)
            if (reader.scopes[collection.collection_id] !== collection.scope_fp)
                throw new DsearchError('NO_ACTIVE_GENERATION');
        const names = (prefix: string) => selected.map(c => prefix + c.collection_id.replaceAll('-', ''));
        const internal = request.mode === 'lexical' ? [...names('s_'), ...names('l_')] : names('s_'), query = quotedKeywords(request.query);
        const started = performance.now();
        type Hit = { file: string; score: number };
        type EngineResult = { hits: Hit[]; effective_mode: SearchRequest['mode']; rank_stage: KeywordComplete['rank_stage']; degraded: boolean; warnings?: string[]; candidate_receipt?: CandidateReceipt };
        const engine = await lease.run<EngineResult>(this.options.onCandidates ? 'search_receipt' : 'search', { ...request, query: request.query, lexical_query: query, collections: internal, limit: request.candidate_limit }, { signal, onProgress });
        if (this.options.onCandidates) {
            const receipt = engine.result.candidate_receipt;
            const stage = engine.result.effective_mode === 'lexical' ? 'bm25' : 'rrf_before_chunk_selection';
            if (!receipt || receipt.stage !== stage || receipt.candidates.length > request.candidate_limit || receipt.candidates.length !== Number(engine.stats.actualCandidates) || new Set(receipt.candidates.map(c => c.file)).size !== receipt.candidates.length)
                throw new DsearchError('COMPATIBILITY_FAILED');
            const candidates = receipt.candidates.map((candidate, index) => {
                const passage = reader.mappings.get(candidate.file.replace(/^qmd:\/\//, ''));
                if (!passage || candidate.rank !== index + 1 || !Number.isFinite(candidate.score)) throw new DsearchError('SOURCE_MAP_MISMATCH');
                return { doc_id: passage.doc_id, revision_id: passage.revision_id, passage_id: passage.passage_id, rank: candidate.rank, score: candidate.score };
            });
            this.options.onCandidates({ search_id: searchId, generation_id: lease.snapshot.generation_id, epoch: lease.snapshot.epoch, profile_fp: lease.snapshot.profile_fp, requested_mode: request.mode, effective_mode: engine.result.effective_mode, stage: receipt.stage, budget: request.candidate_limit, candidates });
        }
        const hits = engine.result.hits;
        const supplemental = request.mode !== 'lexical' ? await lease.run<EngineResult>('search', { ...request, query, mode: 'lexical', rerank: false, collections: names('l_'), limit: Math.min(80, request.candidate_limit) }, { signal, onProgress }) : undefined;
        const candidates = [...hits.map(hit => ({ hit, supplemental: false })), ...(supplemental?.result.hits ?? []).map(hit => ({ hit, supplemental: true }))].map(value => {
            const passage = reader.mappings.get(value.hit.file.replace(/^qmd:\/\//, ''));
            if (!passage || !Number.isFinite(value.hit.score)) throw new DsearchError('SOURCE_MAP_MISMATCH');
            return { ...value, passage };
        });
        const locations = new Map<string, { file: string; projectionSha256: string; ranges: SourceSpan[] }>();
        // SDK evidence request is bounded to 80; supplemental candidates have their own budget.
        for (let i = 0; i < candidates.length; i += 80) {
            const located = await lease.run<{ file: string; projectionSha256: string; ranges: SourceSpan[] }[]>('lexical_matches', { query, files: candidates.slice(i, i + 80).map(({ hit, passage }) => ({ file: hit.file, primaryRanges: passage.segments.flatMap(s => s.kind === 'source' && !s.context ? [{ start: s.projection_start, end: s.projection_end }] : []) })) }, { signal, onProgress });
            for (const value of located.result) locations.set(value.file, value);
        }
        const sources = new Map<string, Promise<Awaited<ReturnType<Catalog['readDocument']>>>>();
        type Group = {
            score: number;
            document: SearchDocument;
            ranges: SourceSpan[];
        };
        const groups = new Map<string, Group>(), extraGroups = new Map<string, Group>();
        let stale = 0, generatedOnly = 0;
        for (const { hit, passage: indexed, supplemental: isExtra } of candidates) {
            if (signal.aborted)
                throw new DsearchError('CANCELLED');
            const semantic = !isExtra && engine.result.effective_mode !== 'lexical';
            const location = locations.get(hit.file);
            // FTS returns no row for a purely vector hit; local projection hash + source map still verify it.
            if (!location && !semantic)
                throw new DsearchError('SOURCE_MAP_MISMATCH');
            if (location && location.projectionSha256 !== indexed.projection_sha256)
                throw new DsearchError('SOURCE_MAP_MISMATCH');
            const ranges = location?.ranges ?? [];
            if (!ranges.length && !semantic) {
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
            const target = isExtra ? extraGroups : groups;
            let group = target.get(indexed.doc_id);
            if (!group) {
                group = { score: hit.score, document: { score: hit.score, doc_id: indexed.doc_id, revision_id: indexed.revision_id, title: label(String(source.metadata.title ?? indexed.heading[0] ?? basename(source.document.relative_path))), collection_id: source.collection.collection_id, relative_path: source.document.relative_path, freshness: 'verified_at_read', evidence: [] }, ranges: [] };
                target.set(indexed.doc_id, group);
            }
            else group.score = Math.max(group.score, hit.score);
            group.document.score = group.score;
            const matches = ranges.length ? ranges : indexed.segments.filter(s => s.kind === 'source' && !s.context).map(s => ({ start: s.projection_start, end: s.projection_end }));
            for (const match of matches) {
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
                    group.document.evidence.push({ match_type: ranges.length ? 'lexical' : 'semantic', passage_id: indexed.passage_id, heading_path: indexed.heading.map(h => label(h)), locator: locator(source.text, range), excerpt: source.text.slice(range.start, range.end), excerpt_truncated: range.start > primary.source_start || range.end < primary.source_end });
                    break;
                }
            }
            if (!group.document.evidence.length) {
                target.delete(indexed.doc_id);
                generatedOnly++;
            }
        }
        // Scope is checked again after asynchronous native and source operations.
        const current = this.validateCollections(request.collections);
        if (current.some(c => selected.find(s => s.collection_id === c.collection_id)!.scope_fp !== c.scope_fp))
            throw new DsearchError('SCOPE_DENIED');
        const sort = (values: Map<string, Group>) => [...values.values()].sort((a, b) => b.score - a.score || a.document.collection_id.localeCompare(b.document.collection_id, 'en') || a.document.doc_id.localeCompare(b.document.doc_id, 'en'));
        const ranked = sort(groups), results = ranked.slice(0, request.limit).map(g => g.document);
        const supplementalResults = sort(extraGroups).filter(g => !groups.has(g.document.doc_id)).slice(0, 5).map(g => g.document);
        const stats = engine.stats;
        return KeywordComplete.parse({ search_id: searchId, state: 'completed', purpose: 'find', requested_mode: request.mode, effective_mode: engine.result.effective_mode, rank_stage: engine.result.rank_stage, degraded: engine.result.degraded, generation_id: lease.snapshot.generation_id, epoch: lease.snapshot.epoch, profile_fp: lease.snapshot.profile_fp, retrieval_fp: digest(canonicalJSON({ policy: 'structured-lex-vec-primary-v1', profile: lease.snapshot.profile_fp, requested_mode: request.mode, effective_mode: engine.result.effective_mode, rerank: request.rerank, rank_stage: engine.result.rank_stage, candidate_limit: request.candidate_limit, aggregation: 'max-two-nonoverlapping-primary', supplemental_limit: 5, lexical_query_policy: 'quoted-terms-v1', filter: request.filter ?? null })), persisted: false,
            query_plan: { query: request.query, lexical_query: query, semantic_query: engine.result.effective_mode === 'lexical' ? null : request.query.replace(/\s+/g, ' '), derived_query: false, expansion_used: false },
            counts: { retrieved_passages: Number(stats.actualCandidates ?? hits.length), reranked_passages: Number(stats.rerankedCandidates ?? 0), returned_documents: results.length, stale_omitted: stale, generated_only_omitted: generatedOnly },
            telemetry: { candidate_limit: request.candidate_limit, actual_candidates: Number(stats.actualCandidates ?? hits.length), lexical_contributors: Number(stats.lexicalContributors ?? 0), vector_contributors: Number(stats.vectorContributors ?? 0), reranked_candidates: Number(stats.rerankedCandidates ?? 0), supplemental_candidates: supplemental?.result.hits.length ?? 0, embedding_calls: Number(stats.embeddingCalls ?? 0), reranking_calls: Number(stats.rerankingCalls ?? 0), truncated_inputs: Number(stats.truncatedInputs ?? 0), fallback_used: !!stats.fallbackUsed, engine_ms: engine.duration_ms + (supplemental?.duration_ms ?? 0), worker_rss_bytes: Math.max(engine.rss_bytes, supplemental?.rss_bytes ?? 0), total_ms: performance.now() - started },
            results, supplemental_results: supplementalResults, warnings: [...new Set([...(engine.result.warnings ?? []), ...(stale ? ['STALE_OMITTED'] : []), ...(selected.some(c => this.catalog.scanStatus(c.collection_id).status === 'incomplete') ? ['SCOPE_INCOMPLETE'] : [])])], has_more: ranked.length > results.length });
    }

    async related(request: RelatedRequest, searchId: string, lease: ReadLease, signal: AbortSignal, onProgress: (p: Progress) => void): Promise<KeywordComplete> {
        const source = await this.catalog.readDocument(request.source.doc_id, request.source.revision_id);
        const range = selectionRange(source.text, request.source.locator);
        let tokenizerFallback = false;
        let plan;
        try { plan = await relatedQuery(source.text, range, request.mode === 'lexical' ? undefined : async query => {
            // Token counting uses the exact installed embedding tokenizer, without the overflow check itself.
            const result = await lease.run<number>('query_tokens', { query }, { signal, onProgress });return result.result;
        }); } catch (error) {
            if (!request.allow_degraded || !(error instanceof DsearchError) || !['MODEL_NOT_INSTALLED', 'MODEL_UNAVAILABLE'].includes(error.code)) throw error;
            tokenizerFallback = true;plan = await relatedQuery(source.text, range);
        }
        const { source: _source, ...searchOptions } = request;
        const result = await this.keyword(SearchRequest.parse({ ...searchOptions, query: plan.query, purpose: 'find', filter: { field: 'document_key', operator: 'ne', value: request.source.doc_id } }), searchId, lease, signal, onProgress);
        await this.catalog.readDocument(request.source.doc_id, request.source.revision_id);
        return KeywordComplete.parse({ ...result, purpose: 'related', warnings: [...result.warnings, ...(tokenizerFallback ? ['QUERY_TOKENIZER_UNAVAILABLE'] : [])], query_plan: { ...result.query_plan, derived_query: true, source: { doc_id: request.source.doc_id, revision_id: request.source.revision_id }, used_spans: plan.used_spans, omitted_spans: plan.omitted_spans } });
    }
    async compare(request: CompareRequest, searchId: string, lease: ReadLease, signal: AbortSignal, onProgress: (p: Progress) => void): Promise<CompareComplete> {
        const left = await this.catalog.readDocument(request.left.doc_id, request.left.revision_id), right = await this.catalog.readDocument(request.right.doc_id, request.right.revision_id);
        const search = (ref: CompareRequest['left'], collection: string) => this.keyword(SearchRequest.parse({ query: request.query, purpose: 'find', mode: request.mode, rerank: request.rerank, allow_degraded: request.allow_degraded, candidate_limit: request.candidate_limit, limit: 1, collections: [collection], filter: { field: 'document_key', operator: 'eq', value: ref.doc_id } }), searchId, lease, signal, onProgress);
        const a = await search(request.left, left.collection.collection_id), b = await search(request.right, right.collection.collection_id);
        for (const result of [a, b]) if (!result.results.length && result.supplemental_results.length) result.warnings.push('LEXICAL_ONLY_SOURCE');
        await this.catalog.readDocument(request.left.doc_id, request.left.revision_id);await this.catalog.readDocument(request.right.doc_id, request.right.revision_id);
        return CompareComplete.parse({ search_id: searchId, state: 'completed', purpose: 'compare', persisted: false, left: { source: request.left, result: a }, right: { source: request.right, result: b } });
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
