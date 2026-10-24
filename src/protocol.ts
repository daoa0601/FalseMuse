import { isRecord, parseJson } from "./json.ts";
import { quotaHeaders, type Quota } from "./usage.ts";

/** WebSocket messages between the Master and a node daemon. */

/** Parts of an owner transcript upload; R2 multipart parts are at most this size here. */
export const UPLOAD_PART_BYTES = 10 * 1024 * 1024;

export const REPORT_STATUSES = ["done", "failed", "aborted"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const isReportStatus = (value: unknown): value is ReportStatus =>
  REPORT_STATUSES.some((status) => status === value);

export interface Job {
  id: string;
  machine: string;
  cwd: string;
  task: string;
  view: string;
  status: string;
  report: string | null;
}

export type SpawnCommand = Job & { type: "spawn"; resume?: boolean };

export type CloudMessage =
  | { type: "registered"; name: string }
  | { type: "ready"; jobs: number }
  | SpawnCommand
  | { type: "tell" | "abort"; id: string; message?: string }
  | { type: "permission"; job: string; id: string; allowed: boolean }
  | { type: "permission_pending"; job: string; id: string }
  | { type: "ack"; id: string }
  | { type: "error"; error: string };

export interface PermissionRequest {
  type: "permission_request";
  job: string;
  id: string;
  title: string;
  message: string;
}

export interface ModelCallEvent {
  type: "model_call";
  id: string;
  job: string;
  date: string;
  model: string;
  usage: unknown;
  quota: Quota;
}

export interface ReportMessage {
  type: "report";
  id: string;
  report: string;
  status: ReportStatus;
}

export type NodeMessage =
  | { type: "node_ready" }
  | { type: "resume_job"; id: string; job: string }
  | PermissionRequest
  | { type: "permission_received"; job: string; id: string }
  | ModelCallEvent
  | ReportMessage;

const DELIVERY_ID = /^[\w-]{1,80}$/;

function job(value: Record<string, unknown>): Job {
  const report = value["report"];
  return {
    id: text(value, "id"),
    machine: text(value, "machine"),
    cwd: text(value, "cwd"),
    task: text(value, "task"),
    view: text(value, "view"),
    status: text(value, "status"),
    report: typeof report === "string" ? report : null,
  };
}

/** Parse a message from the Master; unknown types return null so older daemons ignore them. */
export function parseCloudMessage(raw: string): CloudMessage | null {
  const value = parseJson(raw);
  if (!isRecord(value)) throw new Error("A cloud message must be an object");
  switch (value["type"]) {
    case "registered":
      return { type: "registered", name: text(value, "name") };
    case "ready":
      return { type: "ready", jobs: Number(value["jobs"]) };
    case "spawn":
      return {
        ...job(value),
        type: "spawn",
        ...(value["resume"] === true ? { resume: true } : {}),
      };
    case "tell":
    case "abort": {
      const message = value["message"];
      return {
        type: value["type"],
        id: text(value, "id"),
        ...(typeof message === "string" ? { message } : {}),
      };
    }
    case "permission":
      return {
        type: "permission",
        job: text(value, "job"),
        id: text(value, "id"),
        allowed: value["allowed"] === true,
      };
    case "permission_pending":
      return { type: "permission_pending", job: text(value, "job"), id: text(value, "id") };
    case "ack":
      return { type: "ack", id: text(value, "id") };
    case "error":
      return { type: "error", error: text(value, "error") };
    default:
      return null;
  }
}

function text(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string") throw new Error(`The node message needs ${field}`);
  return result;
}

function deliveryId(value: Record<string, unknown>, field: string): string {
  const result = text(value, field);
  if (!DELIVERY_ID.test(result)) throw new Error(`Invalid ${field} in the node message`);
  return result;
}

export function parseNodeMessage(raw: string): NodeMessage {
  const value = parseJson(raw);
  if (!isRecord(value)) throw new Error("A node message must be an object");
  switch (value["type"]) {
    case "node_ready":
      return { type: "node_ready" };
    case "resume_job":
      return { type: "resume_job", id: deliveryId(value, "id"), job: text(value, "job") };
    case "permission_request": {
      const title = text(value, "title");
      const message = text(value, "message");
      if (title.length > 100 || new TextEncoder().encode(message).length > 128_000) {
        throw new Error("Invalid tool review");
      }
      return {
        type: "permission_request",
        job: text(value, "job"),
        id: deliveryId(value, "id"),
        title,
        message,
      };
    }
    case "permission_received":
      return { type: "permission_received", job: text(value, "job"), id: text(value, "id") };
    case "model_call":
      return {
        type: "model_call",
        id: deliveryId(value, "id"),
        job: text(value, "job"),
        date: text(value, "date"),
        model: text(value, "model"),
        usage: value["usage"],
        quota: quotaHeaders(value["quota"]),
      };
    case "report": {
      const status = value["status"];
      if (!isReportStatus(status)) throw new Error("Invalid Pi report");
      return { type: "report", id: text(value, "id"), report: text(value, "report"), status };
    }
    default:
      throw new Error("Unknown node message");
  }
}
