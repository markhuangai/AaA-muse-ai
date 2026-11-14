import { APIError, BUILD, type API, type BrowserReport } from './api';

export class Reports {
  #queue: BrowserReport[] = [];
  #omitted = 0;
  #sending = false;
  #waiters = new Set<() => void>();
  #generation = 0;
  #abort = new AbortController();
  constructor(private api: API) {}

  clear() {
    for (const resolve of this.#waiters) resolve();
    this.#waiters = new Set();
    this.#generation++;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#queue = [];
    this.#omitted = 0;
    this.#sending = false;
  }

  add(value: Omit<BrowserReport, 'build' | 'omitted_reports'>) {
    if (this.#queue.length >= 20) { this.#omitted = Math.min(1_000_000, this.#omitted + 1); return; }
    this.#queue.push({ ...value, build: BUILD, omitted_reports: 0 });
    void this.flush();
  }

  async drain() {
    await this.flush();
    if (this.#sending) await new Promise<void>(resolve => this.#waiters.add(resolve));
  }

  async flush() {
    if (this.#sending) return;
    this.#sending = true;
    const generation = this.#generation, waiters = this.#waiters;
    try {
      while (this.#queue.length && generation === this.#generation) {
        const omitted = this.#omitted;
        try {
          await this.api.report({ ...this.#queue[0], omitted_reports: omitted }, this.#abort.signal);
        } catch (error) {
          if (generation !== this.#generation) return;
          if (error instanceof APIError && error.status === 401) this.clear();
          return;
        }
        if (generation !== this.#generation) return;
        this.#omitted -= omitted;
        this.#queue.shift();
      }
    } finally { if (generation === this.#generation) this.#sending = false; for (const resolve of waiters) resolve(); waiters.clear(); }
  }
}
