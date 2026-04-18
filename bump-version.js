#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Version Bumper — run before committing a new release
//
// Usage:
//   node bump-version.js patch "Short description of what changed"
//   node bump-version.js minor "Short description of what changed"
//   node bump-version.js major "Short description of what changed"
//
// What it does:
//   1. Reads version.json
//   2. Increments the version number (patch/minor/major)
//   3. Adds a new changelog entry with today's date + your description
//   4. Writes version.json back
//   5. Prints the git commands to tag + commit
// ─────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'version.json');
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const bump = process.argv[2] || 'patch';
const desc = process.argv.slice(3).join(' ') || 'No description provided';

// Parse current version
const parts = data.version.split('.').map(Number);
if (bump === 'major') { parts[0]++; parts[1] = 0; parts[2] = 0; }
else if (bump === 'minor') { parts[1]++; parts[2] = 0; }
else { parts[2]++; } // patch

const newVersion = parts.join('.');
const today = new Date().toISOString().slice(0, 10);

data.version  = newVersion;
data.released = today;

// Prepend new changelog entry
data.changelog.unshift({
  version: newVersion,
  date:    today,
  label:   desc,
  changes: [],
});

fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');

console.log(`\n✅  Bumped to v${newVersion}\n`);
console.log('Next steps:');
console.log(`  1. Add your changes to version.json → changelog[0].changes`);
console.log(`  2. git add version.json`);
console.log(`  3. git commit -m "v${newVersion}: ${desc}"`);
console.log(`  4. git tag v${newVersion}`);
console.log(`  5. git push origin main --tags\n`);
