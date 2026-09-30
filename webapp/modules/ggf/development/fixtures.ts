import type { Configuration } from "../engine/types";

export const demoConfiguration: Configuration = {
  classifications: [
    { id: "FAB", name: "Fabricacao" },
    { id: "APOIO", name: "Apoio industrial" }
  ],
  accounts: [
    {
      account: "DEV-6101",
      name: "Energia",
      classificationId: "FAB",
      criterion: "DIRECT_COST",
      percent: "100",
      active: true
    },
    {
      account: "DEV-6102",
      name: "Materiais indiretos",
      classificationId: "FAB",
      criterion: "QUANTITY",
      percent: "100",
      active: true
    },
    {
      account: "DEV-6103",
      name: "Supervisao",
      classificationId: "APOIO",
      criterion: "HOURS",
      percent: "100",
      active: true
    },
    {
      account: "DEV-6104",
      name: "Manutencao",
      classificationId: "APOIO",
      criterion: "RESOURCE_GROUP",
      percent: "100",
      active: true
    }
  ],
  groupShares: [
    { account: "DEV-6104", group: "MAQUINA", percent: "60" },
    { account: "DEV-6104", group: "EQUIPE", percent: "40" }
  ]
};

// Fictional movements, isolated from all Service Layer code.
export const demoLedger = demoConfiguration.accounts.flatMap((a, i) => [
  {
    id: `DEV-J-${i}`,
    account: a.account,
    date: "2026-09-15",
    branch: "DEV-01",
    costCenter: "FABRICA",
    amount: ["1000.00", "600.00", "900.00", "1500.00"][i]!,
    generatedByGgf: false
  },
  {
    id: `DEV-J-B-${i}`,
    account: a.account,
    date: "2026-09-15",
    branch: "DEV-02",
    costCenter: "APOIO",
    amount: "100.00",
    generatedByGgf: false
  },
  {
    id: `DEV-J-OLD-${i}`,
    account: a.account,
    date: "2026-08-15",
    branch: "DEV-01",
    costCenter: "FABRICA",
    amount: "50.00",
    generatedByGgf: false
  },
  {
    id: `DEV-J-SELF-${i}`,
    account: a.account,
    date: "2026-09-15",
    branch: "DEV-01",
    costCenter: "FABRICA",
    amount: "9999.00",
    generatedByGgf: true
  }
]);
export const demoOrders = [
  { id: "DEV-OP-101", number: "101", item: "DEV-PROD-A", currentCost: "12000.00" },
  { id: "DEV-OP-102", number: "102", item: "DEV-PROD-B", currentCost: "23000.00" },
  { id: "DEV-OP-103", number: "103", item: "DEV-PROD-C", currentCost: "35000.00" },
  { id: "DEV-OP-201", number: "201", item: "DEV-PROD-D", currentCost: "1000.00" }
];
export const demoProduction = demoOrders.map((o, i) => ({
  id: `DEV-MOV-${i}`,
  orderId: o.id,
  date: "2026-09-16",
  branch: i === 3 ? "DEV-02" : "DEV-01",
  costCenter: i === 3 ? "APOIO" : "FABRICA",
  directCost: ["10000.00", "20000.00", "30000.00", "500.00"][i]!,
  materials: ["7000.00", "14000.00", "21000.00", "350.00"][i]!,
  resources: ["3000.00", "6000.00", "9000.00", "150.00"][i]!,
  resourceConsumption: {
    MAQUINA: {
      quantity: ["4", "2", "0", "1"][i]!,
      value: ["2400.00", "4000.00", "0.00", "100.00"][i]!
    },
    EQUIPE: {
      quantity: ["1", "3", "6", "1"][i]!,
      value: ["600.00", "2000.00", "9000.00", "50.00"][i]!
    }
  },
  quantity: ["100", "200", "300", "10"][i]!,
  groupHours: { MAQUINA: ["8", "2", "0", "1"][i]!, EQUIPE: ["2", "18", "30", "1"][i]! }
}));
