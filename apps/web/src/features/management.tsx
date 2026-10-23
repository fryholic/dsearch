import { useEffect, useState, type FormEvent } from 'react';
import { Preferences, CollectionPreview, CollectionPatch, type CollectionInfo } from '@dsearch/contracts/control';
import { api, message } from '../api.js';
import { ScopeFields, scopeDraft, scopeRules, eligibilityLabel, reasonLabel } from './scope-fields.js';
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
      <label className="checkbox"><input type="checkbox" checked={draft.search.rerank} onChange={e => setDraft({ ...draft, search: { ...draft.search, rerank: e.target.checked } })}/>리랭킹 사용</label><p className="hint">검색 후보의 관련성을 다시 검토해 순서를 조정해요. 추가 처리 시간이 필요하며 기본값은 꺼짐이에요.</p>
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
  const [name, setName] = useState(collection.name), [rules, setRules] = useState(() => scopeDraft(collection)), [relax, setRelax] = useState(false), [error, setError] = useState(''), [preview, setPreview] = useState<CollectionPreview>(), [checked, setChecked] = useState(''), [coverage, setCoverage] = useState<{ documents: { doc_id: string; relative_path: string; eligibility: string; reason: string | null }[]; has_more: boolean; offset: number }>(), [busy, setBusy] = useState(false);
  let parsedRules;try { parsedRules = scopeRules(rules); } catch { /* Explained beside the condition field. */ }
  const patch = { name, ...parsedRules, ...(collection.legacy_compatibility && relax ? { legacy_compatibility: false as const } : {}) }, fingerprint = JSON.stringify(patch), valid = !!parsedRules && CollectionPatch.safeParse(patch).success;
  const load = async (offset = 0) => { setError('');setBusy(true);try { setCoverage(await api('POST', '/v1/collections/' + collection.collection_id + '/coverage', { offset, limit: 50 })); } catch (e) { setError(message(e)); } finally { setBusy(false); } };
  const check = async () => { setError('');setBusy(true);try { setPreview(CollectionPreview.parse(await api('POST', '/v1/collections/' + collection.collection_id + '/preview', patch)));setChecked(fingerprint); } catch (e) { setError(message(e)); } finally { setBusy(false); } };
  const submit = async (e: FormEvent) => { e.preventDefault();if (checked !== fingerprint) return;setBusy(true);setError('');try { await api('PATCH', '/v1/collections/' + collection.collection_id, patch);setChecked('');await onUpdated(); } catch (e) { setError(message(e)); } finally { setBusy(false); } };
  return <details className="collection-editor"><summary>범위 편집과 처리 상태</summary>
    {error ? <Notice error>{error}</Notice> : null}
    {collection.migration?.reindex_required ? <Notice error={collection.migration.status === 'changed'}>{collection.migration.status === 'changed' ? '이전 설정과 포함 범위가 달라 자동 적용을 중단했어요. 규칙을 확인하고 미리보기 후 저장하세요.' : collection.migration.status === 'unverified' ? '이전 설정을 변환했어요. 수동 색인에서 기존 포함 범위와 대조해요.' : '규칙을 확인했어요. 새 색인을 만들어 적용하세요.'}</Notice> : null}
    <form className="management-form" onSubmit={submit}><label>이름<input value={name} maxLength={80} required onChange={e => setName(e.target.value)}/></label><ScopeFields value={rules} change={setRules}/>
    {collection.legacy_compatibility ? <label className="checkbox"><input type="checkbox" checked={relax} onChange={e => setRelax(e.target.checked)}/>이전 버전의 메타데이터 형식 제약 해제</label> : null}
    {collection.legacy_compatibility ? <p className="hint">기존 문서 범위를 유지하고 있어요. 형식 제약을 해제하면 목록형 필드 등을 가진 문서가 추가될 수 있으니 미리보기의 차이를 확인하세요.</p> : null}
    <p className="hint">범위를 바꾸면 새 색인이 필요해요. 원문 파일은 수정하지 않아요.</p>
    <div className="management-actions"><Button disabled={busy || !valid} onClick={() => void check()}>변경 범위 미리보기</Button><Button type="submit" disabled={busy || !valid || checked !== fingerprint}>범위 저장</Button></div>
    {preview && checked === fingerprint ? <p role="status">{preview.changes ? `포함 추가 ${preview.changes.added}개 · 제외로 변경 ${preview.changes.removed}개 · 포함 유지 ${preview.changes.unchanged}개` : '확인 한도 또는 접근 제한으로 전체 차이를 계산하지 못했어요. 실제 색인에서 전체 범위를 확인해요.'}</p> : null}</form>
    <Button onClick={() => void load()} disabled={busy}>문서별 처리 상태 확인</Button>{coverage ? <><ul className="coverage-list">{coverage.documents.map(d => <li key={d.doc_id}><span className="path">{d.relative_path}</span><span>{eligibilityLabel(d.eligibility)} · {reasonLabel(d.reason)}</span><details><summary>진단 코드</summary>{d.eligibility} · {d.reason}</details></li>)}</ul><div className="management-actions"><Button disabled={busy || coverage.offset === 0} onClick={() => void load(Math.max(0, coverage.offset - 50))}>이전 50개</Button><Button disabled={busy || !coverage.has_more} onClick={() => void load(coverage.offset + 50)}>다음 50개</Button></div></> : null}
  </details>;
}
