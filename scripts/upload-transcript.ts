import { open } from "node:fs/promises";
import { UPLOAD_PART_BYTES } from "../src/protocol.ts";
import type { CloudClient } from "./cloud-client.ts";

export interface UploadProgress {
  session: string;
  part: number;
  parts: number;
}

// Only immutable Phase 1 exports belong here. A session key names that prepared
// snapshot, and accepted parts remain available when the uploader is restarted.
export async function uploadTranscript(
  client: CloudClient,
  path: string,
  session: string,
  onProgress: (progress: UploadProgress) => void = () => {},
) {
  const file = await open(path, "r");
  const route = `/api/transcript-upload?session=${encodeURIComponent(session)}`;
  try {
    const { size } = await file.stat();
    if (size < 1) throw new Error(`The prepared transcript is empty: ${path}`);
    const parts = Math.ceil(size / UPLOAD_PART_BYTES);
    const state = await client.request(`${route}&action=start`, { parts });
    if (state["complete"] === true) return state;
    const accepted = new Set(Array.isArray(state["accepted"]) ? state["accepted"] : []);
    for (let number = 1; number <= parts; number++) {
      if (accepted.has(number)) continue;
      const offset = (number - 1) * UPLOAD_PART_BYTES;
      const body = Buffer.alloc(Math.min(UPLOAD_PART_BYTES, size - offset));
      let read = 0;
      while (read < body.length) {
        const result = await file.read(body, read, body.length - read, offset + read);
        if (!result.bytesRead)
          throw new Error(`The prepared transcript ended during part ${number}: ${path}`);
        read += result.bytesRead;
      }
      await client.uploadPart(`${route}&action=part&number=${number}`, body);
      onProgress({ session, part: number, parts });
    }
    return await client.request(`${route}&action=finish`, {});
  } finally {
    await file.close();
  }
}
