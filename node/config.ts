import { readFileSync } from "node:fs";
import { isRecord } from "../src/json.ts";

/** A registered node's local configuration, written by scripts/register-node.ts. */
export interface NodeConfig {
  name: string;
  key: string;
  url: string;
  roots: string[];
  tools: string[];
  directory?: string;
  subscription?: "cloud";
  /** Path of this file, which Sandbox Pi extensions read for the subscription broker. */
  subscriptionConfig?: string;
  ingest?: { baseline?: string };
  /** Serve the Master's model calls with this machine's subscription login. */
  models?: true;
}

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;

export function readNodeConfig(path: string): NodeConfig {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value)) throw new Error(`${path} is not a node configuration`);
  const { name, key, url, directory, subscription, ingest, models } = value;
  const roots = strings(value["roots"]);
  const tools = strings(value["tools"] ?? ["read"]);
  if (
    typeof name !== "string" ||
    typeof key !== "string" ||
    typeof url !== "string" ||
    !roots ||
    !tools
  ) {
    throw new Error(`${path} needs the node name, key, url, roots, and tools`);
  }
  const baseline = isRecord(ingest) ? ingest["baseline"] : undefined;
  return {
    name,
    key,
    url,
    roots,
    tools,
    ...(typeof directory === "string" ? { directory } : {}),
    ...(subscription === "cloud" ? { subscription, subscriptionConfig: path } : {}),
    ...(isRecord(ingest) ? { ingest: typeof baseline === "string" ? { baseline } : {} } : {}),
    ...(models === true ? { models } : {}),
  };
}
