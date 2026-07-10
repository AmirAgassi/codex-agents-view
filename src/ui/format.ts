import type { PendingRequest, SessionRecord } from "../domain/types.js";
import type {
  ParsedQuestion,
  ParsedQuestionOption,
  SemanticSessionGroup,
} from "./types.js";

const MARKDOWN_DECORATION = /[*_`#>~]/g;
const WHITESPACE = /\s+/g;
const PATH_SEPARATOR = /[\\/]+/;
const TERMINAL_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

export function compactText(value: string | undefined | null): string {
  return (value ?? "")
    .replace(TERMINAL_CONTROL, "")
    .replace(MARKDOWN_DECORATION, "")
    .replace(WHITESPACE, " ")
    .trim();
}

export function sessionName(record: SessionRecord): string {
  const { thread } = record;
  const candidate =
    thread.name ?? thread.agentNickname ?? compactText(thread.preview).split("\n")[0];

  if (candidate && candidate.trim().length > 0) {
    return compactText(candidate);
  }

  return `session ${thread.id.slice(0, 8)}`;
}

export function sessionSummary(record: SessionRecord): string {
  const lastTurn = record.turns.at(-1);
  const error = lastTurn?.error?.message;
  const planStep = record.plan.find(
    (step) => step.status === "inProgress" || step.status === "in_progress",
  )?.step;

  return (
    compactText(record.activity) ||
    compactText(planStep) ||
    compactText(record.latestText) ||
    compactText(error) ||
    compactText(record.thread.preview) ||
    "No activity yet"
  );
}

export function semanticGroup(record: SessionRecord): SemanticSessionGroup {
  const { status } = record.thread;
  if (status.type === "notLoaded") return "stale";
  const isWaiting =
    record.pendingRequests.length > 0 ||
    (status.type === "active" &&
      status.activeFlags.some(
        (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
      ));

  if (isWaiting) {
    return "needsInput";
  }

  if (status.type === "active" || record.activeTurnId !== undefined) {
    return "working";
  }

  return "completed";
}

export function formatAge(timestamp: number, now = Date.now()): string {
  // App-server timestamps may be Unix seconds or milliseconds.
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  const elapsed = Math.max(0, now - milliseconds);
  const seconds = Math.floor(elapsed / 1000);

  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks}w`;
  return `${Math.floor(days / 30)}mo`;
}

export function basename(path: string): string {
  const pieces = path.split(PATH_SEPARATOR).filter(Boolean);
  return pieces.at(-1) ?? path;
}

export function abbreviateHome(path: string): string {
  const home = process.env.HOME;
  if (home && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

export function isApprovalRequest(request: PendingRequest): boolean {
  return request.method.toLowerCase().includes("approval");
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = compactText(value);
  return compact.length > 0 ? compact : undefined;
}

function optionFromUnknown(value: unknown): ParsedQuestionOption | undefined {
  if (typeof value === "string") return { label: value };
  if (value === null || typeof value !== "object") return undefined;
  const option = value as Record<string, unknown>;
  const label = stringValue(option.label) ?? stringValue(option.value);
  if (!label) return undefined;
  return { label, description: stringValue(option.description) };
}

export function parseQuestions(request: PendingRequest): ParsedQuestion[] {
  const rawQuestions = request.params.questions;
  if (!Array.isArray(rawQuestions)) return [];

  const parsed: ParsedQuestion[] = [];
  for (const [index, value] of rawQuestions.entries()) {
    if (value === null || typeof value !== "object") continue;
    const question = value as Record<string, unknown>;
    const text = stringValue(question.question) ?? stringValue(question.prompt);
    if (!text) continue;
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    const options = rawOptions
      .map(optionFromUnknown)
      .filter((option): option is ParsedQuestionOption => option !== undefined);

    parsed.push({
      id: stringValue(question.id) ?? `question_${index + 1}`,
      header: stringValue(question.header),
      question: text,
      isSecret: question.isSecret === true,
      options,
    });
  }

  return parsed;
}

export function requestDescription(request: PendingRequest): string {
  const params = request.params;
  const command = params.command;
  const commandText = Array.isArray(command)
    ? command.filter((part): part is string => typeof part === "string").join(" ")
    : stringValue(command);

  return (
    stringValue(params.reason) ??
    stringValue(params.description) ??
    stringValue(params.message) ??
    commandText ??
    request.method
  );
}

export function requestCommand(request: PendingRequest): string | undefined {
  const command = request.params.command;
  if (Array.isArray(command)) {
    const parts = command.filter((part): part is string => typeof part === "string");
    return parts.length > 0 ? compactText(parts.join(" ")) : undefined;
  }
  return stringValue(command);
}

export function requestCwd(request: PendingRequest): string | undefined {
  return stringValue(request.params.cwd);
}

function compactJson(value: unknown): string | undefined {
  try {
    const rendered = compactText(JSON.stringify(value)).slice(0, 220);
    return rendered.length > 0 && rendered !== "{}" && rendered !== "[]"
      ? rendered
      : undefined;
  } catch {
    return undefined;
  }
}

/** Human-readable capability scope for approval requests. */
export function requestScopeDetails(request: PendingRequest): string[] {
  const { params } = request;
  const details: string[] = [];
  const network = params.networkApprovalContext;
  if (typeof network === "object" && network !== null && !Array.isArray(network)) {
    const value = network as Record<string, unknown>;
    const host = stringValue(value.host) ?? stringValue(value.hostname);
    const protocol = stringValue(value.protocol);
    const port = typeof value.port === "number" ? String(value.port) : stringValue(value.port);
    const target = host
      ? `${protocol ? `${protocol}://` : ""}${host}${port ? `:${port}` : ""}`
      : compactJson(network);
    if (target) details.push(`Network: ${target}`);
  }

  const grantRoot = stringValue(params.grantRoot);
  if (grantRoot) details.push(`File access: ${abbreviateHome(grantRoot)}`);

  const permissions = params.permissions;
  if (typeof permissions === "object" && permissions !== null) {
    const rendered = compactJson(permissions);
    if (rendered) details.push(`Permissions: ${rendered}`);
  }

  const additional = compactJson(params.additionalPermissions);
  if (additional) details.push(`Additional scope: ${additional}`);

  const amendment = compactJson(
    params.proposedExecpolicyAmendment ?? params.proposedExecPolicyAmendment,
  );
  if (amendment) details.push(`Policy change: ${amendment}`);

  return details;
}
