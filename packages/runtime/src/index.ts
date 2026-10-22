import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { DsearchError, ErrorCode, ErrorReason } from "@dsearch/contracts";
export { fileDigest, verifyModel, engineArtifact, loadEngineArtifact } from "./artifacts.js";

export type WorkerState = "idle" | "running" | "cancel_requested" | "stopped";
export type Progress = { phase: string; completed: number };
type Pending = {
  id: string; cancelled: boolean; finish: (error?: Error, value?: unknown) => void;
  progress?: (event: Progress) => void; killTimer?: ReturnType<typeof setTimeout>;
};

/** One isolated native worker. A cancellation is terminal only after a reply or confirmed process exit. */
export class EngineProcess {
  readonly pid: number;
  private readonly child: ChildProcess;
  private pending: Pending | undefined;
  private exited = false;
  private closing: Promise<void> | undefined;
  private stateValue: WorkerState = "idle";
  private diagnosticBytes = 0;
  constructor(entry: URL, options: { env?: Record<string, string>; cancelGraceMs?: number } = {}) {
    this.cancelGraceMs = options.cancelGraceMs ?? 3000;
    this.child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: [],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        LANG: "en_US.UTF-8", NODE_NO_WARNINGS: "1", ...options.env } });
    this.pid = this.child.pid!;
    // Native stdout/stderr can contain input or paths. Never forward or persist them.
    const discard = (chunk: Buffer) => { this.diagnosticBytes = Math.min(1_048_576, this.diagnosticBytes + chunk.length); };
    this.child.stdout?.on("data", discard); this.child.stderr?.on("data", discard);
    this.child.on("message", message => this.receive(message));
    this.child.on("error", () => this.fail(new DsearchError("WORKER_EXITED")));
    this.child.on("exit", () => {
      this.exited = true; this.stateValue = "stopped";
      this.fail(new DsearchError(this.pending?.cancelled ? "CANCELLED" : "WORKER_EXITED"));
    });
  }
  private readonly cancelGraceMs: number;
  get state(): WorkerState { return this.stateValue; }
  get diagnostics(): { discardedBytes: number } { return { discardedBytes: this.diagnosticBytes }; }

  invoke<T>(payload: unknown, options: { signal?: AbortSignal; onProgress?: (event: Progress) => void; timeoutMs?: number } = {}): Promise<T> {
    if (this.exited || this.closing) return Promise.reject(new DsearchError("WORKER_EXITED"));
    if (options.signal?.aborted) return Promise.reject(new DsearchError("CANCELLED"));
    if (this.pending) return Promise.reject(new DsearchError("BUSY"));
    let serialized: string;
    try { serialized = JSON.stringify(payload); } catch { return Promise.reject(new DsearchError("INVALID_REQUEST")); }
    if (!serialized || Buffer.byteLength(serialized) > 1_048_576) return Promise.reject(new DsearchError("INVALID_REQUEST"));
    this.stateValue = "running";
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID();
      const cancel = () => {
        const pending = this.pending;
        if (!pending || pending.id !== id || pending.cancelled) return;
        pending.cancelled = true; this.stateValue = "cancel_requested";
        this.child.send({ version: 1, id, type: "cancel" });
        pending.killTimer = setTimeout(() => this.child.kill("SIGKILL"), this.cancelGraceMs);
      };
      const deadline = setTimeout(cancel, options.timeoutMs ?? 120_000);
      this.pending = { id, cancelled: false,
        ...(options.onProgress ? { progress: options.onProgress } : {}),
        finish: (error, value) => {
          clearTimeout(deadline); options.signal?.removeEventListener("abort", cancel);
          if (this.pending?.killTimer) clearTimeout(this.pending.killTimer);
          this.pending = undefined;
          if (!this.exited) this.stateValue = "idle";
          if (error) reject(error); else resolve(value as T);
        },
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      this.child.send({ version: 1, id, type: "request", payload }, error => {
        if (error) this.fail(new DsearchError("WORKER_EXITED"));
      });
    });
  }
  private fail(error: Error): void { this.pending?.finish(error); }
  private receive(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    const pending = this.pending;
    if (!pending || record.version !== 1 || record.id !== pending.id) return;
    if (record.type === "progress") {
      const value = record.value as Partial<Progress> | undefined;
      if (value && typeof value.phase === "string" && /^[a-z-]{1,48}$/.test(value.phase)
        && Number.isSafeInteger(value.completed) && value.completed! >= 0)
        pending.progress?.({ phase: value.phase, completed: value.completed! });
      return;
    }
    if (record.type !== "response") return;
    const telemetry = record.telemetry && typeof record.telemetry === "object"
      ? Object.fromEntries(Object.entries(record.telemetry).filter(([key, value]) => /^[a-zA-Z]{1,32}$/.test(key)
        && (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))))) : undefined;
    if (pending.cancelled) { pending.finish(Object.assign(new DsearchError("CANCELLED"), { telemetry })); return; }
    if (record.ok === true) pending.finish(undefined, record.value);
    else {
      const parsed = ErrorCode.safeParse(record.code);
      pending.finish(Object.assign(new DsearchError(parsed.success ? parsed.data : "INTERNAL_ERROR", undefined, false, ErrorReason.safeParse(record.reason).success ? ErrorReason.parse(record.reason) : undefined), { telemetry }));
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.exited) return;
      const exit = once(this.child, "exit");
      this.child.kill("SIGTERM");
      const force = setTimeout(() => this.child.kill("SIGKILL"), this.cancelGraceMs);
      try { await exit; } finally { clearTimeout(force); }
    })();
    return this.closing;
  }
}

export { HeavyLane } from './heavy-lane.js';

export { connect, startDaemon, waitForStopped, openUI, defaultRoot, type Packet } from './client.js';
