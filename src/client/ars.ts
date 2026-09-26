// Checks for the region key (Amtlicher Regionalschlüssel, ARS) the dashboard
// endpoint is addressed by. Shared by the client (library callers) and the CLI.

/**
 * District keys whose district part (digits 3-5) is `000`: the city-states Hamburg
 * and Berlin are their own district. Every other key ending in `000` + `0000000`
 * is a whole state (or `000000000000`, the whole country).
 */
export const CITY_STATE_DISTRICT_KEYS: readonly string[] = ["020000000000", "110000000000"];

/** The shape of a district-level ARS: 12 digits, the last seven `0`. */
const DISTRICT_ARS = /^\d{5}0{7}$/;

/**
 * Why `ars` cannot address the dashboard, or `undefined` if it can. The dashboard
 * takes a district-level ARS only: 12 digits, the last seven `0`. Anything else gets
 * an opaque HTTP 400 or 404 from the API, so it is refused with the recipe (and, where
 * the intended district is clear, the key to use). The dashboard also answers a
 * state-level key with `[]` and HTTP 200 even while a district in that state has
 * warnings, which reads as an all-clear; so such keys are refused too.
 */
export function arsProblem(ars: string): string | undefined {
  const key = JSON.stringify(ars);
  if (!/^\d{12}$/.test(ars)) {
    let hint = "";
    if (/^\d{11}$/.test(ars) && DISTRICT_ARS.test(`0${ars}`)) {
      hint = ` It has 11 digits; if a leading zero was lost, try "0${ars}".`;
    } else if (/^\d{8}$/.test(ars)) {
      hint = ` An 8-digit AGS (municipality key) belongs to the district "${ars.slice(0, 5)}0000000".`;
    } else if (/^\d{5}$/.test(ars)) {
      hint = ` For the district ${ars}, use "${ars}0000000".`;
    }
    return (
      `Invalid region key ${key}: expected a 12-digit district-level ARS, the district's ` +
      `first five digits followed by 0000000 (e.g. 055150000000 for Münster).${hint}`
    );
  }
  if (!DISTRICT_ARS.test(ars)) {
    return (
      `Region key ${key} is not a district key: the last seven digits must be 0 (this is ` +
      `a municipality-level key). Use its district: "${ars.slice(0, 5)}0000000".`
    );
  }
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
