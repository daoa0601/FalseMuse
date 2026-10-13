const encoder = new TextEncoder();
const SESSION_CONTEXT = "optchat-owner-session-v1";
export const SESSION_COOKIE = "owner";

async function digest(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(text));
}

/** Compare secrets in constant time; hashing first makes the lengths equal. */
async function same(candidate: string, secret: string): Promise<boolean> {
  return crypto.subtle.timingSafeEqual(await digest(candidate), await digest(secret));
}

/**
 * The web session cookie is an HMAC of the owner key, so the cookie jar never holds the key.
 * Rotating OWNER_KEY signs every browser out.
 */
export async function sessionToken(ownerKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(ownerKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(SESSION_CONTEXT));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;
}

export async function isOwnerKey(candidate: unknown, ownerKey: string): Promise<boolean> {
  return typeof candidate === "string" && Boolean(ownerKey) && (await same(candidate, ownerKey));
}

/** The owner authenticates with a bearer key (CLI) or the derived session cookie (web). */
export async function isOwner(request: Request, ownerKey: string): Promise<boolean> {
  if (!ownerKey) return false;
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (bearer !== undefined) return same(bearer, ownerKey);
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  return cookie !== undefined && same(cookie, await sessionToken(ownerKey));
}
