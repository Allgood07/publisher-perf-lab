import { check } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';

const port = Number(__ENV.PUBLISHER_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid Publisher port');
const origin = `http://127.0.0.1:${port}`;
const title = 'Publisher smoke V1';
const marker = 'publisher-smoke-v1-742b';
const request = { redirects: 0, timeout: '2s' };
const expectedRedirect = http.expectedStatuses(303);

export const options = {
  setupTimeout: '5s',
  scenarios: {
    guest: { executor: 'shared-iterations', vus: 1, iterations: 5, maxDuration: '15s', gracefulStop: '0s' },
  },
  thresholds: {
    checks: ['rate==1'],
    iterations: ['count==5'],
    http_req_failed: ['rate==0'],
  },
};

export function setup() {
  const write = { ...request, responseCallback: expectedRedirect };
  const saved = http.post(`${origin}/draft`, { title, body: marker }, write);
  if (saved.status !== 303) exec.test.abort(`Setup save failed: ${saved.status}`);
  const published = http.post(`${origin}/publish`, null, write);
  if (published.status !== 303) exec.test.abort(`Setup publish failed: ${published.status}`);
}

export default function () {
  const response = http.get(`${origin}/p/pilot-page`, request);
  check(response, {
    'guest receives HTTP 200': r => r.status === 200,
    'guest sees the exact V1 title and marker': r => r.status === 200
      && r.html().find('article h1').text() === title
      && r.html().find('article p').text() === marker,
  });
}
