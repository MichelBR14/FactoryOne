"""Offline SAP capture reconciliation. No FactoryOne imports and no network client."""
import csv
import hashlib
import json
import sys
from decimal import Decimal, ROUND_HALF_UP, localcontext
from fractions import Fraction
from pathlib import Path
from urllib.parse import urlsplit, parse_qs


def require(condition, message):
    if not condition:
        raise ValueError(message)


def scaled(value, places=2):
    require(value is not None and not isinstance(value, bool), "Missing decimal")
    number = Decimal(str(value)) * 10 ** places
    require(number.is_finite() and number == number.to_integral_value(), "Non-exact scaled decimal")
    return int(number)


def fraction_text(value):
    return f"{value.numerator}/{value.denominator}"


def display(value, places=6):
    with localcontext() as ctx:
        ctx.prec = 60
        return str((Decimal(value.numerator) / Decimal(value.denominator)).quantize(
            Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP))


def distribute(balance_minor, percent, weights):
    """Independent rational quotas: floors, then ranked exact fractional parts."""
    percentage = Decimal(str(percent))
    require(0 <= percentage <= 100 and scaled(percent) >= 0, "Invalid percentage")
    applicable = int((Decimal(balance_minor) * percentage / 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    require(weights and all(v >= 0 for v in weights.values()) and sum(weights.values()) > 0, "No positive base")
    total = sum(weights.values())
    sign = -1 if applicable < 0 else 1
    quotas = {key: Fraction(abs(applicable) * value, total) for key, value in weights.items()}
    floors = {key: quota.numerator // quota.denominator for key, quota in quotas.items()}
    residual = abs(applicable) - sum(floors.values())
    ranked = sorted(weights, key=lambda key: (-(quotas[key] - floors[key]), key))
    extras = set(ranked[:residual])
    return applicable, [{
        "orderId": key, "basis": weights[key], "totalBasis": total,
        "participationExact": fraction_text(Fraction(weights[key] * 100, total)),
        "participationPercent": display(Fraction(weights[key] * 100, total)),
        "grossMinorExact": fraction_text(quotas[key] * sign),
        "grossMinorDecimal": display(quotas[key] * sign, 12),
        "truncatedMinor": floors[key] * sign,
        "roundingMinor": sign if key in extras else 0,
        "finalMinor": (floors[key] + (key in extras)) * sign,
        "adjustmentFromGrossMinorExact": fraction_text((floors[key] + (key in extras) - quotas[key]) * sign),
        "remainder": (abs(applicable) * weights[key]) % total
    } for key in sorted(weights)]


def collections(source):
    keys = {"ChartOfAccounts": "Code", "JournalEntries": "JdtNum", "ProductionOrders": "AbsoluteEntry",
            "InventoryGenEntries": "DocEntry", "InventoryGenExits": "DocEntry", "Resources": "Code", "ResourceGroups": "Code"}
    rows = {entity: [] for entity in keys}
    counts = {entity: [] for entity in keys}
    for read in source["reads"]:
        require(read["method"] == "GET", "Business write present")
        path = urlsplit(read["path"]).path
        if path in rows:
            rows[path].extend(read["data"]["value"])
        elif path.endswith("/$count") and path[:-7] in counts:
            counts[path[:-7]].append(int(read["data"]))
    for entity, values in rows.items():
        require(len({row[keys[entity]] for row in values}) == len(values), f"Duplicate {entity}")
        require(len(counts[entity]) >= 2 and all(n == len(values) for n in counts[entity]), f"Count mismatch {entity}")
    return rows


def verify(source, report):
    request, scenario = source["request"], source["scenario"]
    require(source["connection"]["company"] == request["company"] == "SBODEMOBR2", "Company mismatch")
    require(source["connection"]["tlsVerified"] is True, "Unverified TLS")
    require(request["purpose"] == "CONTA DE VALIDACAO TECNICA - NAO GGF FUNCIONAL", "Technical purpose missing")
    require(request["account"] != "4.01.01.04.07", "Resource absorption account excluded")
    require(report["postingBlocked"] is True and report["functionalGgfApproved"] is False, "Unsafe report flags")
    rows = collections(source)
    start, end = request["filter"]["start"], request["filter"]["end"]
    require(not request["filter"]["branch"] and not request["filter"]["costCenter"], "Unsupported filtering")
    selected = set(scenario["orderEntries"])
    require({o["AbsoluteEntry"] for o in rows["ProductionOrders"]} == selected, "OP selection mismatch")
    account = next(a for a in rows["ChartOfAccounts"] if a["Code"] == request["account"])
    require(account["Name"] == request["description"], "Account description differs from SAP")
    ledger_lines = []
    for j in rows["JournalEntries"]:
        require(start <= j["ReferenceDate"][:10] <= end, "Ledger outside period")
        lines = j["JournalEntryLines"]
        require(len({l["Line_ID"] for l in lines}) == len(lines), "Duplicate ledger line")
        require(sum(scaled(l["Debit"]) - scaled(l["Credit"]) for l in lines) == 0, "Unbalanced source journal")
        for line in lines:
            if line["AccountCode"] == request["account"]:
                ledger_lines.append({"entity": "JournalEntries", "transId": j["JdtNum"], "line": line["Line_ID"],
                    "date": j["ReferenceDate"], "fields": ["JournalEntryLines.Debit", "JournalEntryLines.Credit"],
                    "debitMinor": scaled(line["Debit"]), "creditMinor": scaled(line["Credit"]),
                    "branch": line["BPLID"], "dimensions": [line.get("CostingCode" + (str(i) if i > 1 else "")) for i in range(1, 6)],
                    "relatedOrder": None})
    require(ledger_lines, "No real account movement")
    debit, credit = sum(l["debitMinor"] for l in ledger_lines), sum(l["creditMinor"] for l in ledger_lines)
    basis_rows = []
    for order in sorted(rows["ProductionOrders"], key=lambda o: o["AbsoluteEntry"]):
        details = []
        for entity in ["InventoryGenExits", "InventoryGenEntries"]:
            for doc in rows[entity]:
                require(start <= doc["DocDate"][:10] <= end, "Movement outside period")
                require(len({l["LineNum"] for l in doc["DocumentLines"]}) == len(doc["DocumentLines"]), "Duplicate movement line")
                for line in doc["DocumentLines"]:
                    if line.get("BaseType") != 202 or line.get("BaseEntry") != order["AbsoluteEntry"]:
                        continue
                    require(doc["Cancelled"] == "tNO" and doc["CancelStatus"] == "csNo" and doc["DocCurrency"] == "R$", "Unsupported document")
                    details.append({"entity": entity, "docEntry": doc["DocEntry"], "line": line["LineNum"], "date": doc["DocDate"],
                        "orderEntry": order["AbsoluteEntry"], "orderNumber": order["DocumentNumber"], "baseLine": line["BaseLine"],
                        "item": line["ItemCode"], "kind": line["ItemType"], "quantity": str(line["Quantity"]),
                        "inventoryQuantity": str(line["InventoryQuantity"]), "unit": line["MeasureUnit"],
                        "unitPrice": str(line["UnitPrice"]), "valueMinor": scaled(line["LineTotal"]),
                        "valueField": "DocumentLines.LineTotal", "quantityField": "DocumentLines.InventoryQuantity",
                        "linkFields": ["DocumentLines.BaseType", "DocumentLines.BaseEntry", "DocumentLines.BaseLine"],
                        "useBaseUnits": line["UseBaseUnits"], "transactionType": line["TransactionType"]})
        issues = [d for d in details if d["entity"] == "InventoryGenExits"]
        receipts = [d for d in details if d["entity"] == "InventoryGenEntries"]
        require(issues and receipts, "Missing real movements")
        require(order["ProductionOrderStatus"] == "boposClosed" and order["ProductionOrderType"] == "bopotStandard", "Unsupported OP")
        for line in issues:
            components = [c for c in order["ProductionOrderLines"] if c["LineNumber"] == line["baseLine"]]
            require(len(components) == 1 and components[0]["ItemNo"] == line["item"], "Issue without component")
            require(line["kind"] in ["dit_Item", "dit_Resource"], "Unknown issue kind")
        for component in order["ProductionOrderLines"]:
            if component["ItemType"] in ["pit_Item", "pit_Resource"]:
                require(sum(scaled(l["quantity"], 6) for l in issues if l["baseLine"] == component["LineNumber"]) ==
                        scaled(component["IssuedQuantity"], 6), "Issued quantity incomplete")
        require(all(r["item"] == order["ItemNo"] and r["unit"] == order["InventoryUOM"] and
                    r["useBaseUnits"] == "tYES" and r["transactionType"] == "botrntComplete" and
                    scaled(r["quantity"], 6) == scaled(r["inventoryQuantity"], 6) for r in receipts), "Receipt units incomplete")
        quantity = sum(scaled(r["inventoryQuantity"], 6) for r in receipts)
        require(quantity == scaled(order["CompletedQuantity"], 6), "Completion mismatch")
        materials = sum(d["valueMinor"] for d in issues if d["kind"] == "dit_Item")
        resources = sum(d["valueMinor"] for d in issues if d["kind"] == "dit_Resource")
        receipt_value = sum(d["valueMinor"] for d in receipts)
        require(materials + resources == receipt_value, "Issues/receipts value difference")
        basis_rows.append({"orderId": str(order["AbsoluteEntry"]), "number": order["DocumentNumber"], "item": order["ItemNo"],
            "orderDate": order["PostingDate"], "closingDate": order["ClosingDate"], "planned": str(order["PlannedQuantity"]),
            "completed": str(order["CompletedQuantity"]), "materialsMinor": materials, "resourcesMinor": resources,
            "directMinor": materials + resources, "receiptMinor": receipt_value, "receiptDifferenceMinor": materials + resources - receipt_value,
            "quantityMicros": quantity, "unit": order["InventoryUOM"], "details": details})
    if scenario["criterion"] == "QUANTITY":
        require(len({(o["item"], o["unit"]) for o in basis_rows}) == 1, "Non-comparable products/units")
    else:
        require(scenario["criterion"] == "DIRECT_COST", "Unsupported independent criterion")
    weights = {o["orderId"]: o["directMinor"] if scenario["criterion"] == "DIRECT_COST" else o["quantityMicros"] for o in basis_rows}
    applicable, allocation = distribute(debit - credit, request["percent"], weights)
    engine = report["result"]
    differences = []
    def equal(label, actual, expected):
        if actual != expected:
            differences.append({"field": label, "engine": actual, "independent": expected})
    equal("filter", engine["snapshot"]["filter"], request["filter"])
    equal("snapshot.origin", engine["snapshot"]["origin"], "sap")
    equal("account description", engine["configuration"]["accounts"][0]["name"], account["Name"])
    equal("ledger amount", scaled(engine["snapshot"]["balances"][0]["amount"]), debit - credit)
    equal("account percentage", engine["accounts"][0]["percent"], request["percent"])
    equal("applicable", int(engine["total"]), applicable)
    equal("account count", len(engine["accounts"]), 1)
    equal("account periodAmount", int(engine["accounts"][0]["periodAmount"]), debit - credit)
    equal("account applicableAmount", int(engine["accounts"][0]["applicableAmount"]), applicable)
    expected_applicability_adjustment = applicable * 10000 - (debit - credit) * scaled(request["percent"])
    equal("account roundingNumerator", int(engine["accounts"][0]["roundingNumerator"]), expected_applicability_adjustment)
    equal("traces count", len(engine["traces"]), len(allocation))
    equal("orders count", len(engine["orders"]), len(allocation))
    equal("order identities", sorted(o["order"]["id"] for o in engine["orders"]), sorted(weights))
    comparisons = []
    for allocation_row in allocation:
        key = allocation_row["orderId"]
        order = next(o for o in basis_rows if o["orderId"] == key)
        trace = next(t for t in engine["traces"] if t["orderId"] == key)
        normalized = next(o for o in engine["orders"] if o["order"]["id"] == key)
        equal(f"{key}.directCost", scaled(normalized["order"]["directCost"]), order["directMinor"])
        equal(f"{key}.quantity", scaled(normalized["order"]["quantity"], 6), order["quantityMicros"])
        components = sorted((c["sourceRefs"][0], c["code"], c["kind"], scaled(c["amount"])) for c in normalized["order"]["directCostComponents"])
        expected = sorted((f"InventoryGenExits({d['docEntry']})/{d['line']}", d["item"], d["kind"], d["valueMinor"])
                          for d in order["details"] if d["entity"] == "InventoryGenExits")
        equal(f"{key}.components", components, expected)
        for field in ["basis", "totalBasis", "roundingMinor", "remainder"]:
            equal(f"{key}.{field}", int(trace[field]), allocation_row[field])
        equal(f"{key}.percent", trace["participationPercent"], allocation_row["participationPercent"])
        equal(f"{key}.criterion", trace["criterion"], scenario["criterion"])
        equal(f"{key}.account", trace["account"], request["account"])
        equal(f"{key}.accountAmount", int(trace["accountAmount"]), debit - credit)
        equal(f"{key}.accountPercent", trace["accountPercent"], request["percent"])
        equal(f"{key}.applicableAmount", int(trace["applicableAmount"]), applicable)
        equal(f"{key}.poolAmount", int(trace["poolAmount"]), applicable)
        equal(f"{key}.accountRoundingNumerator", int(trace["accountRoundingNumerator"]), expected_applicability_adjustment)
        equal(f"{key}.basisDecimals", trace["basisDecimals"], 2 if scenario["criterion"] == "DIRECT_COST" else 6)
        equal(f"{key}.basisUnit", trace["basisUnit"], "SAP_LOCAL" if scenario["criterion"] == "DIRECT_COST" else order["unit"])
        equal(f"{key}.final", int(trace["amount"]), allocation_row["finalMinor"])
        equal(f"{key}.orderTotal", int(normalized["allocated"]), allocation_row["finalMinor"])
        comparisons.append({**allocation_row, "number": order["number"], "engineMinor": int(trace["amount"]),
                            "differenceMinor": int(trace["amount"]) - allocation_row["finalMinor"]})
    total = sum(r["finalMinor"] for r in allocation)
    equal("distributed", int(engine["distributed"]), total)
    equal("difference", int(engine["difference"]), applicable - total)
    equal("account distributed", int(engine["accounts"][0]["distributed"]), total)
    equal("account difference", int(engine["accounts"][0]["difference"]), applicable - total)
    for path in source["pointReads"]:
        detail = next(r["data"] for r in source["reads"] if r["path"] == path)
        entity = path.split("(")[0]
        key = {"ChartOfAccounts": "Code", "JournalEntries": "JdtNum", "ProductionOrders": "AbsoluteEntry"}.get(entity, "DocEntry")
        primary = next(r for r in rows[entity] if r[key] == detail[key])
        fields = parse_qs(urlsplit(path).query)["$select"][0].split(",")
        require([primary[f] for f in fields] == [detail[f] for f in fields], "Point read mismatch")
    return {"passed": not differences and applicable == total, "method": "Independent Python Decimal/Fraction; raw SAP rows, no FactoryOne imports",
        "company": request["company"], "purpose": request["purpose"], "criterion": scenario["criterion"], "filter": request["filter"],
        "account": account, "percent": request["percent"], "ledger": {"debitMinor": debit, "creditMinor": credit,
        "netMinor": debit - credit, "lines": ledger_lines}, "bases": basis_rows, "baseTotal": sum(weights.values()),
        "applicableMinor": applicable, "comparison": comparisons, "distributedMinor": total, "differenceMinor": applicable - total,
        "differences": differences, "sourceCounts": {entity: len(records) for entity, records in rows.items()},
        "pointReadCount": len(source["pointReads"]), "postingBlocked": True, "functionalGgfApproved": False}


if __name__ == "__main__":
    source_path, engine_path, result_path, csv_path = map(Path, sys.argv[1:])
    source = json.loads(source_path.read_text(), parse_float=Decimal)
    report = json.loads(engine_path.read_text(), parse_float=Decimal)
    require(hashlib.sha256(source_path.read_bytes()).hexdigest() == report["sourceHash"], "Capture hash mismatch")
    result = verify(source, report)
    result["sourceHash"] = report["sourceHash"]
    result_path.write_text(json.dumps(result, indent=2, ensure_ascii=True, default=str) + "\n")
    result_path.chmod(0o600)
    context = {"company": result["company"], "purpose": result["purpose"], "postingBlocked": True,
               "account": result["account"]["Code"], "description": result["account"]["Name"],
               "periodStart": result["filter"]["start"], "periodEnd": result["filter"]["end"],
               "accountPercent": result["percent"], "ledgerMinor": result["ledger"]["netMinor"],
               "applicableMinor": result["applicableMinor"], "criterion": result["criterion"]}
    csv_rows = [{**context, **row} for row in result["comparison"]]
    # Keep a standalone CSV explicitly technical-only, including when opened in a spreadsheet.
    def csv_value(value):
        return "'" + value if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r")) else value
    with csv_path.open("w", newline="") as output:
        fields = list(csv_rows[0])
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()
        writer.writerows({key: csv_value(value) for key, value in row.items()} for row in csv_rows)
    csv_path.chmod(0o600)
    print(json.dumps({"passed": result["passed"], "differenceMinor": result["differenceMinor"], "differences": result["differences"]}))
    sys.exit(0 if result["passed"] else 1)
