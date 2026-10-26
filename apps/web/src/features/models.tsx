import { useState } from 'react';
import type { AppStatus, ModelInfo, ProfileCatalog, JobInfo } from '@dsearch/contracts/control';
import { DsearchError } from '@dsearch/contracts';
import { Button, Notice, phaseLabel } from '../components.js';
import { message } from '../api.js';

export function JobProgress({ job }: { job: JobInfo | undefined }) {
  if (!job) return null;const p = job.progress;
  return <div className="job-progress" role="status"><p>{phaseLabel(job.phase)} · {phaseLabel(job.state)}</p>
    {job.phase === 'downloading-model' && p.total_bytes ? <><label>현재 모델 파일 · {Math.round((p.bytes ?? 0) / 1048576)} / {Math.round(p.total_bytes / 1048576)}MiB<progress value={p.bytes ?? 0} max={p.total_bytes}/></label></> : p.completed !== undefined && p.total !== undefined ? <p className="caption">{job.phase === 'embedding' ? '검색 구간' : '처리'} {p.completed} / {p.total}{job.phase === 'embedding' ? '개 준비' : ''}</p> : <p className="caption">{Object.entries(p).filter(([key,value])=>!['embedding_calls','failed_native_requests','embedding_call_count_incomplete','yields'].includes(key)&&(!['resource_retries','reused_documents'].includes(key)||value>0)).map(([key,value])=>({documents:'문서',passages:'검색 구간',reused_documents:'재사용 문서',embedding_calls:'임베딩 호출',bytes:'바이트',generations:'색인',models:'모델',resource_retries:'메모리 재시도',failed_native_requests:'실패한 모델 요청',embedding_call_count_incomplete:'호출 수 확인 제한'}[key]??key)+': '+value).join(' · ')}</p>}
    {job.error_code ? <p className="error-text">{message(new DsearchError(job.error_code))}</p> : null}</div>;
}
export function Models({ catalog, models, status, start, setup = false, canBuild = true }: {
  catalog: ProfileCatalog; models: ModelInfo[]; status: AppStatus; start: (path: string, body: unknown) => Promise<{ job_id: string }>; setup?: boolean; canBuild?: boolean;
}) {
  const [selected, setSelected] = useState(catalog.selected_profile_id), [error, setError] = useState(''), [starting, setStarting] = useState(false), [lastJob, setLastJob] = useState<string>();
  const profile = catalog.profiles.find(p => p.profile_id === selected) ?? catalog.profiles[0]!, needed = models.filter(m => profile.model_roles.includes(m.role)), ready = needed.length === profile.model_roles.length && needed.every(m => m.state === 'verified'), busy = status.busy || starting;
  const run = async (path: string, body: unknown) => { setError('');setStarting(true);try { setLastJob((await start(path, body)).job_id); } catch (e) { setError(message(e)); } finally { setStarting(false); } };
  const names = { missing: '설치되지 않음', unverified: '파일 있음 · 실행 시 검증', verified: '무결성 확인됨', invalid: '파일 검증 필요' };
  return <section className="management-card model-settings" aria-label="검색 모델과 프로필"><h2>{setup ? '2. 검색 모델 준비' : '검색 모델과 프로필'}</h2>{error ? <Notice error>{error}</Notice> : null}
    <label htmlFor={setup ? 'setup-profile' : 'settings-profile'}>사용할 프로필</label><select id={setup ? 'setup-profile' : 'settings-profile'} value={profile.profile_id} disabled={busy} onChange={e => setSelected(e.target.value)}>{catalog.profiles.map(p => <option key={p.profile_id} value={p.profile_id}>{p.title}{p.profile_id === catalog.selected_profile_id ? ' · 현재 선택' : ''}</option>)}</select>
    <p>선택만으로 현재 검색 프로필이 바뀌지 않아요. 새 색인을 검증한 뒤 전환해요.</p><div className="model-list">{needed.map(m => <article key={m.role} className="model-file"><div className="row"><h3>{m.role === 'rerank' ? '리랭킹 모델' : '임베딩 모델'}</h3><span className="badge">{names[m.state]}</span></div><p className="path">{m.filename}</p><p className="caption">{Math.round(m.bytes / 1048576)}MiB · 로컬 GGUF Q8_0</p>{m.verified_at ? <p className="caption">확인: {new Date(m.verified_at).toLocaleString('ko-KR')}</p> : null}<details><summary>파일 식별자</summary><p className="path">{m.repository}<br/>revision: {m.revision}<br/>SHA-256: {m.sha256}</p></details></article>)}</div>
    <p className="hint">필요한 파일 합계 {Math.round(needed.reduce((sum, m) => sum + m.bytes, 0) / 1048576)}MiB. 다운로드는 고정된 저장소·revision에서 진행하고 SHA-256을 확인해요.</p>
    <div className="management-actions"><Button disabled={busy} onClick={() => void run('/v1/models/check', { profile_id: profile.profile_id })}>설치 파일 검증</Button><Button disabled={busy} onClick={() => void run('/v1/models/prepare', { profile_id: profile.profile_id })}>다운로드 및 검증</Button></div>
    <JobProgress job={status.jobs.find(j => j.job_id === lastJob)}/>
    {setup ? <><h2>3. 색인 만들기</h2><p>폴더 등록과 모델 검증을 마치면 원문을 대조하고 새 색인을 게시해요.</p><Button primary disabled={busy || !ready || !canBuild} onClick={() => void run('/v1/profiles/' + profile.profile_id + '/build', {})}>{busy ? '작업 진행 중' : '색인 만들고 검색 준비'}</Button></> : <>
      <h3>전환할 색인 준비</h3><Button disabled={busy || !ready} onClick={() => void run('/v1/profiles/' + profile.profile_id + '/prepare', {})}>이 프로필의 새 색인 준비</Button>
      <div className="generation-list">{catalog.generations.filter(g => g.profile_id === profile.profile_id).map(g => <article className="generation-row" key={g.generation_id}><div><p>{g.state === 'active' ? '사용 중' : g.state === 'ready' ? '전환 준비됨' : g.state === 'retired' ? '이전 세대' : g.state === 'invalid' ? '검증 실패' : '준비 중'}{g.stale ? ' · 원문 갱신 필요' : ''}</p><p className="caption path">{g.generation_id}</p></div>{['ready', 'retired'].includes(g.state) ? <Button disabled={busy || !g.compatible || g.stale} onClick={() => void run('/v1/profiles/' + profile.profile_id + '/activate', { generation_id: g.generation_id, expected_epoch: catalog.active_epoch })}>검증 후 전환</Button> : null}</article>)}</div>
    </>}
  </section>;
}
