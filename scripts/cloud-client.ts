import { existsSync, readFileSync } from "node:fs";
import { isRecord } from "../src/json.ts";

export interface CloudClient {
  url: string;
  /** An owner API request; the response is untrusted JSON for the caller to check. */
  request(path: string, body?: unknown, method?: string): Promise<Record<string, unknown>>;
  uploadPart(path: string, body: Buffer): Promise<Record<string, unknown>>;
  /** An owner GET whose raw response the caller reads. */
  get(path: string): Promise<Response>;
}

function readJson(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value)) throw new Error(`${path} must contain a JSON object`);
  return value;
}

async function result(response: Response, failure: string): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  const body = isRecord(value) ? value : { value };
  if (!response.ok) {
    throw new Error(
      typeof body["error"] === "string" ? body["error"] : `${failure} (${response.status})`,
    );
  }
  return body;
}

/** Cloudflare Access's service token for the Worker, from data/access-token.json if present. */
function accessHeaders(): Record<string, string> {
  if (!existsSync("data/access-token.json")) return {};
  const { client_id: id, client_secret: secret } = readJson("data/access-token.json");
  if (typeof id !== "string" || typeof secret !== "string") {
    throw new Error("data/access-token.json needs client_id and client_secret");
  }
  return { "cf-access-client-id": id, "cf-access-client-secret": secret };
}

/** The owner's client for the deployed Master, configured from the private data directory. */
export function cloudClient(): CloudClient {
  const { url } = readJson("data/cloud.json");
  const { OWNER_KEY: ownerKey } = readJson("data/owner-secrets.json");
  if (typeof url !== "string" || typeof ownerKey !== "string") {
    throw new Error("data/cloud.json needs url and data/owner-secrets.json needs OWNER_KEY");
  }
  const owner = { ...accessHeaders(), authorization: `Bearer ${ownerKey}` };
  return {
    url,
    get: (path) => fetch(url + path, { headers: owner, redirect: "manual" }),
    async request(path, body, method = body === undefined ? "GET" : "POST") {
      const response = await fetch(url + path, {
        method,
        headers: { ...owner, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return result(response, "Request failed");
    },
    async uploadPart(path, body) {
      const response = await fetch(url + path, {
        method: "PUT",
        headers: {
          ...owner,
          "content-type": "application/octet-stream",
          "content-length": String(body.length),
        },
        body,
      });
      return result(response, "Transcript part failed");
    },
  };
}
