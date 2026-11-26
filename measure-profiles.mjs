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

export function measurementProfile(name) {
  return Object.prototype.hasOwnProperty.call(profiles, name) ? profiles[name] : null;
}
