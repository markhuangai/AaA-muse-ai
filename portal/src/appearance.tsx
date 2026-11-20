import { useEffect, useState } from 'react';

const preferenceKey = 'muse-portal-appearance';
const options = ['system', 'light', 'dark'] as const;
type Theme = typeof options[number];

function isTheme(value: string | null): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark';
}

function readTheme(): Theme {
  try {
    const value = localStorage.getItem(preferenceKey);
    return isTheme(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme = readTheme()) {
  document.documentElement.dataset.theme = theme;
}

export function Appearance() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key !== preferenceKey && event.key !== null) return;
      const next = readTheme();
      applyTheme(next);
      setTheme(next);
    }
    addEventListener('storage', sync);
    return () => removeEventListener('storage', sync);
  }, []);
  return <label className="appearance"><span className="sr-only">Appearance</span><select value={theme} onChange={event => {
    const next = event.target.value;
    if (!isTheme(next)) return;
    applyTheme(next);
    setTheme(next);
    try { localStorage.setItem(preferenceKey, next); } catch { /* The choice still applies in this tab. */ }
  }}>{options.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>;
}
