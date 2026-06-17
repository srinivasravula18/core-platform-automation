// Print the newest agent run's status + last phase message; exit 0 when terminal.
const fs = require('fs');
let d;
try { d = JSON.parse(fs.readFileSync('.testflow-data.json', 'utf8')); } catch { console.log('read-err'); process.exit(1); }
const runs = Array.isArray(d.agentRuns) ? d.agentRuns : [];
const run = runs.slice().sort((a, b) => String(b.started_at || b.created_at || '').localeCompare(String(a.started_at || a.created_at || '')))[0];
if (!run) { console.log('no runs'); process.exit(1); }
const msgs = Array.isArray(run.messages) ? run.messages : [];
const last = msgs[msgs.length - 1] || {};
console.log(`[${new Date().toISOString().slice(11, 19)}] ${run.name || ''} status=${run.status} | ${last.agent || ''} ${last.status || ''} ${String(last.output || '').replace(/\s+/g, ' ').slice(0, 160)}`);
process.exit(['completed', 'failed', 'review_required', 'cancelled', 'coverage_options'].includes(run.status) ? 0 : 1);
