import { parseArgs } from 'node:util';
import { createApplication } from './server.js';
import { DsearchError } from '@dsearch/contracts';
try {
    const { values } = parseArgs({ options: { 'data-root': { type: 'string' }, port: { type: 'string' } }, strict: true });
    const app = await createApplication({ ...(values['data-root'] ? { dataRoot: values['data-root'] } : {}), ...(values.port ? { port: Number(values.port) } : {}) });
    const stop = () => { void app.close().then(() => process.exit(0), () => process.exit(1)); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.stdout.write(JSON.stringify({ url: app.url, instance_id: app.instance_id }) + '\n');
}
catch (error) {
    process.stderr.write((error instanceof DsearchError ? error.code : 'SERVICE_UNAVAILABLE') + '\n');
    process.exitCode = 1;
}
