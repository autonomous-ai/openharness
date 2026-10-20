import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { join } from "path";
import { describe, expect, it } from "vitest";

const app = join(process.cwd(), "src", "app");
const bash = readFileSync(join(app, "flash-circle.sh", "flash-circle.sh"), "utf8");
const ps1Bytes = readFileSync(join(app, "flash-circle.ps1", "flash-circle.ps1"));
const ps1 = ps1Bytes.toString("utf8");

/** A value as the bash flasher sets it: `NAME="v"` or `NAME="${NAME:-v}"`, alone or after `;`. */
function inBash(name: string): string {
  const match = new RegExp(`(?:^|;\\s*)${name}="(?:\\$\\{[A-Z_]+:-)?([^"}]*)\\}?"`, "m").exec(bash);
  if (!match) throw new Error(`flash-circle.sh does not set ${name}`);
  return match[1];
}

/** A value as the PowerShell flasher sets it: `$NAME = 'v'` or `$NAME = EnvOr 'ENV' 'v'`. */
function inPs1(name: string): string {
  const match = new RegExp(`\\$${name} = (?:\\[int\\]\\()?(?:EnvOr '[A-Z_]+' )?'([^']*)'`, "m").exec(ps1);
  if (!match) throw new Error(`flash-circle.ps1 does not set ${name}`);
  return match[1];
}

// Cleanup contracts supplement the Windows behavioral cases below on non-Windows hosts.
it("keeps the child owned through cleanup and process exit bounded after pipe EOF", () => {
  expect(ps1).toContain("if ($open -eq 0 -and $p.HasExited) { break }");
  expect(ps1).toMatch(/finally \{\s*Stop-Child\s*\$p.Dispose\(\)\s*\$captured.Dispose\(\)/);
  expect(ps1).not.toContain("$p.WaitForExit()");
});

// Load only the real function definitions and initialization, never the entry point: these fixtures cannot
// enumerate USB or run an installed Harness. Each child is Windows PowerShell itself, with a private cache.
const entryPoint = ps1.lastIndexOf("\ntry {\n  Invoke-FlashCircle $args");
if (entryPoint < 0) throw new Error("Cannot safely exclude the flasher entry point from fixtures");
const definitions = ps1.slice(0, entryPoint);
const windowsIt = process.platform === "win32" ? it : it.skip;

function runFixture(body: string) {
  const directory = mkdtempSync(join(tmpdir(), "harness-flasher-"));
  const system32 = join(process.env.SystemRoot || "C:\\Windows", "System32");
  const powershell = join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
  // An inherited developer PATH must never resolve an installed Harness in a regression fixture.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  try {
    const fixture = join(directory, "fixture.ps1");
    writeFileSync(fixture, `${definitions}\n${body}\n`, "utf8");
    return spawnSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fixture], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...environment, Path: `${system32};${join(system32, "WindowsPowerShell", "v1.0")}`, HARNESS_FLASHER_CACHE: directory },
      windowsHide: true,
    });
  } finally {
    // Regression failures must not leave fixtures running after Vitest kills the wrapper.
    for (const file of ["child-pid", "descendant-pid"]) {
      try {
        const pid = readFileSync(join(directory, file), "utf8").trim();
        if (/^[1-9][0-9]*$/.test(pid)) {
          spawnSync(join(system32, "taskkill.exe"), ["/PID", pid, "/T", "/F"], { timeout: 5_000, windowsHide: true });
        }
      } catch { /* The child may not have reached initialization. */ }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function expectFixture(body: string) {
  const result = runFixture(body);
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return result;
}

describe("Windows PowerShell 5.1 flasher behavior without a board", () => {
  windowsIt("quotes Unicode, spaces, punctuation, quotes and trailing backslashes as individual child arguments", () => {
    expectFixture(`
$script:ESPTOOL = (Get-Process -Id $PID).Path
$child = Join-Path $CACHE_DIR 'echo.ps1'
Set-Content -LiteralPath $child -Encoding ascii -Value '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); [Console]::Out.Write(($args | ConvertTo-Json -Compress))'
$values = @("C:\\Nguy$([char]0x1EC5)n V$([char]0x0103)n A' & 100%\\firmware.bin", 'a"b', 'with space\\', '')
$result = Invoke-Esptool (@('-NoProfile', '-File', $child) + $values) 5 'none'
if ($result.Code -ne 0) { throw "echo child exited $($result.Code): $($result.Text)" }
$seen = @($result.Text | ConvertFrom-Json)
if ($seen.Count -ne $values.Count) { throw "expected $($values.Count) arguments, got $($seen.Count)" }
for ($i = 0; $i -lt $values.Count; $i++) { if ($seen[$i] -cne $values[$i]) { throw "changed argument $i" } }
`);
  }, 25_000);

  windowsIt("forwards carriage-return progress without turning it into lines", () => {
    const result = expectFixture(`
$script:ESPTOOL = (Get-Process -Id $PID).Path
$code = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('[Console]::Out.Write("progress' + [char]96 + 'r100%' + [char]96 + 'r")'))
$result = Invoke-Esptool @('-NoProfile', '-EncodedCommand', $code) 5
if ($result.Code -ne 0 -or $result.Text -cne "progress\`r100%\`r") { throw 'progress was changed' }
`);
    expect(result.stdout).toBe("progress\r100%\r");
  }, 25_000);

  windowsIt("times out a child that closes both pipes but remains alive", () => {
    const code = Buffer.from(String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class FixtureHandles {
  [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
[IO.File]::WriteAllText($env:HARNESS_FLASHER_CACHE + '\child-pid', [string]$PID)
[void][FixtureHandles]::CloseHandle([FixtureHandles]::GetStdHandle(-11))
[void][FixtureHandles]::CloseHandle([FixtureHandles]::GetStdHandle(-12))
[IO.File]::WriteAllText($env:HARNESS_FLASHER_CACHE + '\pipes-closed', 'closed')
Start-Sleep -Seconds 30
`, "utf16le").toString("base64");
    expectFixture(`
$script:ESPTOOL = (Get-Process -Id $PID).Path
$pidFile = Join-Path $CACHE_DIR 'child-pid'
$code = '${code}'
$clock = [Diagnostics.Stopwatch]::StartNew()
$result = Invoke-Esptool @('-NoProfile', '-EncodedCommand', $code) 5 'none'
if ($result.Code -ne 124 -or $clock.Elapsed.TotalSeconds -gt 12) { throw 'timeout was not bounded' }
if (-not (Test-Path -LiteralPath (Join-Path $CACHE_DIR 'pipes-closed'))) { throw 'child never closed its pipes' }
$childId = [int](Get-Content -LiteralPath $pidFile)
if (Get-Process -Id $childId -ErrorAction SilentlyContinue) { throw 'timed-out child survived' }
`);
  }, 25_000);

  windowsIt("stops the entire esptool tree on cancel and exits 130 after restoring only the stopped Harness", () => {
    const result = runFixture(`
$script:ESPTOOL = (Get-Process -Id $PID).Path
$script:HarnessStopped = $true
$script:FlashingMarked = $true
Set-Content -LiteralPath (Join-Path $CACHE_DIR 'flashing') -Value 'owned'
function Invoke-Harness([string]$Verb) { [IO.File]::WriteAllText((Join-Path $CACHE_DIR 'restored'), $Verb); return 0 }
$code = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('[IO.File]::WriteAllText($env:HARNESS_FLASHER_CACHE + "\\child-pid", [string]$PID); $p = Start-Process powershell.exe -ArgumentList "-NoProfile", "-Command", "Start-Sleep -Seconds 30" -PassThru -NoNewWindow; [IO.File]::WriteAllText($env:HARNESS_FLASHER_CACHE + "\\descendant-pid", [string]$p.Id); [IO.File]::WriteAllText($env:HARNESS_FLASHER_CACHE + "\\cancel", "cancel"); Start-Sleep -Seconds 30'))
try { Invoke-Esptool @('-NoProfile', '-EncodedCommand', $code) 8 'none' | Out-Null; throw 'cancel ignored' }
catch { if ($_.Exception.Message -ne $StopMarker) { throw } }
finally { Stop-Child; Start-HarnessAfterFlash }
$childId = [int](Get-Content -LiteralPath (Join-Path $CACHE_DIR 'descendant-pid'))
if (Get-Process -Id $childId -ErrorAction SilentlyContinue) { throw 'cancelled descendant survived' }
if (Test-Path -LiteralPath (Join-Path $CACHE_DIR 'flashing')) { throw 'marker survived cancellation' }
if ((Get-Content -LiteralPath (Join-Path $CACHE_DIR 'restored')) -ne 'start') { throw 'Harness was not restored' }
exit $script:ExitCode
`);
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(130);
    expect(result.stderr).toContain("error: cancelled");
  }, 25_000);

  windowsIt("cleans its marker after a failed stop without starting Harness", () => {
    expectFixture(`
function harness { }
function Invoke-Harness([string]$Verb) { if ($Verb -eq 'start') { throw 'must not start after a failed stop' }; return 1 }
try { Stop-HarnessForFlash; throw 'stop failure ignored' }
catch { if ($_.Exception.Message -ne $StopMarker) { throw } }
finally { Start-HarnessAfterFlash }
if (Test-Path -LiteralPath (Join-Path $CACHE_DIR 'flashing')) { throw 'marker survived failed stop' }
if ($script:HarnessStopped) { throw 'failed stop claimed daemon ownership' }
`);
  }, 25_000);

  windowsIt("cleans a running child when the stream loop throws", () => {
    expectFixture(`
$script:ESPTOOL = (Get-Process -Id $PID).Path
$code = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('[IO.File]::WriteAllText($env:HARNESS_FLASHER_CACHE + "\\child-pid", [string]$PID); [Console]::Out.Write("progress"); Start-Sleep -Seconds 30'))
# Inject an exceptional loop exit after the real child has started.
function Test-Cancel { if ($script:Child -and (Test-Path -LiteralPath (Join-Path $CACHE_DIR 'child-pid'))) { throw 'fixture read failure' } }
try { Invoke-Esptool @('-NoProfile', '-EncodedCommand', $code) 8 'none' | Out-Null; throw 'failure ignored' }
catch { if ($_.Exception.Message -ne 'fixture read failure') { throw } }
if ($script:Child) { throw 'child ownership was not cleared' }
$pidFile = Join-Path $CACHE_DIR 'child-pid'
$childId = [int](Get-Content -LiteralPath $pidFile)
if (Get-Process -Id $childId -ErrorAction SilentlyContinue) { throw 'child survived a stream-loop exception' }
`);
  }, 25_000);
});

describe("/flash-circle.ps1, the Windows flasher", () => {
  it("starts with the marker harness flash checks, and is ASCII only", () => {
    expect(ps1.split(/\r?\n/)[0]).toBe("# flash-circle.ps1");
    // Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page: one non-ASCII byte is mojibake.
    expect([...ps1Bytes].findIndex((byte) => byte > 0x7f)).toBe(-1);
  });

  it("writes with exactly the bash flasher's numbers", () => {
    for (const name of [
      "CHIP", "APP_OFFSET", "OTADATA_OFFSET", "OTADATA_SIZE", "NVS_OFFSET", "NVS_SIZE",
      "FLASH_MODE", "FLASH_FREQ", "FLASH_SIZE", "ESPTOOL_VERSION", "OTA_KEY", "METADATA_PATH",
      "FIRMWARE_PATH_PREFIX", "GCS_BUCKET", "FLASHER_VERSION", "PROBE_TIMEOUT",
    ]) {
      expect(inPs1(name), name).toBe(inBash(name));
    }
  });

  it("runs esptool with the bash flasher's reset and speed choices", () => {
    for (const [inBashForm, inPs1Form] of [
      ["--before default_reset --after hard_reset --connect-attempts 1 --no-stub chip_id",
        "'--before', 'default_reset', '--after', 'hard_reset', '--connect-attempts', '1', '--no-stub', 'chip_id'"],
      ['--before default_reset --after no_reset \\\n      erase_region "$OTADATA_OFFSET" "$OTADATA_SIZE"',
        "'--before', 'default_reset', '--after', 'no_reset', 'erase_region', $OTADATA_OFFSET, $OTADATA_SIZE"],
      ['erase_region "$NVS_OFFSET" "$NVS_SIZE"', "'erase_region', $NVS_OFFSET, $NVS_SIZE"],
      ['-b 460800 --before default_reset --after hard_reset \\\n      write_flash --flash_mode "$FLASH_MODE" --flash_size "$FLASH_SIZE" --flash_freq "$FLASH_FREQ"',
        "'-b', '460800', '--before', 'default_reset', '--after', 'hard_reset', 'write_flash', '--flash_mode', $FLASH_MODE, '--flash_size', $FLASH_SIZE, '--flash_freq', $FLASH_FREQ"],
    ]) {
      expect(bash, inBashForm).toContain(inBashForm);
      expect(ps1, inPs1Form).toContain(inPs1Form);
    }
  });

  it("pins the Windows esptool by the vendor's own digest", () => {
    expect(ps1).toContain("'esptool-v5.3.1-windows-amd64.zip' { '2b4a73c45db27426685896f64ce3e557f63a64f43cc100cb65c0cc3486af96d3' }");
    expect(ps1).toContain('$ESPTOOL_ASSET = "esptool-v$ESPTOOL_VERSION-windows-amd64.zip"');
  });

  it("prints the lines the desktop app reads, as bash does", () => {
    // desktop/lib/flash/flasher.dart: `>> board: `, `more than one ESP32-S3`, `no permission`, `error: `.
    expect(bash).toContain('say ">> board: $PORT"');
    expect(ps1).toContain('Say ">> board: $($script:PORT)"');
    expect(bash).toContain('warn "more than one ESP32-S3 is connected:"');
    expect(ps1).toContain("Warn 'more than one ESP32-S3 is connected:'");
    expect(ps1).toContain('Warn "error: $Text"');
    expect(ps1).toContain("Say '>> detect-only: nothing was written.'");
  });

  it("stops Harness only to flash, and starts it again however the run ends", () => {
    expect(ps1).toContain("if (-not $script:DETECT_ONLY) { Stop-HarnessForFlash }");
    expect(ps1).toMatch(/finally \{\s*Stop-Child\s*Start-HarnessAfterFlash\s*\}/);
    // Only what this script stopped is started again.
    expect(ps1).toContain("if (-not $script:HarnessStopped) { return }");
    expect(ps1).toContain("Join-Path $CACHE_DIR 'flashing'");
  });

  it("is cancelled by a file, ends esptool's whole tree, and exits 130", () => {
    expect(ps1).toContain("$CANCEL_FILE = Join-Path $CACHE_DIR 'cancel'");
    expect(ps1).toContain("Die 'cancelled' 130");
    expect(ps1).toContain("taskkill.exe /PID $p.Id /T /F");
  });

  it("is served as text that no cache keeps", async () => {
    const { GET } = await import("./route");
    const response = GET();
    expect((await response.text()).startsWith("# flash-circle.ps1")).toBe(true);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");
  });
});
