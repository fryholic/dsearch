import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DsearchError, ErrorEnvelope, API_VERSION } from '@dsearch/contracts';
export const defaultRoot = () => join(homedir(), 'Library/Application Support/dsearch');
export type Packet = {
    schema_version: 1;
    request_id: string;
    ok: true;
    data: any;
};
async function privateFile(path: string, max: number): Promise<string> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > max || (info.mode & 0o077) !== 0)
        throw new DsearchError('SCOPE_DENIED');
    return readFile(path, 'utf8');
}
export async function connect(dataRoot: string) {
    let runtime: any, token: string;
    try {
        const root = resolve(dataRoot), info = await lstat(root);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root || (info.mode & 0o077) !== 0)
            throw new DsearchError('SCOPE_DENIED');
        const credentials = join(root, 'credentials'), credentialsInfo = await lstat(credentials);
        if (!credentialsInfo.isDirectory() || credentialsInfo.isSymbolicLink() || await realpath(credentials) !== credentials || (credentialsInfo.mode & 0o077) !== 0)
            throw new DsearchError('SCOPE_DENIED');
        runtime = JSON.parse(await privateFile(join(root, 'runtime.json'), 4096));
        token = (await privateFile(join(credentials, 'device-token'), 128)).trim();
        if (runtime.schema_version !== 1 || !Number.isSafeInteger(runtime.pid) || typeof runtime.instance_id !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(runtime.url) || !/^[A-Za-z0-9_-]{43}$/.test(token))
            throw new DsearchError('COMPATIBILITY_FAILED');
    }
    catch (e) {
        if (e instanceof DsearchError)
            throw e;
        throw new DsearchError('SERVICE_UNAVAILABLE');
    }
    const call = async (method: string, path: string, value?: unknown): Promise<Packet> => {
        if (!/^\/v1\/[A-Za-z0-9_/-]+$/.test(path))
            throw new DsearchError('INVALID_REQUEST');
        let response: Response;
        try {
            response = await fetch(runtime.url + path, { method, redirect: 'error', signal: AbortSignal.timeout(10000), headers: { authorization: 'Bearer ' + token, ...(value !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(value !== undefined ? { body: JSON.stringify(value) } : {}) });
        }
        catch {
            throw new DsearchError('SERVICE_UNAVAILABLE');
        }
        let packet: any;
        try {
            packet = await response.json();
        }
        catch {
            throw new DsearchError('COMPATIBILITY_FAILED');
        }
        if (packet.schema_version !== API_VERSION)
            throw new DsearchError('UNSUPPORTED_VERSION');
        const error = ErrorEnvelope.safeParse(packet);
        if (error.success)
            throw new DsearchError(error.data.error.code);
        if (!response.ok || packet.ok !== true || typeof packet.request_id !== 'string' || !('data' in packet))
            throw new DsearchError('COMPATIBILITY_FAILED');
        return packet;
    };
    const packet = await call('GET', '/v1/status');
    if (packet.data.instance_id !== runtime.instance_id)
        throw new DsearchError('COMPATIBILITY_FAILED');
    return { call, runtime };
}
export async function startDaemon(dataRoot: string) {
    try {
        return await connect(dataRoot);
    }
    catch (e) {
        if (!(e instanceof DsearchError) || e.code !== 'SERVICE_UNAVAILABLE')
            throw e;
    }
    const entry = fileURLToPath(new URL('../../daemon/dist/main.js', import.meta.url));
    const child = spawn(process.execPath, [entry, '--data-root', resolve(dataRoot)], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    let spawnError = false;
    child.on('error', () => { spawnError = true; });
    for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (spawnError)
            break;
        try {
            return await connect(dataRoot);
        }
        catch (e) {
            if (!(e instanceof DsearchError) || e.code !== 'SERVICE_UNAVAILABLE')
                throw e;
        }
    }
    throw new DsearchError('SERVICE_UNAVAILABLE');
}
/** runtime.json is removed only after owned jobs/readers have actually stopped. */
export async function waitForStopped(dataRoot: string, instance: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
        try {
            const runtime = JSON.parse(await privateFile(join(resolve(dataRoot), 'runtime.json'), 4096));
            if (runtime.instance_id !== instance) return;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new DsearchError('BUSY');
}
export async function openUI(url: string): Promise<void> {
    if (process.platform !== 'darwin')
        throw new DsearchError('SERVICE_UNAVAILABLE');
    await new Promise<void>((resolve, reject) => { const child = spawn('/usr/bin/open', [url], { stdio: 'ignore' }); child.once('error', () => reject(new DsearchError('SERVICE_UNAVAILABLE'))); child.once('exit', code => code === 0 ? resolve() : reject(new DsearchError('SERVICE_UNAVAILABLE'))); });
}
