import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, lstat, open, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { DsearchError } from '@dsearch/contracts';
const secret = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
type Session = {
    csrf: string;
    lastAccess: number;
};
export class LocalAuth {
    readonly cookieName: string;
    private readonly codes = new Map<string, number>();
    private readonly sessions = new Map<string, Session>();
    private constructor(private readonly token: string, instance: string, private readonly now: () => number) { this.cookieName = 'dsearch_' + instance.replaceAll('-', '').slice(0, 12); }
    static async open(root: string, instance: string, now: () => number = Date.now): Promise<LocalAuth> {
        const folder = join(root, 'credentials');
        await mkdir(folder, { recursive: true, mode: 0o700 });
        const info = await lstat(folder);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(folder) !== folder || (info.mode & 0o077) !== 0)
            throw new DsearchError('SCOPE_DENIED');
        const file = join(folder, 'device-token');
        try {
            const fd = await open(file, 'wx', 0o600);
            try {
                await fd.writeFile(secret() + '\n');
                await fd.sync();
            }
            finally {
                await fd.close();
            }
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
                throw e;
        }
        const tokenInfo = await lstat(file);
        if (!tokenInfo.isFile() || tokenInfo.isSymbolicLink() || tokenInfo.size > 128 || (tokenInfo.mode & 0o077) !== 0)
            throw new DsearchError('SCOPE_DENIED');
        const token = (await readFile(file, 'utf8')).trim();
        if (!/^[A-Za-z0-9_-]{43}$/.test(token))
            throw new DsearchError('COMPATIBILITY_FAILED');
        return new LocalAuth(token, instance, now);
    }
    private sweep(): void { for (const [code, expires] of this.codes)
        if (expires <= this.now())
            this.codes.delete(code); for (const [key, s] of this.sessions)
        if (this.now() - s.lastAccess > 12 * 60 * 60 * 1000)
            this.sessions.delete(key); }
    issue(origin: string): string { this.sweep(); while (this.codes.size >= 16)
        this.codes.delete(this.codes.keys().next().value!); const code = secret(); this.codes.set(hash(code), this.now() + 60000); return origin + '/#code=' + code; }
    exchange(code: string): {
        cookie: string;
        csrf_token: string;
    } {
        this.sweep();
        const key = hash(code), expires = this.codes.get(key);
        this.codes.delete(key);
        if (!expires || expires <= this.now())
            throw new DsearchError('UNAUTHORIZED');
        while (this.sessions.size >= 16)
            this.sessions.delete(this.sessions.keys().next().value!);
        const id = secret(), csrf = secret();
        this.sessions.set(hash(id), { csrf, lastAccess: this.now() });
        return { cookie: this.cookieName + '=' + id + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200', csrf_token: csrf };
    }
    cookieSession(req: IncomingMessage, origin: string): Session {
        this.sweep();
        const parts = (req.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(this.cookieName + '='));
        if (parts.length !== 1)
            throw new DsearchError('UNAUTHORIZED');
        if (req.headers.origin !== origin && req.headers['sec-fetch-site'] !== 'same-origin')
            throw new DsearchError('SCOPE_DENIED');
        const session = this.sessions.get(hash(parts[0]!.slice(this.cookieName.length + 1)));
        if (!session)
            throw new DsearchError('UNAUTHORIZED');
        session.lastAccess = this.now();
        return session;
    }
    authenticate(req: IncomingMessage, origin: string): 'bearer' | 'cookie' {
        if (req.headers.authorization) {
            if (!equal(req.headers.authorization, 'Bearer ' + this.token))
                throw new DsearchError('UNAUTHORIZED');
            return 'bearer';
        }
        const session = this.cookieSession(req, origin);
        if (!['GET', 'HEAD'].includes(req.method ?? '')) {
            if (req.headers.origin !== origin || typeof req.headers['x-dsearch-csrf'] !== 'string' || !equal(req.headers['x-dsearch-csrf'], session.csrf))
                throw new DsearchError('SCOPE_DENIED');
        }
        return 'cookie';
    }
    close(): void { this.codes.clear(); this.sessions.clear(); }
}
