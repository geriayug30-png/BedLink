import { readConfig } from './config.mjs';
import { createApp } from './app.mjs';
import { createSupabaseAuth } from './auth/supabase-auth.mjs';
import { createSupabaseRpc } from './db/supabase-rpc.mjs';
import { createWorkflowDatabase } from './db/workflow.mjs';
import { createWorkflowService } from './services/workflow.mjs';

const config = readConfig();
const database = createWorkflowDatabase({ connectionString: process.env.WORKFLOW_DATABASE_URL });
const workflow = createWorkflowService({ database, policy: config.matchingPolicy, travelTimeoutMs: config.travelTimeoutMs });
const app = createApp({ config, authenticate: createSupabaseAuth(config), rpc: createSupabaseRpc(config), workflow });
const server = app.listen(config.port, config.host, () => console.log(JSON.stringify({ event: 'listening', port: config.port })));
server.requestTimeout = 30000;
server.headersTimeout = 15000;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(async () => { await database.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
});
