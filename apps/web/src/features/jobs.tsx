import { DsearchError } from '@dsearch/contracts';
import type { JobInfo } from '@dsearch/contracts/control';
import { Button, Empty } from '../components.js';
import { message } from '../api.js';
import { JobProgress } from './models.js';
import { isWorking } from './search-session.js';
export function Jobs({ jobs, cancel, retry }: { jobs: JobInfo[]; cancel: (id: string) => void; retry: (id: string) => void }) {
  const names = { 'full-build': '문서 색인', 'profile-build': '프로필 색인 준비', 'model-prepare': '모델 다운로드·검증', 'model-check': '모델 파일 검증', 'profile-activate': '검증된 세대 전환', backup:'데이터 백업', 'generation-gc':'이전 색인 정리' };
  return <section className="job-list" aria-label="작업 목록">{!jobs.length ? <Empty title="아직 작업이 없어요">검색 준비에서 폴더와 모델을 준비하세요.</Empty> : jobs.map(job => <article className="job-card" key={job.job_id}><div><h2>{names[job.kind]}</h2><JobProgress job={job}/><p className="caption">{new Date(job.updated_at).toLocaleString('ko-KR')}</p><details><summary>처리 정보</summary><p className="path">작업: {job.job_id}</p>{job.generation_id ? <p className="path">세대: {job.generation_id}</p> : null}{job.progress.embedding_calls!==undefined?<p>확인된 임베딩 호출: {job.progress.embedding_calls}회{job.progress.embedding_call_count_incomplete?' · 종료된 일부 요청의 호출 수는 포함되지 않았어요.':''}</p>:null}{job.progress.yields ? <p>검색을 위한 양보: {job.progress.yields}회</p> : null}{job.error_code ? <p>{message(new DsearchError(job.error_code))}</p> : null}</details></div>{isWorking(job.state) ? <Button disabled={job.state === 'cancel_requested'} onClick={() => cancel(job.job_id)}>{job.state === 'cancel_requested' ? '멈추는 중' : '취소'}</Button> : job.retryable ? <Button onClick={() => retry(job.job_id)}>다시 시도</Button> : null}</article>)}<p className="hint">질의와 검색 결과는 작업 이력에 저장하지 않아요. 취소는 실제 처리가 종료된 후 ‘취소됨’으로 표시해요.</p></section>;
}
