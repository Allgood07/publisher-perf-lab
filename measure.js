import { sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';
import { capacityBudget, measurementProfile } from './measure-profiles.mjs';

const port = Number(__ENV.PUBLISHER_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid Publisher port');
const origin = `http://127.0.0.1:${port}`;
const profile = __ENV.PUBLISHER_PROFILE;
const config = measurementProfile(profile);
if (!config) throw new Error('Invalid measurement profile');
const { rate, windowSeconds, writes, preAllocatedVUs, maxVUs } = config;
const targetReads = rate * windowSeconds;
const warmupSeconds = 5;
const firstWriteSeconds = warmupSeconds + 1;
const pollMs = 50;
const visibilityDeadlineMs = 2_000;
const request = { redirects: 0, timeout: '2s' };
const writeRequest = { ...request, timeout: '500ms', responseCallback: http.expectedStatuses(303) };
const writeSpacingMs = 3_500;
const versions = Array.from({ length: writes + 1 }, (_, i) => ({ title: `Publisher measurement V${i + 1}`, body: `publisher-measure-marker-${i + 1}` }));
const guestReadMillis = new Trend('guest_read_ms', true);
const guestReadSamples = new Counter('guest_read_samples');
const guestReadErrors = new Rate('guest_read_errors');
const guestVersionMismatches = new Rate('guest_version_mismatches');
const publishVisibleMillis = new Trend('publish_visible_ms', true);
const visiblePublications = new Counter('visible_publications');
const publicationProbes = new Counter('publication_probes');

function arrival(exec, startTime, duration) {
  const capacityWarmup = config.capacity && exec === 'warmup';
  return {
    executor: 'constant-arrival-rate', exec, startTime, duration,
    rate: capacityWarmup ? 50 : rate, timeUnit: '1s',
    preAllocatedVUs: capacityWarmup ? 4 : preAllocatedVUs,
    maxVUs: capacityWarmup ? 4 : maxVUs,
    gracefulStop: config.capacity && exec === 'reader' ? '2s' : '0s',
  };
}

export const options = {
  setupTimeout: '5s',
  summaryTrendStats: config.capacity ? ['med', 'p(95)', 'p(99)', 'max'] : ['med', 'p(95)', 'max'],
  scenarios: {
    warmup: arrival('warmup', '0s', `${warmupSeconds}s`),
    reader: arrival('reader', `${warmupSeconds}s`, `${windowSeconds}s`),
    // Align the writer with the measured window. Each update has up to 1s for writes and 2s for visibility.
    ...(writes ? { writer: { executor: 'per-vu-iterations', exec: 'writer', startTime: `${firstWriteSeconds}s`, vus: 1, iterations: writes, maxDuration: `${warmupSeconds + windowSeconds - firstWriteSeconds}s`, gracefulStop: '0s' } } : {}),
  },
  thresholds: {
    'iterations{scenario:reader}': [config.capacity ? `count>=${targetReads}` : `count==${targetReads}`],
    guest_read_samples: [`count==${targetReads}`],
    'dropped_iterations{scenario:reader}': ['count==0'],
    guest_read_errors: ['rate==0'],
    guest_version_mismatches: ['rate==0'],
    http_req_failed: ['rate==0'],
    ...(writes ? { visible_publications: [`count==${writes}`] } : {}),
    ...(config.capacity ? {
      guest_read_ms: [`p(95)<=${capacityBudget.p95}`, `p(99)<=${capacityBudget.p99}`],
      ...(writes ? { publish_visible_ms: [`p(95)<=${capacityBudget.visibility}`] } : {}),
    } : {}),
  },
};

function publish(version) {
  const save = http.post(`${origin}/draft`, version, writeRequest);
  if (save.status !== 303) exec.test.abort(`Save failed: ${save.status}`);
  const result = http.post(`${origin}/publish`, null, writeRequest);
  const acknowledgedAt = Date.now();
  if (result.status !== 303) exec.test.abort(`Publish failed: ${result.status}`);
  return acknowledgedAt;
}

function readPublic(params = request) { return http.get(`${origin}/p/pilot-page`, params); }

function observedVersion(response) {
  if (response.status !== 200) return -1;
  const document = response.html();
  const title = document.find('article h1').text();
  const body = document.find('article p').text();
  return versions.findIndex(v => v.title === title && v.body === body);
}

export function setup() { publish(versions[0]); }
export function warmup() { readPublic({ ...request, responseType: 'none' }); }

export function reader() {
  // With gracefulStop, k6 can dispatch extra iterations around the window boundary.
  if (config.capacity && exec.scenario.iterationInTest >= targetReads) return;
  const response = readPublic();
  guestReadMillis.add(response.timings.duration);
  guestReadErrors.add(response.status !== 200);
  const v = observedVersion(response);
  guestVersionMismatches.add(response.status === 200 && (v < 0 || (!writes && v !== 0)));
  // Count only iterations that recorded timing, status, and version together.
  guestReadSamples.add(1);
}

export function writer() {
  const index = exec.scenario.iterationInTest + 1;
  const waitMs = exec.scenario.startTime + (index - 1) * writeSpacingMs - Date.now();
  if (waitMs > 0) sleep(waitMs / 1_000);
  const ack = publish(versions[index]);
  while (Date.now() - ack < visibilityDeadlineMs) {
    const remaining = visibilityDeadlineMs - (Date.now() - ack);
    if (remaining <= 0) break;
    const response = readPublic({ ...request, timeout: `${remaining}ms`, jar: new http.CookieJar(), headers: { Connection: 'close' } });
    publicationProbes.add(1);
    const elapsed = Date.now() - ack;
    if (elapsed <= visibilityDeadlineMs && observedVersion(response) === index) {
      publishVisibleMillis.add(elapsed);
      visiblePublications.add(1);
      return;
    }
    const rest = visibilityDeadlineMs - (Date.now() - ack);
    if (rest > 0) sleep(Math.min(rest, pollMs) / 1_000);
  }
  exec.test.abort(`Publication V${index + 1} was not observed within ${visibilityDeadlineMs} ms`);
}

export function handleSummary({ metrics }) {
  const value = name => metrics[name]?.values ?? null;
  const iterations = value('iterations{scenario:reader}')?.count ?? 0;
  const samples = value('guest_read_samples')?.count ?? 0;
  const reads = config.capacity ? samples : iterations;
  const summary = {
    profile, windowSeconds, rateTarget: rate,
    reads,
    fullReadSamples: samples,
    achievedReadsPerSec: reads / windowSeconds,
    dropped: value('dropped_iterations{scenario:reader}')?.count ?? 0,
    ...(config.capacity ? { budgets: capacityBudget, readerIterations: iterations, peakActiveVUs: value('vus')?.max ?? null } : {}),
    readErrors: value('guest_read_errors')?.passes ?? 0,
    versionMismatches: value('guest_version_mismatches')?.passes ?? 0,
    allRequests: value('http_reqs')?.count ?? 0,
    allRequestErrors: value('http_req_failed')?.passes ?? 0,
    readMillis: value('guest_read_ms'),
    publishedObserved: value('visible_publications')?.count ?? 0,
    publicationProbes: value('publication_probes')?.count ?? 0,
    visibleMillis: value('publish_visible_ms'),
  };
  return { stdout: `MEASUREMENT ${JSON.stringify(summary)}\n` };
}
