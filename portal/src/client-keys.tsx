import { useState, type FormEvent } from 'react';
import { randomHex } from './api';
import type { PortalController, View } from './controller';

export function ClientKeys({ controller, view }: { controller: PortalController; view: View }) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [generated, setGenerated] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const names = view.settings?.client_key_names;
  const pending = view.keySave?.pending;

  function generate() {
    setKey('aaa_muse_ai_' + randomHex(32));
    setGenerated(true);
    setCopyStatus('');
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(key);
      setCopyStatus('Copied.');
    } catch {
      setCopyStatus('Clipboard access failed. Select the generated key to copy it.');
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !key || pending) return;
    void controller.createClientKey(name.trim(), key);
    setName('');
    setKey('');
    setGenerated(false);
    setCopyStatus('');
  }

  return <section className="settings-section" aria-labelledby="client-keys-title">
    <div className="section-intro">
      <h2 id="client-keys-title">Client keys</h2>
      <p>Authorize a model client. Copy generated keys before saving. Saved key values are available in the host’s config.yaml.</p>
    </div>
    <div className="data-panel">
      {names?.length ? <ul className="client-key-list" aria-label="Saved client keys">{names.map(name => <li key={name}>{name}</li>)}</ul> :
        <p className="field-note">{names ? 'No client keys configured.' : 'Client keys are unavailable until settings load.'}</p>}
      <form className="client-key-form" onSubmit={submit} autoComplete="off">
        <label htmlFor="client-key-name">Name</label>
        <input id="client-key-name" value={name} onChange={event => setName(event.target.value)} maxLength={100} required disabled={pending} />
        <label htmlFor="client-key-value">Key</label>
        <input id="client-key-value" data-sensitive="client-key" type={generated ? 'text' : 'password'} value={key}
          onChange={event => { setKey(event.target.value); setGenerated(false); setCopyStatus(''); }}
          autoComplete="off" spellCheck={false} required disabled={pending} />
        <div className="copy-controls">
          <button type="button" onClick={generate} disabled={pending}>Generate</button>
          {generated && <button type="button" onClick={() => void copy()}>Copy key</button>}
          <button type="submit" className="primary" disabled={!name.trim() || !key || pending}>{pending ? 'Saving…' : 'Save client key'}</button>
        </div>
        {copyStatus && <p className="field-note" role="status">{copyStatus}</p>}
      </form>
      {view.keySave?.message && <div className="notice" role="status"><p>{view.keySave.message}</p>
        {view.keySave.requestID && <p className="trace">Request <code>{view.keySave.requestID}</code></p>}
        <p className="trace">Operation <code>{view.keySave.operationID}</code></p>
      </div>}
    </div>
  </section>;
}
