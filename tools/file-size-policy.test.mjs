import assert from 'node:assert/strict';
import test from 'node:test';
import { checkFileSizes, countLines, main } from './file-size-policy.mjs';
import { fixture } from './test/helpers.mjs';

test('actual line counter handles final newlines, CRLF, Unicode and the 1000/1001 boundary', () => {
  for (const [raw, lines] of [['', 0], ['x', 1], ['x\n', 1], ['x\r\ny', 2], ['λ\n', 1]]) assert.equal(countLines(Buffer.from(raw)), lines);
  assert.equal(checkFileSizes(['code.mjs'], () => Buffer.from('x\n'.repeat(1000))).problems.length, 0);
  const result = checkFileSizes(['code.mjs'], () => Buffer.from('x\n'.repeat(1000) + 'x'));
  assert.deepEqual(result.problems, [{ path: 'code.mjs', lines: 1001, maximum: 1000, cause: 'maintained_file_exceeds_limit' }]);
  assert.throws(() => countLines(Buffer.from([255])), /encoded data/);
  assert.throws(() => countLines(Buffer.from('x\0y')), /nul_in_maintained_source/);
});

test('only exact dependency lockfiles are excluded and generated-looking handwritten code still fails', () => {
  const paths = ['package-lock.json', '.github/scripts/package-lock.json', 'go.sum', 'worker/dist/handwritten.js', 'tools/fake.generated.mjs', 'other/package-lock.json', 'worker/setup/install.sh', 'internal/schema.sql', '.github/workflows/ci.yml', 'Makefile', 'Dockerfile', 'tests/a.Dockerfile', 'README.md', 'photo.png'];
  const result = checkFileSizes(paths, () => Buffer.from('x\n'.repeat(1001)));
  assert.equal(result.excluded_files.length, 3);
  assert.equal(result.problems.length, 9);
  assert(result.problems.some(problem => problem.path === 'worker/dist/handwritten.js'));
  assert(result.problems.some(problem => problem.path === 'other/package-lock.json'));
  assert(!result.files.some(file => file.path === 'README.md'));
});

test('unreadable or invalid maintained source produces explicit diagnostic evidence', t => {
  const failure = checkFileSizes(['source.go'], () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
  assert.equal(failure.problems[0].cause, 'EACCES');
  const f = fixture(t);
  const events = [], emit = (_core, level, event, fields) => events.push({ level, event, ...fields });
  assert.equal(main(f.root, f.inspect, emit), 0);
  f.write('tools/example.mjs', 'x\n'.repeat(1001));
  assert.equal(main(f.root, f.inspect, emit), 1);
  assert(events.some(event => event.event === 'ci.file_limit_rejected' && event.level === 'error' && event.path === 'tools/example.mjs' && event.lines === 1001 && event.maximum === 1000 && event.source.sha));
  const captured = [], previous = console.log;
  console.log = line => captured.push(line);
  try { assert.equal(main(f.root, f.inspect), 1); } finally { console.log = previous; }
  const rejected = captured.filter(line => line.startsWith('::error::')).map(line => JSON.parse(line.slice(9)));
  assert(rejected.some(event => event.level === 'ERROR' && event.event === 'ci.file_limit_rejected' && event.lines === 1001 && event.path === 'tools/example.mjs' && event.source.sha));
  assert.equal(main(f.root, () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, emit), 1);
  assert.equal(events.at(-1).cause, 'ENOENT');
});
