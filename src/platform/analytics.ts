/**
 * Anonymous playtest events (docs/ARCHITECTURE.md §9). Every event goes to a local log, the
 * export fallback; while sending is on, events are also batched to a sink, Firestore on the
 * web build. Nothing personal is recorded: an install id (a random UUID kept in local
 * storage), a per-page session id, and what happened in the game.
 */

export type EventValue =
  string | number | boolean | null | readonly EventValue[] | { readonly [key: string]: EventValue };

export type EventFields = Readonly<Record<string, EventValue>>;

export interface PlaytestEvent {
  readonly type: string;
  /** Seconds since this page session started, to 0.1 s. */
  readonly t: number;
  readonly [field: string]: EventValue;
}

/** One stored document: a slice of one session's events. */
export interface EventBatch {
  readonly v: 1;
  readonly installId: string;
  readonly sessionId: string;
  /** 1, 2, … within the session; with sessionId it names the document. */
  readonly seq: number;
  readonly build: string;
  readonly locale: string;
  /** ISO 8601. */
  readonly sentAt: string;
  readonly events: readonly PlaytestEvent[];
}

export interface EventSink {
  /**
   * Stores a batch; resolves false on any failure instead of rejecting. `keepalive` asks the
   * request to outlive the page (pagehide).
   */
  send(batch: EventBatch, keepalive: boolean): Promise<boolean>;
}

export interface Analytics {
  readonly installId: string;
  /** Whether a sink is configured at all; without one, events are only logged locally. */
  readonly canSend: boolean;
  /** Whether events go to the sink. The player's choice is remembered. */
  sending: boolean;
  track(type: string, fields?: EventFields): void;
  /** Sends what is pending and saves the local log. */
  flush(keepalive?: boolean): void;
  /** The local log as JSON, for the "export playtest data" fallback. */
  exportLocal(): string;
}

/** The slice of Web Storage this module uses. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const INSTALL_ID_KEY = 'bc-incremental.installId';
export const SENDING_KEY = 'bc-incremental.analytics.sending';
export const LOG_KEY = 'bc-incremental.analytics.log';

/** Events kept in the local log; the oldest go first. */
export const LOG_LIMIT = 3000;
/** Events per stored document (the Firestore rules allow 200). */
export const BATCH_LIMIT = 200;
/**
 * Events per document sent while the page closes: keepalive requests share a 64 KiB body
 * budget, and an encoded event is a few hundred bytes.
 */
export const KEEPALIVE_BATCH_LIMIT = 40;
/** Unsent events kept for a later flush when the sink keeps failing; the oldest go first. */
export const PENDING_LIMIT = 1000;

export interface PlaytestAnalyticsOptions {
  readonly store: KeyValueStore;
  readonly sink: EventSink | null;
  /** Milliseconds, monotonic (performance.now). */
  readonly clock: () => number;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly build: string;
  readonly locale: string;
  /** Sending before the player chooses (docs/ARCHITECTURE.md §9: on for the web playtest). */
  readonly defaultSending: boolean;
}

function safeGet(store: KeyValueStore, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(store: KeyValueStore, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    // Private mode or a full quota: the log is a fallback, the game goes on without it.
  }
}

function readLog(store: KeyValueStore): PlaytestEvent[] {
  const text = safeGet(store, LOG_KEY);
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as PlaytestEvent[]) : [];
  } catch {
    return [];
  }
}

export class PlaytestAnalytics implements Analytics {
  readonly installId: string;
  readonly sessionId: string;
  private readonly startMs: number;
  private sendingValue: boolean;
  private seq = 0;
  private pending: PlaytestEvent[] = [];
  private readonly log: PlaytestEvent[];

  constructor(private readonly options: PlaytestAnalyticsOptions) {
    const { store } = options;
    let installId = safeGet(store, INSTALL_ID_KEY);
    if (installId === null || installId === '') {
      installId = options.newId();
      safeSet(store, INSTALL_ID_KEY, installId);
    }
    this.installId = installId;
    this.sessionId = options.newId();
    this.startMs = options.clock();
    const choice = safeGet(store, SENDING_KEY);
    this.sendingValue = choice === null ? options.defaultSending : choice === '1';
    this.log = readLog(store);
  }

  get canSend(): boolean {
    return this.options.sink !== null;
  }

  get sending(): boolean {
    return this.canSend && this.sendingValue;
  }

  set sending(on: boolean) {
    this.sendingValue = on;
    safeSet(this.options.store, SENDING_KEY, on ? '1' : '0');
    if (!on) this.pending = [];
  }

  track(type: string, fields: EventFields = {}): void {
    const t = Math.round((this.options.clock() - this.startMs) / 100) / 10;
    const event: PlaytestEvent = { ...fields, type, t };
    this.log.push(event);
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    if (this.sending) {
      this.pending.push(event);
      if (this.pending.length > PENDING_LIMIT) {
        this.pending.splice(0, this.pending.length - PENDING_LIMIT);
      }
    }
  }

  flush(keepalive = false): void {
    safeSet(this.options.store, LOG_KEY, JSON.stringify(this.log));
    const sink = this.options.sink;
    if (sink === null || !this.sending) return;
    const limit = keepalive ? KEEPALIVE_BATCH_LIMIT : BATCH_LIMIT;
    // A closing page gets one small request; the rest waits in the local log.
    const batches = keepalive ? 1 : Math.ceil(this.pending.length / limit);
    for (let i = 0; i < batches && this.pending.length > 0; i++) {
      const events = this.pending.splice(0, limit);
      this.seq++;
      const batch: EventBatch = {
        v: 1,
        installId: this.installId,
        sessionId: this.sessionId,
        seq: this.seq,
        build: this.options.build,
        locale: this.options.locale,
        sentAt: this.options.now().toISOString(),
        events,
      };
      void sink.send(batch, keepalive).then((ok) => {
        // Put a failed batch back for the next flush, unless sending was turned off since.
        if (!ok && this.sending) {
          this.pending.unshift(...events);
          if (this.pending.length > PENDING_LIMIT) this.pending.length = PENDING_LIMIT;
        }
      });
    }
  }

  exportLocal(): string {
    return JSON.stringify(
      { installId: this.installId, build: this.options.build, events: this.log },
      null,
      1,
    );
  }
}

// ---- Firestore (REST, no SDK) ----

export interface FirestoreConfig {
  readonly projectId: string;
  readonly apiKey: string;
}

type FirestoreValue =
  | { readonly nullValue: null }
  | { readonly booleanValue: boolean }
  | { readonly integerValue: string }
  | { readonly doubleValue: number }
  | { readonly stringValue: string }
  | { readonly timestampValue: string }
  | { readonly arrayValue: { readonly values: readonly FirestoreValue[] } }
  | { readonly mapValue: { readonly fields: Readonly<Record<string, FirestoreValue>> } };

/** A JSON-like value in Firestore's REST encoding; non-finite numbers become null. */
export function toFirestoreValue(value: EventValue): FirestoreValue {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { nullValue: null };
    return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: (value as readonly EventValue[]).map(toFirestoreValue) } };
  }
  return { mapValue: { fields: toFirestoreFields(value as EventFields) } };
}

function toFirestoreFields(fields: EventFields): Record<string, FirestoreValue> {
  const out: Record<string, FirestoreValue> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = toFirestoreValue(value);
  return out;
}

/** The document body for a batch; sentAt is a Firestore timestamp. */
export function batchDocument(batch: EventBatch): {
  fields: Record<string, FirestoreValue>;
} {
  const { sentAt, events, ...rest } = batch;
  return {
    fields: {
      ...toFirestoreFields(rest),
      sentAt: { timestampValue: sentAt },
      events: toFirestoreValue(events as readonly EventValue[]),
    },
  };
}

/** Collection the Firestore rules (firestore.rules) open for create only. */
export const PLAYTEST_COLLECTION = 'playtest';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; keepalive: boolean },
) => Promise<{ ok: boolean }>;

/** Creates one document per batch through the Firestore REST API, with the web API key. */
export class FirestoreSink implements EventSink {
  constructor(
    private readonly config: FirestoreConfig,
    private readonly fetchFn: FetchLike,
  ) {}

  url(batch: EventBatch): string {
    const project = encodeURIComponent(this.config.projectId);
    const id = encodeURIComponent(`${batch.sessionId}-${batch.seq}`);
    const key = encodeURIComponent(this.config.apiKey);
    return (
      `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/` +
      `${PLAYTEST_COLLECTION}?documentId=${id}&key=${key}`
    );
  }

  async send(batch: EventBatch, keepalive: boolean): Promise<boolean> {
    try {
      const response = await this.fetchFn(this.url(batch), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batchDocument(batch)),
        keepalive,
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
