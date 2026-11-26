FROM grafana/k6:1.0.0@sha256:f21270290d702cbf0a7d6ba5d7ed100b63bcb233b558b885ed787547b3488279 AS k6
FROM node:22.22.0-alpine@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34

COPY --from=k6 /usr/bin/k6 /usr/local/bin/k6
WORKDIR /app
COPY run-smoke.mjs smoke.js measure.js measure-profiles.mjs cpu-sample.sh k6-diagnostic.sh k6-second-buckets.awk ./
USER node
ENTRYPOINT ["node", "/app/run-smoke.mjs"]
