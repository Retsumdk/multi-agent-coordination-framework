export const USAGE = `macf — multi-agent coordination framework

Usage:
  macf demo                 Run the deterministic coordination demo (JSON)
  macf run --script <path>  Execute a JSON array of ops against a fresh engine (JSON)
  macf help                 Show this help

Script ops (JSON array):
  {"op":"register","agent":"a1","capabilities":["write"]}
  {"op":"put","agent":"a1","key":"k","value":"v"}            lease + write shared state
  {"op":"get","key":"k"}
  {"op":"try-put","agent":"a2","key":"k","value":"v2","expectedVersion":1}
  {"op":"create-task","title":"...","requiredCapabilities":["summarize"]}
  {"op":"claim","agent":"a1","task":"task-001"}
  {"op":"complete","agent":"a1","task":"task-001","result":{}}
  {"op":"fail","agent":"a1","task":"task-001","reason":"bad input"}
  {"op":"lease","agent":"a1","resource":"gpu:node-7","ttlMs":500}
  {"op":"tick","advanceMs":60000}                            sweep expired leases/claims

Exit codes: 0 ok | 1 runtime failure | 2 usage/validation error`;