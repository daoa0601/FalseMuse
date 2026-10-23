import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import type {
  Bucket,
  BucketValue,
  MultipartUpload,
  StoredBody,
  StoredObject,
  UploadedPart,
} from "../src/host.ts";

/** Write a value to a temporary file beside `path`, then rename it into place. */
async function save(path: string, value: BucketValue | null): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.part`;
  try {
    if (value === null || typeof value === "string" || !("getReader" in value)) {
      const bytes =
        value === null
          ? new Uint8Array()
          : typeof value === "string"
            ? new TextEncoder().encode(value)
            : value instanceof ArrayBuffer
              ? new Uint8Array(value)
              : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      await writeFile(temporary, bytes, { flush: true });
    } else {
      await value.pipeTo(Writable.toWeb(createWriteStream(temporary, { flush: true })));
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return (await stat(path)).size;
}

async function size(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The Master's bucket as files under one directory, keyed like R2. A multipart upload keeps its
 * parts in `.uploads/<id>/` until it completes into one file.
 */
export class DirectoryBucket implements Bucket {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const path = resolve(this.root, key);
    if (!key || key.startsWith(".") || !path.startsWith(this.root + sep)) {
      throw new Error(`Not a bucket key: ${key}`);
    }
    return path;
  }

  async head(key: string): Promise<StoredObject | null> {
    const bytes = await size(this.path(key));
    return bytes === null ? null : { size: bytes };
  }

  async get(key: string): Promise<StoredBody | null> {
    const path = this.path(key);
    const bytes = await size(path);
    if (bytes === null) return null;
    let body: ReadableStream<Uint8Array> | undefined;
    return {
      size: bytes,
      get body() {
        // Node streams yield Buffers, which are Uint8Arrays.
        body ??= Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
        return body;
      },
      async arrayBuffer() {
        const data = await readFile(path);
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      },
    };
  }

  async put(key: string, value: BucketValue | null): Promise<StoredObject> {
    return { size: await save(this.path(key), value) };
  }

  async createMultipartUpload(key: string): Promise<MultipartUpload> {
    const upload = this.resumeMultipartUpload(key, randomUUID());
    await mkdir(join(this.root, ".uploads", upload.uploadId), { recursive: true });
    return upload;
  }

  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload {
    const target = this.path(key);
    if (!/^[\w-]+$/.test(uploadId)) throw new Error("Not an upload id");
    const parts = join(this.root, ".uploads", uploadId);
    const part = (number: number) => join(parts, String(number));
    return {
      uploadId,
      async uploadPart(number: number, value: BucketValue): Promise<UploadedPart> {
        if (!Number.isSafeInteger(number) || number < 1) throw new Error("Not a part number");
        const directory = await stat(parts).catch(() => null);
        if (!directory?.isDirectory()) throw new Error("No such upload");
        await save(part(number), value);
        return { partNumber: number, etag: String(number) };
      },
      async abort() {
        await rm(parts, { recursive: true, force: true });
      },
      async complete(uploaded: UploadedPart[]): Promise<StoredObject> {
        const present = new Set(await readdir(parts));
        const ordered = [...uploaded].sort((a, b) => a.partNumber - b.partNumber);
        if (ordered.some((item) => !present.has(String(item.partNumber)))) {
          throw new Error("A completed upload names a part that was never uploaded");
        }
        const files = ordered.map((item) => part(item.partNumber));
        const joined = Readable.toWeb(
          Readable.from(
            (async function* () {
              for (const file of files) yield* createReadStream(file);
            })(),
          ),
        ) as ReadableStream<Uint8Array>;
        const bytes = await save(target, joined);
        await rm(parts, { recursive: true, force: true });
        return { size: bytes };
      },
    };
  }
}
