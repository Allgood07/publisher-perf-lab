import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';

const shutdown = new AbortController();
const onInt = () => shutdown.abort(new Error('Interrupted (SIGINT)'));
const onTerm = () => shutdown.abort(new Error('Interrupted (SIGTERM)'));
process.once('SIGINT', onInt);
process.once('SIGTERM', onTerm);
const deadline = AbortSignal.any([shutdown.signal, AbortSignal.timeout(25_000)]);
const children = [];

function supervise(child) {
  let spawnError;
  child.once('error', error => { spawnError = error; });
  const closed = new Promise(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal, spawnError }));
  });
  const handle = { child, closed };
  children.push(handle);
  return handle;
}

async function stop({ child, closed }) {
  const running = () => child.pid && child.exitCode === null && child.signalCode === null;
  async function waitClosed() {
    let timer;
    try {
      return await Promise.race([
        closed.then(() => true),
        new Promise(resolve => { timer = setTimeout(resolve, 750, false); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  if (running()) child.kill('SIGTERM');
  if (await waitClosed()) return true;
  if (running()) child.kill('SIGKILL');
  return waitClosed();
}

async function smoke() {
  const server = supervise(fork('/publisher/src/server.ts', [], {
    execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  }));
  const [port] = await Promise.race([
    once(server.child, 'message', { signal: AbortSignal.any([deadline, AbortSignal.timeout(5_000)]) }),
    server.closed.then(() => { throw new Error('Publisher exited before readiness'); }),
  ]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid Publisher port');
  deadline.throwIfAborted();

  // Do not pass proxy or arbitrary target configuration to k6.
  const load = supervise(spawn('/usr/local/bin/k6', ['run', '--no-color', '/app/smoke.js'], {
    env: { HOME: '/tmp', PUBLISHER_PORT: String(port) },
    stdio: ['ignore', 'inherit', 'inherit'],
  }));
  const result = await Promise.race([
    load.closed,
    server.closed.then(() => { throw new Error('Publisher exited during smoke'); }),
    once(deadline, 'abort').then(() => deadline.throwIfAborted()),
  ]);
  if (result.spawnError) throw result.spawnError;
  if (result.code !== 0) {
    process.exitCode = result.code ?? 1;
    throw new Error(`k6 failed (${result.code ?? result.signal})`);
  }
}

try {
  await smoke();
} catch (error) {
  process.exitCode ||= 1;
  console.error(`Smoke failed: ${error.message}`);
} finally {
  let allClosed = true;
  for (const handle of children.reverse()) {
    if (!await stop(handle)) {
      console.error(`Child ${handle.child.pid ?? 'unknown'} did not close after SIGKILL`);
      allClosed = false;
    }
  }
  // Exiting the launcher lets Docker tear down the container even if a child hangs.
  if (!allClosed) process.exit(1);
  process.removeListener('SIGINT', onInt);
  process.removeListener('SIGTERM', onTerm);
}
