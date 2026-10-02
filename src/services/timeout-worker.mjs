import { setTimeout as sleep } from 'node:timers/promises';

export function workerConfig(env = {}) {
  const integer = (name, fallback, minimum, maximum) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}`);
    return value;
  };
  return { pollMs: integer('WORKER_POLL_MS', 2000, 50, 60000), batchSize: integer('WORKER_BATCH_SIZE', 100, 1, 1000) };
}

export async function runTimeoutWorker({ database, signal, pollMs = 2000, batchSize = 100,
  logger = event => console.log(JSON.stringify(event)), wait = sleep }) {
  while (!signal.aborted) {
    try {
      const result = await database.transaction(null, query => query('tick', [batchSize]));
      if (result.processed) logger({ event: 'timeout_batch', processed: result.processed });
    } catch {
      logger({ event: 'timeout_batch_failed' }); // never include SQL, credentials, patient IDs or exception text
    }
    if (signal.aborted) break;
    try { await wait(pollMs, undefined, { signal }); } catch {
      if (!signal.aborted) throw new Error('Worker timer failed');
    }
  }
}
