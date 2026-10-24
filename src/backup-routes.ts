import { errorMessage, isRecord } from "./json.ts";
import { BACKUP_PART_BYTES, SNAPSHOT_PREFIX } from "./backup-protocol.ts";

const json = (value: unknown, status = 200): Response => Response.json(value, { status });

function key(query: URLSearchParams): string {
  const value = query.get("key") ?? "";
  if (
    !value ||
    value.length > 1024 ||
    value.startsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Name an object key of relative path segments");
  }
  return value;
}

function length(request: Request): number {
  const size = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(size) || size < 0 || size > BACKUP_PART_BYTES || !request.body) {
    throw new Error("Send a body of at most 32 MiB with Content-Length");
  }
  return size;
}

/**
 * The local Master's backup of its database snapshots and bucket into R2. The Worker has already
 * authenticated the owner.
 */
export async function backupRoute(request: Request, bucket: R2Bucket): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams;
  try {
    switch (`${request.method} ${url.pathname}`) {
      case "GET /backup/list": {
        const cursor = query.get("cursor");
        const listed = await bucket.list({
          limit: 1000,
          prefix: query.get("prefix") ?? "",
          ...(cursor ? { cursor } : {}),
        });
        return json({
          objects: listed.objects.map(({ key: name, size }) => ({ key: name, size })),
          cursor: listed.truncated ? listed.cursor : null,
        });
      }
      case "PUT /backup/object": {
        const name = key(query);
        length(request);
        const stored = await bucket.put(name, request.body);
        return json({ key: name, size: stored?.size ?? 0 });
      }
      case "DELETE /backup/object": {
        const name = key(query);
        if (!name.startsWith(SNAPSHOT_PREFIX)) throw new Error("Only snapshots can be deleted");
        await bucket.delete(name);
        return json({ deleted: name });
      }
      case "POST /backup/multipart": {
        const upload = await bucket.createMultipartUpload(key(query));
        return json({ upload: upload.uploadId });
      }
      case "PUT /backup/part": {
        const upload = bucket.resumeMultipartUpload(key(query), query.get("upload") ?? "");
        const number = Number(query.get("number"));
        if (!Number.isSafeInteger(number) || number < 1 || number > 10_000) {
          throw new Error("Number parts from 1 to 10,000");
        }
        length(request);
        const part = await upload.uploadPart(number, request.body ?? new Uint8Array());
        return json(part);
      }
      case "POST /backup/complete": {
        const upload = bucket.resumeMultipartUpload(key(query), query.get("upload") ?? "");
        const input: unknown = await request.json();
        const parts = isRecord(input) && Array.isArray(input["parts"]) ? input["parts"] : [];
        const stored = await upload.complete(
          parts.map((part: unknown) => {
            if (
              !isRecord(part) ||
              typeof part["partNumber"] !== "number" ||
              typeof part["etag"] !== "string"
            ) {
              throw new Error("Each part needs its partNumber and etag");
            }
            return { partNumber: part["partNumber"], etag: part["etag"] };
          }),
        );
        return json({ key: stored.key, size: stored.size });
      }
      default:
        return json({ error: "No such backup route" }, 404);
    }
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }
}
