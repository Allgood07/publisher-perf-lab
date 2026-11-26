// Explicit profiles only. A profile never accepts a URL or port from the caller.
const profiles = {
  read:         { rate:  5, windowSeconds: 20, preAllocatedVUs:  2, maxVUs:  4, writes:  0 },
  publish:      { rate:  5, windowSeconds: 20, preAllocatedVUs:  2, maxVUs:  4, writes:  5 },
  'probe-10':   { rate: 10, windowSeconds:  8, preAllocatedVUs: 16, maxVUs: 32, writes:  0 },
  'probe-25':   { rate: 25, windowSeconds:  8, preAllocatedVUs: 16, maxVUs: 32, writes:  0 },
  'probe-50':   { rate: 50, windowSeconds:  8, preAllocatedVUs: 16, maxVUs: 32, writes:  0 },
  'read-50':    { rate: 50, windowSeconds: 60, preAllocatedVUs: 16, maxVUs: 32, writes:  0 },
  'publish-50': { rate: 50, windowSeconds: 60, preAllocatedVUs: 16, maxVUs: 32, writes: 16 },
};

const capacities = new Set([50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 900, 1000, 1100, 1200, 1400, 1600]);
export const capacityBudget = Object.freeze({ p95: 20, p99: 50, visibility: 100 });

export function measurementProfile(name) {
  if (Object.prototype.hasOwnProperty.call(profiles, name)) return profiles[name];
  const match = /^(scan|capacity|soak|endurance|diagnostic)-(read|publish)-(\d{2,4})$/.exec(name);
  if (!match) return null;
  const [, phase, workload, target] = match;
  const rate = Number(target);
  if (!capacities.has(rate) || target !== String(rate)
      || (phase === 'endurance' && rate !== 800) || (phase === 'diagnostic' && rate !== 1200)) return null;
  const windowSeconds = { scan: 12, capacity: 30, soak: 90, endurance: 300, diagnostic: 30 }[phase];
  return {
    rate, windowSeconds, preAllocatedVUs: 64, maxVUs: 96,
    writes: workload === 'publish' ? Math.floor((windowSeconds - 4) / 3.5) + 1 : 0,
    capacity: true,
  };
}
