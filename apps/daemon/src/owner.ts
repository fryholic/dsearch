import { open, lstat, readFile, rm, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DsearchError } from '@dsearch/contracts';
export async function privateRoot(path: string): Promise<string> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
        throw new DsearchError('SCOPE_DENIED');
    return realpath(path);
}
export async function takeOwnership(root: string, instance: string): Promise<() => Promise<void>> {
    const path = join(root, 'daemon.lock'), recovery = path + '.recovery';
    const claim = async () => { const fd = await open(path, 'wx', 0o600); try {
        await fd.writeFile(JSON.stringify({ instance_id: instance, pid: process.pid }));
        await fd.sync();
    }
    finally {
        await fd.close();
    } };
    try {
        await claim();
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
            throw e;
        let guard;
        try {
            guard = await open(recovery, 'wx', 0o600);
        }
        catch {
            throw new DsearchError('BUSY');
        }
        try {
            const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
                throw new DsearchError('BUSY');
            const owner = JSON.parse(await readFile(path, 'utf8')) as {
                pid?: number;
                instance_id?: string;
            };
            if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0 || typeof owner.instance_id !== 'string')
                throw new DsearchError('BUSY');
            let alive = true;
            try {
                process.kill(owner.pid!, 0);
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ESRCH')
                    alive = false;
            }
            if (alive)
                throw new DsearchError('BUSY');
            await rm(path);
            await claim();
        }
        finally {
            await guard.close();
            await rm(recovery, { force: true });
        }
    }
    return async () => { try {
        const owner = JSON.parse(await readFile(path, 'utf8'));
        if (owner.instance_id === instance)
            await rm(path);
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
            throw e;
    } };
}
