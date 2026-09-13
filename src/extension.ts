import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_PAGE = "https://claude.ai/settings/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const DEFAULT_UA = "claude-code/2.1.266";

interface Limit {
  kind: "session" | "weekly_all" | "weekly_scoped" | string;
  percent: number;
  resets_at: string | null;
  is_active?: boolean;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

interface UsageResponse {
  limits?: Limit[];
  five_hour?: { utilization: number; resets_at: string | null } | null;
  seven_day?: { utilization: number; resets_at: string | null } | null;
}

interface Row {
  label: string;
  percent: number;
  resetsAt: Date | null;
  active: boolean;
}

let statusItem: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;
let lastRows: Row[] = [];
let lastError: string | undefined;
let lastUpdated: Date | undefined;
let viewProvider: UsageViewProvider | undefined;
let userAgent = DEFAULT_UA;
let backoffUntil = 0;

// --- Credentials -----------------------------------------------------------

async function readToken(): Promise<string> {
  const parse = (raw: string): string => {
    const json = JSON.parse(raw);
    const token = json?.claudeAiOauth?.accessToken;
    if (typeof token !== "string" || !token) {
      throw new Error("No claudeAiOauth.accessToken in credentials");
    }
    return token;
  };

  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      return parse(stdout.trim());
    } catch {
      // fall through to file
    }
  }
  const file = path.join(os.homedir(), ".claude", ".credentials.json");
  return parse(await fs.readFile(file, "utf8"));
}

async function detectUserAgent(): Promise<void> {
  try {
    const { stdout } = await execFileAsync("claude", ["--version"]);
    const version = stdout.trim().split(/\s+/)[0];
    if (/^\d+\.\d+\.\d+/.test(version)) {
      userAgent = `claude-code/${version}`;
    }
  } catch {
    // keep default
  }
}

// --- Fetch -----------------------------------------------------------------

async function fetchUsage(): Promise<Row[]> {
  const token = await readToken();
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": userAgent,
      Accept: "application/json",
    },
  });
  if (res.status === 401) {
    throw new Error("Unauthorized (run `claude` to refresh login)");
  }
  if (res.status === 429) {
    backoffUntil = Date.now() + 15 * 60 * 1000;
    throw new Error("Rate limited by usage endpoint, backing off 15 min");
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = (await res.json()) as UsageResponse;
  return toRows(data);
}

function toRows(data: UsageResponse): Row[] {
  const rows: Row[] = [];
  const limits = data.limits ?? [];
  const parseDate = (s: string | null | undefined) => (s ? new Date(s) : null);

  if (limits.length > 0) {
    for (const l of limits) {
      let label: string;
      if (l.kind === "session") {
        label = "5h";
      } else if (l.kind === "weekly_all") {
        label = "wk";
      } else if (l.kind === "weekly_scoped") {
        label = l.scope?.model?.display_name ?? "model";
      } else {
        label = l.kind;
      }
      rows.push({
        label,
        percent: Math.round(l.percent),
        resetsAt: parseDate(l.resets_at),
        active: Boolean(l.is_active),
      });
    }
    return rows;
  }

  // Fallback for older response shapes without `limits`.
  if (data.five_hour) {
    rows.push({
      label: "5h",
      percent: Math.round(data.five_hour.utilization),
      resetsAt: parseDate(data.five_hour.resets_at),
      active: false,
    });
  }
  if (data.seven_day) {
    rows.push({
      label: "wk",
      percent: Math.round(data.seven_day.utilization),
      resetsAt: parseDate(data.seven_day.resets_at),
      active: false,
    });
  }
  return rows;
}

// --- Rendering -------------------------------------------------------------

function relative(d: Date | null): string {
  if (!d) {
    return "n/a";
  }
  const ms = d.getTime() - Date.now();
  if (ms <= 0) {
    return "now";
  }
  const mins = Math.round(ms / 60000);
  if (mins < 60) {
    return `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `${hours}h ${mins % 60}m`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function thresholds(): { warnAt: number; errorAt: number } {
  const cfg = vscode.workspace.getConfiguration("claudeUsageBar");
  return {
    warnAt: cfg.get<number>("warnAtPercent", 80),
    errorAt: cfg.get<number>("errorAtPercent", 95),
  };
}

function applyStatusBarVisibility(): void {
  const show = vscode.workspace.getConfiguration("claudeUsageBar").get<boolean>("showStatusBarItem", true);
  if (show) {
    statusItem.show();
  } else {
    statusItem.hide();
  }
}

function render(rows: Row[]): void {
  lastRows = rows;
  lastError = undefined;
  lastUpdated = new Date();
  viewProvider?.update();
  const { warnAt, errorAt } = thresholds();

  const text = rows.map((r) => `${r.label} ${r.percent}%`).join(" · ");
  statusItem.text = `$(pulse) ${text}`;

  const max = Math.max(0, ...rows.map((r) => r.percent));
  if (max >= errorAt) {
    statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (max >= warnAt) {
    statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    statusItem.backgroundColor = undefined;
  }

  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown("**Claude plan usage**\n\n");
  md.appendMarkdown("| Limit | Used | Resets in | Resets at |\n|---|---|---|---|\n");
  for (const r of rows) {
    const name = r.active ? `**${r.label}** (binding)` : r.label;
    const at = r.resetsAt ? r.resetsAt.toLocaleString() : "n/a";
    md.appendMarkdown(`| ${name} | ${r.percent}% | ${relative(r.resetsAt)} | ${at} |\n`);
  }
  md.appendMarkdown(`\n_Updated ${new Date().toLocaleTimeString()}. Click to open the usage page._`);
  statusItem.tooltip = md;
}

function renderError(message: string): void {
  lastError = message;
  viewProvider?.update();
  statusItem.text = "$(warning) Claude usage";
  statusItem.backgroundColor = undefined;
  statusItem.tooltip = `Claude usage unavailable: ${message}\nClick to open the usage page.`;
}

// --- Explorer view ---------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string
  );
}

class UsageViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: false };
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void refresh();
      }
    });
    this.update();
  }

  update(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.html = this.html();
  }

  private html(): string {
    const { warnAt, errorAt } = thresholds();
    const style = `
      body { padding: 6px 12px 10px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
      .row { margin: 0 0 12px; }
      .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
      .label { font-weight: 600; }
      .binding { opacity: 0.7; font-weight: 400; font-size: 0.9em; margin-left: 4px; }
      .pct { font-variant-numeric: tabular-nums; }
      .track { height: 6px; border-radius: 3px; background: var(--vscode-progressBar-background, #444); opacity: 0.35; position: relative; }
      .wrap { position: relative; height: 6px; }
      .fill { position: absolute; top: 0; left: 0; height: 6px; border-radius: 3px; }
      .ok { background: var(--vscode-charts-blue, #3794ff); }
      .warn { background: var(--vscode-charts-yellow, #cca700); }
      .err { background: var(--vscode-charts-red, #f14c4c); }
      .meta { opacity: 0.7; font-size: 0.9em; margin-top: 3px; }
      .foot { opacity: 0.6; font-size: 0.85em; margin-top: 4px; }
      .error { color: var(--vscode-errorForeground); }
    `;
    let body = "";
    if (lastError && lastRows.length === 0) {
      body = `<p class="error">Usage unavailable: ${escapeHtml(lastError)}</p>`;
    } else if (lastRows.length === 0) {
      body = `<p class="meta">Loading…</p>`;
    } else {
      for (const r of lastRows) {
        const cls = r.percent >= errorAt ? "err" : r.percent >= warnAt ? "warn" : "ok";
        const width = Math.min(100, Math.max(0, r.percent));
        const name = r.label === "5h" ? "Current session" : r.label === "wk" ? "All models" : r.label;
        const resets = r.resetsAt
          ? `Resets in ${relative(r.resetsAt)} (${r.resetsAt.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })})`
          : "";
        body += `<div class="row">
          <div class="head"><span class="label">${escapeHtml(name)}${r.active ? '<span class="binding">binding</span>' : ""}</span><span class="pct">${r.percent}% used</span></div>
          <div class="wrap"><div class="track"></div><div class="fill ${cls}" style="width:${width}%"></div></div>
          <div class="meta">${escapeHtml(resets)}</div>
        </div>`;
      }
      if (lastError) {
        body += `<p class="error">Last refresh failed: ${escapeHtml(lastError)}</p>`;
      }
    }
    const updated = lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : "";
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
      <style>${style}</style></head><body>${body}<div class="foot">${updated}</div></body></html>`;
  }
}

// --- Lifecycle -------------------------------------------------------------

async function refresh(): Promise<void> {
  if (Date.now() < backoffUntil) {
    return;
  }
  try {
    render(await fetchUsage());
  } catch (err) {
    renderError(err instanceof Error ? err.message : String(err));
  }
}

function schedule(): void {
  if (timer) {
    clearInterval(timer);
  }
  const minutes = vscode.workspace
    .getConfiguration("claudeUsageBar")
    .get<number>("refreshIntervalMinutes", 5);
  timer = setInterval(() => void refresh(), Math.max(1, minutes) * 60 * 1000);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.name = "Claude Usage";
  statusItem.command = "claudeUsageBar.openUsagePage";
  statusItem.text = "$(sync~spin) Claude usage";
  applyStatusBarVisibility();

  viewProvider = new UsageViewProvider();

  context.subscriptions.push(
    statusItem,
    vscode.window.registerWebviewViewProvider("claudeUsageBar.view", viewProvider),
    vscode.commands.registerCommand("claudeUsageBar.refresh", () => refresh()),
    vscode.commands.registerCommand("claudeUsageBar.openUsagePage", () =>
      vscode.env.openExternal(vscode.Uri.parse(USAGE_PAGE))
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeUsageBar")) {
        applyStatusBarVisibility();
        schedule();
        void refresh();
      }
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        void refresh();
      }
    })
  );

  await detectUserAgent();
  await refresh();
  schedule();
}

export function deactivate(): void {
  if (timer) {
    clearInterval(timer);
  }
}
