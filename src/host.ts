import type { SqlDatabase } from "./database.ts";
import type { ModelResult, RelayedRequest } from "./codex.ts";

/**
 * What the Master needs from the machine it runs on. A Durable Object provides it in
 * `src/worker.ts` and the laptop in `node/master.ts`; nothing else in `src/` names a platform.
 */
export interface MasterHost {
  sql: SqlDatabase;
  /** Small values the Master keeps outside its tables: instructions, logins, the last error. */
  storage: Settings;
  /** Transcripts, images and the task audit. */
  bucket: Bucket;
  /** Connected nodes, tagged with their machine names. */
  sockets: { getWebSockets(machine?: string): NodeSocket[] };
  /** Keep work running after the request or alarm that started it returns. */
  waitUntil(work: Promise<unknown>): void;
  config: MasterConfig;
  /**
   * Call the model with the machine's own subscription login. Without it the Master calls through
   * a node that serves models, else with the device login it keeps in storage.
   */
  callModel?: (request: RelayedRequest & { signal: AbortSignal }) => Promise<ModelResult>;
  /** Run a Code Mode script whose only outside access is `invoke`. */
  runCode?: (code: string, invoke: CodeInvoke) => Promise<unknown>;
  sandbox?: SandboxControl;
}

export interface MasterConfig {
  masterModel: string;
  compactorModel: string;
  compactorEffort: string;
  /** The owner's IANA time zone, for the time each turn carries. */
  timezone: string;
}

export type CodeInvoke = (name: string, input: unknown, step: number) => Promise<unknown>;

export interface Settings {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
  /** The one pending wake-up, as a Unix time in milliseconds. */
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}

/** A node's connection; it carries the machine name and model flag it announced. */
export interface NodeSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export type BucketValue = ReadableStream | ArrayBuffer | ArrayBufferView | string;

export interface StoredObject {
  readonly size: number;
}

export interface StoredBody extends StoredObject {
  readonly body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface MultipartUpload {
  readonly uploadId: string;
  uploadPart(number: number, value: BucketValue): Promise<UploadedPart>;
  abort(): Promise<void>;
  complete(parts: UploadedPart[]): Promise<StoredObject>;
}

/** The part of R2 the Master uses. */
export interface Bucket {
  head(key: string): Promise<StoredObject | null>;
  get(key: string): Promise<StoredBody | null>;
  put(
    key: string,
    value: BucketValue | null,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  createMultipartUpload(key: string): Promise<MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload;
}

/** The node configuration written into the Sandbox container for its daemon. */
export interface SandboxNodeConfig {
  name: string;
  key: string;
  roots: string[];
  tools: string[];
  url: string;
  directory: string;
  subscription: "cloud";
}

/** The cloud Sandbox, which only a Durable Object host has. */
export interface SandboxControl {
  status(): Promise<unknown>;
  start(config: SandboxNodeConfig): Promise<unknown>;
  save(): Promise<unknown>;
  startLogin(): Promise<unknown>;
  credential(): Promise<unknown>;
}
