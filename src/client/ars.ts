// Checks for the region key (Amtlicher Regionalschlüssel, ARS) the dashboard
// endpoint is addressed by. Shared by the client (library callers) and the CLI.

/**
 * District keys whose district part (digits 3-5) is `000`: the city-states Hamburg
 * and Berlin are their own district. Every other key ending in `000` + `0000000`
 * is a whole state (or `000000000000`, the whole country).
 */
export const CITY_STATE_DISTRICT_KEYS: readonly string[] = ["020000000000", "110000000000"];

/**
 * Why `ars` cannot address the dashboard, or `undefined` if it can. The dashboard
 * answers a state-level key with `[]` and HTTP 200 even while a district in that
 * state has warnings, which reads as an all-clear; so such keys are refused.
 */
export function arsProblem(ars: string): string | undefined {
  const key = JSON.stringify(ars);
  if (/^\d{2}000\d{7}$/.test(ars) && !CITY_STATE_DISTRICT_KEYS.includes(ars)) {
    return (
      `Region key ${key} is not a district key: digits 3-5 are "000" (a whole state, or ` +
      `the whole country), and the dashboard answers such a key with an empty list even ` +
      `while a district there has warnings. Use the district's key: its first five digits ` +
      `followed by 0000000, e.g. 055150000000 (Münster). Only Hamburg (020000000000) and ` +
      `Berlin (110000000000) are their own district.`
    );
  }
  return undefined;
}
