import { HeavyLane } from '@dsearch/runtime';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, lstat, realpath, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { StateStore, Catalog, canonicalJSON, digest } from '@dsearch/catalog';
import { createAlphaProfile, atomicFile, reconcileInterruptedBuilds, BackupStore, GenerationGC, reconcileGC, maintenanceActive } from '@dsearch/generations';
import { ReaderPool, SourceSearch, SearchSessions } from '@dsearch/search';
import { API_VERSION, DsearchError, ErrorCode, CollectionRequest, ReadRequest, ProfileManifest, DocumentRef } from '@dsearch/contracts';
import { CollectionInfo, CollectionPatch, ReconcileRequest, JobInfo, AppStatus, ReadResponse, ExportRequest, CoverageRequest, ModelAction, ActivateRequest, RollbackRequest, PrepareProfileRequest, GCPolicy, GCApply, MaintenanceResult, retryableJobCode } from '@dsearch/contracts/control';
import { PreferenceStore, exportSearch, openRegisteredDocument } from './management.js';
import { ManagedJobs } from './jobs.js';
import { ModelManager } from './models.js';
import { ProfileController } from './profiles.js';
import {Synchronization} from './synchronization.js';
import { recoverActiveGeneration } from './recovery.js';
import { reconcileRestore } from './restore.js';
import { LocalAuth } from './auth.js';
import { privateRoot, takeOwnership } from './owner.js';
const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const statuses: Partial<Record<ErrorCode, number>> = { INVALID_REQUEST: 422, INVALID_QUERY: 422, UNSUPPORTED_LOCATOR: 422, UNAUTHORIZED: 401, SCOPE_DENIED: 403, NO_ACTIVE_GENERATION: 409, STALE_REVISION: 409, STALE_EPOCH: 409, RESULT_EXPIRED: 410, INPUT_TOO_LARGE: 413, MODEL_NOT_INSTALLED: 503, MODEL_UNAVAILABLE: 503, RESOURCE_EXHAUSTED:503, BUSY: 503, SERVICE_UNAVAILABLE: 503, CANCELLED: 409, NOT_FOUND: 404, SOURCE_PENDING: 409, SOURCE_TOO_LARGE: 413, SCOPE_INCOMPLETE: 409, RERANK_UNAVAILABLE: 503, INPUT_TOO_LONG: 422, INVALID_LOCATOR: 422 };
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
    maintenanceFault?: (phase:string)=>void|Promise<void>;
    synchronization?: ConstructorParameters<typeof Synchronization>[1]&{enabled?:boolean};
};
export async function createApplication(options: ApplicationOptions = {}) {
    const requestedRoot=resolve(options.dataRoot ?? join(homedir(), 'Library/Application Support/dsearch'));await reconcileRestore(requestedRoot);
    const root = await privateRoot(requestedRoot), instance = randomUUID(), release = await takeOwnership(root, instance);
    let state: StateStore | undefined, auth: LocalAuth | undefined, stopWorkers: (() => Promise<void>) | undefined, startupCleanup: (() => Promise<void>) | undefined;
    try {
        state = await StateStore.open(root);reconcileInterruptedBuilds(state);
        const catalog = new Catalog(state), engineRoot = options.engineRoot ?? join(workspace, '.local/qmd-recovery'), modelRoot = options.modelRoot ?? join(workspace, '.local/models');
        const backups=new BackupStore(catalog,{...(options.maintenanceFault?{fault:options.maintenanceFault}:{})}),collector=new GenerationGC(catalog,{...(options.maintenanceFault?{fault:options.maintenanceFault}:{}),backupReferences:()=>backups.generationReferences()});await reconcileGC(catalog);await backups.reconcile();
        const knownProfiles = options.profile ? [ProfileManifest.parse(options.profile)] : (await Promise.all([createAlphaProfile(engineRoot), createAlphaProfile(engineRoot, 'reference')])).map(p => p.manifest);
        const recovery=await recoverActiveGeneration(catalog,{engineRoot,modelRoot,profileFingerprints:new Set(knownProfiles.map(p=>digest(canonicalJSON(p))))});
        const models = await ModelManager.open(modelRoot), managed = new ManagedJobs(state,{profiles:new Set(knownProfiles.map(p=>digest(canonicalJSON(p))))}), lane = new HeavyLane();
        let profiles: ProfileController;
        const readers = new ReaderPool(catalog, { engineRoot, modelRoot, acceptProfile: fp => fp === profiles.fingerprint });
        stopWorkers = () => readers.close();
        profiles = new ProfileController(catalog, { profiles: knownProfiles, engineRoot, modelRoot, models, lane, readers });
        const sessions = new SearchSessions(new SourceSearch(catalog), readers, { lane });
        stopWorkers = async () => { await Promise.allSettled([profiles.close(), managed.close(), sessions.close()]); };
        const preferences = new PreferenceStore(root);await preferences.load();
        const synchronization=new Synchronization({catalog,enabled:()=>options.synchronization?.enabled??preferences.get().auto_sync,busy:()=>profiles.busy||managed.busy||maintenanceActive(state!),profile:()=>profiles.fingerprint,models:()=>models.availability(profiles.profile.models.embed.dimension===1024?'embed':'reference'),build:()=>profiles.builder.start(),cancel:id=>profiles.builder.cancel(id),published:()=>readers.sweep(),onWake:()=>lane.run(new AbortController().signal,()=>readers.unloadExcept(),'background')},options.synchronization);
        stopWorkers=async()=>{await Promise.allSettled([synchronization.close(),profiles.close(),managed.close(),sessions.close()]);};
        auth = await LocalAuth.open(root, instance, options.now);
        const authentication = auth, store = state, staticFiles = await assets(options.webRoot ?? join(workspace, 'apps/web/dist-web'));
        let origin = '', authority = '', closing: Promise<void> | undefined;
        const streams = new Set<ServerResponse>(), inflight = new Set<Promise<void>>();
        const collectionInfo = (id: string) => { const c = catalog.collection(id), policy = JSON.parse(c.scope_json), counts: Record<string, number> = {}; for (const doc of catalog.documents(id))
            if (doc.present)
                counts[doc.eligibility] = (counts[doc.eligibility] ?? 0) + 1; return CollectionInfo.parse({ collection_id: c.collection_id, name: c.name, root_path: c.root_path, enabled: !!c.enabled, preset: "general", policy_version: 2, legacy_compatibility: policy.metadata_mode === "legacy-v1", path_prefixes: policy.path_prefixes ?? [], metadata_filter: policy.metadata_filter ?? null, navigation_headings: policy.navigation_headings ?? [], migration: catalog.migrationInfo(id), include: policy.include, exclude: policy.exclude, scope_fp: c.scope_fp, coverage: counts, scope: catalog.scanStatus(id) }); };
        const jobInfo = (id: string) => managed.info(id);
        const startBackup=()=>{
          const accepted=managed.start('backup',async(signal,progress)=>{progress('backing-up');const info=await backups.create(signal);store.db.prepare('UPDATE jobs SET cursor_json=? WHERE job_id=?').run(canonicalJSON({result:{kind:'backup',backup:info}}),accepted.job_id);progress('complete',{bytes:info.bytes,generations:info.generations});});return accepted;
        };
        const status = () => {
            const profile = profiles.profile, profileFp = profiles.fingerprint;
            const generation = store.db.prepare("SELECT a.generation_id,a.epoch,g.profile_fp,g.source_seq,g.coverage_json FROM active_slot a JOIN generations g ON g.generation_id=a.generation_id WHERE a.slot=1 AND g.state='active'").get();
            const coverage: Record<string, number> = {};
            if (generation)
                for (const doc of JSON.parse(String(generation.coverage_json)))
                    coverage[doc.state] = (coverage[doc.state] ?? 0) + 1;
            const profileState = store.db.prepare('SELECT status FROM profiles WHERE profile_id=?').get(profile.profile_id)?.status ?? 'draft';
            return AppStatus.parse({ version: '0.1.0-alpha', instance_id: instance, pid: process.pid, source_seq: store.sourceSeq, generation: generation ? { generation_id: generation.generation_id, epoch: generation.epoch, profile_fp: generation.profile_fp, source_seq: generation.source_seq } : null, profile: { profile_id: profile.profile_id, profile_fp: profileFp, status: profileState }, recovery:recovery.state==='rebuild_required'&&generation?{state:'recovered',damaged_generation_id:recovery.damaged_generation_id,recovered_generation_id:generation.generation_id}:recovery, synchronization:synchronization.info(), busy: profiles.busy || managed.busy || synchronization.busy || maintenanceActive(store), scope_incomplete: catalog.listCollections().some(c => c.enabled && catalog.scanStatus(c.collection_id).status === 'incomplete'), needs_rebuild: !generation || generation.profile_fp !== profileFp || generation.source_seq !== store.sourceSeq, policy_upgrade_pending: catalog.policyUpgradePending, modes: { lexical: !!generation && generation.profile_fp === profileFp && !catalog.policyUpgradePending, hybrid: !!generation && generation.profile_fp === profileFp && !catalog.policyUpgradePending, deep: false, literal: true }, execution: { heavy_concurrency: 1, heavy_busy: lane.busy, maintenance_busy:maintenanceActive(store), queued_requests: lane.queued + sessions.queuedCount, resident_workers: readers.residentWorkers, idle_shutdown_seconds: 300 }, coverage, jobs: store.db.prepare('SELECT job_id FROM jobs ORDER BY updated_at DESC LIMIT 20').all().map(row => jobInfo(String(row.job_id))) });
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
            const asset = staticFiles.get(['/', '/setup', '/search', '/related', '/compare', '/collections', '/jobs', '/settings', '/diagnostics'].includes(path) ? 'index.html' : path.slice(1));
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
            if(maintenanceActive(store)&&!(path==='/v1/settings'&&synchronization.busy)&&!['GET','HEAD'].includes(req.method??'')&&!['/v1/searches','/v1/related-searches','/v1/comparisons','/v1/literal-searches','/v1/documents/read','/v1/documents/info','/v1/documents/open','/v1/diagnostics','/v1/ui/code','/v1/shutdown'].includes(path)&&!(req.method==='DELETE'&&/^\/v1\/(jobs|searches)\/[A-Za-z0-9_-]+$/.test(path)))throw new DsearchError('BUSY');
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
            if (path === '/v1/settings' && req.method === 'GET') { json(res, 200, envelope(preferences.get(), requestId));return; }
            if (path === '/v1/settings' && req.method === 'PUT') { const before=preferences.get().auto_sync,value=await preferences.set(await body(req));if(before!==value.auto_sync)synchronization.refresh();json(res, 200, envelope(value, requestId));return; }
            if (path === '/v1/diagnostics' && req.method === 'POST') {
                const input = await body(req);if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new DsearchError('INVALID_REQUEST');
                const current = status();json(res, 200, envelope({ diagnostic_version: 1, created_at: new Date().toISOString(), runtime: { node: process.versions.node, platform: process.platform, arch: process.arch }, version: current.version, generation: current.generation, profile: current.profile, recovery:current.recovery,synchronization:current.synchronization, execution: current.execution, needs_rebuild: current.needs_rebuild, scope_incomplete: current.scope_incomplete, coverage: current.coverage, jobs: current.jobs.map(job => ({ state: job.state, phase: job.phase, error_code: job.error_code })), storage_policy: { queries: 'memory-only', results: 'memory-only', source_writes: false }, capabilities: { mcp: true, automatic_sync:true, incremental_sync: true, backup_restore: true, deep: false } }, requestId));return;
            }
            if (path === '/v1/documents/open' && req.method === 'POST') {
                const parsed = DocumentRef.safeParse(await body(req));if (!parsed.success) throw new DsearchError('INVALID_REQUEST');
                json(res, 200, envelope(await openRegisteredDocument(catalog, parsed.data.doc_id, parsed.data.revision_id), requestId));return;
            }
            const exported = /^\/v1\/searches\/([A-Za-z0-9_-]{1,128})\/export$/.exec(path);
            if (exported && req.method === 'POST') { const parsed = ExportRequest.safeParse(await body(req));if (!parsed.success) throw new DsearchError('INVALID_REQUEST');json(res, 200, envelope(exportSearch(sessions.get(exported[1]!), parsed.data.include_query), requestId));return; }
            const coveragePath = /^\/v1\/collections\/([A-Za-z0-9_-]{1,128})\/coverage$/.exec(path);
            if (coveragePath && req.method === 'POST') { const parsed = CoverageRequest.safeParse(await body(req));if (!parsed.success) throw new DsearchError('INVALID_REQUEST');const c = catalog.collection(coveragePath[1]!), docs = catalog.documents(c.collection_id).filter(d => d.present), { offset, limit } = parsed.data;json(res, 200, envelope({ collection_id: c.collection_id, total: docs.length, offset, has_more: offset + limit < docs.length, documents: docs.slice(offset, offset + limit).map(d => ({ doc_id: d.doc_id, relative_path: d.relative_path, eligibility: d.eligibility, reason: d.eligibility_reason, revision_id: d.latest_revision_id })), scope: catalog.scanStatus(c.collection_id) }, requestId));return; }
            if (path === '/v1/collections/preview' && req.method === 'POST') { json(res, 200, envelope(await catalog.preview(await body(req)), requestId));return; }
            if(path==='/v1/backups'&&req.method==='GET'){if(maintenanceActive(store))throw new DsearchError('BUSY');json(res,200,envelope(await backups.list(),requestId));return;}
            if(path==='/v1/backups'&&req.method==='POST'){if(!PrepareProfileRequest.safeParse(await body(req)).success)throw new DsearchError('INVALID_REQUEST');if(managed.busy||profiles.busy)throw new DsearchError('BUSY');json(res,202,envelope(startBackup(),requestId));return;}
            if(path==='/v1/maintenance/gc/preview'&&req.method==='POST'){const parsed=GCPolicy.safeParse(await body(req));if(!parsed.success)throw new DsearchError('INVALID_REQUEST');if(maintenanceActive(store))throw new DsearchError('BUSY');json(res,200,envelope(await collector.preview(parsed.data),requestId));return;}
            if(path==='/v1/maintenance/gc/apply'&&req.method==='POST'){
             const parsed=GCApply.safeParse(await body(req));if(!parsed.success)throw new DsearchError('INVALID_REQUEST');if(managed.busy||profiles.busy)throw new DsearchError('BUSY');const {plan_id,...policy}=parsed.data;
             const preview=await collector.preview(policy);if(preview.plan_id!==plan_id)throw new DsearchError('STALE_EPOCH');
             const accepted=managed.start('generation-gc',async(signal,progress)=>{progress('collecting');const result=await collector.apply(plan_id,policy,signal);store.db.prepare('UPDATE jobs SET cursor_json=? WHERE job_id=?').run(canonicalJSON({result:{kind:'generation-gc',generation_ids:result.removed,bytes:result.bytes}}),accepted.job_id);progress('complete',{generations:result.removed.length,bytes:result.bytes});});json(res,202,envelope(accepted,requestId));return;
            }
            const jobResult=/^\/v1\/jobs\/([A-Za-z0-9_-]{1,128})\/result$/.exec(path);
            if(jobResult&&req.method==='GET'){const row=store.db.prepare('SELECT state,cursor_json FROM jobs WHERE job_id=?').get(jobResult[1]!);if(!row)throw new DsearchError('NOT_FOUND');const result=JSON.parse(String(row.cursor_json)).result;if(!result)throw new DsearchError('SOURCE_PENDING');json(res,200,envelope(MaintenanceResult.parse(result),requestId));return;}
            if (path === '/v1/models' && req.method === 'GET') { json(res, 200, envelope(await models.list(), requestId));return; }
            if (path === '/v1/profiles' && req.method === 'GET') { json(res, 200, envelope(profiles.list(), requestId));return; }
            if (['/v1/models/check', '/v1/models/prepare'].includes(path) && req.method === 'POST') {
                const parsed = ModelAction.safeParse(await body(req));if (!parsed.success) throw new DsearchError('INVALID_REQUEST');if (profiles.busy) throw new DsearchError('BUSY');
                const roles = profiles.roles(profiles.resolve(parsed.data.profile_id)), download = path.endsWith('/prepare');
                const accepted = managed.start(download ? 'model-prepare' : 'model-check', async (signal, progress) => { if (download) await models.prepare(roles, signal, progress);else await models.check(roles, signal, progress);await lane.run(signal, () => readers.unloadExcept());synchronization.notify('models',true); }, null, { profile_id: parsed.data.profile_id });
                json(res, 202, envelope(accepted, requestId));return;
            }
            const profileAction = /^\/v1\/profiles\/([A-Za-z0-9_-]{1,128})\/(prepare|build|activate)$/.exec(path);
            if (profileAction && req.method === 'POST') {
                if (managed.busy || profiles.busy) throw new DsearchError('BUSY');
                if (profileAction[2] !== 'activate') { if (!PrepareProfileRequest.safeParse(await body(req)).success) throw new DsearchError('INVALID_REQUEST');const accepted = profiles.prepare(profileAction[1]!, profileAction[2] === 'build');json(res, 202, envelope({ job_id: accepted.job_id, generation_id: accepted.generation_id, state: 'queued' }, requestId));return; }
                const parsed = ActivateRequest.safeParse(await body(req));if (!parsed.success) throw new DsearchError('INVALID_REQUEST');profiles.resolve(profileAction[1]!);
                if (!store.db.prepare('SELECT generation_id FROM generations WHERE generation_id=?').get(parsed.data.generation_id)) throw new DsearchError('NOT_FOUND');
                const accepted = managed.start('profile-activate', (signal, progress) => profiles.activate(profileAction[1]!, parsed.data.generation_id, parsed.data.expected_epoch, signal, progress), parsed.data.generation_id, { profile_id: profileAction[1]! });
                json(res, 202, envelope(accepted, requestId));return;
            }
            if (path === '/v1/collections' && req.method === 'GET') {
                json(res, 200, envelope(catalog.listCollections().map(c => collectionInfo(c.collection_id)), requestId));
                return;
            }
            if (path === '/v1/collections' && req.method === 'POST') {
                const parsed = CollectionRequest.safeParse(await body(req));
                if (!parsed.success)
                    throw new DsearchError('INVALID_REQUEST');
                const collection = await catalog.addCollection(parsed.data);synchronization.notify('configuration');
                json(res, 201, envelope(collectionInfo(collection.collection_id), requestId));
                return;
            }
            const scopePreview = /^\/v1\/collections\/([A-Za-z0-9_-]{1,128})\/preview$/.exec(path);
            if (scopePreview && req.method === 'POST') { json(res, 200, envelope(await catalog.previewPatch(scopePreview[1]!, await body(req)), requestId));return; }
            const collection = /^\/v1\/collections\/([A-Za-z0-9_-]{1,128})$/.exec(path);
            if (collection && req.method === 'PATCH') {
                const parsed = CollectionPatch.safeParse(await body(req));
                if (!parsed.success)
                    throw new DsearchError('INVALID_REQUEST');
                catalog.patch(collection[1]!, parsed.data);
                sessions.invalidateCollection(collection[1]!);synchronization.notify('configuration');
                json(res, 200, envelope(collectionInfo(collection[1]!), requestId));
                return;
            }
            if (collection && req.method === 'DELETE') { catalog.unregister(collection[1]!);sessions.invalidateCollection(collection[1]!);synchronization.notify('configuration');json(res, 200, envelope({ collection_id: collection[1], removed: true }, requestId));return; }
            if (path === '/v1/reconcile' && req.method === 'POST') {
                const value = await body(req);
                const parsed = ReconcileRequest.safeParse(value);
                if (!parsed.success) throw new DsearchError('INVALID_REQUEST');
                if (managed.busy || profiles.busy) throw new DsearchError('BUSY');
                const job = profiles.builder.start(parsed.data);
                void job.completion.then(() => {readers.sweep();synchronization.notify('periodic',true);}, () => { });
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
            if (path === '/v1/documents/info' && req.method === 'POST') {
                const value = await body(req);if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('doc_id' in value) || typeof value.doc_id !== 'string') throw new DsearchError('INVALID_REQUEST');
                const doc = catalog.document(value.doc_id);if (!doc.latest_revision_id) throw new DsearchError('SOURCE_PENDING');
                const current = await catalog.readDocument(doc.doc_id, doc.latest_revision_id);json(res, 200, envelope({ doc_id: doc.doc_id, revision_id: doc.latest_revision_id, collection_id: doc.collection_id, relative_path: doc.relative_path, title: current.metadata.title ?? doc.relative_path }, requestId));return;
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
            const rollback = /^\/v1\/generations\/([A-Za-z0-9_-]{1,128})\/rollback$/.exec(path);
            if (rollback && req.method === 'POST') {
                if (managed.busy || profiles.busy) throw new DsearchError('BUSY');
                const parsed = RollbackRequest.safeParse(await body(req));if (!parsed.success) throw new DsearchError('INVALID_REQUEST');
                const target = store.db.prepare('SELECT profile_id FROM generations WHERE generation_id=?').get(rollback[1]!);if (!target) throw new DsearchError('NOT_FOUND');profiles.resolve(String(target.profile_id));
                const accepted = managed.start('profile-activate', (signal, progress) => profiles.activate(String(target.profile_id), rollback[1]!, parsed.data.expected_epoch, signal, progress), rollback[1]!, { profile_id: String(target.profile_id) });json(res, 202, envelope(accepted, requestId));return;
            }
            const retryJob = /^\/v1\/jobs\/([A-Za-z0-9_-]{1,128})\/retry$/.exec(path);
            if (retryJob && req.method === 'POST') {
                if (!PrepareProfileRequest.safeParse(await body(req)).success) throw new DsearchError('INVALID_REQUEST');if (managed.busy || profiles.busy) throw new DsearchError('BUSY');
                const row = store.db.prepare('SELECT * FROM jobs WHERE job_id=?').get(retryJob[1]!);if (!row) throw new DsearchError('NOT_FOUND');
                const cursor=JSON.parse(String(row.cursor_json));
                if (!['failed','obsolete','cancelled'].includes(String(row.state)) || (!cursor.checkpoint && !retryableJobCode(row.error_code == null ? null : String(row.error_code)))) throw new DsearchError('INVALID_REQUEST');
                if(row.kind==='backup'){json(res,202,envelope(startBackup(),requestId));return;}
                if (['full-build','profile-build'].includes(String(row.kind))) {
                    const target = store.db.prepare('SELECT profile_id FROM generations WHERE generation_id=?').get(String(row.generation_id));if (!target) throw new DsearchError('NOT_FOUND');
                    const accepted = cursor.checkpoint ? profiles.resume(retryJob[1]!) : profiles.prepare(String(target.profile_id), row.kind === 'full-build');void accepted.completion.then(()=>synchronization.notify('periodic',true),()=>{});json(res, 202, envelope({ job_id: accepted.job_id, generation_id: accepted.generation_id, state: 'queued' }, requestId));return;
                }
                const meta = JSON.parse(String(row.cursor_json)) as { profile_id?: string };if (!meta.profile_id) throw new DsearchError('INVALID_REQUEST');const target = profiles.resolve(meta.profile_id);
                const kind = String(row.kind);if (!['model-check','model-prepare','profile-activate'].includes(kind)) throw new DsearchError('INVALID_REQUEST');
                const accepted = managed.start(kind as 'model-check' | 'model-prepare' | 'profile-activate', async (signal, progress) => { if (kind === 'profile-activate') await profiles.activate(target.profile_id, String(row.generation_id), profiles.list().active_epoch, signal, progress);else { if (kind === 'model-prepare') await models.prepare(profiles.roles(target), signal, progress);else await models.check(profiles.roles(target), signal, progress);await lane.run(signal, () => readers.unloadExcept()); } }, row.generation_id == null ? null : String(row.generation_id), { profile_id: target.profile_id });
                json(res, 202, envelope(accepted, requestId));return;
            }
            const job = /^\/v1\/jobs\/([A-Za-z0-9_-]{1,128})$/.exec(path);
            if (job && req.method === 'GET') {
                json(res, 200, envelope(jobInfo(job[1]!), requestId));
                return;
            }
            if (job && req.method === 'DELETE') {
                if (!managed.cancel(job[1]!)) profiles.builder.cancel(job[1]!);
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
        synchronization.start();
        return { url: origin, instance_id: instance, root, catalog, synchronization, get builder() { return profiles.builder; }, profiles, models, sessions, status, close };
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
