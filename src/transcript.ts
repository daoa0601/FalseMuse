import { cap } from "./tools.ts";
import type { Bucket } from "./host.ts";

/** Read source lines [start, start+count) of a stored transcript, bounding each line while streaming. */
export async function readTranscript(
  bucket: Bucket,
  session: string,
  start: number,
  count: number,
): Promise<string> {
  if (
    !Number.isSafeInteger(start) ||
    start < 1 ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 100
  ) {
    throw new Error("Choose a positive start line and 1–100 lines");
  }
  const object = await bucket.get(`sessions/${session}.jsonl`);
  if (!object) throw new Error(`No transcript for ${session}`);
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let number = 1;
  let head = "";
  let tail = "";
  let length = 0;
  let done = false;
  const half = 15_000;

  function fragment(text: string): void {
    length += text.length;
    head += text.slice(0, Math.max(0, half - head.length));
    tail = (tail + text).slice(-half);
  }

  function finishLine(): void {
    const original = head.match(/^\s*\{"line"\s*:\s*(\d+)\s*,\s*"event"\s*:/);
    const sourceLine = original?.[1] ? Number(original[1]) : number;
    if (sourceLine >= start && sourceLine < start + count) {
      let text = head;
      if (length > half && length <= 2 * half) text += tail.slice(-(length - head.length));
      if (length > 2 * half) {
        text = `${head}\n[${length - 2 * half} characters omitted from this line]\n${tail}`;
      }
      lines.push(text);
    }
    done = sourceLine >= start + count - 1;
    number++;
    head = "";
    tail = "";
    length = 0;
  }

  // Bound each line while streaming: a large tool event must not fill the Master's memory.
  for await (const chunk of object.body) {
    const fragments = decoder.decode(chunk, { stream: true }).split("\n");
    for (let index = 0; index < fragments.length; index++) {
      fragment(fragments[index] ?? "");
      if (index < fragments.length - 1) finishLine();
      if (done) return cap(lines.join("\n"));
    }
  }
  fragment(decoder.decode());
  if (length) finishLine();
  return cap(lines.join("\n"));
}
