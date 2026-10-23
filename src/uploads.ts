import type { SqlDatabase } from "./database.ts";
import type { Bucket, StoredObject, UploadedPart } from "./host.ts";

export type UploadState =
  { complete: true; size: number } | { complete: false; parts: number; accepted: number[] };

interface Upload {
  session: string;
  upload_id: string;
  parts: number;
}

export function transcriptKey(session: unknown): string {
  if (typeof session !== "string" || !/^[\w./-]+$/.test(session) || session.includes("..")) {
    throw new Error("Use a valid transcript session");
  }
  return `sessions/${session}.jsonl`;
}

// The owner uploads prepared, immutable transcripts. The bucket holds the bytes; SQLite
// remembers accepted parts so a restarted client does not repeat completed work.
export class TranscriptUploads {
  private readonly database: SqlDatabase;
  private readonly bucket: Bucket;

  constructor(database: SqlDatabase, bucket: Bucket) {
    this.database = database;
    this.bucket = bucket;
    database.exec(
      "CREATE TABLE IF NOT EXISTS transcript_uploads (session TEXT PRIMARY KEY, upload_id TEXT NOT NULL, parts INTEGER NOT NULL)",
    );
    database.exec(
      "CREATE TABLE IF NOT EXISTS transcript_parts (session TEXT, number INTEGER, etag TEXT NOT NULL, PRIMARY KEY(session, number))",
    );
  }

  async start(session: string, parts: unknown): Promise<UploadState> {
    if (typeof parts !== "number" || !Number.isSafeInteger(parts) || parts < 1 || parts > 10_000) {
      throw new Error("Choose 1–10000 transcript parts");
    }
    const object = await this.bucket.head(transcriptKey(session));
    if (object) return { complete: true, size: object.size };
    let upload = this.find(session);
    if (!upload) {
      const created = await this.bucket.createMultipartUpload(transcriptKey(session));
      this.database.exec(
        "INSERT OR IGNORE INTO transcript_uploads VALUES (?, ?, ?)",
        session,
        created.uploadId,
        parts,
      );
      upload = this.upload(session);
      if (upload.upload_id !== created.uploadId) await created.abort();
    }
    if (upload.parts !== parts) {
      throw new Error(
        "The prepared transcript's part count changed; resume with the original export",
      );
    }
    const accepted = this.database
      .rows<{ number: number }>(
        "SELECT number FROM transcript_parts WHERE session=? ORDER BY number",
        session,
      )
      .map((part) => part.number);
    return { complete: false, parts: upload.parts, accepted };
  }

  async put(session: string, number: number, body: ReadableStream | null) {
    const upload = this.upload(session);
    if (!Number.isSafeInteger(number) || number < 1 || number > upload.parts || !body) {
      throw new Error("Send an existing transcript part and its body");
    }
    const [accepted] = this.database.rows(
      "SELECT number FROM transcript_parts WHERE session=? AND number=?",
      session,
      number,
    );
    if (accepted) return { accepted: number };
    const part = await this.bucket
      .resumeMultipartUpload(transcriptKey(session), upload.upload_id)
      .uploadPart(number, body);
    this.database.exec(
      "INSERT OR REPLACE INTO transcript_parts VALUES (?, ?, ?)",
      session,
      number,
      part.etag,
    );
    return { accepted: number };
  }

  async finish(session: string): Promise<UploadState> {
    const key = transcriptKey(session);
    let object: StoredObject | null = await this.bucket.head(key);
    if (!object) {
      const upload = this.upload(session);
      const parts = this.database.rows<UploadedPart>(
        "SELECT number AS partNumber, etag FROM transcript_parts WHERE session=? ORDER BY number",
        session,
      );
      if (parts.length !== upload.parts) {
        throw new Error(
          `Transcript has ${parts.length} of ${upload.parts} accepted parts; upload the remaining parts`,
        );
      }
      object = await this.bucket.resumeMultipartUpload(key, upload.upload_id).complete(parts);
    }
    this.database.transaction(() => {
      this.database.exec("DELETE FROM transcript_parts WHERE session=?", session);
      this.database.exec("DELETE FROM transcript_uploads WHERE session=?", session);
    });
    return { complete: true, size: object.size };
  }

  private find(session: string): Upload | undefined {
    transcriptKey(session);
    return this.database.rows<Upload>(
      "SELECT * FROM transcript_uploads WHERE session=?",
      session,
    )[0];
  }

  private upload(session: string): Upload {
    const upload = this.find(session);
    if (!upload) throw new Error("Start the transcript upload first");
    return upload;
  }
}
