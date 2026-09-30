"""Invented test data only; no saved SAP captures or network dependencies."""
import runpy
import unittest

checker = runpy.run_path("scripts/ggf-independent-check.py")
distribute, verify, scaled = (checker[name] for name in ("distribute", "verify", "scaled"))


def fixture():
    date = "2026-09-10T00:00:00Z"
    request = {"company": "SBODEMOBR2", "purpose": "CONTA DE VALIDACAO TECNICA - NAO GGF FUNCIONAL",
               "account": "TEST-ACCOUNT", "description": "Invented technical account", "percent": "100",
               "filter": {"start": "2026-09-01", "end": "2026-09-30", "branch": "", "costCenter": ""}}
    scenario = {"id": "test", "criterion": "DIRECT_COST", "orderEntries": [1, 2]}
    rows = {"ChartOfAccounts": [{"Code": request["account"], "Name": request["description"]}],
            "JournalEntries": [{"JdtNum": 99, "ReferenceDate": date, "JournalEntryLines": [
                {"Line_ID": 0, "AccountCode": "TEST-ACCOUNT", "Debit": 0.01, "Credit": 0, "BPLID": 1},
                {"Line_ID": 1, "AccountCode": "TEST-OTHER", "Debit": 0, "Credit": 0.01, "BPLID": 1}]}],
            "ProductionOrders": [], "InventoryGenExits": [], "InventoryGenEntries": [], "Resources": [], "ResourceGroups": []}
    engine_orders, traces = [], []
    for key, minor, percent, final in [(1, 2, "40.000000", 0), (2, 3, "60.000000", 1)]:
        component = {"LineNumber": 0, "ItemNo": "TEST-MATERIAL", "ItemType": "pit_Item", "IssuedQuantity": 1}
        rows["ProductionOrders"].append({"AbsoluteEntry": key, "DocumentNumber": key, "ItemNo": "TEST-PRODUCT",
            "PostingDate": date, "ClosingDate": date, "PlannedQuantity": 1, "CompletedQuantity": 1, "InventoryUOM": "UN",
            "ProductionOrderStatus": "boposClosed", "ProductionOrderType": "bopotStandard", "ProductionOrderLines": [component]})
        for entity in ["InventoryGenExits", "InventoryGenEntries"]:
            receipt = entity == "InventoryGenEntries"
            rows[entity].append({"DocEntry": key, "DocDate": date, "DocCurrency": "R$", "Cancelled": "tNO", "CancelStatus": "csNo",
                "DocumentLines": [{"LineNum": 0, "BaseType": 202, "BaseEntry": key, "BaseLine": 0,
                    "ItemCode": "TEST-PRODUCT" if receipt else "TEST-MATERIAL", "ItemType": "dit_Item", "Quantity": 1,
                    "InventoryQuantity": 1, "MeasureUnit": "UN", "UnitPrice": minor / 100, "LineTotal": minor / 100,
                    "UseBaseUnits": "tYES", "TransactionType": "botrntComplete"}]})
        engine_orders.append({"order": {"id": str(key), "directCost": f"0.0{minor}", "quantity": "1",
            "directCostComponents": [{"sourceRefs": [f"InventoryGenExits({key})/0"], "code": "TEST-MATERIAL", "kind": "dit_Item", "amount": f"0.0{minor}"}]}, "allocated": str(final)})
        traces.append({"orderId": str(key), "basis": str(minor), "totalBasis": "5", "roundingMinor": str(final),
            "remainder": str(minor), "participationPercent": percent, "criterion": "DIRECT_COST", "account": "TEST-ACCOUNT", "amount": str(final),
            "accountAmount": "1", "accountPercent": "100", "applicableAmount": "1", "poolAmount": "1", "accountRoundingNumerator": "0",
            "basisDecimals": 2, "basisUnit": "SAP_LOCAL"})
    reads = []
    for entity, values in rows.items():
        reads.extend([{"method": "GET", "path": entity + "/$count", "data": str(len(values))},
                      {"method": "GET", "path": entity + "?$select=test", "data": {"value": values}},
                      {"method": "GET", "path": entity + "/$count", "data": str(len(values))}])
    source = {"request": request, "scenario": scenario, "reads": reads, "pointReads": [],
              "connection": {"company": "SBODEMOBR2", "tlsVerified": True}}
    report = {"postingBlocked": True, "functionalGgfApproved": False, "result": {
        "snapshot": {"filter": request["filter"], "origin": "sap", "balances": [{"amount": "0.01"}]},
        "configuration": {"accounts": [{"name": request["description"]}]},
        "accounts": [{"percent": "100", "periodAmount": "1", "applicableAmount": "1", "roundingNumerator": "0", "distributed": "1", "difference": "0"}],
        "total": "1", "distributed": "1", "difference": "0", "orders": engine_orders, "traces": traces}}
    return source, report


class IndependentRateioTests(unittest.TestCase):
    def test_exact_decimal_not_binary_float(self):
        self.assertEqual(scaled("10000000000.29"), 1000000000029)
        with self.assertRaises(ValueError):
            scaled("0.001")

    def test_applicable_percentage_and_half_cent(self):
        self.assertEqual(distribute(3, "50", {"A": 1})[0], 2)
        self.assertEqual(distribute(-3, "50", {"A": 1})[0], -2)

    def test_largest_remainder_not_nearest_per_line(self):
        amount, rows = distribute(2, "100", {"C": 1, "B": 1, "A": 1})
        self.assertEqual(amount, 2)
        self.assertEqual([r["finalMinor"] for r in rows], [1, 1, 0])

    def test_negative_sign(self):
        _, rows = distribute(-1, "100", {"A": 1, "B": 2})
        self.assertEqual([r["finalMinor"] for r in rows], [0, -1])

    def test_missing_or_invalid_weights(self):
        for weights in [{}, {"A": 0}, {"A": -1, "B": 2}]:
            with self.assertRaises(ValueError):
                distribute(100, "100", weights)

    def test_invalid_percent(self):
        for percent in ["-1", "100.01", "0.001"]:
            with self.assertRaises(ValueError):
                distribute(100, percent, {"A": 1})

    def test_complete_fake_source_reconciles(self):
        result = verify(*fixture())
        self.assertTrue(result["passed"])
        self.assertEqual(result["differences"], [])
        self.assertEqual(result["comparison"][1]["grossMinorExact"], "3/5")

    def test_detects_wrong_final_even_if_engine_claims_zero_difference(self):
        source, engine = fixture()
        engine["result"]["traces"][0]["amount"] = "1"
        self.assertFalse(verify(source, engine)["passed"])

    def test_detects_wrong_basis_percent_and_rounding(self):
        for field, value in [("basis", "9"), ("roundingMinor", "0"), ("participationPercent", "50.000000"), ("poolAmount", "2")]:
            source, engine = fixture()
            engine["result"]["traces"][1][field] = value
            self.assertFalse(verify(source, engine)["passed"])

    def test_detects_corrupted_component(self):
        source, engine = fixture()
        engine["result"]["orders"][0]["order"]["directCostComponents"][0]["amount"] = "0.03"
        self.assertFalse(verify(source, engine)["passed"])

    def test_duplicate_and_count_mismatch_rejected(self):
        source, engine = fixture()
        source["reads"][0]["data"] = "99"
        with self.assertRaisesRegex(ValueError, "Count mismatch"):
            verify(source, engine)
        source, engine = fixture()
        source["reads"][1]["data"]["value"] *= 2
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            verify(source, engine)

    def test_business_write_and_wrong_company_rejected(self):
        source, engine = fixture()
        source["reads"][0]["method"] = "POST"
        with self.assertRaisesRegex(ValueError, "Business write"):
            verify(source, engine)
        source, engine = fixture()
        source["connection"]["company"] = "OTHER"
        with self.assertRaisesRegex(ValueError, "Company"):
            verify(source, engine)

    def test_no_fallback_on_absorption_account_or_foreign_currency(self):
        source, engine = fixture()
        source["request"]["account"] = "4.01.01.04.07"
        with self.assertRaisesRegex(ValueError, "absorption"):
            verify(source, engine)
        source, engine = fixture()
        next(r for r in source["reads"] if r["path"].startswith("InventoryGenEntries?"))["data"]["value"][0]["DocCurrency"] = "USD"
        with self.assertRaisesRegex(ValueError, "document"):
            verify(source, engine)

    def test_quantity_comparison_and_stable_tie(self):
        source, engine = fixture()
        source["scenario"]["criterion"] = "QUANTITY"
        for index, trace in enumerate(engine["result"]["traces"]):
            trace.update(criterion="QUANTITY", basis="1000000", totalBasis="2000000",
                         remainder="1000000", participationPercent="50.000000", basisDecimals=6,
                         basisUnit="UN", amount=str(1-index), roundingMinor=str(1-index))
            engine["result"]["orders"][index]["allocated"] = str(1-index)
        result = verify(source, engine)
        self.assertTrue(result["passed"])
        self.assertEqual([r["finalMinor"] for r in result["comparison"]], [1, 0])

    def test_same_unit_does_not_make_different_products_comparable(self):
        source, engine = fixture()
        source["scenario"]["criterion"] = "QUANTITY"
        orders = next(r for r in source["reads"] if r["path"].startswith("ProductionOrders?"))["data"]["value"]
        receipts = next(r for r in source["reads"] if r["path"].startswith("InventoryGenEntries?"))["data"]["value"]
        orders[1]["ItemNo"] = "TEST-DIFFERENT"
        receipts[1]["DocumentLines"][0]["ItemCode"] = "TEST-DIFFERENT"
        with self.assertRaisesRegex(ValueError, "Non-comparable"):
            verify(source, engine)

    def test_receipt_value_is_not_silently_substituted(self):
        source, engine = fixture()
        receipts = next(r for r in source["reads"] if r["path"].startswith("InventoryGenEntries?"))["data"]["value"]
        receipts[0]["DocumentLines"][0]["LineTotal"] = 0.99
        with self.assertRaisesRegex(ValueError, "Issues/receipts"):
            verify(source, engine)


if __name__ == "__main__":
    unittest.main()
