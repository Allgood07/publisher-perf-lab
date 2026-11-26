#!/bin/sh
# Linux cgroup v2 counters, on the same clock as k6 in the Docker VM.
while :; do
  now=$(date +%s)
  awk -v now="$now" '$1=="usage_usec" { u=$2 } $1=="nr_throttled" { n=$2 } $1=="throttled_usec" { t=$2 } END { if (u!="" && n!="" && t!="") printf "CPU_SAMPLE %s %s %s %s\n",now,u,n,t }' /sys/fs/cgroup/cpu.stat
  sleep 1
done
