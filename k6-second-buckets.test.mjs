import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./k6-second-buckets.awk', import.meta.url));
const header = 'metric_name,timestamp,metric_value,scenario,extra_tags';
const bucket = lines => spawnSync('awk', ['-f', script], { input: `${lines.join('\n')}\n`, encoding: 'utf8' });

test('CSV diagnostics exclude warmup and keep read, drop, and VU samples separate', () => {
  const out = bucket([header, 'guest_read_ms,100,3,reader,', 'guest_read_ms,100,5,reader,',
    'guest_read_ms,100,100,warmup,', 'dropped_iterations,100,3,reader,',
    'dropped_iterations,100,9,warmup,', 'vus,100,1,,', 'diagnostic_active_vus,100,9,reader,',
    'diagnostic_active_vus,100,4,reader,', 'dropped_iterations,102,2,reader,']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, 'K6_SECOND 100 2 3 1 9 4.000000 5.000000\nK6_SECOND 102 0 2 - - - -\n');
});

test('Invalid diagnostic data does not turn into a partial success', () => {
  for (const input of [[header], ['bad,header', 'guest_read_ms,100,3,reader,'], [header, 'guest_read_ms,100,3,reader,', 'dropped_iterations,xyz,5,reader,']]) {
    const out = bucket(input);
    assert.equal(out.status, 2);
    assert.equal(out.stdout, '');
  }
});
