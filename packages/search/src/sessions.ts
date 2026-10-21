import { randomUUID } from 'node:crypto';
import { DsearchError, ErrorCode, SearchRequest, LiteralRequest } from '@dsearch/contracts';
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
    bytes: number;
    listeners: Set<(value: SearchStatus) => void>;
    lease?: ReadLease;
};
export class SearchSessions {
    private readonly values = new Map<string, Session>();
    private tail: Promise<void> = Promise.resolve();
    private closing = false;
    private readonly timer: ReturnType<typeof setInterval>;
    constructor(readonly source: SourceSearch, readonly readers: ReaderPool, readonly settings: {
        ttlMs?: number;
        maxSessions?: number;
        maxBytes?: number;
        now?: () => number;
    } = {}) {
        this.timer = setInterval(() => this.sweep(), 30000);
        this.timer.unref();
    }
    private now(): number { return this.settings.now?.() ?? Date.now(); }
    private admit(): void {
        this.sweep();
        if (this.closing)
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
        if (request.mode !== 'lexical' || request.rerank)
            throw new DsearchError('INVALID_REQUEST', 'This alpha supports lexical and literal search');
        this.source.validateCollections(request.collections);
        this.admit();
        const lease = this.readers.reserve(request.expected_epoch);
        return this.enqueue(request.collections, (id, signal, progress) => this.source.keyword(request, id, lease, signal, progress), lease);
    }
    createLiteral(input: unknown) { const parsed = LiteralRequest.safeParse(input); if (!parsed.success)
        throw new DsearchError('INVALID_REQUEST'); const request = parsed.data; this.source.validateCollections(request.collections); this.admit(); return this.enqueue(request.collections, (id, signal, progress) => this.source.literal(request, id, signal, progress)); }
    private enqueue(scopes: string[], operation: (id: string, signal: AbortSignal, progress: (event: {
        phase: string;
        completed: number;
    }) => void) => Promise<SearchComplete>, lease?: ReadLease) {
        const id = randomUUID(), session: Session = { id, scopes, status: { search_id: id, state: 'queued', phase: 'queued' }, controller: new AbortController(), lastAccess: this.now(), running: false, expired: false, bytes: 128, listeners: new Set(), ...(lease ? { lease } : {}) };
        this.values.set(id, session);
        const task = this.tail.then(async () => {
            if (session.controller.signal.aborted || session.expired)
                return;
            session.running = true;
            this.update(session, { search_id: id, state: 'running', phase: lease ? 'loading' : 'literal-scanning' });
            try {
                const result = await operation(id, session.controller.signal, event => { if (!session.controller.signal.aborted)
                    this.update(session, { search_id: id, state: 'running', phase: event.phase, completed: event.completed }); });
                if (session.controller.signal.aborted)
                    throw new DsearchError('CANCELLED');
                this.update(session, result);
            }
            catch (e) {
                const candidate = e && typeof e === 'object' && 'code' in e ? ErrorCode.safeParse(e.code) : undefined, code = session.controller.signal.aborted ? 'CANCELLED' : candidate?.success ? candidate.data : 'INTERNAL_ERROR';
                this.update(session, code === 'CANCELLED' ? { search_id: id, state: 'cancelled', phase: 'cancelled' } : { search_id: id, state: 'failed', phase: 'failed', error: { code, message: code, retryable: ['BUSY', 'SERVICE_UNAVAILABLE', 'SOURCE_PENDING'].includes(code) } });
            }
            finally {
                session.running = false;
                this.free(session);
                this.sweep();
            }
        }).finally(() => { this.free(session); });
        this.tail = task.catch(() => { });
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
        const session = this.values.get(id);
        if (!session)
            throw new DsearchError('RESULT_EXPIRED');
        if (['completed', 'failed', 'cancelled'].includes(session.status.state))
            return session.status;
        session.controller.abort();
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
        s.controller.abort(); await this.tail; for (const s of this.values.values())
        this.free(s); this.values.clear(); await this.readers.close(); }
}
