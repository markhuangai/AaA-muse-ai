#!/usr/bin/env node
import { dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Collector } from './qualification-collector.mjs';
import { need, openEvidence, privateRead, readExports } from './qualification-evidence.mjs';
import { validateReport } from './qualification-report.mjs';
import { Redactor } from '../worker/dist/diagnostics.js';

const help = `Qualification tooling; no live Muse pass is supplied by software tests.
Build helpers first: npm run build --workspace worker
collect --suite poc --origin HTTPS_ORIGIN --worker-id ID --admin-header-file ABSOLUTE_FILE --evidence-dir ABSOLUTE_DIR --observations ABSOLUTE_FILE [--stage all|baseline|readiness-repeat|replay|refresh|finalize]
validate-report --report FILE [--synthetic]
diagnostics --evidence-dir ABSOLUTE_DIR
Live collection requires the tooling PR to be human-merged and separately authorized owner access.
`;

export async function main(args = process.argv.slice(2), output = value => process.stdout.write(value+'\n')) {
  if (!args.length || args[0] === '--help') { output(help); return 0; }
  const command = args.shift(), options = {};
  const allowed = {collect:['suite','origin','worker-id','admin-header-file','evidence-dir','observations','stage'],'validate-report':['report','synthetic'],diagnostics:['evidence-dir']}[command];
  need(allowed,'unknown_command');
  while (args.length) {
    const flag = args.shift(); need(flag.startsWith('--') && allowed.includes(flag.slice(2)) && !Object.hasOwn(options,flag.slice(2)),'invalid_or_duplicate_option');
    const name = flag.slice(2); options[name] = name === 'synthetic' ? true : args.shift();
    need(options[name] && !(typeof options[name] === 'string' && options[name].startsWith('--')),'option_value_required');
  }
  if (command === 'validate-report') {
    need(options.report,'report_required');
    const {readFile} = await import('node:fs/promises');
    const {resolve,join} = await import('node:path');
    const path = resolve(options.report);
    const read = options.synthetic ? file => readFile(join(dirname(path),file),'utf8') : file => privateRead(join(dirname(path),file));
    const report = JSON.parse(options.synthetic ? await readFile(path,'utf8') : await privateRead(path));
    need(!options.synthetic || report.evidence_kind === 'synthetic','synthetic_flag_rejects_live_evidence');
    const result = validateReport(report,await readExports(report,read));
    output(JSON.stringify(new Redactor().value(result)));
    return result.valid ? 0 : 1;
  }
  need(options['evidence-dir'] && isAbsolute(options['evidence-dir']),'absolute_evidence_directory_required');
  const evidence = await openEvidence(options['evidence-dir']);
  if (command === 'diagnostics') { output(await evidence.capture.export({},true)); return 0; }
  need(options.suite === 'poc' && options.origin && options['worker-id'] && options['admin-header-file'] && options.observations,'collection_options_required');
  const collector = new Collector({...evidence,origin:options.origin,workerID:options['worker-id'],header:await privateRead(options['admin-header-file']),observations:options.observations});
  const result = await collector.collect(options.stage ?? 'all');
  output(JSON.stringify(evidence.logger.redactor.value({valid:result.valid,verdict:result.verdict,missing:result.missing,errors:result.errors})));
  return !result.valid ? 1 : result.verdict === 'pass' ? 0 : result.verdict === 'fail' ? 1 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(); }
  catch (error) { process.stderr.write(JSON.stringify({level:'ERROR',msg:'qualification.command_failed',cause:/^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : error.name,remediation:'Check documented inputs and protected qualification diagnostics; preserve partial evidence.'})+'\n'); process.exitCode = 1; }
}
