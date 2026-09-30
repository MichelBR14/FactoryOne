import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { openHomologationSession } from "./ggf-homologation-session.mjs";

const COMPANY = "SBODEMOBR2";
const CLAIM_ID = "F1HC260928A";
const RECOVERY_ID = "F1HC260928B";
const LINES_ID = "F1HL260928A";
const MISSING_ID = "F1HC260928MISSING";
const output = ".local/ggf/ggf-closing-real-validation.json";

async function runtime() {
  await mkdir(".local/ggf", { recursive: true, mode: 0o700 });
  const file = ".local/ggf/closing-real-runtime.mjs";
  await build({ stdin: { contents: `
export { SapGgfClosingRepository } from "./webapp/modules/ggf/repository/SapGgfClosingRepository.ts";
export { ServiceLayerError } from "./webapp/core/service/errors.ts";
export { postingHash, transitionClosing, assertClosingConsistency } from "./webapp/modules/ggf/service/GgfClosing.ts";
export { GgfPostingCoordinator } from "./webapp/modules/ggf/service/GgfPostingCoordinator.ts";
`, resolveDir: process.cwd() }, outfile: file, bundle: true, platform: "node", format: "esm" });
  return import(pathToFileURL(resolve(file)).href + `?t=${Date.now()}`);
}

const serial = value => JSON.parse(JSON.stringify(value));
function check(condition, message) { if (!condition) throw new Error(message); }

function draft(id) {
  return { closingId: id, companyDB: COMPANY, periodStart: "2026-09-01", periodEnd: "2026-09-30",
    branch: "1", dimensions: {}, status: "DRAFT", version: 1, lineVersion: 1,
    createdAt: new Date().toISOString(), createdBy: "FactoryOne technical homologation",
    calculatedAt: null, postedAt: null, totalGgf: "0.00", totalAllocated: "0.00",
    totalRevalued: "0.00", sapMaterialRevaluationDocEntry: null,
    sapMaterialRevaluationDocNum: null, sapJournalTransId: null, postingHash: null,
    reopenedFrom: null, cancelledAt: null,
    notes: "TESTE TECNICO UDO; valores ficticios; sem MaterialRevaluation",
    lastError: null, postingBasis: null, proposedPayload: null, lines: [] };
}

async function withTechnicalLines(core, closing, secondValue) {
  const rows = [
    { account: "TECH-GGF", criterion: "DIRECT_COST", orderId: "TECH-OP-1", item: "TECH-ITEM-1",
      warehouse: "TECH-WH", basis: "10.00", percent: "33.33", allocated: "1.00",
      costBefore: "10.00", costAfter: "11.00", revaluation: "1.00", status: "TECHNICAL_ONLY" },
    { account: "TECH-GGF", criterion: "DIRECT_COST", orderId: "TECH-OP-2", item: "TECH-ITEM-2",
      warehouse: "TECH-WH", basis: "20.00", percent: "66.67", allocated: secondValue,
      costBefore: "20.00", costAfter: secondValue === "2.00" ? "22.00" : "22.50",
      revaluation: secondValue, status: "TECHNICAL_ONLY" }
  ];
  const total = secondValue === "2.00" ? "3.00" : "3.50";
  // Stored only for hash/audit verification. This payload is never sent to MaterialRevaluation.
  const payload = { DocDate: "2026-09-28", RevalType: "P",
    Comments: `FactoryOne technical ${closing.closingId}`,
    MaterialRevaluationLines: rows.map(row => ({ ItemCode: row.item, WarehouseCode: row.warehouse,
      Price: Number(row.costAfter), RevaluationIncrementAccount: "TECH-NOT-AN-ACCOUNT" })) };
  const basis = { companyDB: COMPANY, periodStart: closing.periodStart, periodEnd: closing.periodEnd,
    branch: closing.branch, dimensions: closing.dimensions,
    totals: { ggf: total, allocated: total, revalued: total },
    accounts: [{ account: "TECH-GGF", amount: total, percent: "100", criterion: "DIRECT_COST" }],
    lines: rows, inventoryAccounts: {}, payload };
  return { ...closing, totalGgf: total, totalAllocated: total, totalRevalued: total,
    lines: rows, postingBasis: basis, proposedPayload: payload, postingHash: await core.postingHash(basis) };
}

function client(sap, core) {
  const unwrap = result => {
    if (!result.ok) throw new core.ServiceLayerError(
      result.errorMessage || `SAP HTTP ${result.status}`, result.status, result.errorCode);
    return result.data;
  };
  return { get: async path => unwrap(await sap.get(path)),
    post: async (path, body) => unwrap(await sap.postClosingEvidence(path, body)),
    patch: async (path, body) => unwrap(await sap.patchClosingEvidence(path, body)) };
}

async function sapGet(sap, path) {
  const response = await sap.get(path);
  check(response.ok, `SAP read ${path} failed HTTP ${response.status}: ${response.errorMessage}`);
  return response.data;
}

async function rawLines(sap, id, version) {
  const filter = encodeURIComponent(`U_ClosingId eq '${id}' and U_Version eq '${version}'`);
  const count = Number(await sapGet(sap, `FBO_GGF_CLINE/$count?$filter=${filter}`));
  const page = await sapGet(sap, `FBO_GGF_CLINE?$filter=${filter}&$orderby=Code&$top=100`);
  check(Array.isArray(page?.value) && !page["@odata.nextLink"] && page.value.length === count,
    `Incomplete independent audit rows for ${id} version ${version}`);
  return { count, rows: page.value };
}

function compareLines(actual, expected, label) {
  check(actual.length === expected.length, `${label}: line count differs`);
  for (let index = 0; index < expected.length; index++)
    for (const [field, value] of Object.entries(expected[index]))
      check(actual[index]?.[field] === value, `${label}: line ${index + 1} ${field} differs`);
}

async function compareVersion(sap, repo, core, expected) {
  const loaded = await repo.get(expected.closingId);
  check(loaded !== null, `Closing ${expected.closingId} missing in fresh session`);
  await core.assertClosingConsistency(loaded);
  const fields = ["closingId", "companyDB", "periodStart", "periodEnd", "branch", "status",
    "version", "lineVersion", "totalGgf", "totalAllocated", "totalRevalued", "postingHash",
    "sapMaterialRevaluationDocEntry", "sapMaterialRevaluationDocNum", "sapJournalTransId"];
  for (const field of fields) check(loaded[field] === expected[field], `Header ${field} differs`);
  check(JSON.stringify(loaded.dimensions) === JSON.stringify(expected.dimensions), "Dimensions differ");
  check(JSON.stringify(loaded.postingBasis) === JSON.stringify(expected.postingBasis), "Posting basis differs");
  check(JSON.stringify(loaded.proposedPayload) === JSON.stringify(expected.proposedPayload), "Proposed payload differs");
  compareLines(loaded.lines, expected.lines, `version ${expected.version}`);
  const raw = await rawLines(sap, expected.closingId, expected.lineVersion);
  check(raw.count === expected.lines.length, "Independent SAP line count differs");
  const mapping = { account: "U_Account", criterion: "U_Criterion", orderId: "U_OrderId",
    item: "U_Item", warehouse: "U_Warehouse", basis: "U_Basis", percent: "U_Percent",
    allocated: "U_Allocated", costBefore: "U_CostBefore", costAfter: "U_CostAfter",
    revaluation: "U_Revaluation", status: "U_Status" };
  for (let i = 0; i < expected.lines.length; i++) {
    const row = raw.rows[i];
    check(row.U_ClosingId === expected.closingId && row.U_Version === String(expected.lineVersion),
      `SAP line ${i + 1} foreign key/version differs`);
    for (const [field, sapField] of Object.entries(mapping))
      check(String(row[sapField]) === expected.lines[i][field], `SAP line ${i + 1} ${sapField} differs`);
  }
  return { status: loaded.status, version: loaded.version, lineVersion: loaded.lineVersion,
    lineCount: raw.count, totalGgf: loaded.totalGgf, totalAllocated: loaded.totalAllocated,
    totalRevalued: loaded.totalRevalued, postingHash: loaded.postingHash, fieldsCompared: fields.length + 3,
    lineFieldsCompared: expected.lines.length * (Object.keys(mapping).length + 2) };
}

async function expectBlocked(action, label) {
  try { await action(); } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function run() {
  const core = await runtime();
  const evidence = { companyDB: COMPANY, mode: "SAP native UDO technical-only; no MaterialRevaluation",
    startedAt: new Date().toISOString(), ids: { claim: CLAIM_ID, versions: LINES_ID },
    attempts: [], results: {} };
  let a, b, c;
  try {
    a = await openHomologationSession();
    b = await openHomologationSession();
    const repoA = new core.SapGgfClosingRepository(client(a, core));
    const repoB = new core.SapGgfClosingRepository(client(b, core));
    check(await repoA.get(CLAIM_ID) === null && await repoA.get(LINES_ID) === null,
      "Technical ClosingId already exists; refusing overwrite or repeat");
    check(await repoA.getClaim(CLAIM_ID) === null, "Technical claim already exists");
    await repoA.create(draft(CLAIM_ID));
    const hash = "a".repeat(64);
    const payload = { Code: CLAIM_ID, Name: CLAIM_ID, U_ClosingId: CLAIM_ID,
      U_PostingHash: hash, U_ClaimedAt: new Date().toISOString(), U_Version: "1" };
    const attempt = async (sap, session) => {
      const startedAt = new Date().toISOString();
      const response = await sap.postClosingEvidence("FBO_GGF_CLAIM", payload);
      return { id: `ATTEMPT_${session}`, session: `INDEPENDENT_SESSION_${session}`,
        startedAt, endedAt: new Date().toISOString(), httpStatus: response.status,
        acquired: response.ok, sapCode: response.errorCode ?? null,
        sapMessage: response.errorMessage ?? null };
    };
    evidence.attempts = await Promise.all([attempt(a, "A"), attempt(b, "B")]);
    check(evidence.attempts.filter(x => x.acquired).length === 1, "Concurrent claim did not have exactly one winner");
    check(evidence.attempts.filter(x => !x.acquired).length === 1, "Concurrent claim did not block loser");
    await a.close(); a = null;
    await b.close(); b = null;
    c = await openHomologationSession();
    const repoC = new core.SapGgfClosingRepository(client(c, core));
    const claim = await repoC.getClaim(CLAIM_ID);
    const rawClaim = await sapGet(c, `FBO_GGF_CLAIM('${CLAIM_ID}')`);
    const claimCount = Number(await sapGet(c, `FBO_GGF_CLAIM/$count?$filter=${encodeURIComponent(`Code eq '${CLAIM_ID}'`)}`));
    check(claim?.hash === hash && claim.version === 1 && rawClaim.Code === CLAIM_ID && claimCount === 1,
      "Claim not unique or did not survive new session");
    const retry = await c.postClosingEvidence("FBO_GGF_CLAIM", payload);
    check(!retry.ok, "Repeated claim unexpectedly acquired");
    const missing = await repoC.get(MISSING_ID);
    check(missing === null, "Nonexistent closing unexpectedly exists");
    let gatewayCalls = 0;
    const gateway = { post: async () => { gatewayCalls++; throw new Error("Financial POST forbidden in this test"); },
      find: async () => { gatewayCalls++; throw new Error("Financial read forbidden in this test"); } };
    const coordinator = new core.GgfPostingCoordinator(repoC, gateway);
    const incomplete = await expectBlocked(() => coordinator.post(CLAIM_ID, {}), "Incomplete claim");
    const nonexistent = await expectBlocked(() => coordinator.post(MISSING_ID, {}), "Nonexistent closing");
    check(gatewayCalls === 0, "Posting gateway was invoked");
    const claimClosing = await repoC.get(CLAIM_ID);
    const cancelled = { ...core.transitionClosing(claimClosing, "CANCELLED"),
      cancelledAt: new Date().toISOString() };
    await repoC.replace(claimClosing, cancelled);
    const finalState = await expectBlocked(() => coordinator.post(CLAIM_ID, {}), "Final-state claim");
    const retryFinal = await c.postClosingEvidence("FBO_GGF_CLAIM", payload);
    check(!retryFinal.ok && gatewayCalls === 0, "Final-state claim retry unexpectedly acquired");
    evidence.results.claim = { count: claimCount, winner: evidence.attempts.find(x => x.acquired).id,
      persistedHash: claim.hash, persistedVersion: claim.version, retryHttpStatus: retry.status,
      retrySapCode: retry.errorCode ?? null, retrySapMessage: retry.errorMessage ?? null,
      incompleteClosingStatus: claimClosing.status, incompleteBlocked: incomplete,
      nonexistentBlocked: nonexistent, finalStatus: cancelled.status, finalBlocked: finalState,
      finalRetryHttpStatus: retryFinal.status, gatewayCalls };
    await c.close(); c = null;

    a = await openHomologationSession();
    const repo1 = new core.SapGgfClosingRepository(client(a, core));
    const first = await withTechnicalLines(core, draft(LINES_ID), "2.00");
    await repo1.create(first);
    await a.close(); a = null;
    b = await openHomologationSession();
    const repo2 = new core.SapGgfClosingRepository(client(b, core));
    const version1 = await compareVersion(b, repo2, core, first);
    const next = await withTechnicalLines(core, {
      ...core.transitionClosing(first, "CALCULATED"), calculatedAt: new Date().toISOString()
    }, "2.50");
    check(first.postingHash !== next.postingHash, "Functional change did not change hash");
    const bad = { ...next, totalAllocated: "4.00" };
    const mismatchBlocked = await expectBlocked(() => repo2.replace(first, bad), "Mismatched header");
    await repo2.replace(first, next);
    await b.close(); b = null;
    c = await openHomologationSession();
    const repo3 = new core.SapGgfClosingRepository(client(c, core));
    const version2 = await compareVersion(c, repo3, core, next);
    const oldRows = await rawLines(c, LINES_ID, 1);
    check(oldRows.count === first.lines.length && oldRows.rows[1].U_Allocated === "2.00",
      "Version 1 lines were overwritten");
    const existing = await repo3.get(LINES_ID);
    const unchanged = await expectBlocked(() => repo3.replace(existing, {
      ...existing, version: existing.version + 1, status: "POSTED", totalGgf: "999.00"
    }), "Invalid direct POSTED edit");
    check((await repo3.get(LINES_ID)).postingHash === next.postingHash,
      "Rejected edit unexpectedly changed SAP record");
    evidence.results.versions = { version1, version2, version1StillAvailable: oldRows.count,
      hashChanged: first.postingHash !== next.postingHash, mismatchBlocked,
      directPostedEditBlocked: unchanged, note: "POSTED immutability also tested offline; no fake POSTED persisted in SAP" };
    await c.close(); c = null;
    evidence.finishedAt = new Date().toISOString();
    evidence.passed = true;
    await writeFile(output, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    return evidence;
  } catch (error) {
    evidence.finishedAt = new Date().toISOString(); evidence.passed = false;
    evidence.failure = error instanceof Error ? error.message : String(error);
    await writeFile(output, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    throw error;
  } finally {
    await Promise.allSettled([a?.close(), b?.close(), c?.close()]);
  }
}

async function runRecovery() {
  const core = await runtime();
  const evidence = { companyDB: COMPANY, mode: "SAP native UDO claim recovery; no MaterialRevaluation",
    closingId: RECOVERY_ID, startedAt: new Date().toISOString() };
  let a, b, c;
  try {
    a = await openHomologationSession();
    const repoA = new core.SapGgfClosingRepository(client(a, core));
    check(await repoA.get(RECOVERY_ID) === null && await repoA.getClaim(RECOVERY_ID) === null,
      "Recovery ClosingId already exists; refusing overwrite or repeat");
    const first = await withTechnicalLines(core, draft(RECOVERY_ID), "2.00");
    await repoA.create(first);
    const calculated = { ...core.transitionClosing(first, "CALCULATED"), calculatedAt: new Date().toISOString() };
    await repoA.replace(first, calculated);
    const validated = core.transitionClosing(calculated, "VALIDATED");
    await repoA.replace(calculated, validated);
    const ready = core.transitionClosing(validated, "READY_TO_POST");
    await repoA.replace(validated, ready);
    await repoA.claim(RECOVERY_ID, ready.postingHash, ready.version);
    evidence.claimedVersion = ready.version;
    evidence.claimedHash = ready.postingHash;
    await a.close(); a = null;

    b = await openHomologationSession();
    const repoB = new core.SapGgfClosingRepository(client(b, core));
    let gatewayCalls = 0;
    const gateway = { post: async () => { gatewayCalls++; throw new Error("Financial POST forbidden"); },
      find: async () => { gatewayCalls++; throw new Error("Financial read forbidden"); } };
    const coordinator = new core.GgfPostingCoordinator(repoB, gateway);
    const result = await coordinator.post(RECOVERY_ID, ready.postingBasis);
    check(result.status === "POSTING_UNCERTAIN" && result.lastError === "CLAIM_EXISTS_BEFORE_POSTING_STATE" &&
      gatewayCalls === 0, "Existing claim was not fail-closed before financial POST");
    evidence.recovery = { status: result.status, version: result.version, reason: result.lastError,
      gatewayCalls, retryBlocked: await expectBlocked(
        () => coordinator.post(RECOVERY_ID, ready.postingBasis), "Uncertain retry") };
    await b.close(); b = null;

    c = await openHomologationSession();
    const repoC = new core.SapGgfClosingRepository(client(c, core));
    const reread = await repoC.get(RECOVERY_ID);
    const claim = await repoC.getClaim(RECOVERY_ID);
    check(reread.status === "POSTING_UNCERTAIN" && reread.lastError === result.lastError &&
      reread.postingHash === ready.postingHash && claim?.hash === ready.postingHash &&
      claim.version === ready.version, "Claim/recovery state did not persist in new SAP session");
    evidence.freshSession = { closingStatus: reread.status, closingVersion: reread.version,
      claimVersion: claim.version, claimHash: claim.hash, lineCount: reread.lines.length };
    evidence.finishedAt = new Date().toISOString(); evidence.passed = true;
    await writeFile(".local/ggf/ggf-closing-claim-recovery.json", JSON.stringify(evidence, null, 2) + "\n",
      { mode: 0o600 });
    return evidence;
  } catch (error) {
    evidence.finishedAt = new Date().toISOString(); evidence.passed = false;
    evidence.failure = error instanceof Error ? error.message : String(error);
    await writeFile(".local/ggf/ggf-closing-claim-recovery.json", JSON.stringify(evidence, null, 2) + "\n",
      { mode: 0o600 });
    throw error;
  } finally { await Promise.allSettled([a?.close(), b?.close(), c?.close()]); }
}

try {
  const recovery = process.argv[2] === "recovery";
  if (process.argv[2] && !recovery) throw new Error("Only 'recovery' is supported as an optional mode");
  const result = recovery ? await runRecovery() : await run();
  console.log(JSON.stringify({ passed: result.passed, companyDB: result.companyDB,
    ...(recovery ? { closingId: result.closingId, recovery: result.recovery,
      freshSession: result.freshSession, evidenceFile: ".local/ggf/ggf-closing-claim-recovery.json" } :
      { ids: result.ids, attempts: result.attempts, results: result.results, evidenceFile: output }) }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
