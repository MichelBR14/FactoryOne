/** UI catalog, not license flags or SAP module identifiers. Core has no user-facing screen. */
export const MODULE_NAVIGATION = [
  {
    key: "ggf",
    title: "module_ggf",
    icon: "sap-icon://accounting-document-verification",
    route: "ggf"
  },
  { key: "ind", title: "module_ind", icon: "sap-icon://factory", route: "" },
  {
    key: "quality",
    title: "module_quality",
    icon: "sap-icon://quality-issue",
    route: ""
  }
] as const;

export const GGF_NAVIGATION = [
  {
    key: "classifications",
    title: "ggfClassifications",
    icon: "sap-icon://tags",
    route: "ggfClassifications"
  },
  {
    key: "allocations",
    title: "ggfAllocations",
    icon: "sap-icon://pie-chart",
    route: "ggfAllocations"
  },
  {
    key: "closing",
    title: "ggfClosing",
    icon: "sap-icon://process",
    route: "ggfClosing"
  },
  {
    key: "indirect",
    title: "ggfIndirect",
    icon: "sap-icon://expense-report",
    route: ""
  },
  {
    key: "reports",
    title: "ggfReports",
    icon: "sap-icon://business-objects-experience",
    route: ""
  }
] as const;
