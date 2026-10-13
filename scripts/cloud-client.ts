import { readFileSync } from "node:fs";
import { isRecord } from "../src/json.ts";

export interface CloudClient {
  url: string;
  /** An owner API request; the response is untrusted JSON for the caller to check. */
  request(path: string, body?: unknown, method?: string): Promise<Record<string, unknown>>;
  uploadPart(path: string, body: Buffer): Promise<Record<string, unknown>>;
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

/** The owner's client for the deployed Master, configured from the private data directory. */
export function cloudClient(): CloudClient {
  const { url } = readJson("data/cloud.json");
  const { OWNER_KEY: ownerKey } = readJson("data/owner-secrets.json");
  if (typeof url !== "string" || typeof ownerKey !== "string") {
    throw new Error("data/cloud.json needs url and data/owner-secrets.json needs OWNER_KEY");
  }
  return {
    url,
    async request(path, body, method = body === undefined ? "GET" : "POST") {
      const response = await fetch(url + path, {
        method,
        headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return result(response, "Request failed");
    },
    async uploadPart(path, body) {
      const response = await fetch(url + path, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${ownerKey}`,
          "content-type": "application/octet-stream",
          "content-length": String(body.length),
        },
        body,
      });
      return result(response, "Transcript part failed");
    },
  };
}
