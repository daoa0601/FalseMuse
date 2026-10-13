import type { SqlDatabase } from "./database.ts";
import { isRecord } from "./json.ts";

export interface Schedule {
  id: number;
  prompt: string;
  at: number;
  every_minutes: number;
  enabled: number;
  last_fired: number | null;
}

export class Schedules {
  private readonly database: SqlDatabase;

  constructor(database: SqlDatabase) {
    this.database = database;
    database.exec(`CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY, prompt TEXT NOT NULL, at INTEGER NOT NULL,
      every_minutes INTEGER NOT NULL, enabled INTEGER NOT NULL, last_fired INTEGER)`);
  }

  create(input: unknown, now = Date.now()): Schedule {
    if (!isRecord(input)) throw new Error("A schedule needs a prompt");
    const { prompt, at, every_minutes: everyMinutes = 0 } = input;
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("A schedule needs a prompt");
    if (typeof at !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(at)) {
      throw new Error("Use an ISO date and time with a timezone");
    }
    const time = Date.parse(at);
    if (!Number.isFinite(time) || time <= now) throw new Error("Choose a future time");
    if (
      typeof everyMinutes !== "number" ||
      !Number.isSafeInteger(everyMinutes) ||
      everyMinutes < 0
    ) {
      throw new Error("Repeat minutes must be zero or a positive integer");
    }
    this.database.exec(
      "INSERT INTO schedules(prompt, at, every_minutes, enabled) VALUES (?, ?, ?, 1)",
      prompt,
      time,
      everyMinutes,
    );
    const [schedule] = this.database.rows<Schedule>(
      "SELECT * FROM schedules WHERE id=last_insert_rowid()",
    );
    if (!schedule) throw new Error("The schedule was not stored");
    return schedule;
  }

  list(): Schedule[] {
    return this.database.rows<Schedule>("SELECT * FROM schedules ORDER BY enabled DESC, at, id");
  }

  cancel(id: unknown): { id: number; cancelled: true } {
    if (typeof id !== "number") throw new Error(`No schedule ${String(id)}`);
    const [schedule] = this.database.rows("SELECT id FROM schedules WHERE id=?", id);
    if (!schedule) throw new Error(`No schedule ${id}`);
    this.database.exec("UPDATE schedules SET enabled=0 WHERE id=?", id);
    return { id, cancelled: true };
  }

  /** Queue a note turn for each due schedule; returns how many fired. */
  fireDue(now = Date.now()): number {
    return this.database.transaction(() => {
      const due = this.database.rows<Schedule>(
        "SELECT * FROM schedules WHERE enabled=1 AND at<=? ORDER BY at, id",
        now,
      );
      for (const schedule of due) {
        const text = `[Scheduled ${schedule.id}, ${new Date(schedule.at).toISOString()}] ${schedule.prompt}`;
        this.database.exec(
          "INSERT INTO turns(text, kind, status) VALUES (?, 'note', 'pending')",
          text,
        );
        // A late wake runs once, rather than flooding the chat with missed repeats.
        const repeat = schedule.every_minutes > 0;
        this.database.exec(
          "UPDATE schedules SET at=?, enabled=?, last_fired=? WHERE id=?",
          repeat ? now + schedule.every_minutes * 60_000 : schedule.at,
          repeat ? 1 : 0,
          now,
          schedule.id,
        );
      }
      return due.length;
    });
  }

  nextWake(): number | null {
    return (
      this.database.rows<{ at: number | null }>(
        "SELECT MIN(at) AS at FROM schedules WHERE enabled=1",
      )[0]?.at ?? null
    );
  }
}

/**
 * A time in the owner's zone as the schedule tool takes it, an ISO date and time with its offset,
 * after the weekday and before the zone's name: "Sunday 2026-10-11T18:05+03:00 (Europe/Helsinki)".
 */
export function localTime(time: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "longOffset",
  }).formatToParts(time);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  // UTC itself is named "GMT", without an offset.
  const offset = part("timeZoneName").replace(/^GMT/, "") || "+00:00";
  return `${part("weekday")} ${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}${offset} (${zone})`;
}
