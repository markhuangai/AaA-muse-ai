import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const report = JSON.parse(readFileSync('../.artifacts/unit/worker/coverage-final.json', 'utf8'));
const expected = readdirSync('src').filter(n => n.endsWith('.ts')).map(n => resolve('src', n)).sort();
assert.deepEqual(Object.keys(report).map(p => resolve(p)).sort(), expected, 'unit receipt must include every production module');
let covered = 0, total = 0;
for (const entry of Object.values(report)) for (const hits of Object.values(entry.s)) { total++; if (hits > 0) covered++; }
const receipt = { component: 'worker', suite: 'unit', covered, total, modules: expected.map(p => relative(process.cwd(), p)), passed: total > 0 && covered * 100 > total * 90 };
writeFileSync('../.artifacts/unit/worker/receipt.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
assert(receipt.passed, 'worker unit statements must be strictly greater than 90%');
