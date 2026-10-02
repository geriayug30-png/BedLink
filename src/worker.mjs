import { createWorkflowDatabase } from './db/workflow.mjs';
import { runTimeoutWorker, workerConfig } from './services/timeout-worker.mjs';

if (!process.env.WORKER_DATABASE_URL) throw new Error('WORKER_DATABASE_URL is required');
const database = createWorkflowDatabase({ connectionString: process.env.WORKER_DATABASE_URL, role: 'bedlink_worker' });
const controller = new AbortController();
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => controller.abort());
try { await runTimeoutWorker({ database, signal: controller.signal, ...workerConfig(process.env) }); }
finally { await database.close(); }
