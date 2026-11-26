import assert from 'node:assert/strict';
import test from 'node:test';
import { capacityBudget, measurementProfile } from './measure-profiles.mjs';

test('capacity profiles are finite, local-only names with fixed latency budgets', () => {
  assert.deepEqual(capacityBudget, { p95: 20, p99: 50, visibility: 100 });
  for (const name of ['scan-read-0', 'scan-read-50.0', 'scan-read-050', 'capacity-read-1650', 'soak-read-16000', 'scan-write-50', 'endurance-read-1200', 'diagnostic-publish-800', 'https://site.pro', 'constructor']) {
    assert.equal(measurementProfile(name), null, name);
  }
  assert.equal(measurementProfile('soak-read-1600').rate, 1600);
});

test('writer can finish every update within the measured window at every phase', () => {
  for (const [phase, seconds, writes] of [['scan', 12, 3], ['capacity', 30, 8], ['soak', 90, 25], ['endurance', 300, 85], ['diagnostic', 30, 8]]) {
    const rate = { endurance: 800, diagnostic: 1200 }[phase] ?? 600;
    const reader = measurementProfile(`${phase}-read-${rate}`);
    const writer = measurementProfile(`${phase}-publish-${rate}`);
    assert.deepEqual({ ...reader, writes }, writer);
    assert.deepEqual([reader.windowSeconds, reader.writes, writer.writes], [seconds, 0, writes]);
    assert.ok(1 + (writes - 1) * 3.5 + 2 * 0.5 + 2 <= seconds);
  }
  assert.equal(measurementProfile('read-50').windowSeconds, 60);
  assert.equal(measurementProfile('publish').rate, 5);
});
