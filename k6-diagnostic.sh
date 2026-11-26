#!/bin/sh
set -eu
fifo=/tmp/k6-metrics.fifo
mkfifo "$fifo"
# Keep a writer until k6 exits so the reader sees EOF even on an early k6 failure.
exec 3<> "$fifo"
awk -f /app/k6-second-buckets.awk < "$fifo" 3>&- &
reader=$!
sh /app/cpu-sample.sh 3>&- &
sampler=$!
set +e
K6_CSV_TIME_FORMAT=unix k6 run --no-color --quiet --out "csv=$fifo" "$1" 3>&-
code=$?
kill "$sampler" 2>/dev/null
wait "$sampler" 2>/dev/null
exec 3>&-
wait "$reader"
parsed=$?
if [ "$parsed" -ne 0 ]; then
  printf 'k6 diagnostic CSV aggregation failed (%s)\n' "$parsed" >&2
  exit 2
fi
exit "$code"
