export type Phase7EDocumentKey = "MaterialRevaluation" | "JournalEntry.CPV" | "JournalEntry.Closing";

const DOCUMENTS: ReadonlyArray<{ type: Phase7EDocumentKey; code: string; sequence: number }> = [
  { type: "MaterialRevaluation", code: "MR", sequence: 1 },
  { type: "JournalEntry.CPV", code: "CPV", sequence: 2 },
  { type: "JournalEntry.Closing", code: "CLS", sequence: 3 }
];

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 is unavailable for Phase 7E OrderId generation");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Produces SAP-safe, deterministic row identifiers while retaining document type and sequence. */
export async function buildPhase7EOrderIds(
  closingId: string,
  digest: (value: string) => Promise<string> = sha256
): Promise<Record<Phase7EDocumentKey, string>> {
  if (!closingId.trim()) throw new Error("ClosingId is required for Phase 7E OrderId generation");
  const entries = await Promise.all(DOCUMENTS.map(async document => {
    const fingerprint = await digest(`${closingId}\u0000${document.type}\u0000${document.sequence}`);
    if (!/^[a-f0-9]{16,}$/i.test(fingerprint)) throw new Error("OrderId digest must contain at least 16 hexadecimal characters");
    const orderId = `7E-${document.code}-${String(document.sequence).padStart(2, "0")}-${fingerprint.slice(0, 16).toUpperCase()}`;
    if (orderId.length > 30) throw new Error("Generated Phase 7E OrderId exceeds the SAP field limit");
    return [document.type, orderId] as const;
  }));
  const ids = entries.map(([, orderId]) => orderId);
  if (new Set(ids).size !== ids.length) throw new Error("Phase 7E OrderId collision detected within the Closing");
  return Object.fromEntries(entries) as Record<Phase7EDocumentKey, string>;
}

