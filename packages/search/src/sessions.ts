import { HeavyLane } from '@dsearch/runtime';
import { randomUUID } from 'node:crypto';
import { DsearchError, ErrorCode, ErrorReason, SearchRequest, RelatedRequest, CompareRequest, LiteralRequest } from '@dsearch/contracts';
import { SearchStatus, type SearchComplete } from '@dsearch/contracts/search';
import type { ReaderPool, ReadLease } from './readers.js';
import type { SourceSearch } from './source-search.js';
type Session = {
    id: string;
    scopes: string[];
    status: SearchStatus;
    controller: AbortController;
    lastAccess: number;
    running: boolean;
    expired: boolean;
    interrupted?: boolean;
    bytes: number;
    listeners: Set<(value: SearchStatus) => void>;
    lease?: ReadLease;
};
export class SearchSessions {
    private readonly values = new Map<string, Session>();
    private tail: Promise<void> = Promise.resolve();
    private literalTail: Promise<void> = Promise.resolve();
    private lexicalTail: Promise<void> = Promise.resolve();
    private closing = false;
    private recovering = false;
    private readonly timer: ReturnType<typeof setInterval>;
    constructor(readonly source: SourceSearch, readonly readers: ReaderPool, readonly settings: {
        ttlMs?: number;
        maxSessions?: number;
        maxBytes?: number;
        now?: () => number;
        lane?: HeavyLane;
        lexicalReaders?: ReaderPool;
    } = {}) {
        this.timer = setInterval(() => this.sweep(), 30000);
        this.timer.unref();
    }
    get queuedCount(): number { return [...this.values.values()].filter(s => s.status.state === 'queued').length; }
    private now(): number { return this.settings.now?.() ?? Date.now(); }
    private admit(native = true): void {
        this.sweep();
        if (this.closing || (native && this.recovering))
            throw new DsearchError('SERVICE_UNAVAILABLE');
        while (this.values.size >= (this.settings.maxSessions ?? 50)) {
            const victim = [...this.values.values()].filter(v => !v.running && ['completed', 'failed', 'cancelled'].includes(v.status.state)).sort((a, b) => a.lastAccess - b.lastAccess)[0];
            if (!victim)
                throw new DsearchError('BUSY');
            this.expire(victim);
        }
    }
    createKeyword(input: unknown) {
        const parsed = SearchRequest.safeParse(input);
        if (!parsed.success)
            throw new DsearchError('INVALID_REQUEST');
        const request = parsed.data;
        this.source.validateCollections(request.collections);
        this.admit();
        const lexical = request.mode === 'lexical' && !!this.settings.lexicalReaders;
        const lease = (lexical ? this.settings.lexicalReaders! : this.readers).reserve(request.expected_epoch);
        return this.enqueue(request.collections, (id, signal, progress) => this.source.keyword(request, id, lease, signal, progress), lease, !lexical);
    }
    createRelated(input: unknown) {
        const parsed = RelatedRequest.safeParse(input);if (!parsed.success) throw new DsearchError('INVALID_REQUEST');const request = parsed.data;
        const sourceScope = this.source.catalog.document(request.source.doc_id).collection_id;
        const scopes = [...new Set([...request.collections, sourceScope])];this.source.validateCollections(scopes);this.admit();
        const lease = this.readers.reserve(request.expected_epoch);
        return this.enqueue(scopes, (id, signal, progress) => this.source.related(request, id, lease, signal, progress), lease);
    }
    createCompare(input: unknown) {
        const parsed = CompareRequest.safeParse(input);if (!parsed.success) throw new DsearchError('INVALID_REQUEST');const request = parsed.data;
        const scopes = [...new Set([request.left, request.right].map(ref => this.source.catalog.document(ref.doc_id).collection_id))];this.source.validateCollections(scopes);this.admit();
        const lexical = request.mode === 'lexical' && !!this.settings.lexicalReaders;
        const lease = (lexical ? this.settings.lexicalReaders! : this.readers).reserve(request.expected_epoch);
        return this.enqueue(scopes, (id, signal, progress) => this.source.compare(request, id, lease, signal, progress), lease, !lexical);
    }
    createLiteral(input: unknown) { const parsed = LiteralRequest.safeParse(input); if (!parsed.success)
        throw new DsearchError('INVALID_REQUEST'); const request = parsed.data; this.source.validateCollections(request.collections); this.admit(false); return this.enqueue(request.collections, (id, signal, progress) => this.source.literal(request, id, signal, progress)); }
    private enqueue(scopes: string[], operation: (id: string, signal: AbortSignal, progress: (event: {
        phase: string;
        completed: number;
    }) => void) => Promise<SearchComplete>, lease?: ReadLease, native = true) {
        const id = randomUUID(), session: Session = { id, scopes, status: { search_id: id, state: 'queued', phase: 'queued' }, controller: new AbortController(), lastAccess: this.now(), running: false, expired: false, bytes: 128, listeners: new Set(), ...(lease ? { lease } : {}) };
        this.values.set(id, session);
        const acceptedAt = performance.now();
        const task = (lease ? native ? this.tail : this.lexicalTail : this.literalTail).then(async () => {
            if (session.controller.signal.aborted || session.expired)
                return;
            session.running = true;
            this.update(session, { search_id: id, state: 'running', phase: lease ? 'loading' : 'literal-scanning' });
            try {
                let queueMs = 0;
                const execute = async () => {
                    queueMs = performance.now() - acceptedAt;
                    if (lease && native && this.readers.unloadExcept) await this.readers.unloadExcept(lease.snapshot.generation_id);
                    return operation(id, session.controller.signal, event => { if (!session.controller.signal.aborted) this.update(session, { search_id: id, state: 'running', phase: event.phase, completed: event.completed }); });
                };
                if (lease && native && this.settings.lane?.busy) this.update(session, { search_id: id, state: 'running', phase: 'waiting-model' });
                const result = lease && native && this.settings.lane ? await this.settings.lane.run(session.controller.signal, execute) : await execute();
                if (session.controller.signal.aborted)
                    throw new DsearchError('CANCELLED');
                if (result.purpose !== 'compare' && result.effective_mode !== 'literal') { result.telemetry.queue_ms = queueMs;result.telemetry.total_ms = performance.now() - acceptedAt; }
                this.update(session, result);
            }
            catch (e) {
                const candidate = e && typeof e === 'object' && 'code' in e ? ErrorCode.safeParse(e.code) : undefined, code = session.interrupted ? 'SERVICE_UNAVAILABLE' : session.controller.signal.aborted ? 'CANCELLED' : candidate?.success ? candidate.data : 'INTERNAL_ERROR';
                this.update(session, code === 'CANCELLED' ? { search_id: id, state: 'cancelled', phase: 'cancelled' } : { search_id: id, state: 'failed', phase: 'failed', error: { ...(ErrorReason.safeParse(e && typeof e === 'object' && 'reason' in e ? e.reason : undefined).success ? { reason: (e as DsearchError).reason } : {}), code, message: code, retryable: ['BUSY', 'SERVICE_UNAVAILABLE', 'SOURCE_PENDING'].includes(code) } });
            }
            finally {
                session.running = false;
                this.free(session);
                this.sweep();
            }
        }).finally(() => { this.free(session); });
        if (lease && native) this.tail = task.catch(() => { });else if (lease) this.lexicalTail = task.catch(() => { });else this.literalTail = task.catch(() => { });
        return { search_id: id, state: 'queued' as const, status_url: '/v1/searches/' + id, events_url: '/v1/searches/' + id + '/events' };
    }
    private update(session: Session, status: SearchStatus): void {
        if (session.expired)
            return;
        session.status = SearchStatus.parse(status);
        session.bytes = Buffer.byteLength(JSON.stringify(session.status));
        for (const listener of session.listeners) {
            try {
                listener(session.status);
            }
            catch {
                session.listeners.delete(listener);
            }
        }
    }
    get(id: string): SearchStatus { this.sweep(); const session = this.values.get(id); if (!session)
        throw new DsearchError('RESULT_EXPIRED'); session.lastAccess = this.now(); return session.status; }
    cancel(id: string): SearchStatus {
        this.sweep();
        const session = this.values.get(id);
        if (!session)
            throw new DsearchError('RESULT_EXPIRED');
        if (['completed', 'failed', 'cancelled'].includes(session.status.state))
            return session.status;
        session.interrupted=false;session.controller.abort();
        this.update(session, { search_id: id, state: session.running ? 'cancel_requested' : 'cancelled', phase: session.running ? 'cancel-requested' : 'cancelled' });
        if (!session.running)
            this.free(session);
        return session.status;
    }
    subscribe(id: string, listener: (value: SearchStatus) => void): () => void {
        this.get(id);
        const session = this.values.get(id)!;
        if (session.listeners.size >= 16)
            throw new DsearchError('BUSY');
        session.listeners.add(listener);
        return () => session.listeners.delete(listener);
    }
    invalidateCollection(id: string): void { for (const session of this.values.values())
        if (session.scopes.includes(id))
            this.expire(session); }
    /** Preserve user cancellation; infrastructure interruption is a retryable failure. */
    async interruptForWake(): Promise<void> {
        this.recovering=true;
        for(const session of this.values.values())if(session.lease&&!session.controller.signal.aborted&&!['completed','failed','cancelled'].includes(session.status.state)){
            session.interrupted=true;session.controller.abort();
            if(!session.running){this.update(session,{search_id:session.id,state:'failed',phase:'failed',error:{code:'SERVICE_UNAVAILABLE',message:'SERVICE_UNAVAILABLE',retryable:true}});this.free(session);}
        }
        await Promise.allSettled([this.tail,this.lexicalTail]);
    }
    resumeAfterWake(): void { this.recovering=false; }
    private free(session: Session): void { const lease = session.lease; delete session.lease; lease?.release(); }
    private expire(session: Session): void { session.expired = true; session.controller.abort(); if (!session.running)
        this.free(session); session.listeners.clear(); this.values.delete(session.id); }
    sweep(): void {
        const ttl = this.settings.ttlMs ?? 15 * 60 * 1000;
        for (const session of this.values.values())
            if (this.now() - session.lastAccess >= ttl)
                this.expire(session);
        let bytes = [...this.values.values()].reduce((sum, s) => sum + s.bytes, 0);
        while (bytes > (this.settings.maxBytes ?? 64 * 1024 * 1024)) {
            const victim = [...this.values.values()].filter(s => !s.running && ['completed', 'failed', 'cancelled'].includes(s.status.state)).sort((a, b) => a.lastAccess - b.lastAccess)[0];
            if (!victim)
                break;
            bytes -= victim.bytes;
            this.expire(victim);
        }
    }
    async close(): Promise<void> { this.closing = true; clearInterval(this.timer); for (const s of this.values.values())
        s.controller.abort(); await Promise.allSettled([this.tail, this.literalTail, this.lexicalTail]); for (const s of this.values.values())
        this.free(s); this.values.clear(); await Promise.all([this.readers.close(), this.settings.lexicalReaders?.close()]); }
}
