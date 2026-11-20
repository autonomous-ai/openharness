/**
 * Which build of the Harness Device app a download request wants, read on the server. Chromium sends
 * the arch hints only after this site asked for them (`/device` answers with `Accept-CH`), so a click
 * from `/device`, or any visit after one, carries them; a link pasted into a fresh Chromium does not.
 */

export type DeviceArch = "x64" | "arm64";

/** A Client Hint is a structured-field string: `"arm"`, quotes included. */
function hint(headers: Headers, name: string): string | null {
  return headers.get(name)?.replace(/^"(.*)"$/, "$1") ?? null;
}

/**
 * The Client Hints first; on Linux then the user agent, where Firefox writes the real CPU (Chromium
 * freezes it to `Linux x86_64`). Windows' user agent says `Win64; x64` on ARM too, so it is never read.
 * A computer that cannot tell gets x64, which Windows 11 on ARM runs emulated; Windows 10 on ARM
 * cannot run it, nor can Linux on ARM.
 */
export function deviceArch(headers: Headers, os: "windows" | "linux"): DeviceArch {
  if (hint(headers, "Sec-CH-UA-Bitness") === "64") {
    const arch = hint(headers, "Sec-CH-UA-Arch");
    if (arch === "arm") return "arm64";
    if (arch === "x86") return "x64";
  }
  if (os === "linux" && /\b(?:aarch64|arm64)\b/i.test(headers.get("User-Agent") ?? "")) return "arm64";
  return "x64";
}
