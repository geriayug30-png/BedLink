import pg from 'pg';
import { unauthenticated, unavailable } from '../errors.mjs';

export function verifiedClaims(identity) {
  // identity comes ONLY from the completed Supabase /user verification middleware.
  // Decode verified claims to preserve the issuer namespace; never use a token role.
  try {
    const claims = JSON.parse(Buffer.from(identity.token.split('.')[1], 'base64url'));
    if (claims.sub !== identity.userId || typeof claims.iss !== 'string' || !claims.iss.trim() ||
      !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) throw unauthenticated();
    return { sub: identity.userId, iss: claims.iss, role: 'authenticated' };
  } catch { throw unauthenticated(); }
}

export function createWorkflowDatabase({ connectionString, role = 'bedlink_api', pool: injectedPool, allowPrivilegedForTests = false }) {
  if (!['bedlink_api', 'bedlink_worker'].includes(role)) throw new TypeError('Invalid database role');
  const pool = injectedPool || (connectionString ? new pg.Pool({ connectionString, max: 8,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: 10000,
    idle_in_transaction_session_timeout: 10000 }) : null);
  pool?.on('error', () => {}); // No connection strings, SQL or patient fields in default pool error logs.
  return {
    async transaction(identity, callback) {
      if (!pool) throw unavailable();
      const claims = role === 'bedlink_api' ? verifiedClaims(identity) : null;
      let client, discard = false;
      try {
        client = await pool.connect();
        if (!allowPrivilegedForTests) {
          const { rows } = await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user');
          if (!rows.length || rows[0].rolsuper || rows[0].rolbypassrls) throw unavailable();
        }
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${role}`); // fixed allowlist, never user input
        if (claims) await client.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
        const query = async (name, args) => {
          const calls = {
            context: ['SELECT public.bedlink_workflow_context($1,$2,$3) AS result', args],
            run: ['SELECT public.bedlink_workflow($1,$2,$3) AS result', args],
            finish: ['SELECT public.bedlink_workflow_finish($1,$2) AS result', args],
            tick: ['SELECT public.bedlink_worker_tick($1) AS result', args],
          };
          if (!calls[name]) throw unavailable();
          return (await client.query(...calls[name])).rows[0].result;
        };
        const result = await callback(query);
        await client.query('COMMIT'); // do not acknowledge before durable completion
        return result;
      } catch (error) {
        if (client) { try { await client.query('ROLLBACK'); } catch { discard = true; } }
        if (error.status === 401 || error.status === 503 || error.name === 'AbortError') throw error;
        throw unavailable();
      } finally { client?.release(discard); }
    },
    close: () => pool?.end(),
  };
}
