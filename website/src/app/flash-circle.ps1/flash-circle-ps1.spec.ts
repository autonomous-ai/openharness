import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { join } from "path";
import { describe, expect, it } from "vitest";

const app = join(process.cwd(), "src", "app");
const bash = normalizeBash(readFileSync(join(app, "flash-circle.sh", "flash-circle.sh"), "utf8"));
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

// Git on Windows can check out the bash source as CRLF; command parity is independent of checkout EOLs.
function normalizeBash(source: string): string { return source.replace(/\r\n/g, "\n"); }

function assertResetParity(bashSource: string, ps1Source: string) {
  for (const [inBashForm, inPs1Form] of [
    ["--before default_reset --after hard_reset --connect-attempts 1 --no-stub chip_id",
      "'--before', 'default_reset', '--after', 'hard_reset', '--connect-attempts', '1', '--no-stub', 'chip_id'"],
    ['--before default_reset --after no_reset \\\n      erase_region "$OTADATA_OFFSET" "$OTADATA_SIZE"',
      "'--before', 'default_reset', '--after', 'no_reset', 'erase_region', $OTADATA_OFFSET, $OTADATA_SIZE"],
    ['--before default_reset --after no_reset \\\n        erase_region "$NVS_OFFSET" "$NVS_SIZE"',
      "'--before', 'default_reset', '--after', 'no_reset', 'erase_region', $NVS_OFFSET, $NVS_SIZE"],
    ['-b 460800 --before default_reset --after hard_reset \\\n      write_flash --flash_mode "$FLASH_MODE" --flash_size "$FLASH_SIZE" --flash_freq "$FLASH_FREQ"',
      "'-b', '460800', '--before', 'default_reset', '--after', 'hard_reset', 'write_flash', '--flash_mode', $FLASH_MODE, '--flash_size', $FLASH_SIZE, '--flash_freq', $FLASH_FREQ"],
  ]) {
    expect(normalizeBash(bashSource), inBashForm).toContain(inBashForm);
    expect(ps1Source, inPs1Form).toContain(inPs1Form);
  }
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

function runFixture(body: string, extraEnvironment: Record<string, string> = {}) {
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
      env: {
        ...environment, Path: `${system32};${join(system32, "WindowsPowerShell", "v1.0")}`,
        NODE_ENV: process.env.NODE_ENV ?? "test",
        USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
        ADAPTER_DATA_DIR: join(directory, "data"), HARNESS_AUTH_DIR: join(directory, "auth"),
        HARNESS_FLASHER_CACHE: directory, HARNESS_FLASH_RECOVERY_NODE: "", HARNESS_FLASH_RECOVERY_ARGS: "",
        HARNESS_FLASH_RUN_ID: "", ...extraEnvironment,
      },
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

function expectFixture(body: string, extraEnvironment: Record<string, string> = {}) {
  const result = runFixture(body, extraEnvironment);
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return result;
}

describe("Windows PowerShell 5.1 flasher behavior without a board", () => {
  windowsIt.each(["", "../escape", "A".repeat(32), "a".repeat(31), "a".repeat(32) + "\n"])("keeps the legacy lease for absent or invalid run identity %j", (runId) => {
    expectFixture(`
function harness { }
function Invoke-Harness([string]$Verb) { return 0 }
Stop-HarnessForFlash
$marker = Join-Path $CACHE_DIR 'flashing'
if (-not (Test-Path -LiteralPath $marker)) { throw 'legacy marker missing' }
[long]$stamp = Get-Content -LiteralPath $marker
if ([Math]::Abs([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - $stamp) -gt 5) { throw 'legacy timestamp incompatible' }
Start-HarnessAfterFlash
if (Test-Path -LiteralPath $marker) { throw 'legacy cooperative cleanup failed' }
`, { HARNESS_FLASH_RUN_ID: runId });
  }, 25_000);

  windowsIt("owns a unique timestamp lease, keeps foreign same-second markers, and does not pass the run identity to Harness", () => {
    expectFixture(`
function harness { }
function Invoke-Harness([string]$Verb) {
  if ($env:HARNESS_FLASH_RUN_ID) { throw 'run identity leaked into daemon command' }
  return 0
}
$shared = Join-Path $CACHE_DIR 'flashing'
$foreign = Join-Path $CACHE_DIR ('flashing.' + ('b' * 32))
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
Set-Content -LiteralPath $shared -Value $stamp -Encoding ascii
Set-Content -LiteralPath $foreign -Value $stamp -Encoding ascii
Stop-HarnessForFlash
$owned = Join-Path $CACHE_DIR ('flashing.' + ('a' * 32))
if (-not (Test-Path -LiteralPath $owned)) { throw 'per-run marker missing' }
[long]$started = Get-Content -LiteralPath $owned
if ([Math]::Abs($started - $stamp) -gt 5) { throw 'per-run timestamp incompatible' }
Start-HarnessAfterFlash
if (Test-Path -LiteralPath $owned) { throw 'cooperative cleanup left the owned lease' }
if ((Get-Content -LiteralPath $shared) -ne [string]$stamp -or (Get-Content -LiteralPath $foreign) -ne [string]$stamp) { throw 'foreign lease changed' }
`, { HARNESS_FLASH_RUN_ID: "a".repeat(32) });
  }, 25_000);

  // Exercise the real entry function, replacing only hardware/downloads and using a private fake CLI.
  const recoveryFixture = `
$script:Steps = New-Object 'Collections.Generic.List[string]'
function Stop-HarnessForFlash { $script:HarnessStopped = $true; $script:Steps.Add('stop') }
function Install-Esptool { }
function Select-Port { $script:PORT = 'COM3' }
function Resolve-Release { $script:FW_VER = 'fixture' }
function Get-Firmware { }
function Confirm-Flash { }
function Invoke-Flash { $script:Steps.Add('write') }
# Keep the real version reader/parser. Only its serial transport is a fixture, and a read exception
# after one chunk bounds the loop through the same nonfatal catch as a disconnected real port.
$script:RealConfirmRunning = \${function:Confirm-Running}
$script:BootLog = "App version: fixture"
$script:FakePort = [PSCustomObject]@{ ReadTimeout = 0 }
$script:FakePort | Add-Member -MemberType ScriptMethod -Name Open -Value { }
$script:FakePort | Add-Member -MemberType ScriptMethod -Name ReadExisting -Value { return $script:BootLog }
$script:FakePort | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }
function New-Object([string]$TypeName, [object[]]$ArgumentList) {
  if ($TypeName -eq 'System.IO.Ports.SerialPort') { return $script:FakePort }
  Microsoft.PowerShell.Utility\\New-Object @PSBoundParameters
}
function Start-Sleep { throw 'fixture boot read completed' }
function Confirm-Running { $script:Steps.Add('verify'); return (& $script:RealConfirmRunning) }
function Invoke-Harness([string]$Verb) {
  if ($Verb -ne 'start') { throw 'unexpected Harness command' }
  if (Test-Path -LiteralPath (Join-Path $CACHE_DIR 'completed')) { $script:Steps.Add('complete') }
  $script:Steps.Add('start'); return 0
}
$hook = Join-Path $CACHE_DIR 'fake-cli.ps1'
Set-Content -LiteralPath $hook -Encoding ascii -Value 'if ($args.Count -ne 3 -or $args[0] -ne "flash" -or $args[1] -ne "__complete" -or $args[2] -ne "COM3") { exit 9 }; [IO.File]::WriteAllText([IO.Path]::Combine($env:HARNESS_FLASHER_CACHE, "completed"), "COM3"); exit 0'
$env:HARNESS_FLASH_RECOVERY_NODE = (Get-Process -Id $PID).Path
$env:HARNESS_FLASH_RECOVERY_ARGS = ConvertTo-Json -InputObject @('-NoProfile', '-File', $hook) -Compress
`;

  windowsIt("forgets the flashed board after verification, before the stopped daemon starts", () => {
    expectFixture(`${recoveryFixture}
try { Invoke-FlashCircle @('--yes') } finally { Start-HarnessAfterFlash }
if (($script:Steps -join ',') -ne 'stop,write,verify,complete,start') { throw ('wrong recovery order: ' + ($script:Steps -join ',')) }
`);
  }, 25_000);

  windowsIt.each(["no-verify", "missing-version", "mismatched-version"])("preserves the verdict after a write with %s", (mode) => {
    expectFixture(`${recoveryFixture}
${mode === "missing-version" ? "$script:BootLog = ''" : mode === "mismatched-version" ? "$script:BootLog = 'App version: other'" : ""}
try { Invoke-FlashCircle @('--yes'${mode === "no-verify" ? ", '--no-verify'" : ""}) } finally { Start-HarnessAfterFlash }
if (($script:Steps -join ',') -ne 'stop,write,verify,start') { throw 'unconfirmed firmware cleared the verdict' }
if ($script:ExitCode -ne 0) { throw 'nonfatal version verification changed the exit status' }
`);
  }, 25_000);

  windowsIt.each(["failure", "cancel", "cancel-after-write"])("does not forget a verdict after %s", (mode) => {
    expectFixture(`${recoveryFixture}
${mode === "failure" ? "function Invoke-Flash { Die 'fixture write failure' }" : mode === "cancel" ? "function Invoke-Flash { Die 'cancelled' 130 }" : "function Confirm-Running { Die 'cancelled' 130 }"}
try { Invoke-FlashCircle @('--yes'); throw 'failure was ignored' }
catch { if ($_.Exception.Message -ne $StopMarker) { throw } }
finally { Start-HarnessAfterFlash }
if (Test-Path -LiteralPath (Join-Path $CACHE_DIR 'completed')) { throw 'failed or cancelled flash forgot a verdict' }
if ($script:Steps[$script:Steps.Count - 1] -ne 'start') { throw 'failed flash did not restore Harness' }
`);
  }, 25_000);

  windowsIt.each(["--detect-only", "--no-flash", "--version-info"])("does not forget a verdict or stop Harness for %s", (flag) => {
    expectFixture(`${recoveryFixture}
try { Invoke-FlashCircle @('${flag}') } finally { Start-HarnessAfterFlash }
if ($script:Steps.Count -ne 0 -or (Test-Path -LiteralPath (Join-Path $CACHE_DIR 'completed'))) { throw 'a read-only invocation changed daemon/verdict state' }
`);
  }, 25_000);

  windowsIt("supports a standalone flasher or older CLI with no completion capability", () => {
    expectFixture(`${recoveryFixture}
$env:HARNESS_FLASH_RECOVERY_NODE = ''; $env:HARNESS_FLASH_RECOVERY_ARGS = ''
try { Invoke-FlashCircle @('--yes') } finally { Start-HarnessAfterFlash }
if (($script:Steps -join ',') -ne 'stop,write,verify,start') { throw 'standalone flash did not remain compatible' }
`);
  }, 25_000);

  windowsIt.each(["malformed", "nonzero"])("warns and still restores Harness when the completion capability is %s", (mode) => {
    const result = expectFixture(`${recoveryFixture}
${mode === "malformed" ? "$env:HARNESS_FLASH_RECOVERY_ARGS = '{broken'" : "Set-Content -LiteralPath $hook -Encoding ascii -Value 'exit 7'"}
try { Invoke-FlashCircle @('--yes') } finally { Start-HarnessAfterFlash }
if (($script:Steps -join ',') -ne 'stop,write,verify,start') { throw 'callback failure prevented daemon recovery' }
`);
    expect(result.stderr).toContain("could not refresh the flashed board");
  }, 25_000);

  windowsIt("quotes Unicode, spaces, punctuation, quotes and trailing backslashes as individual child arguments", () => {
    expectFixture(`
$script:ESPTOOL = (Get-Process -Id $PID).Path
$child = Join-Path $CACHE_DIR 'echo.ps1'
Set-Content -LiteralPath $child -Encoding ascii -Value '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); [Console]::Out.Write(($args | ConvertTo-Json -Compress))'
$values = @("C:\\Nguy$([char]0x1EC5)n V$([char]0x0103)n A' & 100%\\firmware.bin", 'a"b', 'with space\\', '')
$result = Invoke-Esptool (@('-NoProfile', '-File', $child) + $values) 5 'none'
if ($result.Code -ne 0) { throw "echo child exited $($result.Code): $($result.Text)" }
# Windows PowerShell 5.1 emits a JSON array as one pipeline object; @() would nest it.
$seen = ConvertFrom-Json -InputObject $result.Text
if ($seen.Count -ne $values.Count) { throw "expected $($values.Count) arguments, got $($seen.Count); JSON: $($result.Text)" }
for ($i = 0; $i -lt $values.Count; $i++) { if ($seen[$i] -cne $values[$i]) { throw "changed argument $i; JSON: $($result.Text)" } }
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

  it.each(["LF", "CRLF"])("matches reset and speed choices with a %s bash checkout", (lineEnding) => {
    const checkout = bash.replace(/\r?\n/g, lineEnding === "CRLF" ? "\r\n" : "\n");
    assertResetParity(checkout, ps1);
  });

  it.each([
    ["before", "'--before', 'no_reset', '--after', 'no_reset'"],
    ["after", "'--before', 'default_reset', '--after', 'hard_reset'"],
  ])("rejects a change to the NVS %s reset choice", (_flag, replacement) => {
    const command = "'--before', 'default_reset', '--after', 'no_reset', 'erase_region', $NVS_OFFSET, $NVS_SIZE";
    expect(ps1).toContain(command);
    const changed = ps1.replace(command, `${replacement}, 'erase_region', $NVS_OFFSET, $NVS_SIZE`);
    expect(() => assertResetParity(bash, changed)).toThrow();
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
