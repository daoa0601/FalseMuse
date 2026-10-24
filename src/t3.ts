import { hasColumn, type SqlDatabase } from "./database.ts";
import { errorMessage, isRecord, parseJson } from "./json.ts";
import { callTool, McpUnauthorized } from "./mcp.ts";
import { redactText } from "./redact.ts";

/** The T3 Code release these calls were written against; its MCP tools are young and change. */
export const T3_VERSION = "0.0.46-nightly.20261010.2935";

const SCOPES = "orchestration:read orchestration:operate";
const FLOW_MS = 15 * 60_000;
const TERMINAL = new Set([
  "idle",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const REPORT_CHARS = 4_000;
/** OptChat's own provider in T3 Code (bin/optchat-acp), as the owner's settings.json names it. */
const OPTCHAT_MODEL: ModelSelection = { instanceId: "optchat", model: "default" };
/** Tries to post a turn, a minute apart and doubling, before it is left unsent. */
const POST_ATTEMPTS = 5;
/**
 * Threads that may run for the Master at once, so fanning out cannot run away. A thread counts for
 * 12 hours from its last start, so one deleted in T3 Code does not hold its place for good.
 */
const MAX_RUNNING = 6;
const RUNNING_MS = 12 * 3_600_000;

/** The computer's sign-in is missing, expired or refused: only the owner can renew it. */
export class SignInNeeded extends Error {
  constructor(name: string) {
    super(`${name} needs the owner to sign in again`);
  }
}

/** A T3 Code provider instance and one of its models, as `t3_thread_launch` takes them. */
export interface ModelSelection {
  instanceId: string;
  model: string;
}

/** A report on watched threads; a finished thread's report names it. */
export type Report = (text: string, finished?: { computer: string; thread: string }) => void;

interface Computer {
  name: string;
  url: string;
  token: string | null;
  expires: number | null;
  session: string | null;
}

interface Flow {
  state: string;
  name: string;
  url: string;
  issuer: string;
  client_id: string;
  verifier: string;
  redirect: string;
  token_endpoint: string;
  created: number;
}

interface Watch {
  computer: string;
  thread: string;
  title: string;
  waiting: number;
  /** Raised each time the Master starts the thread again, so a stale poll leaves the watch. */
  generation: number;
  /** When the Master last started it. */
  since: number;
}

interface Post {
  turn: number;
  title: string;
  attempts: number;
  next: number;
  computer: string | null;
  thread: string | null;
  error: string | null;
}

interface Project {
  id: string;
  title: string;
  root: string;
}

const base64url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const random = (size: number): string => base64url(crypto.getRandomValues(new Uint8Array(size)));

function field(value: unknown, name: string, what: string): string {
  const text = isRecord(value) ? value[name] : undefined;
  if (typeof text !== "string" || !text) throw new Error(`${what} has no ${name}`);
  return text;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return parseJson(await response.text());
}

/**
 * The owner's computers running T3 Code, reached as an outside MCP agent: each one is signed in
 * once with OAuth, and its threads run within the access the owner approved there. Threads the
 * Master starts or messages are watched until they finish, and each result comes back once.
 */
export class Computers {
  private readonly database: SqlDatabase;

  constructor(database: SqlDatabase) {
    this.database = database;
    for (const query of [
      "CREATE TABLE IF NOT EXISTS t3_computers (name TEXT PRIMARY KEY, url TEXT NOT NULL, token TEXT, expires INTEGER, session TEXT)",
      "CREATE TABLE IF NOT EXISTS t3_flows (state TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, issuer TEXT NOT NULL, client_id TEXT NOT NULL, verifier TEXT NOT NULL, redirect TEXT NOT NULL, token_endpoint TEXT NOT NULL, created INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS t3_watches (computer TEXT NOT NULL, thread TEXT NOT NULL, title TEXT NOT NULL, waiting INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, since INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(computer, thread))",
      // Launches by tool call id: T3 Code takes no retry key for them, so a resumed turn must not
      // repeat one. A null result is a launch that may have started before a restart.
      "CREATE TABLE IF NOT EXISTS t3_launches (id TEXT PRIMARY KEY, result TEXT)",
      // Turns nobody prompted for, each shown to the owner as a new OptChat thread.
      "CREATE TABLE IF NOT EXISTS t3_posts (turn INTEGER PRIMARY KEY, title TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next INTEGER NOT NULL, computer TEXT, thread TEXT, error TEXT)",
      // Each computer's OptChat inbox: the one thread posts go to and the owner answers in.
      "CREATE TABLE IF NOT EXISTS t3_inboxes (computer TEXT PRIMARY KEY, thread TEXT NOT NULL)",
    ])
      database.exec(query);
    if (!hasColumn(database, "t3_watches", "since")) {
      database.exec("ALTER TABLE t3_watches ADD COLUMN since INTEGER NOT NULL DEFAULT 0");
      database.exec("UPDATE t3_watches SET since=?", Date.now());
    }
  }

  /** Begin signing in to a computer's MCP endpoint; the owner opens the returned page. */
  async connect(name: unknown, url: unknown, redirect: string): Promise<{ authorize: string }> {
    if (typeof name !== "string" || !/^[\w-]{1,40}$/.test(name)) {
      throw new Error("Name the computer with up to 40 letters, digits, - or _");
    }
    const endpoint = typeof url === "string" ? URL.parse(url) : null;
    if (!endpoint || endpoint.protocol !== "https:" || endpoint.search || endpoint.hash) {
      throw new Error("Give the computer's https MCP URL from T3 Code's Settings → Connections");
    }
    const resource = endpoint.href;
    const protectedResource = await getJson(
      `${endpoint.origin}/.well-known/oauth-protected-resource${endpoint.pathname}`,
    );
    if (field(protectedResource, "resource", "The MCP server") !== resource) {
      throw new Error("The MCP server names a different resource than that URL");
    }
    const servers = isRecord(protectedResource) ? protectedResource["authorization_servers"] : null;
    const issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : null;
    if (!issuer) throw new Error("The MCP server names no authorization server");
    const metadata = await getJson(`${issuer}/.well-known/oauth-authorization-server`);
    if (field(metadata, "issuer", "The authorization server") !== issuer) {
      throw new Error("The authorization server names a different issuer");
    }
    const registration = await fetch(field(metadata, "registration_endpoint", "Its metadata"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "OptChat",
        redirect_uris: [redirect],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    if (!registration.ok) throw new Error(`Client registration failed (${registration.status})`);
    const clientId = field(parseJson(await registration.text()), "client_id", "The registration");
    const verifier = random(32);
    const challenge = base64url(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    const state = random(24);
    this.database.exec("DELETE FROM t3_flows WHERE created<?", Date.now() - FLOW_MS);
    this.database.exec(
      "INSERT INTO t3_flows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      state,
      name,
      resource,
      issuer,
      clientId,
      verifier,
      redirect,
      field(metadata, "token_endpoint", "Its metadata"),
      Date.now(),
    );
    const authorize = new URL(field(metadata, "authorization_endpoint", "Its metadata"));
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
    }))
      authorize.searchParams.set(key, value);
    return { authorize: authorize.href };
  }

  /** Finish a sign-in from the OAuth redirect; the state names the flow, once. */
  async finish(params: URLSearchParams): Promise<string> {
    const state = params.get("state") ?? "";
    const [flow] = this.database.rows<Flow>("SELECT * FROM t3_flows WHERE state=?", state);
    if (!flow || flow.created < Date.now() - FLOW_MS) {
      throw new Error("This sign-in is unknown or expired; start it again");
    }
    this.database.exec("DELETE FROM t3_flows WHERE state=?", state);
    const refused = params.get("error");
    if (refused) throw new Error(`The sign-in was refused: ${refused}`);
    const iss = params.get("iss");
    if (iss !== null && iss !== flow.issuer)
      throw new Error("The sign-in came from another issuer");
    const response = await fetch(flow.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: params.get("code") ?? "",
        redirect_uri: flow.redirect,
        client_id: flow.client_id,
        code_verifier: flow.verifier,
        resource: flow.url,
      }),
    });
    if (!response.ok) throw new Error(`The token exchange failed (${response.status})`);
    const token: unknown = parseJson(await response.text());
    const lifetime = isRecord(token) ? token["expires_in"] : undefined;
    this.database.exec(
      `INSERT INTO t3_computers VALUES (?, ?, ?, ?, NULL) ON CONFLICT(name) DO UPDATE SET
        url=excluded.url, token=excluded.token, expires=excluded.expires, session=NULL`,
      flow.name,
      flow.url,
      field(token, "access_token", "The token response"),
      typeof lifetime === "number" ? Date.now() + lifetime * 1000 : null,
    );
    return flow.name;
  }

  list() {
    return this.database
      .rows<Computer>("SELECT * FROM t3_computers ORDER BY name")
      .map(({ name, url, token, expires }) => ({
        name,
        url,
        connected: this.signedIn({ token, expires }),
        expires: expires === null ? null : new Date(expires).toISOString(),
      }));
  }

  private signedIn({ token, expires }: Pick<Computer, "token" | "expires">): boolean {
    return token !== null && (expires === null || expires > Date.now());
  }

  private async call(name: string, tool: string, args: Record<string, unknown>) {
    const [computer] = this.database.rows<Computer>(
      "SELECT * FROM t3_computers WHERE name=?",
      name,
    );
    if (!computer) throw new Error(`No computer named ${name}; see computers`);
    const token = computer.token;
    if (!token || !this.signedIn(computer)) throw new SignInNeeded(name);
    try {
      const { result, session } = await callTool(
        { url: computer.url, token, session: computer.session },
        tool,
        args,
      );
      this.database.exec(
        "UPDATE t3_computers SET session=? WHERE name=? AND token=?",
        session,
        name,
        token,
      );
      return result;
    } catch (error) {
      if (!(error instanceof McpUnauthorized)) throw error;
      // Clear only the refused token: the owner may have signed in again meanwhile.
      this.database.exec(
        "UPDATE t3_computers SET token=NULL, session=NULL WHERE name=? AND token=?",
        name,
        token,
      );
      const [current] = this.database.rows<Pick<Computer, "token">>(
        "SELECT token FROM t3_computers WHERE name=?",
        name,
      );
      if (current?.token) throw new Error(`${name} was signed in again during this call; retry`);
      throw new SignInNeeded(name);
    }
  }

  private async projects(name: string): Promise<Project[]> {
    const projects: Project[] = [];
    let cursor: unknown = 0;
    for (let page = 0; page < 20 && typeof cursor === "number"; page++) {
      const result = await this.call(name, "t3_project_list", { limit: 100, cursor });
      const entries = isRecord(result) ? result["projects"] : null;
      if (!Array.isArray(entries)) throw new Error("t3_project_list returned no projects");
      for (const project of entries) {
        projects.push({
          id: field(project, "id", "A project"),
          title: field(project, "title", "A project"),
          root: field(project, "workspaceRoot", "A project"),
        });
      }
      cursor = isRecord(result) ? result["nextCursor"] : null;
    }
    return projects;
  }

  /** The id of a project on a computer, named by its id or, in any case, its title. */
  async project(name: string, project: unknown): Promise<string> {
    const projects = await this.projects(name);
    const wanted = typeof project === "string" ? project.toLowerCase() : "";
    const match = projects.find(
      (entry) => entry.id === project || entry.title.toLowerCase() === wanted,
    );
    if (!match) {
      throw new Error(
        `No project ${String(project)} on ${name}; it has ${projects.map((entry) => entry.title).join(", ")}`,
      );
    }
    return match.id;
  }

  /**
   * Every computer with the threads running for the Master on it, oldest first, and the projects,
   * providers and models of those signed in.
   */
  async overview() {
    const watches = this.database.rows<Pick<Watch, "computer" | "thread" | "title" | "waiting">>(
      "SELECT computer, thread, title, waiting FROM t3_watches ORDER BY since",
    );
    return Promise.all(
      this.list().map(async (entry) => {
        const running = watches
          .filter((watch) => watch.computer === entry.name)
          .map(({ thread, title, waiting }) => ({ thread, title, waiting: waiting === 1 }));
        const computer = { ...entry, running };
        if (!computer.connected) return { ...computer, projects: [] };
        try {
          const [projects, providers] = await Promise.all([
            this.projects(computer.name),
            this.models(computer.name),
          ]);
          return { ...computer, projects, providers };
        } catch (error) {
          return { ...computer, error: errorMessage(error) };
        }
      }),
    );
  }

  /** The provider instances a computer's T3 Code offers and their models, without OptChat's own. */
  async models(
    name: string,
  ): Promise<{ provider: string; label: string | null; models: string[] }[]> {
    const result = await this.call(name, "orchestrator_capabilities", {});
    const providers = isRecord(result) ? result["providers"] : null;
    if (!Array.isArray(providers))
      throw new Error("orchestrator_capabilities returned no providers");
    return providers.filter(isRecord).flatMap((entry) => {
      const provider = entry["providerInstanceId"];
      if (typeof provider !== "string" || provider === OPTCHAT_MODEL.instanceId) return [];
      const models = Array.isArray(entry["models"]) ? entry["models"].filter(isRecord) : [];
      return [
        {
          provider,
          label: typeof entry["displayName"] === "string" ? entry["displayName"] : null,
          models: models.flatMap((model) => (typeof model["id"] === "string" ? [model["id"]] : [])),
        },
      ];
    });
  }

  /**
   * The model selection for a provider instance and model the computer offers, or a refusal naming
   * what it offers; both empty or left out mean the project's default in T3 Code.
   */
  async choose(
    name: string,
    provider: unknown,
    model: unknown,
  ): Promise<ModelSelection | undefined> {
    const text = (value: unknown, field: string) => {
      if (value !== undefined && typeof value !== "string")
        throw new Error(`${field} must be text`);
      return value?.trim() ?? "";
    };
    const instance = text(provider, "provider");
    const chosen = text(model, "model");
    if (!instance !== !chosen) {
      throw new Error("Give both a provider and a model, or neither for the project's default");
    }
    if (!instance) return undefined;
    const providers = await this.models(name);
    const entry = providers.find((candidate) => candidate.provider === instance);
    if (!entry) {
      throw new Error(
        `${name} has no provider ${instance}; it has ${providers.map((candidate) => candidate.provider).join(", ")}`,
      );
    }
    if (!entry.models.includes(chosen)) {
      throw new Error(
        `${instance} on ${name} has no model ${chosen}; it has ${entry.models.join(", ")}`,
      );
    }
    return { instanceId: instance, model: chosen };
  }

  /** Switch a thread to another provider instance or model. */
  configure(name: string, thread: string, modelSelection: ModelSelection) {
    return this.call(name, "t3_thread_configure", { threadId: thread, modelSelection });
  }

  /**
   * Start a thread in a project; it runs within the access the owner approved, never above.
   * `request` is the tool call's id: a resumed turn gets the first result instead of a second
   * thread. Without a model, the thread uses the project's default in T3 Code. At most
   * MAX_RUNNING threads run for the Master at once.
   */
  async launch(
    name: string,
    project: unknown,
    title: string,
    task: string,
    request: string,
    modelSelection?: ModelSelection,
    now = Date.now(),
  ) {
    const [earlier] = this.database.rows<{ result: string | null }>(
      "SELECT result FROM t3_launches WHERE id=?",
      request,
    );
    if (earlier?.result) return parseJson(earlier.result);
    if (earlier) {
      throw new Error(
        "This launch may have started before the Master restarted; check threads before launching again",
      );
    }
    const running = this.database.rows<{ title: string }>(
      "SELECT title FROM t3_watches WHERE since>? ORDER BY since",
      now - RUNNING_MS,
    );
    if (running.length >= MAX_RUNNING) {
      throw new Error(
        `${running.length} threads are running for you (${running.map((watch) => watch.title).join(", ")}); wait for a report before starting another`,
      );
    }
    const projectId = await this.project(name, project);
    this.database.exec("INSERT INTO t3_launches VALUES (?, NULL)", request);
    let result: unknown;
    try {
      result = await this.call(name, "t3_thread_launch", {
        projectId,
        title,
        message: task,
        ...(modelSelection ? { modelSelection } : {}),
      });
    } catch (error) {
      this.database.exec("DELETE FROM t3_launches WHERE id=?", request);
      throw error;
    }
    const thread = field(result, "threadId", "t3_thread_launch");
    this.database.transaction(() => {
      this.database.exec(
        "UPDATE t3_launches SET result=? WHERE id=?",
        JSON.stringify(result),
        request,
      );
      this.watch(name, thread, title, now);
    });
    return result;
  }

  /** A launch was made, or may have begun, under this tool call id. */
  launched(request: string): boolean {
    return this.database.rows("SELECT 1 FROM t3_launches WHERE id=?", request).length > 0;
  }

  async threads(name: string, project: unknown) {
    const result = await this.call(name, "t3_thread_list", {
      projectId: await this.project(name, project),
      limit: 20,
    });
    const threads = isRecord(result) ? result["threads"] : null;
    if (!Array.isArray(threads)) throw new Error("t3_thread_list returned no threads");
    return threads.filter(isRecord).map((thread) => ({
      threadId: thread["threadId"],
      title: typeof thread["title"] === "string" ? redactText(thread["title"]) : null,
      status: thread["status"],
      model: thread["model"],
      updatedAt: thread["updatedAt"],
    }));
  }

  /** A thread's state and up to `limit` of its messages after `after`, with secrets redacted. */
  async read(name: string, thread: string, after?: number, limit = 20) {
    const result = await this.call(name, "t3_thread_read", {
      threadId: thread,
      view: "messages",
      limit,
      maxCharsPerItem: REPORT_CHARS,
      ...(after === undefined ? {} : { afterPosition: after }),
    });
    if (!isRecord(result) || !isRecord(result["thread"])) {
      throw new Error("t3_thread_read returned no thread");
    }
    const detail = result["thread"];
    const items = Array.isArray(result["items"]) ? result["items"].filter(isRecord) : [];
    const next = result["nextPosition"];
    return {
      title: typeof detail["title"] === "string" ? redactText(detail["title"]) : thread,
      status: typeof detail["status"] === "string" ? detail["status"] : "unknown",
      pendingRequests:
        typeof detail["pendingRequestCount"] === "number" ? detail["pendingRequestCount"] : 0,
      items: items.map((item) => ({
        position: item["position"],
        type: item["type"],
        text: typeof item["text"] === "string" ? redactText(item["text"]) : null,
      })),
      nextPosition: typeof next === "number" && result["hasMore"] !== false ? next : null,
    };
  }

  /** The thread's last reply, read page by page to its end. */
  private async lastReply(name: string, thread: string): Promise<string | null> {
    let reply: string | null = null;
    let after: number | undefined;
    for (let page = 0; page < 20; page++) {
      const state = await this.read(name, thread, after, 100);
      for (const item of state.items) {
        if (item.type === "assistant_message" && item.text !== null) reply = item.text;
      }
      if (state.nextPosition === null) break;
      after = state.nextPosition;
    }
    return reply;
  }

  /** Message a thread; `request` makes a resumed turn's repeat a no-op in T3 Code. */
  async send(name: string, thread: string, message: string, mode: unknown, request: string) {
    const result = await this.call(name, "t3_thread_send", {
      threadId: thread,
      message,
      mode: mode === "queue" || mode === "steer" || mode === "restart" ? mode : "auto",
      clientRequestId: request,
    });
    // The title is filled in by the next poll.
    this.watch(name, thread, thread);
    return result;
  }

  interrupt(name: string, thread: string, request: string) {
    return this.call(name, "t3_thread_interrupt", { threadId: thread, clientRequestId: request });
  }

  /** Show `turn` to the owner in their OptChat inbox under `title`, at the next post. */
  queuePost(turn: number, title: string, now = Date.now()): void {
    this.database.exec(
      "INSERT INTO t3_posts(turn, title, next) VALUES (?, ?, ?) ON CONFLICT(turn) DO NOTHING",
      turn,
      title,
      now,
    );
  }

  /** Recent posts, sent or not, with why the last try failed. */
  posts() {
    return this.database.rows<Post>("SELECT * FROM t3_posts ORDER BY turn DESC LIMIT 20");
  }

  /** When the next unsent post is due, if any. */
  nextPost(): number | null {
    return (
      this.database.rows<{ next: number | null }>(
        "SELECT MIN(next) AS next FROM t3_posts WHERE thread IS NULL AND attempts<?",
        POST_ATTEMPTS,
      )[0]?.next ?? null
    );
  }

  /**
   * Post each due turn to the OptChat inbox of the first signed-in computer that takes it: the
   * inbox is renamed after the turn, then gets a message that only names the turn, which the
   * OptChat agent reads from the Master. T3 Code notifies the owner's phones under the thread's
   * title when that run ends, and the owner answers in the same thread. The inbox is not watched,
   * or each post would come back as a new turn. Returns why posts failed.
   */
  async post(now = Date.now()): Promise<string[]> {
    const due = this.database.rows<{ turn: number; title: string; attempts: number }>(
      "SELECT turn, title, attempts FROM t3_posts WHERE thread IS NULL AND attempts<? AND next<=? ORDER BY turn",
      POST_ATTEMPTS,
      now,
    );
    const errors: string[] = [];
    for (const post of due) {
      try {
        const [computer, thread] = await this.launchPost(post.turn, post.title);
        this.database.exec(
          "UPDATE t3_posts SET computer=?, thread=?, error=NULL WHERE turn=?",
          computer,
          thread,
          post.turn,
        );
      } catch (error) {
        const reason = `Turn ${post.turn} was not posted to T3 Code: ${errorMessage(error)}`;
        errors.push(reason);
        this.database.exec(
          "UPDATE t3_posts SET attempts=attempts+1, next=?, error=? WHERE turn=?",
          now + 60_000 * 2 ** post.attempts,
          reason,
          post.turn,
        );
      }
    }
    return errors;
  }

  private async launchPost(turn: number, headline: string): Promise<[string, string]> {
    const failures: string[] = [];
    for (const { name, connected } of this.list()) {
      if (!connected) continue;
      try {
        return [name, await this.postTo(name, turn, `OptChat: ${headline}`)];
      } catch (error) {
        failures.push(`${name}: ${errorMessage(error)}`);
      }
    }
    throw new Error(failures.join("; ") || "no computer is signed in");
  }

  /**
   * Post a turn to a computer's inbox, starting one in its Scratch project the first time. The
   * request ids make a repeated post a no-op in T3 Code. If the inbox refuses, it is taken to be
   * gone (the owner may delete it) and a new one starts.
   */
  private async postTo(name: string, turn: number, title: string): Promise<string> {
    const message = `OptChat turn ${turn}`;
    const [inbox] = this.database.rows<{ thread: string }>(
      "SELECT thread FROM t3_inboxes WHERE computer=?",
      name,
    );
    if (inbox) {
      try {
        await this.call(name, "t3_thread_update", {
          threadId: inbox.thread,
          action: "rename",
          title,
          clientRequestId: `post-${turn}-title`,
        });
        // A turn the owner is running in the inbox finishes first.
        await this.call(name, "t3_thread_send", {
          threadId: inbox.thread,
          message,
          mode: "queue",
          clientRequestId: `post-${turn}`,
        });
        return inbox.thread;
      } catch (error) {
        if (error instanceof SignInNeeded) throw error;
      }
    }
    const result = await this.call(name, "t3_thread_launch", {
      scratch: true,
      title,
      modelSelection: OPTCHAT_MODEL,
      message,
    });
    const thread = field(result, "threadId", "t3_thread_launch");
    this.database.exec(
      "INSERT INTO t3_inboxes VALUES (?, ?) ON CONFLICT(computer) DO UPDATE SET thread=excluded.thread",
      name,
      thread,
    );
    return thread;
  }

  private watch(computer: string, thread: string, title: string, now = Date.now()): void {
    this.database.exec(
      `INSERT INTO t3_watches(computer, thread, title, since) VALUES (?, ?, ?, ?)
        ON CONFLICT(computer, thread) DO UPDATE SET waiting=0, generation=generation+1, since=excluded.since`,
      computer,
      thread,
      title,
      now,
    );
  }

  watching(): boolean {
    return this.database.rows("SELECT 1 FROM t3_watches LIMIT 1").length > 0;
  }

  /**
   * Check every watched thread, each computer at once and its threads in turn: a finished one
   * reports its last reply and is dropped, naming the thread; one waiting on the owner reports that
   * once. A computer that needs a new sign-in reports it once.
   */
  async poll(report: Report): Promise<void> {
    const byComputer = new Map<string, Watch[]>();
    for (const watch of this.database.rows<Watch>("SELECT * FROM t3_watches")) {
      byComputer.set(watch.computer, [...(byComputer.get(watch.computer) ?? []), watch]);
    }
    await Promise.all(
      [...byComputer.values()].map(async (watches) => {
        for (const watch of watches) {
          try {
            await this.check(watch, report);
          } catch (error) {
            // Anything else, such as the computer being offline, is tried again at the next poll.
            if (!(error instanceof SignInNeeded)) continue;
            report(
              `[${watch.computer}] needs the owner to sign in again; its threads are not followed`,
            );
            this.database.exec("DELETE FROM t3_watches WHERE computer=?", watch.computer);
            return;
          }
        }
      }),
    );
  }

  private async check(watch: Watch, report: Report): Promise<void> {
    const state = await this.read(watch.computer, watch.thread, undefined, 1);
    // A title is the thread's own text: keep it to one line that cannot close the brackets.
    const head = `[${watch.computer}: ${state.title.replace(/[\r\n[\]]+/g, " ").trim()}]`;
    const current = (field: string) =>
      `UPDATE t3_watches SET ${field} WHERE computer=? AND thread=? AND generation=?`;
    if (state.title !== watch.title) {
      this.database.exec(
        current("title=?"),
        state.title,
        watch.computer,
        watch.thread,
        watch.generation,
      );
    }
    if (TERMINAL.has(state.status)) {
      const reply = await this.lastReply(watch.computer, watch.thread);
      // A send since this check began started a new run; that run reports instead.
      const [still] = this.database.rows(
        "SELECT 1 FROM t3_watches WHERE computer=? AND thread=? AND generation=?",
        watch.computer,
        watch.thread,
        watch.generation,
      );
      if (!still) return;
      this.database.exec(
        "DELETE FROM t3_watches WHERE computer=? AND thread=? AND generation=?",
        watch.computer,
        watch.thread,
        watch.generation,
      );
      report(`${head} ${state.status}: ${(reply ?? "(no reply)").slice(0, REPORT_CHARS)}`, {
        computer: watch.computer,
        thread: watch.thread,
      });
    } else if (state.status === "waiting" || state.pendingRequests > 0) {
      if (watch.waiting) return;
      this.database.exec(current("waiting=1"), watch.computer, watch.thread, watch.generation);
      report(
        `${head} waiting for the owner in T3 Code (${state.pendingRequests} request(s) to answer)`,
      );
    } else if (watch.waiting) {
      this.database.exec(current("waiting=0"), watch.computer, watch.thread, watch.generation);
    }
  }
}
