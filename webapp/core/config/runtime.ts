/** Explicit local-only opt-in. Never enables a license or opens a SAP session. */
export function isDevelopmentMode(
  location: Pick<Location, "hostname" | "search"> = window.location
): boolean {
  return (
    ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) &&
    new URLSearchParams(location.search).get("mode") === "development"
  );
}

/** Separate local gateway; never falls back to fictional data or sends credentials to UI5. */
export function isSapReadMode(
  location: Pick<Location, "hostname" | "search"> = window.location
): boolean {
  return (
    isDevelopmentMode(location) && new URLSearchParams(location.search).get("source") === "sap-read"
  );
}
