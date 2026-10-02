import { readConfig } from './config.mjs';
import { createApp } from './app.mjs';
import { createSupabaseAuth } from './auth/supabase-auth.mjs';
import { createSupabaseRpc } from './db/supabase-rpc.mjs';

const config = readConfig();
const app = createApp({ config, authenticate: createSupabaseAuth(config), rpc: createSupabaseRpc(config) });
const server = app.listen(config.port, config.host, () => console.log(JSON.stringify({ event: 'listening', port: config.port })));
server.requestTimeout = 30000;
server.headersTimeout = 15000;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
});
