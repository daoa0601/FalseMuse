import { isRecord } from "./json.ts";
import type { InputImage, InputItem } from "./codex.ts";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const TYPES = Object.fromEntries(Object.entries(EXTENSIONS).map(([type, ext]) => [ext, type]));
const IMAGE_BYTES = 10 * 1024 * 1024;
const MESSAGE_IMAGES = 8;
/** A model call carries its images inline, under the 32 MiB a relayed WebSocket message may be. */
const MESSAGE_BYTES = 20 * 1024 * 1024;
/** Where an image is until a model call loads it. */
const STORED = "r2:";
const KEY = /^images\/[0-9a-f]{64}\.(png|jpeg|webp|gif)$/;
/** How a message names an image the owner sent: "[image <key>]". */
const MARKER = /\[image (images\/[0-9a-f]{64}\.(?:png|jpeg|webp|gif))\]/g;

export const isImageKey = (value: unknown): value is string =>
  typeof value === "string" && KEY.test(value);

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

/**
 * Store the images of an owner's message in R2 under their content hashes, and return the markers
 * that name them in the message's text. Images are `{mimeType, data}` with base64 data, as ACP
 * sends them.
 */
export async function saveImages(bucket: R2Bucket, value: unknown): Promise<string[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MESSAGE_IMAGES) {
    throw new Error(`Send at most ${MESSAGE_IMAGES} images as a list`);
  }
  const images = value.map((image) => {
    const type = isRecord(image) ? image["mimeType"] : undefined;
    const data = isRecord(image) ? image["data"] : undefined;
    const extension = typeof type === "string" ? EXTENSIONS[type] : undefined;
    if (typeof type !== "string" || !extension || typeof data !== "string") {
      throw new Error("Send images as PNG, JPEG, WebP or GIF with base64 data");
    }
    let binary: string;
    try {
      binary = atob(data);
    } catch {
      throw new Error("An image's data is not base64");
    }
    return { type, extension, bytes: Uint8Array.from(binary, (char) => char.charCodeAt(0)) };
  });
  const total = images.reduce((sum, image) => sum + image.bytes.length, 0);
  if (images.some((image) => image.bytes.length > IMAGE_BYTES) || total > MESSAGE_BYTES) {
    throw new Error("Send images of at most 10 MiB each and 20 MiB in all");
  }
  return Promise.all(
    images.map(async ({ type, extension, bytes }) => {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const key = `images/${hash}.${extension}`;
      await bucket.put(key, bytes, { httpMetadata: { contentType: type } });
      return `[image ${key}]`;
    }),
  );
}

/** An image for the model, named by its key until a call loads it. */
export const storedImage = (key: string): InputImage => ({
  type: "input_image",
  image_url: `${STORED}${key}`,
});

/** The images a message's markers name. */
export const markedImages = (text: string): InputImage[] =>
  [...text.matchAll(MARKER)].flatMap((match) => (match[1] ? [storedImage(match[1])] : []));

/** The input with each stored image loaded from R2 as a data URL, for one model call. */
export async function loadImages(bucket: R2Bucket, input: InputItem[]): Promise<InputItem[]> {
  const loaded = new Map<string, Promise<string>>();
  const load = (key: string) => {
    let url = loaded.get(key);
    if (!url) {
      url = bucket.get(key).then(async (object) => {
        if (!object) throw new Error(`The image ${key} is missing from storage`);
        const bytes = new Uint8Array(await object.arrayBuffer());
        return `data:${TYPES[key.split(".").pop() ?? ""]};base64,${toBase64(bytes)}`;
      });
      loaded.set(key, url);
    }
    return url;
  };
  return Promise.all(
    input.map(async (item) => {
      if (!("role" in item) || item.role !== "user" || !Array.isArray(item.content)) return item;
      const content = await Promise.all(
        item.content.map(async (part) =>
          part.type === "input_image" && part.image_url.startsWith(STORED)
            ? { ...part, image_url: await load(part.image_url.slice(STORED.length)) }
            : part,
        ),
      );
      return { ...item, content };
    }),
  );
}
