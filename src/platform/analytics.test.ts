import { describe, expect, it } from 'vitest';
import {
  BATCH_LIMIT,
  FirestoreSink,
  INSTALL_ID_KEY,
  KEEPALIVE_BATCH_LIMIT,
  LOG_KEY,
  LOG_LIMIT,
  PlaytestAnalytics,
  SENDING_KEY,
  batchDocument,
  toFirestoreValue,
} from './analytics';
import type {
  EventBatch,
  EventSink,
  FetchLike,
  KeyValueStore,
  PlaytestAnalyticsOptions,
} from './analytics';

class MapStore implements KeyValueStore {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/** Records batches; answers each send with the next queued result (true when none left). */
class FakeSink implements EventSink {
  readonly sent: { batch: EventBatch; keepalive: boolean }[] = [];
  results: boolean[] = [];
  send(batch: EventBatch, keepalive: boolean): Promise<boolean> {
    this.sent.push({ batch, keepalive });
    return Promise.resolve(this.results.shift() ?? true);
  }
}

function setup(overrides: Partial<PlaytestAnalyticsOptions> = {}) {
  let ms = 1000;
  let ids = 0;
  const store = new MapStore();
  const sink = new FakeSink();
  const options: PlaytestAnalyticsOptions = {
    store,
    sink,
    clock: () => ms,
    now: () => new Date(Date.UTC(2026, 9, 14, 12, 0, 0)),
    newId: () => `id-${++ids}`,
    build: '0.0.1+abc1234',
    locale: 'en',
    defaultSending: true,
    ...overrides,
  };
  return {
    store,
    sink,
    options,
    analytics: new PlaytestAnalytics(options),
    advance: (by: number) => (ms += by),
  };
}

/** Lets the sends' promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PlaytestAnalytics', () => {
  it('keeps one install id per browser and a new session id per page', () => {
    const { store, options, analytics } = setup();
    expect(analytics.installId).toBe('id-1');
    expect(analytics.sessionId).toBe('id-2');
    expect(store.getItem(INSTALL_ID_KEY)).toBe('id-1');
    const again = new PlaytestAnalytics({ ...options, newId: () => 'later' });
    expect(again.installId).toBe('id-1');
    expect(again.sessionId).toBe('later');
  });

  it('sends by default when a sink exists and remembers the choice', () => {
    const { store, options, analytics } = setup();
    expect(analytics.canSend).toBe(true);
    expect(analytics.sending).toBe(true);
    analytics.sending = false;
    expect(store.getItem(SENDING_KEY)).toBe('0');
    expect(new PlaytestAnalytics(options).sending).toBe(false);
    const off = setup({ defaultSending: false }).analytics;
    expect(off.sending).toBe(false);
    const noSink = setup({ sink: null }).analytics;
    expect(noSink.canSend).toBe(false);
    expect(noSink.sending).toBe(false);
  });

  it('stamps events with seconds since the session started and sends them in batches', async () => {
    const { sink, analytics, advance } = setup();
    advance(12_345);
    analytics.track('run_end', { wave: 9, keystones: ['steadyAim'] });
    for (let i = 0; i < BATCH_LIMIT + 5; i++) analytics.track('talent_allocate', { node: 'might' });
    analytics.flush();
    await settle();
    expect(sink.sent.map((s) => s.batch.events.length)).toEqual([BATCH_LIMIT, 6]);
    const first = sink.sent[0]?.batch as EventBatch;
    expect(first).toMatchObject({
      v: 1,
      installId: 'id-1',
      sessionId: 'id-2',
      seq: 1,
      build: '0.0.1+abc1234',
      locale: 'en',
      sentAt: '2026-10-14T12:00:00.000Z',
    });
    expect(first.events[0]).toEqual({
      type: 'run_end',
      t: 12.3,
      wave: 9,
      keystones: ['steadyAim'],
    });
    expect(sink.sent[1]?.batch.seq).toBe(2);
    analytics.flush();
    await settle();
    expect(sink.sent).toHaveLength(2);
  });

  it('puts a failed batch back and sends it with the next flush', async () => {
    const { sink, analytics } = setup();
    sink.results = [false];
    analytics.track('session_start');
    analytics.flush();
    await settle();
    analytics.track('run_end');
    analytics.flush();
    await settle();
    expect(sink.sent).toHaveLength(2);
    expect(sink.sent[1]?.batch.events.map((e) => e.type)).toEqual(['session_start', 'run_end']);
    expect(sink.sent[1]?.batch.seq).toBe(2);
  });

  it('sends one small keepalive batch when the page closes', async () => {
    const { sink, analytics } = setup();
    for (let i = 0; i < KEEPALIVE_BATCH_LIMIT + 10; i++) analytics.track('talent_allocate');
    analytics.flush(true);
    await settle();
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]?.keepalive).toBe(true);
    expect(sink.sent[0]?.batch.events).toHaveLength(KEEPALIVE_BATCH_LIMIT);
  });

  it('sends nothing while sending is off, and drops what was pending', async () => {
    const { sink, analytics } = setup();
    analytics.track('session_start');
    analytics.sending = false;
    analytics.track('run_end');
    analytics.flush();
    await settle();
    expect(sink.sent).toHaveLength(0);
    analytics.sending = true;
    analytics.track('respec');
    analytics.flush();
    await settle();
    expect(sink.sent[0]?.batch.events.map((e) => e.type)).toEqual(['respec']);
  });

  it('logs every event locally, sent or not, and keeps the log across pages', () => {
    const { store, options, analytics } = setup({ sink: null });
    analytics.track('session_start', { runs: 0 });
    analytics.flush();
    const exported = JSON.parse(analytics.exportLocal()) as {
      installId: string;
      events: unknown[];
    };
    expect(exported.installId).toBe('id-1');
    expect(exported.events).toEqual([{ type: 'session_start', t: 0, runs: 0 }]);
    const next = new PlaytestAnalytics(options);
    next.track('run_end');
    next.flush();
    expect(JSON.parse(store.getItem(LOG_KEY) ?? '[]')).toHaveLength(2);
  });

  it('caps the local log, dropping the oldest events', () => {
    const { store, analytics } = setup({ sink: null });
    for (let i = 0; i < LOG_LIMIT + 3; i++) analytics.track('e', { i });
    analytics.flush();
    const log = JSON.parse(store.getItem(LOG_KEY) ?? '[]') as { i: number }[];
    expect(log).toHaveLength(LOG_LIMIT);
    expect(log[0]?.i).toBe(3);
  });

  it('survives storage that throws', () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const { analytics } = setup({ store: broken });
    analytics.track('session_start');
    expect(() => analytics.flush()).not.toThrow();
    expect(analytics.sending).toBe(true);
  });
});

describe('Firestore encoding', () => {
  it('encodes JSON-like values in the REST format', () => {
    expect(toFirestoreValue(null)).toEqual({ nullValue: null });
    expect(toFirestoreValue(true)).toEqual({ booleanValue: true });
    expect(toFirestoreValue(42)).toEqual({ integerValue: '42' });
    expect(toFirestoreValue(1.5)).toEqual({ doubleValue: 1.5 });
    expect(toFirestoreValue(1e300)).toEqual({ doubleValue: 1e300 });
    expect(toFirestoreValue(Infinity)).toEqual({ nullValue: null });
    expect(toFirestoreValue('x')).toEqual({ stringValue: 'x' });
    expect(toFirestoreValue(['a', 1])).toEqual({
      arrayValue: { values: [{ stringValue: 'a' }, { integerValue: '1' }] },
    });
    expect(toFirestoreValue({ crit: 3 })).toEqual({
      mapValue: { fields: { crit: { integerValue: '3' } } },
    });
  });

  it('makes sentAt a timestamp and the events an array of maps', () => {
    const doc = batchDocument({
      v: 1,
      installId: 'i',
      sessionId: 's',
      seq: 2,
      build: 'b',
      locale: 'zh-TW',
      sentAt: '2026-10-14T12:00:00.000Z',
      events: [{ type: 'respec', t: 1.5 }],
    });
    expect(Object.keys(doc.fields).sort()).toEqual(
      ['build', 'events', 'installId', 'locale', 'sentAt', 'seq', 'sessionId', 'v'].sort(),
    );
    expect(doc.fields['sentAt']).toEqual({ timestampValue: '2026-10-14T12:00:00.000Z' });
    expect(doc.fields['seq']).toEqual({ integerValue: '2' });
    expect(doc.fields['events']).toEqual({
      arrayValue: {
        values: [
          {
            mapValue: {
              fields: { type: { stringValue: 'respec' }, t: { doubleValue: 1.5 } },
            },
          },
        ],
      },
    });
  });
});

describe('FirestoreSink', () => {
  const batch: EventBatch = {
    v: 1,
    installId: 'i',
    sessionId: 'abc',
    seq: 3,
    build: 'b',
    locale: 'en',
    sentAt: '2026-10-14T12:00:00.000Z',
    events: [],
  };

  it('creates one document per batch, named by session and sequence', async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const sink = new FirestoreSink({ projectId: 'proj', apiKey: 'key 1' }, (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({ ok: true });
    });
    expect(await sink.send(batch, true)).toBe(true);
    expect(calls[0]?.url).toBe(
      'https://firestore.googleapis.com/v1/projects/proj/databases/(default)/documents/' +
        'playtest?documentId=abc-3&key=key%201',
    );
    expect(calls[0]?.init).toMatchObject({ method: 'POST', keepalive: true });
    expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual(batchDocument(batch));
  });

  it('reports failures instead of throwing', async () => {
    const refused = new FirestoreSink({ projectId: 'p', apiKey: 'k' }, () =>
      Promise.resolve({ ok: false }),
    );
    expect(await refused.send(batch, false)).toBe(false);
    const offline = new FirestoreSink({ projectId: 'p', apiKey: 'k' }, () =>
      Promise.reject(new TypeError('Failed to fetch')),
    );
    expect(await offline.send(batch, false)).toBe(false);
  });
});
