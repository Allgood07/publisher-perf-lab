import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capacityBudget, measurementProfile } from './measure-profiles.mjs';

const [output, phase, repeatArg, ...rates] = process.argv.slice(2);
const repetitions = Number(repeatArg);
if (!output || !['scan', 'capacity', 'soak'].includes(phase) || ![1, 2, 3].includes(repetitions)
    || !rates.length || new Set(rates).size !== rates.length
    || rates.some(rate => !measurementProfile(`${phase}-read-${rate}`))) {
  throw new Error('Usage: node capacity-series.mjs <new-output-folder> <scan|capacity|soak> <1|2|3 repeats> <allowed rates...>');
}
const out = resolve(output);
mkdirSync(out, { mode: 0o700 });
const cwd = fileURLToPath(new URL('.', import.meta.url));
const save = (name, data) => writeFileSync(resolve(out, name), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
if (sha.status !== 0) throw new Error('Cannot identify scenario revision');
const changes = spawnSync('git', ['status', '--porcelain', '--', 'Dockerfile', '.dockerignore', 'Makefile', 'measure*.js', 'measure*.mjs', 'run-smoke.mjs', 'publisher'], { cwd, encoding: 'utf8' });
if (changes.status !== 0 || changes.stdout) throw new Error('Commit the scenario and submodule before running a campaign');
save('plan.json', { phase, repetitions, rates: rates.map(Number), scenarioRevision: sha.stdout.trim(), budgetMs: capacityBudget });

function capture(line, type) {
  const matches = line.split('\n').filter(x => x.startsWith(`${type} `));
  if (matches.length !== 1) throw new Error(`Expected exactly one ${type} record`);
  return JSON.parse(matches[0].slice(type.length + 1));
}

for (const rate of rates) {
  let failedPairs = 0;
  for (let repeat = 1; repeat <= repetitions; repeat++) {
    const pair = [];
    for (const workload of ['read', 'publish']) {
      const profile = `${phase}-${workload}-${rate}`;
      const config = measurementProfile(profile);
      const result = spawnSync('make', [profile], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      writeFileSync(resolve(out, `${profile}-${repeat}.log`), stdout + stderr, { mode: 0o600 });
      if (result.error || result.signal) throw new Error(`Cannot complete ${profile}: ${result.error?.message ?? result.signal}`);
      const measurement = capture(stdout, 'MEASUREMENT');
      const resources = capture(stdout, 'RESOURCES');
      if (measurement.profile !== profile || resources.profile !== profile || measurement.rateTarget !== config.rate || measurement.windowSeconds !== config.windowSeconds) {
        throw new Error(`Wrong profile, rate or window in summary: ${profile}`);
      }
      const exitCode = result.status === 0 ? 0 : Number(stderr.match(/k6 failed \((\d+)\)/)?.[1]);
      if (![0, 99, 108].includes(exitCode)) throw new Error(`${profile}: infrastructure or runner failure; inspect the log`);
      pair.push({ workload, k6ExitCode: exitCode, measurement, resources });
      console.log(`${profile} #${repeat}: exit=${exitCode}, reads=${measurement.reads}, p95=${measurement.readMillis?.['p(95)']?.toFixed(2)}, p99=${measurement.readMillis?.['p(99)']?.toFixed(2)}, dropped=${measurement.dropped}`);
    }
    save(`pair-${rate}-${repeat}.json`, { rate: Number(rate), repeat, runs: pair });
    if (pair.every(x => x.k6ExitCode !== 0)) failedPairs++;
  }
  if (phase === 'scan' && failedPairs === repetitions) break;
}
