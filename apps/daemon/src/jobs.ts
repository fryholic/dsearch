import { randomUUID } from 'node:crypto';
import { DsearchError, ErrorCode } from '@dsearch/contracts';
import {canResumeBuild} from '@dsearch/generations';
import { JobInfo, retryableJobCode } from '@dsearch/contracts/control';
import { canonicalJSON, type StateStore } from '@dsearch/catalog';
type Kind = 'model-prepare' | 'model-check' | 'profile-activate' | 'backup' | 'generation-gc';
type Progress = (phase: string, counts?: Record<string, number>) => void;
export class ManagedJobs {
  private readonly active = new Map<string, { controller: AbortController; completion: Promise<void> }>();
  private closing = false;
  constructor(private readonly state: StateStore,private readonly options:{profiles?:ReadonlySet<string>}={}) {
    state.db.prepare("UPDATE jobs SET state='obsolete',phase='interrupted',error_code='WORKER_EXITED',updated_at=? WHERE kind IN ('model-prepare','model-check','profile-activate','backup','generation-gc') AND state IN ('queued','running','retry_wait')").run(new Date().toISOString());
  }
  get busy() { return this.active.size > 0; }
  info(id: string): JobInfo {
    const row = this.state.db.prepare('SELECT * FROM jobs WHERE job_id=?').get(id);if (!row) throw new DsearchError('NOT_FOUND');
    const cursor=JSON.parse(String(row.cursor_json)),canResume=canResumeBuild(this.state,id,this.options.profiles),requiresGeneration=['full-build','profile-build','profile-activate'].includes(String(row.kind));
    return JobInfo.parse({ job_id: row.job_id, origin:cursor.origin??'manual', kind: row.kind, generation_id: row.generation_id, state: row.cancel_requested && ['queued', 'running'].includes(String(row.state)) ? 'cancel_requested' : row.state, phase: row.phase, progress: JSON.parse(String(row.progress_json)), error_code: row.error_code, retryable: row.kind!=='generation-gc' && (!requiresGeneration||!!row.generation_id) && ['failed','obsolete','cancelled'].includes(String(row.state)) && (cursor.checkpoint?canResume:retryableJobCode(row.error_code == null ? null : String(row.error_code))), updated_at: row.updated_at });
  }
  start(kind: Kind, operation: (signal: AbortSignal, progress: Progress) => Promise<void>, generationId: string | null = null, metadata: { profile_id?: string } = {}) {
    if (this.closing) throw new DsearchError('SERVICE_UNAVAILABLE');if (this.busy) throw new DsearchError('BUSY');
    const id = randomUUID(), controller = new AbortController(), now = new Date().toISOString();
    this.state.db.prepare("INSERT INTO jobs VALUES (?,?,?,?,'queued','queued',?,'{}',0,0,NULL,NULL,NULL,?)").run(id, id, kind, generationId, canonicalJSON(metadata), now);
    const progress: Progress = (phase, counts = {}) => { this.state.db.prepare("UPDATE jobs SET state='running',phase=?,progress_json=?,updated_at=? WHERE job_id=?").run(phase, canonicalJSON(counts), new Date().toISOString(), id); };
    const completion = Promise.resolve().then(async () => {
      try { if (controller.signal.aborted) throw new DsearchError('CANCELLED');await operation(controller.signal, progress);if (controller.signal.aborted) throw new DsearchError('CANCELLED');
        this.state.db.prepare("UPDATE jobs SET state='succeeded',phase='complete',updated_at=? WHERE job_id=?").run(new Date().toISOString(), id);
      } catch (error) { const parsed = ErrorCode.safeParse(error && typeof error === 'object' && 'code' in error ? error.code : undefined), cancelled = controller.signal.aborted;
        this.state.db.prepare('UPDATE jobs SET state=?,phase=?,error_code=?,updated_at=? WHERE job_id=?').run(cancelled ? 'cancelled' : 'failed', cancelled ? 'cancelled' : 'failed', cancelled ? 'CANCELLED' : parsed.success ? parsed.data : 'INTERNAL_ERROR', new Date().toISOString(), id);
      } finally { this.active.delete(id); }
    });
    this.active.set(id, { controller, completion });return { job_id: id, generation_id: generationId, state: 'queued' as const };
  }
  cancel(id: string): boolean { const item = this.active.get(id);if (!item) return false;this.state.db.prepare('UPDATE jobs SET cancel_requested=1,updated_at=? WHERE job_id=?').run(new Date().toISOString(), id);item.controller.abort();return true; }
  async close() { this.closing = true;for (const item of this.active.values()) item.controller.abort();await Promise.allSettled([...this.active.values()].map(item => item.completion)); }
}
