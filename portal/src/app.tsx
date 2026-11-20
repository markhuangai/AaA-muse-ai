import { Component, useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { BUILD } from './api';
import { PortalController, type View } from './controller';
import { Workers } from './workers';
import { Requests } from './history';
import { ClientKeys } from './client-keys';
import { Appearance } from './appearance';

function Mark() {
  return <span className="wordmark"><svg aria-hidden="true" viewBox="0 0 28 28"><path d="M3 22 9 6l5 12L19 6l6 16M6 15h6m4 0h6" /></svg><span>AaA <span className="wordmark-detail">Muse</span></span></span>;
}

export function Login({ controller, view }: { controller: PortalController; view: View }) {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pending = controller.login(password, remember);
    setPassword('');
    void pending;
  }
  return <main className="login-page">
    <div className="login-intro"><h1>Service access</h1><p>Manage workers, client keys, and request history.</p></div>
    <section className="login-panel" aria-label="Sign in">
      <h2>Operator sign-in</h2>
      <form onSubmit={submit}>
        <label htmlFor="portal-password">Portal password</label>
        <input id="portal-password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="off" required disabled={view.phase === 'signing_in'} />
        <label className="remember-me"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} disabled={view.phase === 'signing_in'} /> Remember me</label>
        <button type="submit" className="primary" disabled={!password || view.phase === 'signing_in'}>{view.phase === 'signing_in' ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="field-note">Use the portal password from your service configuration.</p>
      {view.message && <div className="notice" role="status"><p>{view.message}</p><Correlation view={view} /></div>}
    </section>
  </main>;
}

function SessionStatus({ controller, view }: { controller: PortalController; view: View }) {
  return <main className="login-page"><section className="login-panel" aria-label="Portal session">
    <div role="status"><p>{view.message}</p>
      {(view.phase === 'restore_failed' || view.phase === 'logout_unconfirmed') && <Correlation view={view} />}</div>
    {view.phase === 'restore_failed' && <button className="primary" onClick={() => void controller.restore()}>Retry session check</button>}
    {view.phase === 'logout_unconfirmed' && <button className="primary" onClick={() => void controller.logout()}>Retry sign-out</button>}
  </section></main>;
}

function Correlation({ view }: { view: View }) {
  return <>{view.requestID && <p className="trace">Request <code>{view.requestID}</code></p>}{view.operationID && <p className="trace">Operation <code>{view.operationID}</code></p>}</>;
}

export function Configuration({ controller, view }: { controller: PortalController; view: View }) {
  const settings = view.settings;
  const updated = view.lastGood === null ? 'No successful refresh yet' : `Updated ${new Date(view.lastGood).toISOString().slice(11, 19)} UTC`;
  return <main className="settings-page">
    <div className="page-heading"><div><p className="context-label">Broker configuration</p><h1>Service settings</h1></div><div className="refresh-control"><span>{updated}</span><button onClick={() => void controller.refresh()} disabled={view.loading}>{view.loading ? 'Refreshing…' : 'Refresh'}</button></div></div>
    {view.message && <div className="notice" role="status"><p>{view.message}</p><Correlation view={view} /></div>}
    <section className="settings-section" aria-labelledby="identity-title">
      <div className="section-intro"><h2 id="identity-title">This broker</h2><p>The origin and build currently serving this session.</p><p className="scope-note">Service health describes the broker and database. Inference readiness is verified separately.</p></div>
      <div className="data-panel" aria-busy={view.loading}>
        <dl className="identity-list"><div><dt>Browser origin</dt><dd className="origin-value">{window.location.origin}</dd></div><div><dt>Service health</dt><dd>{settings ? <span className={`status ${settings.ready ? 'healthy' : 'degraded'}`}>{settings.ready ? 'Ready' : 'Database unavailable'}</span> : 'Loading…'}</dd></div><div><dt>Source revision</dt><dd><code>{settings?.build.revision ?? '—'}</code>{settings?.build.dirty && <span className="muted"> · working changes</span>}</dd></div><div><dt>Instance</dt><dd><code>{settings?.instance_id ?? '—'}</code></dd></div><div><dt>Schema version</dt><dd className="num">{settings?.schema_version ?? '—'}</dd></div></dl>
      </div>
    </section>
    <ClientKeys controller={controller} view={view} />
    <section className="settings-section" aria-labelledby="yaml-title">
      <div className="section-intro"><h2 id="yaml-title">Effective configuration</h2><p>Resolved values with defaults applied. Credentials are redacted.</p><span className="read-only">Read only</span><p className="scope-note">Edit general settings in config.yaml, then restart the service.</p></div>
      <div className="yaml-panel"><div className="file-heading"><span>config.yaml</span><span>{view.stale ? 'Stale snapshot' : settings ? 'Current snapshot' : 'Waiting for service'}</span></div><pre aria-label="Redacted effective YAML"><code>{settings?.effective_yaml ?? (view.loading ? 'Loading effective configuration…' : 'Configuration is unavailable. Use Refresh to retry.')}</code></pre></div>
    </section>
    <section className="settings-section capabilities-section" aria-labelledby="capabilities-title">
      <div className="section-intro"><h2 id="capabilities-title">Implemented APIs</h2><p>Software interfaces provided by this build.</p></div>
      <div className="data-panel"><ul className="capability-list">{settings ? settings.capabilities.map(value => <li key={value}>{value}</li>) : <li>Waiting for service details.</li>}</ul></div>
    </section>
  </main>;
}

export class RenderBoundary extends Component<{ controller: PortalController; reload: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.controller.renderFailed(); }
  render() {
    if (this.state.failed) return <main className="render-error"><h1>Portal view could not be rendered</h1><p>The browser reports this failure when the service is reachable.</p><button className="primary" onClick={this.props.reload}>Reload portal</button></main>;
    return this.props.children;
  }
}

export function App({ controller, reload = () => location.reload() }: { controller: PortalController; reload?: () => void }) {
  const view = useSyncExternalStore(controller.subscribe, controller.snapshot);
  useEffect(() => {
    const route = () => controller.navigate(location.pathname === '/workers' ? 'workers' : location.pathname === '/requests' ? 'requests' : 'settings');
    route(); window.addEventListener('popstate', route);
    return () => window.removeEventListener('popstate', route);
  }, [controller]);
  useEffect(() => {
    const report = () => controller.renderFailed();
    window.addEventListener('error', report);
    window.addEventListener('unhandledrejection', report);
    return () => { window.removeEventListener('error', report); window.removeEventListener('unhandledrejection', report); };
  }, [controller]);
  const authenticated = view.phase === 'authenticated';
  const showLogin = view.phase === 'login' || view.phase === 'signing_in';
  return <><header className="site-header"><div className="header-content"><Mark /><span className="header-label">Control portal</span>{authenticated && <nav aria-label="Portal">{(['settings', 'workers', 'requests'] as const).map(page => <a key={page} href={`/${page}`} aria-current={view.page === page ? 'page' : undefined} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); history.pushState(null, '', `/${page}`); controller.navigate(page);
  }}>{page === 'settings' ? 'Settings' : page === 'workers' ? 'Workers' : 'Requests'}</a>)}</nav>}<div className="header-controls"><Appearance />{authenticated && <button className="sign-out" onClick={() => void controller.logout()}>Sign out</button>}</div></div></header>
    <RenderBoundary key={authenticated ? 'session' : 'login'} controller={controller} reload={reload}>
      {authenticated ? view.page === 'workers' ? <Workers controller={controller.workers} /> : view.page === 'requests' ? <Requests controller={controller.history} /> : <Configuration controller={controller} view={view} /> :
        showLogin ? <Login controller={controller} view={view} /> : <SessionStatus controller={controller} view={view} />}
    </RenderBoundary><footer className="site-footer"><span>AaA Muse · Operator console</span><span className="build-label">Portal build <code>{BUILD.slice(0, 8)}</code></span></footer></>;
}
