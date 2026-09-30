// Offline diagnostic arithmetic; never produces an allocation-ready snapshot.
export function decimal(value) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) >= 1e12 ||
    !/^-?\d+(\.\d{1,6})?$/.test(String(value))
  )
    throw new Error("Invalid source decimal");
  const [whole, fraction = ""] = String(value).replace(/^-/, "").split(".");
  return (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"))) * (value < 0 ? -1n : 1n);
}

export function format(value) {
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${abs / 1000000n}.${String(abs % 1000000n).padStart(6, "0")}`;
}

export function rejectContinuation(value) {
  if (!value || typeof value !== "object") return;
  for (const [name, child] of Object.entries(value)) {
    if (/nextLink$/i.test(name) && child != null) throw new Error("Incomplete nested collection");
    rejectContinuation(child);
  }
}

export function readScope(read) {
  return read.id === "JournalEntries"
    ? "September 2026 by ReferenceDate; all branches/dimensions"
    : "all master records";
}

export function summarizeJournals(journals, accounts, start, end) {
  const names = new Map(accounts.map((a) => [a.Code, a.Name]));
  const groups = new Map();
  const ids = new Set();
  let debit = 0n,
    credit = 0n,
    lineCount = 0;
  for (const journal of journals) {
    rejectContinuation(journal);
    if (!Number.isSafeInteger(journal.JdtNum) || ids.has(journal.JdtNum))
      throw new Error("Duplicate or missing journal key");
    ids.add(journal.JdtNum);
    const date = journal.ReferenceDate?.slice(0, 10);
    if (!date || date < start || date > end) throw new Error("Journal outside selected period");
    if (!Array.isArray(journal.JournalEntryLines)) throw new Error("Missing journal lines");
    const lines = new Set();
    let jd = 0n,
      jc = 0n;
    for (const line of journal.JournalEntryLines) {
      if (!Number.isSafeInteger(line.Line_ID) || lines.has(line.Line_ID))
        throw new Error("Duplicate or missing journal line");
      lines.add(line.Line_ID);
      if (!names.has(line.AccountCode)) throw new Error("Unknown ledger account");
      const dimensions = [
        "CostingCode",
        "CostingCode2",
        "CostingCode3",
        "CostingCode4",
        "CostingCode5"
      ].map((field) => {
        if (!(field in line)) throw new Error("Missing dimension field");
        return line[field];
      });
      if (!("BPLID" in line)) throw new Error("Missing branch field");
      const key = JSON.stringify([line.AccountCode, line.BPLID, ...dimensions]);
      const group = groups.get(key) ?? {
        account: line.AccountCode,
        name: names.get(line.AccountCode),
        branch: line.BPLID,
        dimensions,
        debit: 0n,
        credit: 0n,
        journals: new Set(),
        origins: new Map(),
        refs: []
      };
      const d = decimal(line.Debit),
        c = decimal(line.Credit);
      jd += d;
      jc += c;
      group.debit += d;
      group.credit += c;
      group.journals.add(journal.JdtNum);
      const origin = journal.OriginalJournal;
      if (typeof origin !== "string" || !origin) throw new Error("Missing journal origin");
      const source = group.origins.get(origin) ?? {
        journals: new Set(),
        lines: 0,
        debit: 0n,
        credit: 0n
      };
      source.journals.add(journal.JdtNum);
      source.lines++;
      source.debit += d;
      source.credit += c;
      group.origins.set(origin, source);
      group.refs.push(`${journal.JdtNum}/${line.Line_ID}`);
      groups.set(key, group);
      lineCount++;
    }
    if (jd !== jc) throw new Error(`Unbalanced source journal ${journal.JdtNum}`);
    debit += jd;
    credit += jc;
  }
  return {
    allocationReady: false,
    postingBlocked: true,
    start,
    end,
    journalCount: ids.size,
    lineCount,
    debit: format(debit),
    credit: format(credit),
    accounts: [...groups.values()]
      .sort((a, b) =>
        JSON.stringify([a.account, a.branch, a.dimensions]).localeCompare(
          JSON.stringify([b.account, b.branch, b.dimensions])
        )
      )
      .map((g) => ({
        ...g,
        debit: format(g.debit),
        credit: format(g.credit),
        net: format(g.debit - g.credit),
        journals: [...g.journals],
        journalCount: g.journals.size,
        lineCount: g.refs.length,
        origins: [...g.origins].map(([origin, s]) => ({
          origin,
          journals: [...s.journals],
          lines: s.lines,
          debit: format(s.debit),
          credit: format(s.credit),
          net: format(s.debit - s.credit)
        }))
      }))
  };
}
