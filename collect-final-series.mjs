import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { capacityBudget, measurementProfile } from './measure-profiles.mjs';

const [enduranceDir, diagnosticDir, destination] = process.argv.slice(2);
if (process.argv.length !== 5 || !destination) throw new Error('Usage: node collect-final-series.mjs <endurance-dir> <diagnostic-dir> <new-report.json>');
const read = async (dir, file) => JSON.parse(await readFile(join(dir, file), 'utf8'));

function diagnosticData(run) {
  const { seconds, cpu } = run.telemetry;
  assert.equal(seconds.reduce((sum, x) => sum + x.reads, 0), run.measurement.reads);
  assert.equal(seconds.reduce((sum, x) => sum + x.dropped, 0), run.measurement.dropped);
  const intervals = Object.fromEntries(Object.entries(cpu).map(([role, samples]) => {
    const pairs = samples.slice(1).map((later, i) => {
      const earlier = samples[i];
      const seconds = later.second - earlier.second;
      const usageUsec = later.usageUsec - earlier.usageUsec;
      const throttledPeriods = later.throttledPeriods - earlier.throttledPeriods;
      const throttledUsec = later.throttledUsec - earlier.throttledUsec;
      assert.ok(seconds > 0 && usageUsec >= 0 && throttledPeriods >= 0 && throttledUsec >= 0, `${role}: cgroup counter discontinuity`);
      return { from: earlier.second, to: later.second, oneCpuPercent: usageUsec / (seconds * 10_000), throttledPeriods, throttledUsec };
    });
    return [role, pairs];
  }));
  // Only report the interval containing the bucket; a missing interval stays null.
  const drops = seconds.filter(x => x.dropped > 0).map(x => ({
    ...x, cpu: Object.fromEntries(Object.entries(intervals).map(([role, list]) => [role,
      list.find(range => range.from <= x.second && range.to > x.second) ?? null])),
  }));
  return { dropSeconds: drops, intervals };
}

async function campaign(dir, mode, rate) {
  const plan = await read(dir, 'plan.json');
  assert.equal(plan.mode, mode);
  assert.equal(plan.repeats, 3);
  assert.deepEqual(plan.rates, [rate]);
  assert.deepEqual(plan.budgets, capacityBudget);
  assert.deepEqual(plan.quotas, { publisherCpu: 1, k6Cpu: 2, memoryMiBPerContainer: 384, pidsPerContainer: 128 });
  assert.match(plan.scenarioRevision, /^[a-f\d]{40}$/);
  assert.match(plan.publisherRevision, /^[a-f\d]{40}$/);
  const pairs = [];
  for (let i = 1; i <= 3; i++) {
    const pair = await read(dir, `pair-${rate}-${i}.json`);
    assert.equal(pair.rate, rate);
    assert.equal(pair.repeat, i);
    assert.deepEqual(pair.runs.map(r => r.workload), i === 2 ? ['publish', 'read'] : ['read', 'publish']);
    for (const run of pair.runs) {
      const wantProfile = `${mode}-${run.workload}-${rate}`;
      const config = measurementProfile(wantProfile);
      const { measurement: m, k6ExitCode: code } = run;
      assert.equal(run.profile, wantProfile);
      assert.equal(m.profile, wantProfile);
      assert.equal(m.rateTarget, rate);
      assert.equal(m.windowSeconds, config.windowSeconds);
      assert.equal(m.fullReadSamples, m.reads);
      assert.ok(m.reads <= rate * config.windowSeconds);
      assert.ok([0, 99, 108].includes(code));
      if (code === 0) {
        assert.equal(m.reads, rate * config.windowSeconds);
        assert.ok(['dropped', 'readErrors', 'versionMismatches', 'allRequestErrors'].every(key => m[key] === 0));
        assert.ok(m.readMillis?.['p(95)'] <= capacityBudget.p95 && m.readMillis?.['p(99)'] <= capacityBudget.p99);
        assert.equal(m.publishedObserved, config.writes);
        if (config.writes) assert.ok(m.visibleMillis?.['p(95)'] <= capacityBudget.visibility);
      }
      if (mode === 'diagnostic') run.diagnostics = diagnosticData(run);
    }
    pairs.push(pair);
  }
  return { plan, pairs };
}

const endurance = await campaign(enduranceDir, 'endurance', 800);
const diagnostic = await campaign(diagnosticDir, 'diagnostic', 1200);
assert.equal(endurance.plan.publisherRevision, diagnostic.plan.publisherRevision);
await writeFile(destination, `${JSON.stringify({ endurance, diagnostic }, null, 2)}\n`, { flag: 'wx' });
for (const { plan, pairs } of [endurance, diagnostic]) {
  console.log(plan.mode, plan.scenarioRevision);
  for (const { repeat, runs } of pairs) for (const r of runs) {
    const { measurement: m, diagnostics: d } = r;
    console.log(`${repeat} ${r.workload}: exit ${r.k6ExitCode}, n=${m.reads}, drops=${m.dropped}, p95=${m.readMillis?.['p(95)']?.toFixed(2)}, p99=${m.readMillis?.['p(99)']?.toFixed(2)}, versions=${m.publishedObserved}, max visibility=${m.visibleMillis?.max ?? '-'}`);
    for (const row of d?.dropSeconds ?? []) console.log(JSON.stringify(row));
  }
}
