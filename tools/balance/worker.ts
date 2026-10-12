/** Balance worker: runs whole sessions on request from pool.ts. Loaded via worker-boot.mjs. */

import { parentPort } from 'node:worker_threads';
import type { JobMessage, WorkerMessage } from './pool';
import { runSession } from './session';

const port = parentPort;
if (!port) throw new Error('tools/balance/worker.ts must run in a worker thread');

const send = (message: WorkerMessage): void => port.postMessage(message);

port.on('message', (message: JobMessage) => {
  if (message.type === 'stop') {
    port.close();
    return;
  }
  try {
    send({ type: 'result', index: message.index, result: runSession(message.config) });
  } catch (error) {
    const text = error instanceof Error ? describeError(error) : String(error);
    send({ type: 'failed', index: message.index, message: text });
  }
});

send({ type: 'ready' });

function describeError(error: Error): string {
  const cause = error.cause instanceof Error ? `\nCaused by: ${describeError(error.cause)}` : '';
  return (error.stack ?? error.message) + cause;
}
