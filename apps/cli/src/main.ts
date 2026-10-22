import { terminalText } from './terminal.js';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DsearchError, ErrorCode, ErrorReason, CollectionRequest, SearchRequest, LiteralRequest, ReadRequest, RelatedRequest, CompareRequest } from '@dsearch/contracts';
import { SearchStatus } from '@dsearch/contracts/search';
import { connect, startDaemon, waitForStopped, openUI, defaultRoot, type Packet } from './connection.js';
const help = `dsearch 0.1 alpha · QMD 2.8.3
Usage: pnpm dsearch <command> [options]
  serve start|status|stop             Local loopback service
  ui [--print-url]                    Open the authenticated GUI
  collection add <folder> --name <name> [--preset general|learning]
  collection list
  collection enable|disable <id>
  reconcile | sync                   Build and publish a complete generation
  search <query> --collection <id> [--mode lexical|hybrid|deep] [--no-rerank] [--allow-degraded] [--limit 10]
  literal <text> --collection <id> [--ignore-case] [--limit 200]
  read <doc-id> --revision <id> --lines 1:20
  related <doc-id> --revision <id> --lines 1:20 [--mode hybrid]
  compare <left-id> <right-id> --left-revision <id> --right-revision <id> --query <text>
  status
  mcp                                Read-only MCP stdio bridge
Options: --data-root <folder>, --json, --no-start, --no-wait, --stdin
Repeat --collection for several collections; omission searches all enabled collections.
--lines includes both end lines; JSON locators use an exclusive end.
--stdin reads the query from stdin (final LF removed). Queries are never persisted.
Hybrid uses structured lex/vec retrieval with optional reranking. Deep needs a separately validated expansion model (not installed).
`;
const exitCode = (code: ErrorCode) => code === 'CANCELLED' ? 130 : ['UNAUTHORIZED', 'SCOPE_DENIED'].includes(code) ? 3 : ['STALE_REVISION', 'STALE_EPOCH', 'RESULT_EXPIRED', 'SOURCE_PENDING'].includes(code) ? 5 : ['SERVICE_UNAVAILABLE', 'NO_ACTIVE_GENERATION', 'BUSY'].includes(code) ? 4 : ['INVALID_REQUEST', 'INVALID_QUERY', 'INPUT_TOO_LARGE', 'INPUT_TOO_LONG', 'INVALID_LOCATOR', 'UNSUPPORTED_LOCATOR'].includes(code) ? 2 : 6;
let jsonOutput = process.argv.includes('--json');
function checked<T>(schema: {
    safeParse: (x: unknown) => {
        success: boolean;
        data?: T;
    };
}, input: unknown): T { const result = schema.safeParse(input); if (!result.success)
    throw new DsearchError('INVALID_REQUEST'); return result.data!; }
function print(packet: Packet) {
    if (jsonOutput) {
        process.stdout.write(JSON.stringify(packet) + '\n');
        return;
    }
    const human = (value: string) => process.stdout.write(terminalText(value));
    const d = packet.data;
    if (typeof d === 'string')
        human(d + '\n');
    else if (d.purpose === 'compare') {
        for (const side of ['left', 'right']) { human(side.toUpperCase() + ' · ' + d[side].source.doc_id + ' · ' + d[side].source.revision_id + '\n');print({ ...packet, data: d[side].result }); }
    }
    else if (d.results)
        for (const doc of d.results) {
            human(`${doc.title}\n  ${doc.relative_path}\n  ${doc.doc_id} · ${doc.revision_id}\n`);
            for (const e of doc.evidence)
                human(`  L${e.locator.start.line}–${e.locator.end.line}: ${e.excerpt}\n`);
        }
    else if (d.matches)
        for (const m of d.matches)
            human(`${m.relative_path}:${m.match_locator.start.line}:${m.match_locator.start.column_utf16}\n${m.excerpt}\n`);
    else if (typeof d.text === 'string')
        human(d.text + (d.text.endsWith('\n') ? '' : '\n'));
    else
        human(JSON.stringify(d, null, 2) + '\n');
    if (d.purpose === 'related') human(`Derived query: ${d.query_plan.query}\nSource spans: ${d.query_plan.used_spans.length} used, ${d.query_plan.omitted_spans.length} omitted\n`);
    if (d.supplemental_results?.length) {
        human('\nKeyword-only supplemental results (separate ranking):\n');
        for (const doc of d.supplemental_results) human(`${doc.title}\n  ${doc.relative_path}\n  ${doc.evidence[0].excerpt}\n`);
    }
    if (d.rank_stage && d.rank_stage !== 'literal') process.stderr.write(terminalText(`${d.effective_mode} · ${d.rank_stage}${d.degraded ? ' · degraded' : ''}\n${(d.warnings ?? []).join(', ')}\n`));
    if (d.partial)
        process.stderr.write('Partial literal results: ' + d.stop_reason + '\n');
}
try {
    const { values: v, positionals: p } = parseArgs({ allowPositionals: true, strict: true, options: { help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, 'data-root': { type: 'string' }, name: { type: 'string' }, preset: { type: 'string' }, collection: { type: 'string', multiple: true }, mode: { type: 'string' }, limit: { type: 'string' }, revision: { type: 'string' }, 'left-revision': { type: 'string' }, 'right-revision': { type: 'string' }, query: { type: 'string' }, lines: { type: 'string' }, 'no-start': { type: 'boolean' }, 'no-wait': { type: 'boolean' }, 'no-rerank': { type: 'boolean' }, 'allow-degraded': { type: 'boolean' }, 'candidate-limit': { type: 'string' }, 'ignore-case': { type: 'boolean' }, 'print-url': { type: 'boolean' }, stdin: { type: 'boolean' } } });
    jsonOutput = !!v.json;
    if (v.help || !p.length) {
        process.stdout.write(help);
        process.exit(0);
    }
    const root = resolve(v['data-root'] ?? defaultRoot()), command = p[0];
    if (!['serve', 'daemon', 'ui', 'status', 'collection', 'reconcile', 'sync', 'search', 'literal', 'read', 'related', 'compare', 'mcp'].includes(command!))
        throw new DsearchError('INVALID_REQUEST');
    if (command === 'mcp') {
        if (p.length !== 1 || v.json || v.stdin) throw new DsearchError('INVALID_REQUEST');
        const { startMcp } = await import('@dsearch/app-mcp');await startMcp(root, !!v['no-start']);
        process.exit(0);
    }
    if (['serve', 'daemon'].includes(command!) && (!['start', 'status', 'stop'].includes(p[1] ?? '') || p.length !== 2))
        throw new DsearchError('INVALID_REQUEST');
    const client = ['serve', 'daemon'].includes(command!) && p[1] === 'start' ? await startDaemon(root) : v['no-start'] || (['serve', 'daemon'].includes(command!) && p[1] !== 'start') ? await connect(root) : await startDaemon(root), call = client.call;
    const wait = async (path: string, job = false): Promise<Packet> => {
        let cancelled = false, last = '';
        const interrupt = () => { if (cancelled)
            return; cancelled = true; void call('DELETE', path).catch(() => { }); };
        process.once('SIGINT', interrupt);
        try {
            for (;;) {
                const packet = await call('GET', path), state = job ? packet.data : SearchStatus.parse(packet.data);
                const phase = state.phase ?? state.state;
                if (phase !== last) {
                    process.stderr.write(phase + '\n');
                    last = phase;
                }
                if (['completed', 'succeeded'].includes(state.state))
                    return packet;
                if (['cancelled', 'failed', 'obsolete'].includes(state.state))
                    throw new DsearchError(state.state === 'cancelled' ? 'CANCELLED' : ErrorCode.safeParse(state.error?.code ?? state.error_code).success ? (state.error?.code ?? state.error_code) : 'INTERNAL_ERROR', undefined, false, ErrorReason.safeParse(state.error?.reason).success ? state.error.reason : undefined);
                if (cancelled && state.state !== 'cancel_requested')
                    await call('DELETE', path);
                await new Promise(r => setTimeout(r, 100));
            }
        }
        finally {
            process.removeListener('SIGINT', interrupt);
        }
    };
    let packet: Packet;
    if (['serve', 'daemon'].includes(command!)) {
        if (p[1] === 'stop') {
            packet = await call('POST', '/v1/shutdown', {});
            await waitForStopped(root, client.runtime.instance_id);
        }
        else
            packet = await call('GET', '/v1/status');
    }
    else if (command === 'ui') {
        if (p.length !== 1)
            throw new DsearchError('INVALID_REQUEST');
        packet = await call('POST', '/v1/ui/code', {});
        if (!v['print-url']) {
            await openUI(packet.data.url);
            packet = { ...packet, data: { opened: true } };
        }
    }
    else if (command === 'status') {
        if (p.length !== 1)
            throw new DsearchError('INVALID_REQUEST');
        packet = await call('GET', '/v1/status');
    }
    else if (command === 'collection') {
        if (p[1] === 'list' && p.length === 2)
            packet = await call('GET', '/v1/collections');
        else if (p[1] === 'add' && p.length === 3)
            packet = await call('POST', '/v1/collections', checked(CollectionRequest, { name: v.name, root: resolve(p[2]!), preset: v.preset ?? 'general' }));
        else if (['enable', 'disable'].includes(p[1] ?? '') && p.length === 3 && /^[A-Za-z0-9_-]{1,128}$/.test(p[2]!))
            packet = await call('PATCH', '/v1/collections/' + p[2], { enabled: p[1] === 'enable' });
        else
            throw new DsearchError('INVALID_REQUEST');
    }
    else if (['reconcile', 'sync'].includes(command!)) {
        if (p.length !== 1 || v.collection)
            throw new DsearchError('INVALID_REQUEST');
        packet = await call('POST', '/v1/reconcile', {});
        if (!v['no-wait'])
            packet = await wait('/v1/jobs/' + packet.data.job_id, true);
    }
    else if (command === 'related' || command === 'compare') {
        const mode = v.mode ?? 'hybrid', common = { mode, rerank: mode !== 'lexical' && !v['no-rerank'], allow_degraded: !!v['allow-degraded'], ...(v['candidate-limit'] ? { candidate_limit: Number(v['candidate-limit']) } : {}) };
        if (command === 'related') {
            if (p.length !== 2 || !v.lines || !/^\d+:\d+$/.test(v.lines)) throw new DsearchError('INVALID_REQUEST');
            const [start, end] = v.lines.split(':').map(Number);if (!start || !end || end < start) throw new DsearchError('INVALID_REQUEST');
            const collections = v.collection ?? (await call('GET', '/v1/collections')).data.filter((c: any) => c.enabled).map((c: any) => c.collection_id);
            packet = await call('POST', '/v1/related-searches', checked(RelatedRequest, { ...common, source: { doc_id: p[1], revision_id: v.revision, locator: { kind: 'markdown', start: { line: start, column_utf16: 0 }, end: { line: end + 1, column_utf16: 0 } } }, collections, ...(v.limit ? { limit: Number(v.limit) } : {}) }));
        } else {
            if (p.length !== 3) throw new DsearchError('INVALID_REQUEST');
            packet = await call('POST', '/v1/comparisons', checked(CompareRequest, { ...common, query: v.query, left: { doc_id: p[1], revision_id: v['left-revision'] }, right: { doc_id: p[2], revision_id: v['right-revision'] } }));
        }
        if (!v['no-wait']) packet = await wait(packet.data.status_url);
    }
    else if (command === 'search' || command === 'literal') {
        if ((v.stdin && p.length !== 1) || (!v.stdin && p.length !== 2))
            throw new DsearchError('INVALID_REQUEST');
        let query = p[1] ?? '';
        if (v.stdin) {
            const chunks: Buffer[] = [];
            let count = 0;
            for await (const chunk of process.stdin) {
                const bytes = Buffer.from(chunk);
                count += bytes.length;
                if (count > 8193)
                    throw new DsearchError('INPUT_TOO_LARGE');
                chunks.push(bytes);
            }
            query = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/\r?\n$/, '');
        }
        const collections = v.collection ?? (await call('GET', '/v1/collections')).data.filter((c: any) => c.enabled).map((c: any) => c.collection_id);
        const request = command === 'search' ? checked(SearchRequest, { query, purpose: 'find', mode: v.mode ?? 'lexical', rerank: (v.mode ?? 'lexical') !== 'lexical' && !v['no-rerank'], allow_degraded: !!v['allow-degraded'], ...(v['candidate-limit'] ? { candidate_limit: Number(v['candidate-limit']) } : {}), collections, ...(v.limit ? { limit: Number(v.limit) } : {}) }) : checked(LiteralRequest, { query, collections, ignore_case: !!v['ignore-case'], ...(v.limit ? { limit: Number(v.limit) } : {}) });
        packet = await call('POST', command === 'search' ? '/v1/searches' : '/v1/literal-searches', request);
        if (!v['no-wait'])
            packet = await wait(packet.data.status_url);
    }
    else {
        if (p.length !== 2 || !v.lines || !/^\d+:\d+$/.test(v.lines))
            throw new DsearchError('INVALID_REQUEST');
        const [start, end] = v.lines.split(':').map(Number);
        if (!start || !end || end < start || end - start >= 200)
            throw new DsearchError('INVALID_REQUEST');
        packet = await call('POST', '/v1/documents/read', checked(ReadRequest, { doc_id: p[1], revision_id: v.revision, locator: { kind: 'markdown', start: { line: start, column_utf16: 0 }, end: { line: end + 1, column_utf16: 0 } } }));
    }
    print(packet!);
}
catch (error) {
    const code = error instanceof DsearchError ? error.code : error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS') ? 'INVALID_REQUEST' : error instanceof TypeError || error instanceof SyntaxError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
    if (jsonOutput)
        process.stdout.write(JSON.stringify({ schema_version: 1, request_id: randomUUID(), ok: false, error: { ...(error instanceof DsearchError && error.reason ? { reason: error.reason } : {}), code, message: code, retryable: ['BUSY', 'SERVICE_UNAVAILABLE'].includes(code) } }) + '\n');
    else
        process.stderr.write(code + (error instanceof DsearchError && error.reason ? ' · ' + error.reason : '') + '\n');
    process.exitCode = exitCode(code);
}
