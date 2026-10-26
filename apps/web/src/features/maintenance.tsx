import {useEffect,useState} from 'react';
import {BackupInfo,GCPreview,type AppStatus} from '@dsearch/contracts/control';
import {Button,Notice,Empty} from '../components.js';
import {api,message} from '../api.js';
import {JobProgress} from './models.js';
import {downloadJSON} from './management.js';
const size=(bytes:number)=>bytes<1024?bytes+' B':bytes<1048576?Math.ceil(bytes/1024)+' KiB':(bytes/1048576).toFixed(1)+' MiB';
export function Maintenance({status,start,showJobs}:{status:AppStatus;start:(path:string,body:unknown)=>Promise<{job_id:string}>;showJobs:()=>void}){
 const [backups,setBackups]=useState<BackupInfo[]>([]),[preview,setPreview]=useState<GCPreview>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[lastJob,setLastJob]=useState<string>();const job=status.jobs.find(job=>job.job_id===lastJob);
 const load=async()=>{try{const values=await api<unknown[]>('GET','/v1/backups');setBackups(values.map(value=>BackupInfo.parse(value)));}catch(e){setError(message(e));}};
 useEffect(()=>{if(!status.execution.maintenance_busy)void load();},[status.execution.maintenance_busy,job?.state]);
 const run=async(path:string,body:unknown)=>{setError('');setBusy(true);try{const accepted=await start(path,body);setLastJob(accepted.job_id);setPreview(undefined);}catch(e){setError(message(e));}finally{setBusy(false);}};
 const inspect=async()=>{setBusy(true);setError('');try{setPreview(GCPreview.parse(await api('POST','/v1/maintenance/gc/preview',{})));}catch(e){setError(message(e));}finally{setBusy(false);}};
 return <>
  {error?<Notice error>{error}</Notice>:null}
  <section className="management-card" aria-label="데이터 백업"><h2>데이터 백업</h2><p>설정과 검색 색인을 백업해요. 원문 파일은 별도로 백업해 주세요. 최근 백업 7개를 보관해요.</p><div className="management-actions"><Button primary disabled={busy||status.busy} onClick={()=>void run('/v1/backups',{})}>백업 만들기</Button><Button disabled={busy||status.execution.maintenance_busy} onClick={()=>void load()}>목록 새로고침</Button></div>
   {backups.length?<><label className="backup-location">최근 백업 위치<input readOnly value={backups[0]!.path} onFocus={event=>event.currentTarget.select()}/></label><ul className="coverage-list">{backups.slice(0,3).map(backup=><li key={backup.backup_id}><span>{new Date(backup.created_at).toLocaleString('ko-KR')}</span><span className="caption">{size(backup.bytes)}</span></li>)}</ul><details><summary>복원 방법</summary><p>서비스를 종료한 뒤 터미널에서 백업 위치와 복원할 데이터 경로를 지정해 미리보기를 확인하세요.</p><pre className="raw-source">{'pnpm dsearch restore "백업 폴더" --target-root "복원할 데이터 경로" --json'}</pre><p className="hint">미리보기에서 받은 계획 ID를 같은 명령의 <code>--apply --plan-id 계획_ID</code>에 지정하면 복원해요.</p></details></>:<Empty title="아직 백업이 없어요">백업 만들기로 현재 설정과 검색 자료를 보관하세요.</Empty>}
  </section>
  <section className="management-card" aria-label="이전 색인 정리"><h2>이전 색인 정리</h2><p>사용 중이거나 읽기·재개·백업에 필요한 색인을 보존해요. 이전 정상 색인 2개와 최근 24시간의 자료도 남겨요.</p><div className="management-actions"><Button disabled={busy||status.busy} onClick={()=>void inspect()}>정리 대상 확인</Button></div>
   {preview?<div className="scope-preview"><h3>정리 대상 {preview.candidates.length}개 · {size(preview.candidates.reduce((bytes,item)=>bytes+item.bytes,0))}</h3>{preview.candidates.length?<><ul className="coverage-list">{preview.candidates.slice(0,10).map(item=><li key={item.generation_id}><span>{new Date(item.created_at).toLocaleString('ko-KR')}<span className="caption"> · {item.state==='invalid'?'중단된 색인':'이전 색인'}</span></span><span>{size(item.bytes)} · 구간 {item.passages}개</span></li>)}</ul><div className="management-actions"><Button onClick={()=>downloadJSON(preview,'dsearch-cleanup-preview.json')}>전체 대상 목록 저장</Button><Button disabled={busy||status.busy} onClick={()=>void run('/v1/maintenance/gc/apply',{...preview.policy,plan_id:preview.plan_id})}>{preview.candidates.length}개 정리</Button></div></>:<p>지금 정리할 색인이 없어요.</p>}<p className="hint">보관 중인 색인 {preview.protected.length}개. 사용 상태가 바뀌면 대상을 다시 확인해야 해요.</p></div>:null}
  </section>
  {job?<section className="management-card"><h2>처리 상태</h2><JobProgress job={job}/><Button onClick={showJobs}>작업 보기</Button></section>:null}
 </>;
}
