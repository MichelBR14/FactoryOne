# GGF V2 Phase 7E.1 - Economic Scenario

## Scope

This is an offline, isolated accounting model for `PHASE7E_TECHNICAL`. It creates no SAP session, claim, execution, or financial document. The future gateway contract is descriptive and validates a frozen allowlist; `financialWritesEnabled` remains `false` and there is no POST adapter.

## Economic rule

The plan sets `TotalAdjustment = StockAdjustment + ConsumedAdjustment = R$ 2.00`. Its composition is GGF R$ 1.20 and MOD R$ 0.80. Each category is split evenly across stock and consumed for this technical fixture: GGF R$ 0.60 + R$ 0.60; MOD R$ 0.40 + R$ 0.40.

The FIFO candidate is `F1GGF26F01`, warehouse `01`, layer `2790/0`, 5 UN at R$ 12.00. The proposed R$ 1.00 stock effect is represented by changing that layer's unit price by R$ 0.20 to R$ 12.20: `5 x (12.20 - 12.00) = R$ 1.00`. This is a proposed offline value only; the open layer, price, account determination, and stock must be reread before any future authorization.

The three document roles are deliberately different:

| Order | Document | Debit | Credit | Amount |
| --- | --- | --- | --- | ---: |
| 1 | MaterialRevaluation | Stock `1.01.02.01.01` R$ 1.00 | SAP revaluation offset `5.03.01.01.04` R$ 1.00 | R$ 1.00 |
| 2 | Journal Entry CPV | CPV `5.01.01.01.01` R$ 1.00 | Transit `5.04.01.01.05` R$ 1.00 | R$ 1.00 |
| 3 | Journal Entry closing/reclassification | Transit R$ 1.00 + revaluation offset R$ 1.00 | GGF closing `5.04.01.01.03` R$ 1.20 + MOD closing `5.04.01.01.04` R$ 0.80 | R$ 2.00 |

The revaluation offset is included because the already documented FIFO SAP effect debited stock and credited `5.03.01.01.04`; it is not treated as a transit posting. The closing entry clears both this offset and the CPV transit credit, then credits the GGF/MOD closing accounts using the split already present in the plan. The close is a reclassification, not a third economic adjustment.

## Account-balance memory

All opening balances below are zero **inside this isolated fixture**. They are not SAP balances and do not reuse the 7C/7D documents. Debit balances are positive; credit balances are negative. Amounts are cents.

| Account / balance | Opening | After document 1 | After document 2 | After document 3 |
| --- | ---: | ---: | ---: | ---: |
| Stock `1.01.02.01.01` | 0 | +100 | +100 | +100 |
| CPV `5.01.01.01.01` | 0 | 0 | +100 | +100 |
| Transit `5.04.01.01.05` | 0 | 0 | -100 | 0 |
| Revaluation offset `5.03.01.01.04` | 0 | -100 | -100 | 0 |
| GGF closing `5.04.01.01.03` | 0 | 0 | 0 | -120 |
| MOD closing `5.04.01.01.04` | 0 | 0 | 0 | -80 |

Document 1 debit equals credit at 100 cents. Document 2 debit equals credit at 100 cents. Document 3 debits and credits each total 200 cents. Transit ends at zero, as does the SAP revaluation offset used in this fixture. The only economic destinations are stock 100 cents and consumed/CPV 100 cents; their sum is 200 cents. The closing JE is excluded from that sum, preventing double counting.

## Signs and rounding

The pure model reverses debit/credit sides for negative stock, consumed, and GGF/MOD amounts while preserving the signed total. It rejects mixed-sign or inconsistent totals in this isolated scope. `allocateCentsByWeights()` uses integer cents, largest remainder, then stable key order for ties. A one-cent 50/50 split assigns the residual to `GGF`; negative one cent reverses the signed result without losing the cent.

## Future gateway contract

`GgfPhase7EEconomicScenario.ts` exposes `PHASE7E_TECHNICAL` with `financialWritesEnabled: false`. Its future allowlist is limited to:

- Exactly one MaterialRevaluation, one Journal Entry CPV, and one closing Journal Entry, in that order.
- Company `SBODEMOBR2`, branch 1, local currency `R$`.
- Total adjustment at most 200 cents; stock and consumed at most 100 cents each; closing entry at most 200 cents.
- The single item/warehouse/FIFO layer above, with the proposed R$ 12.20 unit price.
- Accounts `1.01.02.01.01`, `5.03.01.01.04`, `5.01.01.01.01`, `5.04.01.01.05`, `5.04.01.01.03`, and `5.04.01.01.04` only.
- Required ClosingId, PostingHash, and a recomputed RequestHash for every exact request.

Any changed account, branch, document count/order/value, item, warehouse, layer, quantity, price, payload, or hash is rejected by the offline contract. This does not grant SAP permissions or permit a POST.

## Remaining SAP proof

The SAP FIFO proof for the earlier test showed inventory debit `1.01.02.01.01` and revaluation credit `5.03.01.01.04`. It did not prove that a future 7E closing Journal Entry should post this technical revaluation offset against GGF/MOD for a production rule. The phase 7E.1 model demonstrates arithmetic only. Before any financial write, the functional accounting owner must approve this reclassification, and the SAP candidate layer/account determination, open period, branch, dimensions, metadata, persisted plan, claim, execution, and all three request hashes must be revalidated. No financial POST occurred for this phase.
