export interface GgfPostingExecutionIdentity {
  closingId: string;
  closingVersion: number;
  postingPlanVersion: number;
  postingHash: string;
}

export type GgfExecutionStatus = "READY" | "POSTING" | "POSTING_PARTIAL" | "POSTING_UNCERTAIN" |
  "POSTED" | "FAILED" | "PAYLOAD_INTEGRITY_VIOLATION";
export type GgfDocumentExecutionStatus = "PENDING" | "SENDING" | "SENT" | "UNCERTAIN" | "RECONCILED" | "FAILED";
export type GgfDocumentReconciliationStatus = "NOT_RUN" | "MATCHED" | "NO_MATCH" | "AMBIGUOUS" | "INCOMPLETE";

export interface GgfDocumentAttempt {
  attempt: number;
  requestHash: string;
  startedAt: string;
  responseReceivedAt: string | null;
  status: GgfDocumentExecutionStatus;
  sanitizedError: string | null;
}

export interface GgfPostingDocumentLedger {
  executionId: string;
  identity: GgfPostingExecutionIdentity;
  sequence: number;
  documentType: string;
  plannedAmount: string;
  currency: string | null;
  status: GgfDocumentExecutionStatus;
  requestHash: string | null;
  request: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
  dependencies: string[];
  attemptCount: number;
  attemptStartedAt: string | null;
  responseReceivedAt: string | null;
  sapDocEntry: number | null;
  sapDocNum: number | null;
  sapTransId: number | null;
  reconciledAt: string | null;
  reconciliationStatus: GgfDocumentReconciliationStatus;
  sanitizedError: string | null;
  attempts: GgfDocumentAttempt[];
}

export interface GgfPostingExecutionRecord {
  executionId: string;
  identity: GgfPostingExecutionIdentity;
  status: GgfExecutionStatus;
  startedAt: string;
  finishedAt: string | null;
  startedBy: string | null;
  lastError: string | null;
  totalExpected: string;
  totalPosted: string;
  totalReconciled: string;
  documents: GgfPostingDocumentLedger[];
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  throw new Error("Posting execution contains a non-JSON value");
}

export function canonicalPostingValue(value: unknown): string {
  return JSON.stringify(canonical(value));
}

async function sha256(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 is unavailable for posting execution");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalPostingValue(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function calculateGgfExecutionId(identity: GgfPostingExecutionIdentity): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(identity.closingId) ||
      !Number.isSafeInteger(identity.closingVersion) || identity.closingVersion < 1 ||
      !Number.isSafeInteger(identity.postingPlanVersion) || identity.postingPlanVersion < 1 ||
      !/^[a-f0-9]{64}$/.test(identity.postingHash)) throw new Error("Invalid financial execution identity");
  return `F1EX${(await sha256({ closingId: identity.closingId, closingVersion: identity.closingVersion,
    postingPlanVersion: identity.postingPlanVersion, postingHash: identity.postingHash })).slice(0, 40)}`;
}

export async function calculateGgfRequestHash(payload: Record<string, unknown>): Promise<string> {
  return sha256(payload);
}

export function assertExecutionIdentity(actual: GgfPostingExecutionIdentity,
  expected: GgfPostingExecutionIdentity): void {
  if (actual.closingId !== expected.closingId || actual.closingVersion !== expected.closingVersion ||
      actual.postingPlanVersion !== expected.postingPlanVersion || actual.postingHash !== expected.postingHash)
    throw new Error("Persisted execution identity differs from Closing and PostingPlan");
}

export function executionTotals(documents: GgfPostingDocumentLedger[]) {
  const sum = (predicate: (document: GgfPostingDocumentLedger) => boolean) => documents
    .filter(predicate).reduce((total, document) => total + BigInt(document.plannedAmount), 0n).toString();
  return {
    expected: sum(() => true),
    posted: sum(document => ["SENT", "RECONCILED"].includes(document.status)),
    reconciled: sum(document => document.status === "RECONCILED")
  };
}
