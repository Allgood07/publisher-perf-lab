import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { capacityBudget, measurementProfile } from './measure-profiles.mjs';

const exec = promisify(execFile);
const cwd = fileURLToPath(new URL('.', import.meta.url));
const [mode, destination, repeatArg, ...rates] = process.argv.slice(2);
const repeats = Number(repeatArg);
if (!destination || !(
  (mode === 'smoke' && process.argv.length === 4)
  || ([1, 2, 3].includes(repeats) && rates.join(',') === { capacity: '600,800,1200', endurance: '800', diagnostic: '1200' }[mode])
)) throw new Error('Usage: node split-cpu.mjs smoke <new-dir> | <capacity|endurance|diagnostic> <new-dir> <1|2|3> <600 800 1200|800|1200>');

const output = resolve(destination);
const imageTag = 'publisher-perf-lab:split-cpu';
const abort = new AbortController();
const onInt = () => abort.abort(new Error('Interrupted (SIGINT)'));
const onTerm = () => abort.abort(new Error('Interrupted (SIGTERM)'));
process.once('SIGINT', onInt);
process.once('SIGTERM', onTerm);
const shell = (bin, args, options) => exec(bin, args, { cwd, timeout: 12_000, maxBuffer: 16 * 1024 * 1024, ...options });
const git = async (...args) => (await shell('git', args)).stdout.trim();
const docker = async (args, options) => (await shell('docker', args, options)).stdout.trim();
const activeDocker = (args, options) => docker(args, { signal: abort.signal, ...options });
const save = (name, data) => writeFile(resolve(output, name), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });

function stat(text) {
  const values = Object.fromEntries(text.split('\n').map(line => line.trim().split(/\s+/)));
  for (const k of ['usage_usec', 'nr_throttled', 'throttled_usec']) {
    if (!/^\d+$/.test(values[k] ?? '')) throw new Error(`Missing cgroup CPU statistic: ${k}`);
  }
  return Object.fromEntries(['usage_usec', 'nr_throttled', 'throttled_usec'].map(k => [k, Number(values[k])]));
}

const limit = (cpus, memory) => ['--cpus', cpus, '--memory', memory, '--pids-limit', '128', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--init'];
const mount = ['--mount', `type=bind,source=${resolve(cwd, 'publisher')},target=/publisher,readonly`];
const runK6 = 'if [ "$2" = diagnostic ]; then sh /app/k6-diagnostic.sh "$1"; else k6 run --no-color "$1"; fi; code=$?; printf "\\nK6_CPU_BEGIN\\n"; cat /sys/fs/cgroup/cpu.stat; printf "K6_CPU_END\\n"; exit "$code"';
const publisherWithCpu = 'sh /app/cpu-sample.sh & exec node /publisher/src/server.ts';

function telemetry(k6, publisher, measurement) {
  function rows(text, name, columns) {
    const result = text.split('\n').filter(line => line.startsWith(`${name} `)).map(line => {
      const fields = line.trim().split(/\s+/).slice(1);
      if (fields.length !== columns.length) throw new Error(`Invalid ${name} row`);
      const values = fields.map(x => x === '-' ? null : Number(x));
      if (!values.every(x => x === null || Number.isFinite(x) && x >= 0)) throw new Error(`Invalid ${name} value`);
      return Object.fromEntries(columns.map((c, i) => [c, values[i]]));
    }).sort((a, b) => a.second - b.second);
    if (result.length < 2 || result.some((row, i) => !Number.isSafeInteger(row.second) || (i && result[i - 1].second >= row.second))) {
      throw new Error(`Missing or repeated ${name} timestamps`);
    }
    return result;
  }
  const seconds = rows(k6, 'K6_SECOND', ['second', 'reads', 'dropped', 'vuGaugeMax', 'sampledActiveVUsMax', 'meanReadMs', 'maxReadMs']);
  const cpu = text => rows(text, 'CPU_SAMPLE', ['second', 'usageUsec', 'throttledPeriods', 'throttledUsec']);
  const sum = field => seconds.reduce((n, row) => n + row[field], 0);
  if (sum('reads') !== measurement.reads || sum('dropped') !== measurement.dropped || !seconds.some(row => row.vuGaugeMax !== null) || !seconds.some(row => row.sampledActiveVUsMax !== null)) {
    throw new Error('Per-second k6 metrics do not reconcile with the trial summary');
  }
  return { seconds, cpu: { publisher: cpu(publisher), k6: cpu(k6) } };
}

async function configuration(name) {
  return JSON.parse(await activeDocker(['inspect', '--format', '{{json .HostConfig}}', name]));
}

async function remove(name, uncertainLaunch) {
  // A timed-out Docker CLI may leave a daemon request still creating the named container.
  for (let attempt = 0; ; attempt++) {
    try { await docker(['rm', '-f', name]); return; }
    catch (error) {
      if (!String(error.stderr).includes('No such container')) throw error;
      if (!uncertainLaunch) return;
      if (attempt === 12) throw new Error(`Cleanup unresolved after Docker launch timeout: check and remove container ${name} before continuing`);
      await delay(250);
    }
  }
}

async function trial(image, profile) {
  const prefix = `publisher-split-${randomUUID()}`;
  const server = `${prefix}-server`, load = `${prefix}-k6`;
  const config = measurementProfile(profile);
  const diagnostic = profile.startsWith('diagnostic-');
  const wall = config ? config.windowSeconds + 20 : 25;
  let result, failure, k6ExitCode = null;
  let wallMs = null, publisherStart = null, publisherEnd = null;
  const file = `${profile}-${trialNumber}`;
  const logs = {};
  const uncertainLaunches = new Set();
  async function launch(name, args) {
    abort.signal.throwIfAborted();
    let id;
    try {
      // Let the bounded create/start RPC settle before responding to a user signal.
      id = await docker(['run', '-d', '--name', name, ...args]);
    } catch (error) {
      if (error.killed || error.signal) uncertainLaunches.add(name);
      throw error;
    }
    abort.signal.throwIfAborted();
    return id;
  }
  async function capture(role, name) {
    if (!logs[role]) {
      try { logs[role] = await shell('docker', ['logs', name]); }
      catch (error) { logs[role] = { stdout: error.stdout ?? '', stderr: error.stderr || error.message }; }
    }
    return logs[role];
  }
  try {
    const serverCommand = diagnostic ? ['--entrypoint', '/bin/sh', image, '-c', publisherWithCpu]
      : ['--entrypoint', 'node', image, '/publisher/src/server.ts'];
    const serverId = await launch(server, ['--network', 'none', ...limit('1', '384m'), ...mount, ...serverCommand]);
    const serverConfig = await configuration(server);
    if (serverConfig.NetworkMode !== 'none' || serverConfig.NanoCpus !== 1_000_000_000
        || serverConfig.PublishAllPorts || Object.keys(serverConfig.PortBindings ?? {}).length) throw new Error('Publisher isolation mismatch');
    const readiness = AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]);
    let port;
    while (!port) {
      readiness.throwIfAborted();
      const logs = await activeDocker(['logs', server], { signal: readiness });
      port = /^Editor: http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/editor$/m.exec(logs)?.[1];
      if (!port) await delay(100, undefined, { signal: readiness });
    }
    if (Number(port) > 65_535) throw new Error('Invalid dynamic Publisher port');
    publisherStart = stat(await activeDocker(['exec', server, 'cat', '/sys/fs/cgroup/cpu.stat']));
    const start = performance.now();
    await launch(load, ['--network', `container:${serverId}`, ...limit('2', '384m'),
      '--env', `PUBLISHER_PORT=${port}`, '--env', `PUBLISHER_PROFILE=${profile}`, '--env', 'HOME=/tmp',
      '--entrypoint', '/bin/sh', image, '-c', runK6, 'k6-wrapper', config ? '/app/measure.js' : '/app/smoke.js', diagnostic ? 'diagnostic' : 'normal']);
    const loadConfig = await configuration(load);
    if (loadConfig.NetworkMode !== `container:${serverId}` || loadConfig.NanoCpus !== 2_000_000_000
        || loadConfig.PublishAllPorts || Object.keys(loadConfig.PortBindings ?? {}).length) throw new Error('k6 isolation mismatch');
    const exit = await activeDocker(['wait', load], { timeout: (wall + 5) * 1000 });
    wallMs = performance.now() - start;
    k6ExitCode = /^\d+$/.test(exit) ? Number(exit) : null;
    const k6Log = await capture('k6', load);
    const record = /^MEASUREMENT (.+)$/m.exec(k6Log.stdout);
    const cpu = /^K6_CPU_BEGIN\r?\n([\s\S]*?)^K6_CPU_END$/m.exec(k6Log.stdout);
    if (!cpu || ![0, 99, 108].includes(k6ExitCode)) throw new Error(`${profile}: infrastructure failure (exit ${exit})`);
    const measurement = record ? JSON.parse(record[1]) : null;
    publisherEnd = stat(await activeDocker(['exec', server, 'cat', '/sys/fs/cgroup/cpu.stat']));
    if (config) {
      if (!measurement || measurement.profile !== profile || measurement.rateTarget !== config.rate
          || measurement.windowSeconds !== config.windowSeconds) throw new Error('Unexpected measurement summary');
      if (k6ExitCode === 0 && (measurement.reads !== config.rate * config.windowSeconds
          || measurement.fullReadSamples !== measurement.reads || measurement.dropped !== 0
          || measurement.readErrors !== 0 || measurement.allRequestErrors !== 0 || measurement.versionMismatches !== 0
          || measurement.publishedObserved !== config.writes)) throw new Error('Successful threshold run has an incomplete result');
    } else if (k6ExitCode !== 0 || !k6Log.stdout.includes('5 complete and 0 interrupted iterations')) {
      throw new Error('Split smoke did not complete all five checks');
    }
    const publisher = Object.fromEntries(Object.keys(publisherStart).map(k => [k, publisherEnd[k] - publisherStart[k]]));
    const trace = diagnostic ? telemetry(k6Log.stdout, (await capture('publisher', server)).stdout, measurement) : null;
    result = { profile, k6ExitCode, measurement, resources: { wallMs, publisher, k6: stat(cpu[1]) }, ...(trace ? { telemetry: trace } : {}) };
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      // Persist each attempt independently, including interrupted or incomplete pairs.
      if (failure && !logs.k6) await docker(['stop', '-t', '1', load]).catch(() => {});
      await capture('k6', load);
      await capture('publisher', server);
      for (const [role, { stdout, stderr }] of Object.entries(logs)) {
        await writeFile(resolve(output, `${file}-${role}.log`), `${stdout}\n${stderr}`, { mode: 0o600, flag: 'wx' });
      }
      let partial = null;
      if (!result) try { partial = JSON.parse(/^MEASUREMENT (.+)$/m.exec(logs.k6.stdout)?.[1]); } catch { /* missing or invalid summary */ }
      await save(`${file}.json`, result ? { status: 'completed', ...result } : {
        status: 'infrastructure-failure', profile, k6ExitCode, measurement: partial,
        resources: { wallMs, publisherStart, publisherEnd }, error: failure?.message,
      });
    } finally {
      // Remove k6 first because its network namespace belongs to Publisher.
      try { await remove(load, uncertainLaunches.has(load)); }
      finally { await remove(server, uncertainLaunches.has(server)); }
    }
  }
}

let trialNumber = 0;
try {
  const scenarioRevision = await git('rev-parse', 'HEAD');
  const launchFiles = ['Dockerfile', '.dockerignore', 'measure.js', 'measure-profiles.mjs', 'run-smoke.mjs', 'smoke.js', 'split-cpu.mjs', 'cpu-sample.sh', 'k6-diagnostic.sh', 'k6-second-buckets.awk', 'publisher'];
  const publisherRevision = await git('-C', 'publisher', 'rev-parse', 'HEAD');
  if (await git('status', '--porcelain', '--ignore-submodules=none', '--', ...launchFiles)
      || publisherRevision !== await git('rev-parse', 'HEAD:publisher')
      || await git('-C', 'publisher', 'status', '--porcelain', '--untracked-files=all')) throw new Error('Commit the scenario and initialize the pinned, clean Publisher submodule');
  await mkdir(output, { mode: 0o700 });
  await activeDocker(['build', '--tag', imageTag, '.'], { timeout: 120_000 });
  const image = await activeDocker(['image', 'inspect', '--format', '{{.Id}}', imageTag]);
  await save('plan.json', { mode, rates: rates.map(Number), repeats: mode === 'smoke' ? 1 : repeats,
    scenarioRevision, publisherRevision, image, target: 'loopback in Docker network none', budgets: capacityBudget,
    quotas: { publisherCpu: 1, k6Cpu: 2, memoryMiBPerContainer: 384, pidsPerContainer: 128 },
    dateUtc: new Date().toISOString() });
  if (mode === 'smoke') {
    const result = await trial(image, 'smoke');
    await save('smoke.json', result);
    console.log('Split smoke: five correct guest responses');
  } else {
    for (const rate of rates) for (let repeat = 1; repeat <= repeats; repeat++) {
      const runs = [];
      const workloads = repeat % 2 === 1 ? ['read', 'publish'] : ['publish', 'read'];
      for (const workload of workloads) {
        trialNumber++;
        const result = await trial(image, `${mode}-${workload}-${rate}`);
        const { measurement: m, k6ExitCode } = result;
        runs.push({ workload, ...result });
        console.log(`${result.profile} #${repeat}: exit=${k6ExitCode}, reads=${m.reads}, p95=${m.readMillis?.['p(95)']?.toFixed(2)}, p99=${m.readMillis?.['p(99)']?.toFixed(2)}, dropped=${m.dropped}`);
      }
      await save(`pair-${rate}-${repeat}.json`, { rate: Number(rate), repeat, runs });
    }
  }
} finally {
  process.removeListener('SIGINT', onInt);
  process.removeListener('SIGTERM', onTerm);
}
