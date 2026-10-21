import { guardedSearchMutation, normalizedScope } from './search-state.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { DsearchError, Locator } from '@dsearch/contracts';
import { AppStatus, CollectionInfo, ReadResponse, type JobInfo } from '@dsearch/contracts/control';
import { SearchStatus, type SearchComplete } from '@dsearch/contracts/search';
import { api, authenticate, message } from './api.js';
import { Button, Notice, Empty, phaseLabel } from './components.js';
import { Markdown } from './markdown.js';
type Selection = {
    key: string;
    doc_id: string;
    revision_id: string;
    title: string;
    relative_path: string;
    collection_id: string;
    locator: ReturnType<typeof Locator.parse>;
    heading: string[];
};
type Page = 'search' | 'collections' | 'jobs';
const active = (state: string) => ['queued', 'running', 'cancel_requested'].includes(state);
export function App() {
    const [ready, setReady] = useState(false), [error, setError] = useState(''), [page, setPage] = useState<Page>('search'), [status, setStatus] = useState<AppStatus>(), [collections, setCollections] = useState<CollectionInfo[]>([]);
    const [query, setQuery] = useState(''), [mode, setMode] = useState<'lexical' | 'hybrid' | 'literal'>('lexical'), [scope, setScope] = useState('all'), [ignoreCase, setIgnoreCase] = useState(false), [rerank, setRerank] = useState(true), [allowDegraded, setAllowDegraded] = useState(false);
    const [search, setSearch] = useState<SearchStatus>(), [outcome, setComplete] = useState<SearchComplete>(), [selection, setSelection] = useState<Selection>(), [source, setSource] = useState<ReadResponse>(), [sourceError, setSourceError] = useState(''), [reading, setReading] = useState(false), [raw, setRaw] = useState(false), [context, setContext] = useState(false), [mobile, setMobile] = useState<'results' | 'source'>('results');
    const [pins, setPins] = useState<Selection[]>([]);
    const [adding, setAdding] = useState(false), [name, setName] = useState(''), [folder, setFolder] = useState(''), [preset, setPreset] = useState('general'), [saving, setSaving] = useState(false);
    const refreshSequence = useRef(0), pendingCancel = useRef(false), generation = useRef(0), readSequence = useRef(0), stream = useRef<EventSource | null>(null), currentSearch = useRef<string | null>(null), scopeFingerprint = useRef(''), alive = useRef(true), searching = !!search && active(search.state);
    const comparison = outcome?.purpose === 'compare' ? outcome : undefined;
    const complete = outcome?.purpose === 'compare' ? undefined : outcome;
    const enabled = collections.filter(c => c.enabled);
    const refresh = async () => {
        const refreshTicket = ++refreshSequence.current;
        const [s, items] = await Promise.all([api('GET', '/v1/status'), api<unknown[]>('GET', '/v1/collections')]);
        if (!alive.current || refreshTicket !== refreshSequence.current)
            return;
        const parsed = items.map(c => CollectionInfo.parse(c)), fp = JSON.stringify(parsed.map(c => [c.collection_id, c.enabled, c.scope_fp]));
        if (scopeFingerprint.current && scopeFingerprint.current !== fp) {
            generation.current++;
            stream.current?.close();
            currentSearch.current = null;
            setSearch(undefined);
            setComplete(undefined);
            setSelection(undefined);
            setPins([]);
            readSequence.current++;
            setSource(undefined);
            setSourceError('');
            setReading(false);
        }
        scopeFingerprint.current = fp;
        setScope(previous => normalizedScope(previous, parsed));
        setCollections(parsed);
        setStatus(AppStatus.parse(s));
    };
    useEffect(() => { alive.current = true; void authenticate().then(refresh).then(() => { if (alive.current)
        setReady(true); }).catch(e => { if (alive.current)
        setError(message(e)); }); return () => { alive.current = false; stream.current?.close(); }; }, []);
    useEffect(() => { if (!ready)
        return; const timer = setInterval(() => void refresh().catch(e => { if (alive.current)
        setError(message(e)); }), 2500); return () => clearInterval(timer); }, [ready]);
    const changeScope = (next: string) => {
        const previous = currentSearch.current;generation.current++;stream.current?.close();currentSearch.current = null;pendingCancel.current = false;
        if (previous && searching) void api('DELETE', '/v1/searches/' + previous).catch(() => {});
        readSequence.current++;setScope(next);setSearch(undefined);setComplete(undefined);setSelection(undefined);setSource(undefined);setReading(false);setSourceError('');setPins([]);
    };
    const runSearch = async (event?: FormEvent, override?: { path: string; body: unknown }) => {
        event?.preventDefault();
        const scopes = scope === 'all' ? enabled.map(c => c.collection_id) : [scope];
        if (!override && (!query.length || !scopes.length))
            return;
        const ticket = ++generation.current;
        stream.current?.close();
        const old = currentSearch.current;
        if (old && searching)
            void api('DELETE', '/v1/searches/' + old).catch(() => { });
        currentSearch.current = null;
        pendingCancel.current = false;
        setError('');
        setSearch({ search_id: 'starting', state: 'queued', phase: 'queued' });
        try {
            const accepted = await api<{
                search_id: string;
                events_url: string;
            }>('POST', override?.path ?? (mode !== 'literal' ? '/v1/searches' : '/v1/literal-searches'), override?.body ?? (mode !== 'literal' ? { query, purpose: 'find', mode, rerank: mode === 'hybrid' && rerank, allow_degraded: allowDegraded, collections: scopes } : { query, collections: scopes, ignore_case: ignoreCase }));
            if (ticket !== generation.current) {
                void api('DELETE', '/v1/searches/' + accepted.search_id).catch(() => { });
                return;
            }
            currentSearch.current = accepted.search_id;
            if (pendingCancel.current)
                await api('DELETE', '/v1/searches/' + accepted.search_id);
            if (ticket !== generation.current || currentSearch.current !== accepted.search_id) return;
            const events = new EventSource(accepted.events_url);
            stream.current = events;
            const apply = (value: unknown) => {
                if (ticket !== generation.current)
                    return;
                const parsed = SearchStatus.parse(value);
                setSearch(parsed);
                if (parsed.state === 'completed') {
                    setComplete(parsed);
                    setMobile('results');
                    events.close();
                    void refresh().catch(() => { });
                }
                else if (parsed.state === 'failed' || parsed.state === 'cancelled') {
                    events.close();
                    if (parsed.state === 'failed')
                        setError(message(new DsearchError(parsed.error?.code ?? 'INTERNAL_ERROR')));
                }
            };
            events.addEventListener('state', event => { try {
                const packet = JSON.parse((event as MessageEvent).data);
                if (packet.schema_version !== 1 || packet.ok !== true)
                    throw new DsearchError('COMPATIBILITY_FAILED');
                apply(packet.data);
            }
            catch (e) {
                events.close();
                if (ticket === generation.current) {
                    setSearch(undefined);
                    setError(message(e));
                }
            } });
            events.onerror = () => { events.close(); void api('GET', '/v1/searches/' + accepted.search_id).then(value => { apply(value); if (ticket === generation.current && active((value as SearchStatus).state)) {
                setSearch(undefined);
                setError('검색 연결이 끊어졌어요. 다시 검색해 주세요.');
            } }).catch(e => { if (ticket === generation.current) {
                setSearch(undefined);
                setError(message(e));
            } }); };
        }
        catch (e) {
            if (ticket === generation.current) {
                setSearch(undefined);
                setError(message(e));
            }
        }
    };
    const cancelSearch = async () => { if (!currentSearch.current) {
        pendingCancel.current = true;
        setSearch({ search_id: 'starting', state: 'cancel_requested', phase: 'cancel-requested' });
        return;
    }
    const captured = { id: currentSearch.current, generation: generation.current };
    await guardedSearchMutation(captured, () => ({ id: currentSearch.current, generation: generation.current }), () => api('DELETE', '/v1/searches/' + captured.id), value => setSearch(SearchStatus.parse(value)), e => setError(message(e)));
    };
    const read = async (item: Selection, withContext = false) => {
        const ticket = ++readSequence.current;
        setSelection(item);
        setReading(true);
        setSourceError('');
        setSource(undefined);
        setContext(withContext);
        setMobile('source');
        try {
            const value = ReadResponse.parse(await api('POST', '/v1/documents/read', { doc_id: item.doc_id, revision_id: item.revision_id, locator: item.locator, context_before_lines: withContext ? 10 : 0, context_after_lines: withContext ? 20 : 0, max_lines: 200 }));
            if (ticket === readSequence.current)
                setSource(value);
        }
        catch (e) {
            if (ticket === readSequence.current)
                setSourceError(message(e));
        }
        finally {
            if (ticket === readSequence.current)
                setReading(false);
        }
    };
    const build = async () => { setError(''); try {
        await api('POST', '/v1/reconcile', {});
        await refresh();
    }
    catch (e) {
        setError(message(e));
    } };
    const cancelJob = async (job: JobInfo) => { try {
        await api('DELETE', '/v1/jobs/' + job.job_id);
        await refresh();
    }
    catch (e) {
        setError(message(e));
    } };
    const add = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setError(''); try {
        await api('POST', '/v1/collections', { name, root: folder, preset });
        await refresh();
        setAdding(false);
        setName('');
        setFolder('');
    }
    catch (e) {
        setError(message(e));
    }
    finally {
        setSaving(false);
    } };
    const toggle = async (collection: CollectionInfo) => { setError(''); try {
        await api('PATCH', '/v1/collections/' + collection.collection_id, { enabled: !collection.enabled });
        await refresh();
    }
    catch (e) {
        setError(message(e));
    } };
    const related = () => { if (!selection) return;const scopes = scope === 'all' ? enabled.map(c => c.collection_id) : [scope];void runSearch(undefined, { path: '/v1/related-searches', body: { source: { doc_id: selection.doc_id, revision_id: selection.revision_id, locator: selection.locator }, collections: scopes, mode: 'hybrid', rerank, allow_degraded: allowDegraded } }); };
    const compare = () => { if (pins.length !== 2) return;const ref = (p: Selection) => ({ doc_id: p.doc_id, revision_id: p.revision_id });void runSearch(undefined, { path: '/v1/comparisons', body: { left: ref(pins[0]!), right: ref(pins[1]!), query, mode: mode === 'literal' ? 'lexical' : mode, rerank: mode === 'hybrid' && rerank, allow_degraded: allowDegraded } }); };
    const collectionName = (id: string) => collections.find(c => c.collection_id === id)?.name ?? '컬렉션';
    const documentItem = (d: import('@dsearch/contracts/search').SearchDocument, group = '') => ({ title: d.title, path: d.relative_path, collection: d.collection_id, key: group + d.doc_id, group, excerpt: d.evidence[0]!.excerpt, choices: d.evidence.map(e => ({ key: d.doc_id + e.passage_id, doc_id: d.doc_id, revision_id: d.revision_id, title: d.title, relative_path: d.relative_path, collection_id: d.collection_id, locator: e.locator, heading: e.heading_path })) });
    const results = comparison ? [...[...comparison.left.result.results, ...comparison.left.result.supplemental_results].map(d => documentItem(d, comparison.left.result.results.includes(d) ? '왼쪽 원문' : '왼쪽 · 키워드 전용')), ...[...comparison.right.result.results, ...comparison.right.result.supplemental_results].map(d => documentItem(d, comparison.right.result.results.includes(d) ? '오른쪽 원문' : '오른쪽 · 키워드 전용'))] : complete ? (complete.effective_mode === 'literal' ? complete.matches.map((m, i) => ({ title: m.title, path: m.relative_path, collection: m.collection_id, key: m.doc_id + '-' + i, group: '', excerpt: m.excerpt, choices: [{ key: m.doc_id + '-' + i, doc_id: m.doc_id, revision_id: m.revision_id, title: m.title, relative_path: m.relative_path, collection_id: m.collection_id, locator: m.match_locator, heading: [] }] })) : complete.results.map(d => documentItem(d))) : [];

    return <div className="app-shell">
  <a className="skip-link" href="#main">본문으로 이동</a>
  <aside className="sidebar"><div className="brand"><span aria-hidden="true">d</span><strong>dsearch</strong><small>alpha</small></div><nav aria-label="주 메뉴">{([['search', '문서 검색', '⌕'], ['collections', '컬렉션', '▤'], ['jobs', '작업', '◷']] as const).map(([id, label, icon]) => <button key={id} className={'nav-item' + (page === id ? ' current' : '')} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}><span aria-hidden="true">{icon}</span>{label}{id === 'jobs' && status?.busy ? <span className="badge">1</span> : null}</button>)}</nav><div className="sidebar-foot"><span className="status-dot" aria-hidden="true"/>{ready ? '내 컴퓨터에서 실행 중' : '연결 확인 중'}<p>수동 색인 · 문서 검색 알파</p></div></aside>
  <div className="workspace"><header className="topbar"><span>내 문서 / {page === 'search' ? '검색' : page === 'collections' ? '컬렉션' : '작업'}</span><span className="local-label">로컬 전용</span></header>
   <main id="main" className="content"><div className="page-heading"><div><p className="eyebrow">MY DOCUMENTS</p><h1>{page === 'search' ? '문서 검색' : page === 'collections' ? '문서 컬렉션' : '작업'}</h1><p>{page === 'search' ? '기억나는 말로 찾고, 원문에서 확인하세요.' : page === 'collections' ? '검색할 폴더와 처리 범위를 관리하세요.' : '수동 색인의 진행과 완료 상태를 확인하세요.'}</p></div>{ready && page !== 'search' ? <Button primary onClick={page === 'collections' ? () => setAdding(true) : build} disabled={page === 'jobs' && (status?.busy || !enabled.length)}>{page === 'collections' ? '폴더 등록' : '수동 색인 시작'}</Button> : null}</div>
    {error && !adding ? <Notice error>{error}</Notice> : null}
    {!ready ? <Empty title="로컬 서비스 연결">터미널에서 <code>pnpm dsearch ui</code>로 이 화면을 열 수 있어요.</Empty> : <>
     {status?.scope_incomplete ? <Notice error>접근하지 못한 폴더가 있어 새 색인을 게시하지 않았어요. 기존 색인을 유지하며, 컬렉션의 접근 권한을 확인해야 해요.</Notice> : null}
     {status?.needs_rebuild && page === 'search' ? <Notice><span>{status.generation ? '변경한 자료를 검색하려면 색인을 다시 만들어 주세요.' : '먼저 폴더를 등록하고 검색 자료를 준비해 주세요.'}</span><Button onClick={enabled.length ? build : () => { setPage('collections'); setAdding(true); }} disabled={status.busy}>{enabled.length ? (status.busy ? '색인 만드는 중' : '수동 색인 시작') : '폴더 등록'}</Button></Notice> : null}
     {page === 'search' ? <>
      <form className="search-form" onSubmit={runSearch}><label htmlFor="query">검색어</label><div className="search-input"><span aria-hidden="true">⌕</span><input id="query" value={query} onChange={e => setQuery(e.target.value)} maxLength={mode === 'literal' ? 1024 : 8192} placeholder="예: ECDSA 서명 검증" autoComplete="off" spellCheck={false}/>{searching ? <Button type="button" onClick={cancelSearch} disabled={search?.state === 'cancel_requested'}>{search?.state === 'cancel_requested' ? '멈추는 중' : '취소'}</Button> : <Button primary type="submit" disabled={(mode !== 'literal' ? !query.trim() : !query.length) || !enabled.length || (mode !== 'literal' && !status?.modes[mode])}>검색</Button>}</div>
       <div className="search-options"><div className="segmented" aria-label="검색 방식"><button type="button" aria-pressed={mode === 'lexical'} onClick={() => setMode('lexical')}>키워드</button><button type="button" aria-pressed={mode === 'hybrid'} onClick={() => setMode('hybrid')}>의미 검색</button><button type="button" aria-pressed={mode === 'literal'} onClick={() => setMode('literal')}>정확한 문자열</button></div><label className="scope-label" htmlFor="scope">범위<select id="scope" value={scope} onChange={e => changeScope(e.target.value)}><option value="all">모든 컬렉션</option>{enabled.map(c => <option key={c.collection_id} value={c.collection_id}>{c.name}</option>)}</select></label>{mode === 'literal' ? <label className="checkbox"><input type="checkbox" checked={ignoreCase} onChange={e => setIgnoreCase(e.target.checked)}/>대소문자 구분 안 함</label> : mode === 'hybrid' ? <><label className="checkbox"><input type="checkbox" checked={rerank} onChange={e => setRerank(e.target.checked)}/>리랭킹</label><label className="checkbox"><input type="checkbox" checked={allowDegraded} onChange={e => setAllowDegraded(e.target.checked)}/>모델 오류 시 대체 검색 허용</label></> : <span className="hint">입력한 단어와 일치하는 구간을 찾아요.</span>}</div>
      </form>
      {pins.length ? <section className="comparison-pins" aria-label="비교할 문서"><h2>비교할 문서</h2>{pins.map((p, i) => <p className="path" key={p.doc_id}>{i ? '오른쪽' : '왼쪽'} · {p.relative_path} · revision {p.revision_id.slice(0, 8)}</p>)}<Button onClick={compare} disabled={pins.length !== 2 || !query.trim() || searching}>현재 검색어로 비교</Button><Button onClick={() => setPins([])}>선택 비우기</Button></section> : null}
      {comparison ? <Notice><span>선택한 두 원문을 각각 확인했어요. {(['left', 'right'] as const).map(side => <span key={side}> {side === 'left' ? '왼쪽' : '오른쪽'}: {comparison[side].result.results.length ? comparison[side].result.rank_stage : comparison[side].result.supplemental_results.length ? '키워드 전용 보조 근거' : '확인 가능한 근거 없음'}{comparison[side].result.degraded ? ' (대체 검색)' : ''} </span>)}</span></Notice> : null}
      {complete && complete.purpose === 'related' ? <details className="search-details"><summary>원문에서 구성한 관련 검색어</summary><p>{complete.query_plan.query}</p><p className="hint">사용 구간 {complete.query_plan.used_spans?.length}개 · 생략 구간 {complete.query_plan.omitted_spans?.length}개. 기준 문서는 결과에서 제외했어요.</p></details> : null}
      {searching ? <p className="search-state" role="status">{phaseLabel('phase' in search ? search.phase : 'queued')}</p> : search?.state === 'cancelled' ? <p role="status">검색을 취소했어요.</p> : null}
      {complete?.effective_mode === 'literal' && complete.partial ? <Notice>일부 범위의 결과예요. {complete.stop_reason === 'match_limit' ? '표시 한도에 도달했어요.' : complete.stop_reason === 'unreadable_sources' ? '읽지 못한 원문이 있어요.' : '시간 또는 크기 한도에 도달했어요.'} 범위를 좁혀 다시 검색할 수 있어요.</Notice> : null}
      {complete && complete.effective_mode !== 'literal' && complete.counts.stale_omitted > 0 ? <Notice>변경된 원문 {complete.counts.stale_omitted}개 구간은 결과에서 제외했어요. 수동 색인 후 다시 검색해 주세요.</Notice> : null}
      {complete && complete.effective_mode !== 'literal' ? <>
       {complete.degraded ? <Notice>선택한 모델 검색을 마치지 못해 허용한 대체 방식으로 실행했어요. 실제 방식: {complete.effective_mode} · {complete.rank_stage}</Notice> : null}
       {complete.warnings.includes('SCOPE_INCOMPLETE') ? <Notice error>현재 접근하지 못하는 폴더가 있어요. 기존 색인에서 확인 가능한 결과만 표시해요.</Notice> : null}
       <details className="search-details"><summary>검색 방식과 처리 정보</summary><p>{complete.requested_mode} → {complete.effective_mode} · {complete.rank_stage}</p><p>후보 {complete.counts.retrieved_passages}개 · 리랭킹 {complete.counts.reranked_passages}개 · 문서 {complete.counts.returned_documents}개</p><p className="hint">{complete.warnings.join(' · ') || '모델 오류와 입력 절단 없이 처리했어요.'}</p></details>
      </> : null}
      <div className="mobile-tabs" aria-label="결과와 원문 전환"><Button aria-pressed={mobile === 'results'} onClick={() => setMobile('results')}>검색 결과</Button><Button aria-pressed={mobile === 'source'} onClick={() => setMobile('source')}>원문 읽기</Button></div>
      <div className="reading-grid"><section className={'results-panel mobile-' + mobile} aria-label="검색 결과"><div className="panel-heading"><h2>{comparison ? '원문 비교 근거' : complete ? '검색 결과 ' + results.length + '개' : '검색 결과'}</h2>{complete ? <span className="caption">{complete.effective_mode === 'literal' ? '원문 문자열 일치' : complete.rank_stage === 'qmd_reranked_blend' ? '의미 검색 · 리랭킹' : complete.rank_stage === 'qmd_rrf' ? '의미 검색' : '키워드 일치'}</span> : null}</div>
       {complete && complete.purpose !== 'related' && complete.query_plan.query !== query ? <p className="hint">표시된 결과는 이전 검색어의 결과예요.</p> : null}
       {!results.length ? <Empty title={comparison ? '확인 가능한 비교 근거가 없어요' : complete ? '일치하는 문서를 찾지 못했어요' : '어떤 문서를 찾고 있나요?'}>{complete || comparison ? '검색어를 짧게 바꾸거나 범위를 넓혀 보세요.' : '검색어를 입력하면 원문 근거와 함께 보여드려요.'}</Empty> : results.map(item => <article className={'result-card' + (item.choices.some(c => c.key === selection?.key) ? ' selected' : '')} key={item.key}><button className="result-main" aria-pressed={item.choices.some(c => c.key === selection?.key)} onClick={() => void read(item.choices[0]!)}><span className="collection-label">{item.group ? item.group + ' · ' : ''}{collectionName(item.collection)}</span><h3>{item.title}</h3><span className="path">{item.path}</span><span className="result-excerpt">{item.excerpt}</span><span className="result-foot">L{item.choices[0]!.locator.start.line} · 원문 읽기 <span aria-hidden="true">↗</span></span></button>{item.choices.length > 1 ? <div className="extra-evidence"><Button onClick={() => void read(item.choices[1]!)}>다른 근거 읽기 · L{item.choices[1]!.locator.start.line}</Button></div> : null}</article>)}
       {complete && complete.effective_mode !== 'literal' && complete.supplemental_results.length ? <section className="supplemental" aria-label="키워드 전용 보조 결과"><h3>키워드 전용 보조 결과</h3><p className="hint">길이 제한으로 벡터를 만들지 않은 구간이에요. 위 의미 검색의 점수와 별도로 표시해요.</p>{complete.supplemental_results.map(d => <article className="result-card" key={d.doc_id}><button className="result-main" onClick={() => void read({ key: d.doc_id + '-extra', ...d, locator: d.evidence[0]!.locator, heading: d.evidence[0]!.heading_path })}><h3>{d.title}</h3><span className="path">{d.relative_path}</span><span className="result-excerpt">{d.evidence[0]!.excerpt}</span><span className="result-foot">원문 읽기 · L{d.evidence[0]!.locator.start.line}</span></button></article>)}</section> : null}
       {complete && complete.effective_mode !== 'literal' && complete.has_more ? <p className="hint">더 많은 문서가 있어요. 검색어를 구체적으로 입력해 보세요.</p> : null}
      </section><section className={'source-panel mobile-' + mobile} aria-label="원문 읽기"><div className="panel-heading"><h2>원문 읽기</h2>{source ? <span className="verified">원문 확인됨</span> : null}</div>
       {!selection ? <Empty title="근거를 원문과 함께 읽어요">왼쪽 결과를 선택해 주세요.</Empty> : <><div className="source-title"><span className="collection-label">{collectionName(selection.collection_id)}</span><h3>{selection.title}</h3><p className="path">{selection.relative_path}</p>{selection.heading.length ? <p className="breadcrumb">{selection.heading.join(' / ')}</p> : null}</div>
        {reading ? <p role="status">원문과 revision을 확인하고 있어요.</p> : sourceError ? <Notice error>{sourceError}<Button onClick={() => void runSearch()}>다시 검색</Button></Notice> : source ? <><div className="source-actions"><Button onClick={related} disabled={searching || !enabled.length}>이 구간으로 관련 검색</Button><Button onClick={() => setPins(previous => previous.some(p => p.doc_id === selection.doc_id) ? previous : [...previous.slice(-1), selection])}>비교에 담기</Button></div><div className="source-tools"><span className="caption">L{source.start_line}–{source.end_line}</span><div><Button aria-pressed={context} onClick={() => void read(selection, !context)}>{context ? '근거만' : '앞뒤 문맥'}</Button><Button aria-pressed={raw} onClick={() => setRaw(!raw)}>{raw ? '읽기 보기' : 'Markdown 보기'}</Button></div></div><div className="source-evidence">{raw ? <pre className="raw-source">{source.text}</pre> : <Markdown text={source.text}/>}</div>{source.truncated ? <p className="hint">표시 한도까지 읽었어요. 더 짧은 근거를 선택해 주세요.</p> : null}<p className="hint">수식은 원문의 TeX 표기로 보여드려요.</p><details className="source-details"><summary>문서와 revision 정보</summary><dl><dt>문서 ID</dt><dd>{source.doc_id}</dd><dt>Revision</dt><dd>{source.revision_id}</dd><dt>근거 범위 (UTF-16 · 끝 제외)</dt><dd>{source.locator.start.line}:{source.locator.start.column_utf16}–{source.locator.end.line}:{source.locator.end.column_utf16}</dd></dl></details></> : null}</>}
      </section></div>
     </> : null}
     {page === 'collections' ? <section className="collection-list" aria-label="등록된 컬렉션">{!collections.length ? <Empty title="내 문서에서 시작해요">기존 Markdown 폴더를 등록하고 수동 색인을 시작하세요.</Empty> : collections.map(c => <article className="collection-card" key={c.collection_id}><div className="collection-card-main"><div className="row"><h2>{c.name}</h2><span className="badge">{c.enabled ? '사용 중' : '중지됨'}</span></div><p className="path">{c.root_path}</p><p className="caption">{c.preset === 'learning' ? '학습 프리셋' : '일반 Markdown'} · 읽기 가능 {c.coverage.eligible ?? 0}개 · 제외 {Object.entries(c.coverage).filter(([k]) => k.startsWith('excluded_')).reduce((n, [, v]) => n + v, 0)}개 · 확인 필요 {Object.entries(c.coverage).filter(([k]) => k !== 'eligible' && !k.startsWith('excluded_')).reduce((n, [, v]) => n + v, 0)}개</p>{c.scope.status === 'incomplete' ? <p className="error-text">범위 확인 미완료 · 접근하지 못한 경계 {c.scope.incomplete_boundaries}개</p> : null}<details><summary>포함·제외 범위</summary><p className="path">포함: {c.include.join(', ')}<br />제외: 숨김 폴더, symlink, 제품 데이터{c.exclude.length ? ', ' + c.exclude.join(', ') : ''}</p></details></div><Button onClick={() => void toggle(c)}>{c.enabled ? '검색에서 제외' : '다시 사용'}</Button></article>)}{collections.length ? <div className="collection-actions"><p>색인은 수동으로 갱신해요. 정확한 문자열은 현재 저장된 원문에서 찾아요.</p><Button primary onClick={build} disabled={status?.busy || !enabled.length}>{status?.busy ? '색인 만드는 중' : '수동 색인 시작'}</Button></div> : null}</section> : null}
     {page === 'jobs' ? <section className="job-list" aria-label="색인 작업">{!status?.jobs.length ? <Empty title="아직 작업이 없어요">컬렉션 등록 후 수동 색인을 시작해 주세요.</Empty> : status.jobs.map(job => <article className="job-card" key={job.job_id}><div><h2>문서 색인</h2><p role={active(job.state) ? 'status' : undefined}>{phaseLabel(job.phase)}{phaseLabel(job.phase) !== phaseLabel(job.state) ? ' · ' + phaseLabel(job.state) : ''}</p><p className="caption">{new Date(job.updated_at).toLocaleString('ko-KR')}</p><details><summary>처리 정보</summary><p className="path">{Object.entries(job.progress).map(([key, n]) => key + ': ' + n).join(' · ') || '단계별 상태를 확인하고 있어요.'}</p>{job.error_code ? <p className="error-text">{message(new DsearchError(job.error_code))}</p> : null}<p className="caption path">{job.job_id}</p></details></div>{active(job.state) ? <Button disabled={job.state === 'cancel_requested'} onClick={() => void cancelJob(job)}>{job.state === 'cancel_requested' ? '멈추는 중' : '취소'}</Button> : null}</article>)}<p className="hint">질의와 검색 결과는 작업 이력에 저장하지 않아요.</p></section> : null}
     <footer className="content-footer">키워드 · 의미 검색 · 원문 읽기 <span>자동 동기화는 아직 제공하지 않아요.</span></footer>
    </>}
   </main>
  </div>
  {adding ? <div className="dialog-backdrop"><CollectionDialog error={error} saving={saving} name={name} folder={folder} preset={preset} setName={setName} setFolder={setFolder} setPreset={setPreset} onClose={() => { if (!saving)
        setAdding(false); }} onSubmit={add}/></div> : null}
 </div>;
}
function CollectionDialog(props: {
    error: string;
    saving: boolean;
    name: string;
    folder: string;
    preset: string;
    setName: (s: string) => void;
    setFolder: (s: string) => void;
    setPreset: (s: string) => void;
    onClose: () => void;
    onSubmit: (e: FormEvent) => void;
}) {
    const ref = useRef<HTMLElement>(null), previous = useRef<Element | null>(null);
    useEffect(() => { previous.current = document.activeElement; ref.current?.querySelector<HTMLInputElement>('input')?.focus(); return () => { (previous.current as HTMLElement | null)?.focus(); }; }, []);
    return <section ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-title" onKeyDown={event => { if (event.key === 'Escape') {
        event.preventDefault();
        props.onClose();
    } if (event.key === 'Tab') {
        const items = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select');
        const first = items?.[0], last = items?.[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
        }
        else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
        }
    } }}><h2 id="add-title">폴더 등록</h2><p>검색할 기존 폴더의 절대 경로를 입력해 주세요.</p>{props.error ? <Notice error>{props.error}</Notice> : null}<form onSubmit={props.onSubmit}><label htmlFor="collection-name">이름</label><input id="collection-name" required maxLength={80} value={props.name} onChange={e => props.setName(e.target.value)}/><label htmlFor="collection-root">폴더 경로</label><input id="collection-root" required maxLength={4096} placeholder="/Users/이름/Documents/Notes" value={props.folder} onChange={e => props.setFolder(e.target.value)} aria-describedby="folder-help"/><p className="hint" id="folder-help">일반 Markdown은 .md와 .markdown 파일을 포함해요. 숨김 폴더와 symlink는 제외해요.</p><label htmlFor="collection-preset">자료 종류</label><select id="collection-preset" value={props.preset} onChange={e => props.setPreset(e.target.value)}><option value="general">일반 Markdown 폴더</option><option value="learning">학습 자료 프리셋</option></select>{props.preset === 'learning' ? <p className="hint">보관소 루트를 등록해 주세요. 30_Resources의 ASN.1·Crypto·V2X-Crypto에서 lesson·concept·example 문서를 포함하고, Sources와 superseded 문서는 제외해요.</p> : null}<div className="dialog-actions"><Button type="button" onClick={props.onClose} disabled={props.saving}>취소</Button><Button primary type="submit" disabled={props.saving}>{props.saving ? '등록 중' : '등록'}</Button></div></form></section>;
}
