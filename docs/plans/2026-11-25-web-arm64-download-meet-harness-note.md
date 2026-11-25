# Meet Harness: offer Windows on ARM its ARM64 installer

For the people who maintain `www.autonomous.ai/meet-harness`. Its code is not in the Harness repo, so this note
carries the fix; the same fix for Harness's own `/device` page lands in the Harness repo (`fix/web-arm64-download`).

## What happens today

A visitor on a Windows on ARM PC (Surface Pro X / Copilot+ PCs, Edge or Chrome) is offered **Windows · x64** as the
main download, although the live release has `Harness-Device-windows-arm64-setup.exe`. Windows 11 on ARM runs the x64
build emulated (slower); Windows 10 on ARM cannot run it at all. The ARM64 build stays reachable under "Also for" and
in the What's New file list, so nothing is hidden; only the main button is wrong.

Why, from the page's public bundle (`app/[lang]/(main)/meet-harness/page-*.js`):

1. The first guess reads `navigator.userAgent`. Every Windows browser says `Win64; x64` there, ARM or not, so it
   can only say `"windows"`.
2. The refinement asks Client Hints (`navigator.userAgentData.getHighEntropyValues(["architecture"])`) but applies
   the answer to `macos-*` and `linux-*` only. A `"windows"` guess is never refined.
3. The build picker then maps `"windows"` to the x64 installer:
   `case "windows": return find("windows", null) ?? find("windows", "x64");`

Mac (one universal dmg) and Linux on ARM with Chromium or Firefox are right. A Linux browser that refuses the hints
(Brave, some privacy settings) stays on the user agent's `x86_64` guess. That case is out of scope here.

## The fix

Read the CPU from Client Hints on Windows too, and pick the ARM64 installer only when the browser says so. Without
the hint (Firefox, Safari, a refused call) keep x64, the build every Windows 11 PC runs. Hide no build.

Names follow the bundle; adapt them to the source.

```ts
// 1. The platform type gains one value.
type Platform = "macos-arm64" | "macos-x64" | "windows" | "windows-arm64" | "linux-x64" | "linux-arm64" | "mobile" | "unknown";

// 2. The Client Hints refinement: ask bitness too, and refine Windows as well.
navigator.userAgentData
  ?.getHighEntropyValues?.(["architecture", "bitness"])
  .then(({ architecture, bitness }) => {
    if (!architecture) return;
    const arm = architecture === "arm" && bitness === "64";
    const current = guess();
    const next =
      current === "macos-arm64" || current === "macos-x64" ? (arm ? "macos-arm64" : "macos-x64")
      : current === "linux-arm64" || current === "linux-x64" ? (arm ? "linux-arm64" : "linux-x64")
      : current === "windows" || current === "windows-arm64" ? (arm ? "windows-arm64" : "windows")
      : current;
    if (next !== platform) { platform = next; notify(); }
  })
  .catch(() => {});

// 3. The build picker.
case "windows-arm64":
  return find("windows", "arm64") ?? find("windows", null);
case "windows":
  return find("windows", null) ?? find("windows", "x64");

// 4. Wherever a platform maps to an OS name or OS key ("Windows", "windows"), add "windows-arm64" beside "windows".
```

Requiring `bitness === "64"` keeps a 32-bit ARM answer off the ARM64 installer. Chromium returns
`architecture: "arm"`, `bitness: "64"` on Windows on ARM. Today's call asks only `architecture`, so `bitness` is new.

## Tests

- `userAgentData = { platform: "Windows", getHighEntropyValues: async () => ({ architecture: "arm", bitness: "64" }) }`
  → the main button is **Windows · ARM64**, and **Windows · x64** is still listed.
- The same with `architecture: "x86"`, with no `userAgentData`, and with `getHighEntropyValues` rejecting → the main
  button stays **Windows · x64**, and **Windows · ARM64** is still listed.
- A Mac and Linux visitor get what they get today.

By hand: Edge on a Windows on ARM PC shows **Windows · ARM64** as the main download.
