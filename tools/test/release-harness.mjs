import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReleaseCollector } from '../product-collector.mjs';
import { openEvidence } from '../qualification-evidence.mjs';
import { completeFixture, exportFixture } from '../qualification-fixtures.mjs';
import { productFixture, stamp } from './product-fixture.mjs';
import { productServer } from './product-server.mjs';

export async function releaseHarness(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'aaa-release-collector-')); t.after(() => fs.rm(directory, { recursive: true }));
  const protocol = await productServer(t), fixture = productFixture(true), requests = [], logs = [], imports = new Map();
  const observations = join(directory, 'observations.json');
  const entries = [...fixture.report.observations, { kind: 'artifact_identity', time: stamp(0), observer: 'owner', source_ref: 'verified-image', service_sha: fixture.report.source.service_sha,
    image_digest: fixture.report.source.image_digest, installer_sha256: fixture.report.source.installer_sha256 }];
  const source = { schema_version: 1, entries, worker_exports: [] };
  const write = () => fs.writeFile(observations, JSON.stringify(source), { mode: 0o600 }); await write();
  const evidence = await openEvidence(join(directory, 'evidence'), { stderr: line => logs.push(JSON.parse(line)) });
  const h = { directory, fixture, requests, logs, entries, imports, write, source, instance: 'process-one', offline: false, badNative: false,
    connections: { a: { connection_id: 'connection-worker-a', connection_generation: 2 }, b: { connection_id: 'connection-worker-b', connection_generation: 2 } } };
  const status = { ...fixture.report.status_receipt, configuration: { limits: { max_jobs: 4, in_flight_per_worker: 1 } } };
  const access = { workers: fixture.report.workers.map(({ slot, worker_id, account_ref }) => ({ slot, worker_id, account_ref })), keys: { a: 'Bearer client-a', b: 'Bearer client-b' }, portal_password_file: join(directory, 'portal-password') };
  const nativeFactory = settings => {
    const complete = completeFixture(['readiness', 'trial-1']);
    const rawReplace = value => JSON.parse(JSON.stringify(value).replaceAll('worker-1', settings.workerID));
    const report = rawReplace(complete.report), decoded = rawReplace(complete.evidence);
    report.exports = []; let index = 0;
    return { report,
      async initialize() {
        for (const ref of decoded.filter(item => item.source === 'broker')) {
          const raw = exportFixture(ref.events); await settings.state.write(ref.file, raw);
          report.exports.push({ source: ref.source, case_id: ref.case_id, file: ref.file, sha256: (await import('../qualification-evidence.mjs')).hash(raw) });
        }
      },
      async runCase(id) {
        const item = report.cases[index++], old = item.id; item.id = id;
        for (const entry of report.observations) if (entry.case_id === old) entry.case_id = id;
        for (const ref of report.exports) if (ref.case_id === old) ref.case_id = id;
        if (h.badNative) item.observed.final_text = 'incorrect-live-result';
      },
      async observe() {
        const path = '/private/' + settings.workerID + '-' + index;
        imports.set(path, exportFixture(decoded.filter(ref => ref.source === 'worker').flatMap(ref => ref.events)));
        return { entries: report.observations, worker_exports: [{ case_id: 'all', path }] };
      },
      async save() { await settings.state.write('report.json', JSON.stringify(report)); },
    };
  };
  const fetcher = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/v1/')) return fetch(protocol.origin + parsed.pathname, options);
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ path: parsed.pathname, search: parsed.search, method: options.method, body });
    let value;
    if (parsed.pathname === '/api/v1/admin/status') value = { ...status, instance_id: h.instance };
    else if (parsed.pathname === '/api/v1/admin/workers') value = { workers: access.workers.map(worker => ({
      id: worker.worker_id, work_status: h.offline && worker.slot === 'a' ? 'unknown' : 'idle', current_job: null,
      connection_status: h.offline && worker.slot === 'a' ? 'offline' : 'online',
      waiting_for_client_tool: h.instance === 'process-two' && worker.slot === 'a' ? 1 : 0,
    })) };
    else if (parsed.pathname === '/api/v1/requests') {
      const key = options.headers.Authorization;
      const target = key === access.keys.a ? 'worker-a' : key === access.keys.b ? 'worker-b' : undefined;
      if (target !== body.worker_id) return new Response('', { status: 404 });
      value = { id: 'pin-' + requests.length, state: 'completed', session_id: options.headers['X-Muse-Session-Id'],
        worker_id: target, output: { type: 'final', text: body.messages.at(-1).text.slice('Reply with exactly: '.length) } };
    }
    else if (parsed.pathname.includes('/qualifications')) return new Response('{"error":"qualification_retired"}', { status: 410 });
    else if (parsed.pathname.includes('/diagnostics/export')) {
      value = parsed.searchParams.has('request_id') ? await protocol.management(parsed.pathname + parsed.search) : exportFixture(fixture.broker);
    } else if (parsed.pathname.startsWith('/api/v1/admin/requests/')) {
      value = await protocol.management(parsed.pathname);
      Object.assign(value.assignment, h.connections[value.execution.worker_id.at(-1)]);
    }
    else throw new Error('unexpected_test_route');
    return new Response(typeof value === 'string' ? value : JSON.stringify(value), { headers: { 'x-request-id': 'management-request', 'content-type': 'application/json' } });
  };
  const collector = new ReleaseCollector({ ...evidence, origin: 'https://broker.test', header: 'Authorization: Bearer management-private', observations, access, fetcher, nativeFactory,
    readPrivate: async path => { if (!imports.has(path)) throw new Error('missing_export'); return imports.get(path); },
    browserRunner: async ({ phase, fixture: input }) => {
      if (h.browserFailure) throw new Error('product_browser_failed');
      return { source_sha: input.source_sha, outcome: 'passed', secrets: ['temporary-session'], cases: [{ id: 'portal.login', outcome: 'passed' },
        ...(phase === 'setup' ? ['a', 'b'].map(slot => ({ id: 'portal.enrollment.' + slot, outcome: 'passed' })) : phase === 'revoke' ? ['a', 'b'].map(slot => ({ id: 'portal.revoke.' + slot, outcome: 'passed' })) : [{ id: 'portal.history', outcome: 'passed' }])] };
    } });
  return Object.assign(h, { collector, evidence, status, access, protocol });
}
