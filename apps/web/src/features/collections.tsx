import { useState, type FormEvent } from 'react';
import { CollectionRequest } from '@dsearch/contracts';
import { CollectionPreview, type CollectionInfo } from '@dsearch/contracts/control';
import { Button, Notice, Empty } from '../components.js';
import { api, message } from '../api.js';
import { ScopeFields, scopeDraft, scopeRules, eligibilityLabel, reasonLabel } from './scope-fields.js';
import { CollectionDetails } from './management.js';

export function CollectionForm({ onAdded }: { onAdded: () => Promise<void> }) {
  const [name, setName] = useState(''), [root, setRoot] = useState(''), [rules, setRules] = useState(scopeDraft()), [preview, setPreview] = useState<CollectionPreview>(), [checked, setChecked] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  let parsedRules;try { parsedRules = scopeRules(rules); } catch { /* The field editor explains invalid conditions. */ }
  const draft = { name, root, preset: 'general', ...parsedRules }, fingerprint = JSON.stringify(draft), valid = !!parsedRules && CollectionRequest.safeParse(draft).success && root.startsWith('/');
  const check = async () => { setBusy(true);setError('');try { setPreview(CollectionPreview.parse(await api('POST', '/v1/collections/preview', draft)));setChecked(fingerprint); } catch (e) { setError(message(e)); } finally { setBusy(false); } };
  const submit = async (event: FormEvent) => { event.preventDefault();if (fingerprint !== checked) return;setBusy(true);setError('');try { await api('POST', '/v1/collections', draft);await onAdded(); } catch (e) { setError(message(e)); } finally { setBusy(false); } };
  return <form className="management-form collection-form" onSubmit={submit}>{error ? <Notice error>{error}</Notice> : null}<label>이름<input required maxLength={80} value={name} onChange={e => setName(e.target.value)}/></label><label>폴더 경로<input required maxLength={4096} placeholder="/absolute/path/to/documents" value={root} onChange={e => setRoot(e.target.value)}/></label><p className="hint">기존 Markdown 폴더의 절대 경로를 입력하세요. 원문 속성이나 파일 내용은 바꾸지 않아요.</p>
    <ScopeFields value={rules} change={setRules}/>
    <div className="management-actions"><Button disabled={!valid || busy} onClick={() => void check()}>{busy ? '확인 중' : '범위 미리보기'}</Button><Button primary type="submit" disabled={!valid || busy || checked !== fingerprint}>폴더 등록</Button></div>
    {preview && checked === fingerprint ? <section className="scope-preview" aria-label="등록 범위 미리보기"><h3>범위 확인</h3><p>포함 가능 {preview.counts.eligible ?? 0}개 · 제외 {Object.entries(preview.counts).filter(([k]) => k.startsWith('excluded')).reduce((sum, [, value]) => sum + value, 0)}개 · 확인 필요 {Object.entries(preview.counts).filter(([k]) => k !== 'eligible' && !k.startsWith('excluded')).reduce((sum, [, value]) => sum + value, 0)}개</p>{preview.partial ? <Notice>미리보기 한도까지 확인했어요. 실제 색인에서 전체 범위를 다시 확인해요.</Notice> : null}{preview.scope_incomplete ? <Notice error>접근하지 못한 범위가 있어요. 폴더 권한을 확인해 주세요.</Notice> : null}<ul className="coverage-list">{preview.sample.slice(0, 8).map((d, i) => <li key={i}><span className="path">{d.relative_path}</span><span className="caption">{eligibilityLabel(d.eligibility)} · {reasonLabel(d.reason)}</span></li>)}</ul></section> : null}
  </form>;
}
export function Collections({ collections, refresh, build, busy }: { collections: CollectionInfo[]; refresh: () => Promise<void>; build: () => void; busy: boolean }) {
  const [error, setError] = useState('');
  const toggle = async (c: CollectionInfo) => { setError('');try { await api('PATCH', '/v1/collections/' + c.collection_id, { enabled: !c.enabled });await refresh(); } catch (e) { setError(message(e)); } };
  const remove = async (c: CollectionInfo) => { setError('');try { await api('DELETE', '/v1/collections/' + c.collection_id);await refresh(); } catch (e) { setError(message(e)); } };
  return <section className="collection-list" aria-label="등록된 컬렉션">{error ? <Notice error>{error}</Notice> : null}{!collections.length ? <Empty title="내 문서에서 시작해요">Markdown 폴더를 등록하고 검색 자료를 준비하세요.</Empty> : collections.map(c => <article className="collection-card" key={c.collection_id}><div className="collection-card-main"><div className="row"><h2>{c.name}</h2><span className="badge">{c.enabled ? '사용 중' : '일시 중지'}</span></div><p className="path">{c.root_path}</p><p className="caption">읽기 가능 {c.coverage.eligible ?? 0}개 · {c.scope.status === 'unscanned' ? '아직 전체 확인 전' : c.scope.status === 'incomplete' ? '접근하지 못한 범위 있음' : '전체 범위 확인됨'}</p><CollectionDetails collection={c} onUpdated={refresh}/><div className="management-actions"><Button onClick={() => void toggle(c)}>{c.enabled ? '일시 중지' : '다시 사용'}</Button><Button onClick={() => void remove(c)}>등록 해제</Button></div><p className="hint">등록 해제는 검색 범위만 제거해요. 같은 폴더를 다시 등록할 수 있어요.</p></div></article>)}{collections.length ? <div className="collection-actions"><p>변경한 문서와 범위 설정은 수동 색인으로 반영하세요.</p><Button primary onClick={build} disabled={busy || !collections.some(c => c.enabled)}>수동 색인 시작</Button></div> : null}</section>;
}
