import { isOwner, isOwnerKey, sessionCookie, sessionToken } from "./owner.ts";
import { INBOX_PAGE } from "./inbox.ts";
import { backupRoute } from "./backup-routes.ts";
export { Inbox } from "./inbox.ts";

const json = (value: unknown, status = 200): Response => Response.json(value, { status });

/** The Master runs on the laptop; this Worker keeps its inbox and backup. */
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/") {
      return new Response(INBOX_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (path === "/login" && request.method === "POST") {
      const key = (await request.formData()).get("key");
      if (!(await isOwnerKey(key, env.OWNER_KEY))) return json({ error: "Unauthorized" }, 401);
      return Response.json(
        { ok: true },
        { headers: { "set-cookie": sessionCookie(await sessionToken(env.OWNER_KEY)) } },
      );
    }
    if (path !== "/api/inbox" && path !== "/master/inbox" && !path.startsWith("/backup/")) {
      return json({ error: "No such route" }, 404);
    }
    if (!(await isOwner(request, env.OWNER_KEY))) return json({ error: "Unauthorized" }, 401);
    return path.startsWith("/backup/")
      ? backupRoute(request, env.TRANSCRIPTS)
      : ctx.exports.Inbox.getByName("owner").fetch(request);
  },
} satisfies ExportedHandler<Env>;
