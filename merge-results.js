#!/usr/bin/env node
// Merges pipeline.js's Workflow return value ([{id, report, ...}]) into
// data.json's `reports` map. No LLM calls — the "result integration" step
// that would otherwise mean hand-pasting markdown into Edit calls again.
// Usage: node merge-results.js <results.json>
const fs = require('fs');
const path = require('path');

const resultsPath = process.argv[2];
if (!resultsPath) {
  console.error('usage: node merge-results.js <results.json>');
  console.error('  <results.json> should contain the array Workflow returned from pipeline.js: [{id, report, ...}]');
  process.exit(1);
}

const dataPath = path.join(__dirname, 'data.json');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
let results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
// Accept the Workflow task-output file ({summary, result: [...], ...}) directly,
// so the raw output under .../tasks/<id>.output can be passed without extraction.
if (!Array.isArray(results) && Array.isArray(results.result)) results = results.result;

let added = 0,
  updated = 0,
  revised = 0,
  skipped = 0;
for (const r of results) {
  if (!r || !r.id || !r.report) {
    skipped++;
    continue;
  }
  if (data.reports[r.id]) updated++;
  else added++;
  if (r.revised) revised++;
  data.reports[r.id] = r.report;
}

fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
console.log(`Merged into data.json: ${added} new, ${updated} overwritten, ${revised} auto-revised after verify, ${skipped} skipped (missing id/report)`);

// Failed/empty games become the retry list — feed these ids back into a resumeFromRunId run
const failedIds = results.filter((r) => r && r.id && !r.report).map((r) => r.id);
if (failedIds.length) console.log(`RETRY NEEDED: ${failedIds.join(', ')}`);
console.log('Next: node build-site.js && node content-lint.js');
