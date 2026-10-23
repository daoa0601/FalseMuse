import type { SqlDatabase } from "./database.ts";
import type { NodeSocket } from "./host.ts";
import { send, type Nodes } from "./nodes.ts";
import type { Job, PermissionRequest } from "./protocol.ts";

interface Permission {
  job: string;
  request: string;
  title: string;
  message: string;
  allowed: number | null;
  state: "pending" | "decided" | "delivered" | "expired";
}

/** Owner reviews of Pi bash, edit, and write calls; a decision is final once made. */
export class Permissions {
  private readonly database: SqlDatabase;
  private readonly nodes: Nodes;

  constructor(database: SqlDatabase, nodes: Nodes) {
    this.database = database;
    this.nodes = nodes;
    database.exec(
      "CREATE TABLE IF NOT EXISTS permissions (job TEXT, request TEXT, title TEXT NOT NULL, message TEXT NOT NULL, allowed INTEGER, state TEXT NOT NULL, PRIMARY KEY(job, request))",
    );
  }

  list() {
    return this.database.rows(
      "SELECT p.job, p.request, p.title, p.message, s.machine, s.cwd FROM permissions p JOIN spawns s ON s.id=p.job WHERE p.state='pending' AND s.status='running' ORDER BY p.rowid",
    );
  }

  async request(
    machine: string,
    { job, id, title, message }: PermissionRequest,
  ): Promise<Permission> {
    this.running(job, machine);
    const saved = this.get(job, id);
    if (saved) return saved;
    await this.nodes.audit(job, "tool-proposed", { request: id, title, message });
    this.running(job, machine);
    this.database.exec(
      "INSERT OR IGNORE INTO permissions VALUES (?, ?, ?, ?, NULL, 'pending')",
      job,
      id,
      title,
      message,
    );
    return this.require(job, id);
  }

  async decide(job: string, id: string, allowed: unknown) {
    this.running(job);
    if (typeof allowed !== "boolean") throw new Error("Choose whether to allow this tool call");
    const saved = this.get(job, id);
    if (!saved) throw new Error("No pending tool review with that id");
    if (saved.state === "pending") {
      await this.nodes.audit(job, allowed ? "tool-approved" : "tool-denied", { request: id });
      this.running(job);
      this.database.exec(
        "UPDATE permissions SET allowed=?, state='decided' WHERE job=? AND request=? AND state='pending'",
        Number(allowed),
        job,
        id,
      );
    }
    const result = this.require(job, id);
    const { machine } = this.running(job);
    for (const socket of this.nodes.sockets.getWebSockets(machine)) this.deliver(socket, result);
    return { allowed: Boolean(result.allowed), state: result.state };
  }

  reconnect(machine: string, socket: NodeSocket): void {
    const decided = this.database.rows<Permission>(
      "SELECT p.* FROM permissions p JOIN spawns s ON s.id=p.job WHERE s.machine=? AND s.status='running' AND p.state='decided'",
      machine,
    );
    for (const permission of decided) this.deliver(socket, permission);
  }

  expire(machine: string, job: string): void {
    this.running(job, machine);
    this.database.exec(
      "UPDATE permissions SET state='expired' WHERE job=? AND state IN ('pending', 'decided')",
      job,
    );
  }

  receive(machine: string, { job, id }: { job: string; id: string }): void {
    this.running(job, machine);
    this.database.exec(
      "UPDATE permissions SET state='delivered' WHERE job=? AND request=? AND state='decided'",
      job,
      id,
    );
  }

  deliver(socket: NodeSocket, permission: Permission): void {
    if (permission.state !== "decided") return;
    send(socket, {
      type: "permission",
      job: permission.job,
      id: permission.request,
      allowed: Boolean(permission.allowed),
    });
  }

  private get(job: string, id: string): Permission | undefined {
    return this.database.rows<Permission>(
      "SELECT * FROM permissions WHERE job=? AND request=?",
      job,
      id,
    )[0];
  }

  private require(job: string, id: string): Permission {
    const permission = this.get(job, id);
    if (!permission) throw new Error("No tool review with that id");
    return permission;
  }

  private running(id: string, machine?: string): Job {
    const [job] = this.database.rows<Job>(
      "SELECT * FROM spawns WHERE id=? AND status='running'",
      id,
    );
    if (!job || (machine !== undefined && job.machine !== machine)) {
      throw new Error("That tool review does not belong to a running task on this node");
    }
    return job;
  }
}
