import { useEffect, useState, type FormEvent } from 'react';
import { Preferences, type CollectionInfo } from '@dsearch/contracts/control';
import { api, message } from '../api.js';
import { Button, Notice, Empty } from '../components.js';

export function downloadJSON(data: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
  const anchor = document.createElement('a');anchor.href = url;anchor.download = name;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Settings({ value, onSaved }: { value: Preferences; onSaved: (value: Preferences) => void }) {
  const [draft, setDraft] = useState(value), [saving, setSaving] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const submit = async (event: FormEvent) => { event.preventDefault();setSaving(true);setSaved(false);setError('');
    try { const result = Preferences.parse(await api('PUT', '/v1/settings', draft));onSaved(result);setSaved(true); } catch (e) { setError(message(e)); } finally { setSaving(false); }
  };
  return <form className="management-form" onSubmit={submit}>
    {error ? <Notice error>{error}</Notice> : null}
    <section className="management-card"><h2>화면</h2><p>흰 배경과 세이지 색상을 기본으로 사용해요.</p><fieldset><legend>테마</legend><div className="theme-choices">{([['system', '시스템'], ['light', '라이트'], ['dark', '다크']] as const).map(([id, label]) => <label key={id}><input type="radio" name="theme" value={id} checked={draft.theme === id} onChange={() => setDraft({ ...draft, theme: id })}/>{label}</label>)}</div></fieldset></section>
    <section className="management-card"><h2>검색 기본값</h2><label htmlFor="default-mode">검색 방식</label><select id="default-mode" value={draft.search.mode} onChange={e => setDraft({ ...draft, search: { ...draft.search, mode: e.target.value as 'lexical' | 'hybrid' } })}><option value="hybrid">의미 함께</option><option value="lexical">키워드</option></select>
      <label className="checkbox"><input type="checkbox" checked={draft.search.rerank} onChange={e => setDraft({ ...draft, search: { ...draft.search, rerank: e.target.checked } })}/>리랭킹 사용</label><p className="hint">현재 조정 자료에서는 리랭킹의 순위 개선을 확인하지 못해 기본으로 꺼 두었어요. 필요할 때 비교해서 사용하세요.</p>
      <label className="checkbox"><input type="checkbox" checked={draft.search.allow_degraded} onChange={e => setDraft({ ...draft, search: { ...draft.search, allow_degraded: e.target.checked } })}/>모델 오류 시 대체 검색 허용</label>
      <label htmlFor="candidate-limit">검색 후보 상한</label><input id="candidate-limit" type="number" min={1} max={80} value={draft.search.candidate_limit} onChange={e => setDraft({ ...draft, search: { ...draft.search, candidate_limit: Number(e.target.value) } })}/>
    </section><section className="management-card"><h2>실행과 저장</h2><p>모델 작업은 한 번에 하나씩 실행하고, 5분간 사용하지 않은 모델은 메모리에서 해제해요.</p><p>검색어와 결과는 메모리에만 유지해요. 검색 결과는 직접 내보내기를 실행할 때 파일로 저장돼요.</p></section>
    <div className="management-actions"><Button primary type="submit" disabled={saving}>{saving ? '저장 중' : '설정 저장'}</Button>{saved ? <p role="status">설정을 저장했어요.</p> : null}</div>
  </form>;
}
export function Diagnostics() {
  const [data, setData] = useState<Record<string, any>>(), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const load = async () => { setLoading(true);setError('');try { setData(await api('POST', '/v1/diagnostics', {})); } catch (e) { setError(message(e)); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, []);
  return <section className="management-form">{error ? <Notice error>{error}</Notice> : null}<div className="management-actions"><Button onClick={() => void load()} disabled={loading}>{loading ? '확인 중' : '상태 다시 확인'}</Button><Button disabled={!data} onClick={() => downloadJSON(data, 'dsearch-diagnostics.json')}>진단 내보내기</Button></div><p className="hint">진단에는 원문·검색어·컬렉션 이름과 경로·인증 정보를 포함하지 않아요.</p>
    {data ? <><section className="management-card"><h2>검색 준비 상태</h2><dl><dt>활성 세대</dt><dd className="path">{data.generation?.generation_id ?? '아직 없음'}</dd><dt>자료 갱신</dt><dd>{data.needs_rebuild ? '수동 색인이 필요해요' : '현재 색인을 사용할 수 있어요'}</dd><dt>폴더 접근</dt><dd>{data.scope_incomplete ? '확인하지 못한 범위가 있어요' : '확인된 불완전 범위가 없어요'}</dd><dt>모델 메모리</dt><dd>{data.execution.resident_workers}개 실행 프로세스</dd><dt>대기 요청</dt><dd>{data.execution.queued_requests}개</dd></dl></section><section className="management-card"><h2>문서 처리 상태</h2>{Object.keys(data.coverage).length ? Object.entries(data.coverage).map(([key, value]) => <p key={key}>{key}: {String(value)}개</p>) : <Empty title="색인이 아직 없어요">컬렉션에서 수동 색인을 시작하세요.</Empty>}</section><details className="management-card"><summary>진단 원자료</summary><pre className="raw-source">{JSON.stringify(data, null, 2)}</pre></details></> : null}
  </section>;
}
export function CollectionDetails({ collection, onUpdated }: { collection: CollectionInfo; onUpdated: () => Promise<void> }) {
  const [name, setName] = useState(collection.name), [include, setInclude] = useState(collection.include.join('\n')), [exclude, setExclude] = useState(collection.exclude.join('\n')), [error, setError] = useState(''), [coverage, setCoverage] = useState<{ documents: { doc_id: string; relative_path: string; eligibility: string; reason: string | null }[]; has_more: boolean; offset: number }>(), [busy, setBusy] = useState(false);
  const load = async (offset = 0) => { setError('');setBusy(true);try { setCoverage(await api('POST', '/v1/collections/' + collection.collection_id + '/coverage', { offset, limit: 50 })); } catch (e) { setError(message(e)); } finally { setBusy(false); } };
  const submit = async (e: FormEvent) => { e.preventDefault();setBusy(true);setError('');try { await api('PATCH', '/v1/collections/' + collection.collection_id, { name, include: include.split('\n').filter(Boolean), exclude: exclude.split('\n').filter(Boolean) });await onUpdated(); } catch (e) { setError(message(e)); } finally { setBusy(false); } };
  return <details className="collection-editor"><summary>범위 편집과 처리 상태</summary>{error ? <Notice error>{error}</Notice> : null}<form className="management-form" onSubmit={submit}><label>이름<input value={name} maxLength={80} required onChange={e => setName(e.target.value)}/></label><label>포함 규칙 · 한 줄에 하나<textarea value={include} onChange={e => setInclude(e.target.value)} rows={3}/></label><label>제외 규칙 · 한 줄에 하나<textarea value={exclude} onChange={e => setExclude(e.target.value)} rows={3}/></label><p className="hint">범위를 바꾸면 새 색인이 필요해요. 원문 파일은 수정하지 않아요.</p><Button type="submit" disabled={busy}>범위 저장</Button></form><Button onClick={() => void load()} disabled={busy}>문서별 처리 상태 확인</Button>{coverage ? <><ul className="coverage-list">{coverage.documents.map(d => <li key={d.doc_id}><span className="path">{d.relative_path}</span><span>{d.eligibility} · {d.reason ?? '확인됨'}</span></li>)}</ul><div className="management-actions"><Button disabled={busy || coverage.offset === 0} onClick={() => void load(Math.max(0, coverage.offset - 50))}>이전 50개</Button><Button disabled={busy || !coverage.has_more} onClick={() => void load(coverage.offset + 50)}>다음 50개</Button></div></> : null}</details>;
}
