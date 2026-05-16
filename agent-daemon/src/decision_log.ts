// Decision log — pretty-print every IDE-agent invocation to stdout (for the
// human glancing at the daemon terminal) and append a JSONL line to a file
// (for post-hoc analysis). After the Phase 18 refactor, the agent's actual
// decision is captured on the backend (because the IDE-agent acts via
// susu_* MCP tools); this log records that the daemon DISPATCHED an event
// to the agent — invocation result, not decision content.

import { appendFile } from "node:fs/promises";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

function isTTY(): boolean { return process.stdout.isTTY === true; }
function dim(s: string): string { return isTTY() ? `${DIM}${s}${RESET}` : s; }
function color(s: string, c: string): string { return isTTY() ? `${c}${s}${RESET}` : s; }

function shortId(id: string): string { return id.slice(0, 8); }

function fmtTime(): string {
  const d = new Date();
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

export interface LogEntry {
  triggering_event: unknown;
  invocation: {
    runner: string;
    duration_ms: number;
    exit_code: number | null;
  };
  /** Tail of the agent CLI's stdout — used only for debugging silent agents. */
  stdout_tail?: string;
}

export class DecisionLog {
  constructor(private filePath?: string) {}

  async log(entry: LogEntry): Promise<void> {
    this.printToTerminal(entry);
    if (this.filePath) await this.appendToFile(entry);
  }

  private printToTerminal(e: LogEntry): void {
    const t = dim(fmtTime());
    const triggerPreview = previewEvent(e.triggering_event);
    process.stdout.write(`${t}  ${triggerPreview}\n`);
    process.stdout.write(
      `  ${dim("⌥ runner:")} ${e.invocation.runner}  ` +
      `${(e.invocation.duration_ms / 1000).toFixed(2)}s  ` +
      `exit=${color(String(e.invocation.exit_code ?? "timeout"), e.invocation.exit_code === 0 ? GREEN : RED)}\n`,
    );
    process.stdout.write("\n");
  }

  private async appendToFile(e: LogEntry): Promise<void> {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      triggering_event: e.triggering_event,
      invocation: e.invocation,
      stdout_tail: e.stdout_tail,
    }) + "\n";
    try { await appendFile(this.filePath!, line, "utf8"); } catch {
      // Don't crash the daemon over log file issues.
    }
  }
}

function previewEvent(evt: any): string {
  if (!evt || typeof evt !== "object") return "(unknown event)";
  const kind = evt.kind ?? "?";
  const who = evt.from_username ? `@${evt.from_username}` : (evt.from_address ? evt.from_address.slice(0, 8) + "…" : "?");
  if (kind === "signal") {
    const txt = previewPayload(evt.payload);
    return `${color("signal", YELLOW)} from ${who}: ${txt}`;
  }
  if (kind === "reaction") {
    const txt = previewPayload(evt.payload);
    return `${color("reaction", YELLOW)} from ${who} on ${shortId(evt.signal_id ?? "")}: ${txt}`;
  }
  return `${color(kind, YELLOW)} from ${who}`;
}

function previewPayload(p: any): string {
  if (p == null) return "(empty)";
  if (typeof p === "string") return p.length > 80 ? p.slice(0, 77) + "..." : p;
  if (typeof p === "object" && typeof p.text === "string") return previewPayload(p.text);
  const s = JSON.stringify(p);
  return s.length > 80 ? s.slice(0, 77) + "..." : s;
}
