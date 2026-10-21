import { HeavyLane } from '@dsearch/runtime';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, lstat, realpath, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { StateStore, Catalog, canonicalJSON, digest } from '@dsearch/catalog';
import { GenerationBuilder, createAlphaProfile, atomicFile } from '@dsearch/generations';
import { ReaderPool, SourceSearch, SearchSessions } from '@dsearch/search';
import { API_VERSION, DsearchError, ErrorCode, CollectionRequest, ReadRequest, ProfileManifest } from '@dsearch/contracts';
import { CollectionInfo, CollectionPatch, JobInfo, AppStatus, ReadResponse } from '@dsearch/contracts/control';
import { LocalAuth } from './auth.js';
import { privateRoot, takeOwnership } from './owner.js';
const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const statuses: Partial<Record<ErrorCode, number>> = { INVALID_REQUEST: 422, INVALID_QUERY: 422, UNSUPPORTED_LOCATOR: 422, UNAUTHORIZED: 401, SCOPE_DENIED: 403, NO_ACTIVE_GENERATION: 409, STALE_REVISION: 409, STALE_EPOCH: 409, RESULT_EXPIRED: 410, INPUT_TOO_LARGE: 413, MODEL_NOT_INSTALLED: 503, MODEL_UNAVAILABLE: 503, BUSY: 503, SERVICE_UNAVAILABLE: 503, CANCELLED: 409, NOT_FOUND: 404, SOURCE_PENDING: 409, SOURCE_TOO_LARGE: 413, SCOPE_INCOMPLETE: 409, RERANK_UNAVAILABLE: 503, INPUT_TOO_LONG: 422, INVALID_LOCATOR: 422 };
const envelope = (data: unknown, requestId: string) => ({ schema_version: API_VERSION, request_id: requestId, ok: true, data });
function json(res: ServerResponse, status: number, value: unknown) { if (res.destroyed || res.writableEnded)
    return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
async function body(req: IncomingMessage): Promise<unknown> {
    const type = req.headers['content-type'];
    if (!type || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type))
        throw new DsearchError('INVALID_REQUEST');
    const declared = req.headers['content-length'];
    if (declared && Number(declared) > 262144)
        throw new DsearchError('INPUT_TOO_LARGE');
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const clean = () => { req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', failed); };
        const failed = () => { clean(); reject(new DsearchError('INVALID_REQUEST')); };
        const data = (chunk: Buffer) => { size += chunk.length; if (size > 262144) {
            clean();
            req.pause();
            reject(new DsearchError('INPUT_TOO_LARGE'));
        }
        else
            chunks.push(chunk); };
        const end = () => { clean(); try {
            resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
        }
        catch {
            reject(new DsearchError('INVALID_REQUEST'));
        } };
        req.on('data', data);
        req.on('end', end);
        req.on('error', failed);
        req.on('aborted', failed);
    });
}
async function assets(folder: string): Promise<Map<string, {
    bytes: Buffer;
    type: string;
}>> {
    const root = await realpath(folder);
    const result = new Map<string, {
        bytes: Buffer;
        type: string;
    }>();
    for (const [name, type] of Object.entries({ 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'app.css': 'text/css; charset=utf-8' })) {
        const path = join(root, name), info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
            throw new DsearchError('COMPATIBILITY_FAILED');
        result.set(name, { bytes: await readFile(path), type });
    }
    return result;
}
export type ApplicationOptions = {
    dataRoot?: string;
    engineRoot?: string;
    modelRoot?: string;
    webRoot?: string;
    profile?: ProfileManifest;
    port?: number;
    now?: () => number;
};
export async function createApplication(options: ApplicationOptions = {}) {
    const root = await privateRoot(resolve(options.dataRoot ?? join(homedir(), 'Library/Application Support/dsearch'))), instance = randomUUID(), release = await takeOwnership(root, instance);
    let state: StateStore | undefined, auth: LocalAuth | undefined, stopWorkers: (() => Promise<void>) | undefined, startupCleanup: (() => Promise<void>) | undefined;
    try {
        state = await StateStore.open(root);
        const catalog = new Catalog(state), engineRoot = options.engineRoot ?? join(workspace, '.local/qmd-upstream'), modelRoot = options.modelRoot ?? join(workspace, '.local/models');
        const profile = options.profile ? ProfileManifest.parse(options.profile) : (await createAlphaProfile(engineRoot)).manifest, profileFp = digest(canonicalJSON(profile));
        const lane = new HeavyLane();
        let readers: ReaderPool;
        const builder = new GenerationBuilder(catalog, { engineRoot, modelRoot, profile, embedRole: profile.models.embed.dimension === 1024 ? 'embed' : 'reference', lane, beforeWork: () => readers.unloadExcept() });
        readers = new ReaderPool(catalog, { engineRoot, modelRoot, profile_fp: profileFp });
        const sessions = new SearchSessions(new SourceSearch(catalog), readers, { lane });
        stopWorkers = async () => { await Promise.allSettled([builder.close(), sessions.close()]); };
        auth = await LocalAuth.open(root, instance, options.now);
        const authentication = auth, store = state, staticFiles = await assets(options.webRoot ?? join(workspace, 'apps/web/dist-web'));
        let origin = '', authority = '', closing: Promise<void> | undefined;
        const streams = new Set<ServerResponse>(), inflight = new Set<Promise<void>>();
        const collectionInfo = (id: string) => { const c = catalog.collection(id), policy = JSON.parse(c.scope_json), counts: Record<string, number> = {}; for (const doc of catalog.documents(id))
            if (doc.present)
                counts[doc.eligibility] = (counts[doc.eligibility] ?? 0) + 1; return CollectionInfo.parse({ collection_id: c.collection_id, name: c.name, root_path: c.root_path, enabled: !!c.enabled, preset: policy.preset, include: policy.include, exclude: policy.exclude, scope_fp: c.scope_fp, coverage: counts, scope: catalog.scanStatus(id) }); };
        const jobInfo = (id: string) => { const job = builder.getJob(id); return JobInfo.parse({ job_id: job.job_id, generation_id: job.generation_id, state: job.state, phase: job.phase, progress: job.progress, error_code: job.error_code, updated_at: job.updated_at }); };
        const status = () => {
            const generation = store.db.prepare("SELECT a.generation_id,a.epoch,g.profile_fp,g.source_seq,g.coverage_json FROM active_slot a JOIN generations g ON g.generation_id=a.generation_id WHERE a.slot=1 AND g.state='active'").get();
            const coverage: Record<string, number> = {};
            if (generation)
                for (const doc of JSON.parse(String(generation.coverage_json)))
                    coverage[doc.state] = (coverage[doc.state] ?? 0) + 1;
            const profileState = store.db.prepare('SELECT status FROM profiles WHERE profile_id=?').get(profile.profile_id)?.status ?? 'draft';
            return AppStatus.parse({ version: '0.1.0-alpha', instance_id: instance, pid: process.pid, source_seq: store.sourceSeq, generation: generation ? { generation_id: generation.generation_id, epoch: generation.epoch, profile_fp: generation.profile_fp, source_seq: generation.source_seq } : null, profile: { profile_id: profile.profile_id, profile_fp: profileFp, status: profileState }, busy: builder.busy, scope_incomplete: catalog.listCollections().some(c => c.enabled && catalog.scanStatus(c.collection_id).status === 'incomplete'), needs_rebuild: !generation || generation.profile_fp !== profileFp || generation.source_seq !== store.sourceSeq, modes: { lexical: !!generation && generation.profile_fp === profileFp, hybrid: !!generation && generation.profile_fp === profileFp, deep: false, literal: true }, execution: { heavy_concurrency: 1, heavy_busy: lane.busy, queued_requests: lane.queued + sessions.queuedCount, resident_workers: readers.residentWorkers, idle_shutdown_seconds: 300 }, coverage, jobs: store.db.prepare('SELECT job_id FROM jobs ORDER BY updated_at DESC LIMIT 20').all().map(row => jobInfo(String(row.job_id))) });
        };
        const requireOrigin = (req: IncomingMessage) => { if (req.headers.origin !== origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))
            throw new DsearchError('SCOPE_DENIED'); };
        const route = async (req: IncomingMessage, res: ServerResponse, requestId: string) => {
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
            res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
            if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== origin))
                throw new DsearchError('SCOPE_DENIED');
            if (closing)
                throw new DsearchError('SERVICE_UNAVAILABLE');
            const path = req.url ?? '';
            if (path.includes('?') || path.includes('#') || /%(?![a-fA-F0-9]{2})/.test(path))
                throw new DsearchError('INVALID_REQUEST');
            if (path === '/healthz' && req.method === 'GET') {
                json(res, 200, { ok: true, version: '0.1.0-alpha' });
                return;
            }
            const asset = staticFiles.get(path === '/' ? 'index.html' : path.slice(1));
            if (asset && ['GET', 'HEAD'].includes(req.method ?? '')) {
                res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.bytes.length });
                res.end(req.method === 'HEAD' ? undefined : asset.bytes);
                return;
            }
            if (path === '/v1/ui/exchange' && req.method === 'POST') {
                requireOrigin(req);
                const value = await body(req);
                if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('code' in value) || typeof value.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.code))
                    throw new DsearchError('INVALID_REQUEST');
                const session = authentication.exchange(value.code);
                res.setHeader('Set-Cookie', session.cookie);
                json(res, 200, envelope({ csrf_token: session.csrf_token }, requestId));
                return;
            }
            const mode = authentication.authenticate(req, origin);
            if (path === '/v1/ui/session' && req.method === 'GET') {
                const session = authentication.cookieSession(req, origin);
                json(res, 200, envelope({ csrf_token: session.csrf }, requestId));
                return;
            }
            if (path === '/v1/ui/code' && req.method === 'POST') {
                if (mode !== 'bearer')
                    throw new DsearchError('SCOPE_DENIED');
                json(res, 200, envelope({ url: authentication.issue(origin) }, requestId));
                return;
            }
            if (path === '/v1/status' && req.method === 'GET') {
                json(res, 200, envelope(status(), requestId));
                return;
            }
            if (path === '/v1/collections' && req.method === 'GET') {
                json(res, 200, envelope(catalog.listCollections().map(c => collectionInfo(c.collection_id)), requestId));
                return;
            }
            if (path === '/v1/collections' && req.method === 'POST') {
                const parsed = CollectionRequest.safeParse(await body(req));
                if (!parsed.success)
                    throw new DsearchError('INVALID_REQUEST');
                const collection = await catalog.addCollection(parsed.data);
                json(res, 201, envelope(collectionInfo(collection.collection_id), requestId));
                return;
            }
            const collection = /^\/v1\/collections\/([A-Za-z0-9_-]{1,128})$/.exec(path);
            if (collection && req.method === 'PATCH') {
                const parsed = CollectionPatch.safeParse(await body(req));
                if (!parsed.success)
                    throw new DsearchError('INVALID_REQUEST');
                const { enabled, ...scope } = parsed.data;
                if (Object.keys(scope).length)
                    catalog.setScope(collection[1]!, scope);
                if (enabled !== undefined)
                    catalog.setEnabled(collection[1]!, enabled);
                sessions.invalidateCollection(collection[1]!);
                json(res, 200, envelope(collectionInfo(collection[1]!), requestId));
                return;
            }
            if (path === '/v1/reconcile' && req.method === 'POST') {
                const value = await body(req);
                if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length)
                    throw new DsearchError('INVALID_REQUEST');
                const job = builder.start();
                void job.completion.then(() => readers.sweep(), () => { });
                json(res, 202, envelope({ job_id: job.job_id, generation_id: job.generation_id, state: 'queued' }, requestId));
                return;
            }
            if (path === '/v1/searches' && req.method === 'POST') {
                json(res, 202, envelope(sessions.createKeyword(await body(req)), requestId));
                return;
            }
            if (path === '/v1/related-searches' && req.method === 'POST') { json(res, 202, envelope(sessions.createRelated(await body(req)), requestId));return; }
            if (path === '/v1/comparisons' && req.method === 'POST') { json(res, 202, envelope(sessions.createCompare(await body(req)), requestId));return; }
            if (path === '/v1/literal-searches' && req.method === 'POST') {
                json(res, 202, envelope(sessions.createLiteral(await body(req)), requestId));
                return;
            }
            if (path === '/v1/documents/read' && req.method === 'POST') {
                const value = await body(req);
                if (value && typeof value === 'object' && 'locator' in value && value.locator && typeof value.locator === 'object' && 'kind' in value.locator && value.locator.kind !== 'markdown')
                    throw new DsearchError('UNSUPPORTED_LOCATOR');
                const parsed = ReadRequest.safeParse(value);
                if (!parsed.success)
                    throw new DsearchError('INVALID_REQUEST');
                json(res, 200, envelope(ReadResponse.parse(await catalog.read(parsed.data)), requestId));
                return;
            }
            const search = /^\/v1\/searches\/([A-Za-z0-9_-]{1,128})(\/events)?$/.exec(path);
            if (search) {
                const id = search[1]!;
                if (req.method === 'DELETE' && !search[2]) {
                    json(res, 202, envelope(sessions.cancel(id), requestId));
                    return;
                }
                if (req.method === 'GET' && !search[2]) {
                    json(res, 200, envelope(sessions.get(id), requestId));
                    return;
                }
                if (req.method === 'GET' && search[2]) {
                    const initial = sessions.get(id);
                    let heartbeat: ReturnType<typeof setInterval> | undefined, unsubscribe: () => void = () => { };
                    let ended = false;
                    const stop = () => { if (ended)
                        return; ended = true; if (heartbeat)
                        clearInterval(heartbeat); unsubscribe(); streams.delete(res); res.end(); };
                    const send = (value: unknown) => { if (ended)
                        return; if (res.writableLength > 1024 * 1024) {
                        stop();
                        return;
                    } res.write('event: state\ndata: ' + JSON.stringify(envelope(value, requestId)) + '\n\n'); if (value && typeof value === 'object' && 'state' in value && ['completed', 'failed', 'cancelled'].includes(String(value.state)))
                        stop(); };
                    unsubscribe = sessions.subscribe(id, send);
                    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Connection': 'keep-alive' });
                    streams.add(res);
                    res.on('close', stop);
                    send(initial);
                    if (!ended) {
                        heartbeat = setInterval(() => { try {
                            sessions.get(id);
                            res.write(': keepalive\n\n');
                        }
                        catch {
                            stop();
                        } }, 15000);
                        heartbeat.unref();
                    }
                    return;
                }
            }
            const job = /^\/v1\/jobs\/([A-Za-z0-9_-]{1,128})$/.exec(path);
            if (job && req.method === 'GET') {
                json(res, 200, envelope(jobInfo(job[1]!), requestId));
                return;
            }
            if (job && req.method === 'DELETE') {
                builder.cancel(job[1]!);
                json(res, 202, envelope(jobInfo(job[1]!), requestId));
                return;
            }
            if (path === '/v1/shutdown' && req.method === 'POST') {
                if (mode !== 'bearer')
                    throw new DsearchError('SCOPE_DENIED');
                json(res, 202, envelope({ state: 'stopping' }, requestId));
                setImmediate(() => void close());
                return;
            }
            throw new DsearchError('NOT_FOUND');
        };
        const server = createServer((req, res) => {
            req.on('error', () => { });
            res.on('error', () => res.destroy());
            const id = randomUUID();
            const task = route(req, res, id).catch(error => { const code = error instanceof DsearchError ? error.code : 'INTERNAL_ERROR'; if (res.destroyed || res.writableEnded)
                return; if (code === 'INPUT_TOO_LARGE' && !res.headersSent)
                res.setHeader('Connection', 'close'); if (!res.headersSent)
                json(res, statuses[code] ?? 500, { schema_version: 1, request_id: id, ok: false, error: { ...(error instanceof DsearchError && error.reason ? { reason: error.reason } : {}), code, message: code, retryable: ['BUSY', 'SERVICE_UNAVAILABLE', 'SOURCE_PENDING'].includes(code) } });
            else
                res.end(); });
            inflight.add(task);
            void task.then(() => inflight.delete(task), () => inflight.delete(task));
        });
        startupCleanup = close;
        server.requestTimeout = 15000;
        server.headersTimeout = 10000;
        const port = options.port ?? 0;
        if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
            throw new DsearchError('INVALID_REQUEST');
        server.listen(port, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string')
            throw new DsearchError('INTERNAL_ERROR');
        authority = '127.0.0.1:' + address.port;
        origin = 'http://' + authority;
        await atomicFile(join(root, 'runtime.json'), canonicalJSON({ schema_version: 1, instance_id: instance, pid: process.pid, url: origin, started_at: new Date().toISOString() }) + '\n');
        function close(): Promise<void> {
            if (closing)
                return closing;
            closing = (async () => {
                const stopped = new Promise<void>(resolve => server.close(() => resolve()));
                for (const stream of streams)
                    stream.end();
                server.closeAllConnections();
                await Promise.allSettled([...inflight]);
                await stopWorkers!();
                authentication.close();
                await stopped;
                store.close();
                try {
                    const info = await lstat(join(root, 'runtime.json'));
                    if (info.isFile() && !info.isSymbolicLink() && info.size < 4096) {
                        const runtime = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'));
                        if (runtime.instance_id === instance)
                            await rm(join(root, 'runtime.json'));
                    }
                }
                catch (e) {
                    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                        throw e;
                }
                finally {
                    await release();
                }
            })();
            return closing;
        }
        return { url: origin, instance_id: instance, root, catalog, builder, sessions, status, close };
    }
    catch (e) {
        if (startupCleanup)
            await startupCleanup();
        else {
            await stopWorkers?.();
            auth?.close();
            state?.close();
            await release();
        }
        throw e;
    }
}
