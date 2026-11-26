# k6 CSV on the fixed local fixture. The required columns precede free-form tags.
BEGIN { FS=","; failed=0 }
NR == 1 {
  for (i=1; i<=NF; i++) col[$i]=i
  if (!col["metric_name"] || !col["timestamp"] || !col["metric_value"] || !col["scenario"]) failed=1
  next
}
failed { next }
{
  name=$(col["metric_name"]); at=$(col["timestamp"]); value=$(col["metric_value"])
  if (name!="vus" && !($(col["scenario"])=="reader" && (name=="dropped_iterations" || name=="guest_read_ms" || name=="diagnostic_active_vus"))) next
  if (at !~ /^[0-9]+$/ || value !~ /^[0-9]+([.][0-9]+)?([eE][-+]?[0-9]+)?$/) { failed=1; next }
  if (!(at in seen)) { seen[at]=1; ordered[++count]=at }
  if (name=="vus") { if (!(at in vus) || value+0>vus[at]) vus[at]=value+0 }
  else if (name=="diagnostic_active_vus") { if (!(at in sampled) || value+0>sampled[at]) sampled[at]=value+0 }
  else if (name=="dropped_iterations") drops[at]+=value
  else { n[at]++; sum[at]+=value; if (value+0>max[at]) max[at]=value+0 }
}
END {
  if (failed || !count) exit 2
  for (i=1; i<=count; i++) {
    s=ordered[i]
    printf "K6_SECOND %s %d %d %s %s %s %s\n",s,n[s],drops[s],((s in vus)?vus[s]:"-"),((s in sampled)?sampled[s]:"-"),(n[s]?sprintf("%.6f",sum[s]/n[s]):"-"),(n[s]?sprintf("%.6f",max[s]):"-")
  }
}
