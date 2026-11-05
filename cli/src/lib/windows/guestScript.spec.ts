import { describe, expect, it } from 'vitest'
import { buildWindowsGuestInstallScript, buildWindowsGuestProcessorScript } from './guestScript.js'

const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const install = (over: Record<string, string> = {}) => buildWindowsGuestInstallScript({
  owner: 'owner', ownerHome: 'C:\\Users\\owner', ownerSid: SID, processor: 'Write-Output ok', version: '1.2.3', ...over,
})
const processor = (over: Record<string, string> = {}) => buildWindowsGuestProcessorScript({ owner: 'owner', ownerHome: 'C:\\Users\\owner', ownerSid: SID, ...over })

describe('the guest install script', () => {
  it('uses its own tree, never the Users-readable Team folder', () => {
    const script = install()
    expect(script).toContain("$ROOT = 'C:\\ProgramData\\HarnessGuests'")
    expect(script).not.toContain("$ROOT = 'C:\\ProgramData\\Harness\\guests'")
    expect(script).toContain('Harness Guests')
  })

  it('builds the guest/owner SIDs into the SDDL at run time, not as single-quoted literals', () => {
    const script = install()
    expect(script).toContain('Set-Folder $ROOT ("O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x20;;;" + $guestSid + ")(A;OICI;0x1200a9;;;" + $OWNER_SID + ")")')
    expect(script).not.toMatch(/Set-Folder \$ROOT 'O:/)
  })

  it('makes the setup task SYSTEM, on demand, one at a time, with the owner able to start it unelevated', () => {
    const script = install()
    expect(script).toContain('<RunLevel>HighestAvailable</RunLevel>')
    expect(script).toContain("RegisterTask($TASK_NAME, $taskXml, 6, 'SYSTEM', $null, 5, $sddl)")
    expect(script).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
    expect(script).toContain('<AllowStartOnDemand>true</AllowStartOnDemand>')
    expect(script).toContain('(A;;FRFX;;;')
    expect(script).not.toContain('New-LocalGroup -Name $group')
  })

  it('writes the processor from base64 and a guest-readable probe, not through a here-string', () => {
    const script = install()
    expect(script).toContain('FromBase64String($processorB64)')
    expect(script).toContain("$probe = Join-Path $SCRIPTS 'probe.ps1'")
    expect(script).toContain("$probeText = \"try { [IO.File]::ReadAllText('$SENTINEL')")
    expect(script).not.toContain('$processorText = @\'')
  })

  it('stages the Node runtime guests install their engine with, and only once per setup version', () => {
    const script = install({ nodeSrc: 'C:\\Program Files\\nodejs' })
    expect(script).toContain("$NODE_SRC = 'C:\\Program Files\\nodejs'")
    expect(script).toContain("$NODEBIN = 'C:\\ProgramData\\HarnessGuests\\bin\\node-1.2.3'")
    expect(script).toContain('Copy-Item -LiteralPath $NODE_SRC -Destination $NODEBIN -Recurse -Force')
    // The marker says the copy finished; a partial copy is replaced rather than trusted.
    expect(script).toContain("$nodeMark = Join-Path $NODEBIN '.complete'")
    expect(script).toContain('if (Test-Path -LiteralPath $NODEBIN) { Remove-Item -LiteralPath $NODEBIN -Recurse -Force }')
    // Read/execute for guests is $BIN's, inherited by everything copied under it.
    expect(script).toContain('0x1200a9;;;" + $guestSid')
    // A build without one stages none: sharing still works for an already-installed engine.
    expect(install()).toContain("$NODE_SRC = ''")
  })

  it('stops every guest host before a re-run, and stages the new host beside the old one it must not overwrite', () => {
    const script = install()
    expect(script).toContain(`$PTYBIN = Join-Path $BIN ('pty-' + $VERSION)`)
    expect(script).toContain('Copy-Item -LiteralPath $PTY_SRC -Destination (Join-Path $PTYBIN "harness-pty.exe") -Force -ErrorAction Stop')
    expect(script).toContain('if (-not (Test-Path -LiteralPath (Join-Path $PTYBIN "harness-pty.exe")))')
    expect(script).toContain('Get-ScheduledTask -TaskPath $HOST_TASK_PATH -ErrorAction SilentlyContinue')
    expect(script).toContain('Stop-ScheduledTask -TaskName $_.TaskName')
    expect(script).toContain('/F /IM harness-pty.exe /FI ("USERNAME eq " + $env:COMPUTERNAME')
  })

  it('refuses a bad owner, SID or version', () => {
    expect(() => install({ owner: "o'brien" })).toThrow()
    expect(() => install({ ownerSid: 'owner' })).toThrow()
    expect(() => install({ version: '..' })).toThrow()
  })
})

describe('the guest processor', () => {
  it('names the owner and sentinel, and never has a read-only $home variable', () => {
    const text = processor()
    expect(text).toContain("$OWNER = 'owner'")
    expect(text).toContain("$SENTINEL = 'C:\\Users\\owner\\.harness-guest-privacy'")
    expect(text).not.toMatch(/\$home\b/)
    expect(text).toContain('$guestHome')
  })

  it('sets the batch logon right before running as the guest, and uses a guest-run probe', () => {
    const text = processor()
    expect(text).toContain('function Set-BatchLogon')
    expect(text.indexOf('Set-BatchLogon $sid $true')).toBeLessThan(text.indexOf('$code = Run-As $user $pw "exit 0"'))
    expect(text).toContain("$probe = Join-Path $ROOT 'scripts\\probe.ps1'")
    expect(text).toContain('if ($code -eq 0) { return $true }')
    expect(text).toContain('throw "the guest privacy probe did not run')
  })

  it('grants only the shared folder: Windows Bypass traverse checking needs no parent ACE', () => {
    const text = processor()
    expect(text).toContain('Bypass traverse checking')
    expect(text).not.toMatch(/foreach \(\$parent in @\(Ancestors/)
    expect(text).toContain('$desired[$key] = @{ path = $path; level = $level }')
  })

  it('uses the drive colon correctly and refuses ADS after it', () => {
    const text = processor()
    expect(text).toContain("$path.Substring(3) -match '[<>:\"|?*]'")
    expect(text).not.toContain("$path -match '[<>:\"|?*]'")
  })

  it('kills the guest with taskkill, not a WMI loop over every process', () => {
    const text = processor()
    expect(text).toContain('taskkill.exe')
    expect(text).not.toContain('Get-CimInstance Win32_Process | ForEach-Object')
  })

  it('checks the request shape before the privileged switch, and a missing user is not success', () => {
    const text = processor()
    expect(text).toContain('the ensure request is not valid')
    expect(text).toContain('the $op request is not valid')
    expect(text).toContain('the share request is not valid')
    expect(text).toContain('the guest account $user is not here')
    // A leftover folder from an earlier account of the same name would suffix the new profile; it is cleared first.
    expect(text).toContain('Windows still holds an earlier guest')
    expect(text).toContain('restart this PC, then share with them again')
  })

  it('gives the guest\'s host its own instance and the owner SID, and lets only the owner start it', () => {
    const text = processor()
    // The host runs the same binary as the owner's: the tag keeps its instance, and every route keyed by it, apart.
    expect(text).toContain('$instanceTag = "gu" + $user.Substring(3)')
    expect(text).toContain('set `"HARNESS_PTY_INSTANCE_TAG=$instanceTag`"')
    expect(text).toContain('set `"HARNESS_PTY_SHARE_SID=$OWNER_SID`"')
    // The guest's own npm prefix and the staged Node are on every pane's PATH: that is where its engine is installed.
    expect(text).toContain('set `"PATH=$hostHome\\engines;%USERPROFILE%\\.local;$NODEBIN;%PATH%`"')
    expect(text).toContain('serve --home `"$hostHome`"')
    // The host is the build staged for this setup version, never a file an older host still runs.
    expect(text).toContain('$PTY_BIN = \'C:\\ProgramData\\HarnessGuests\\bin\\pty-3\\harness-pty.exe\'')
    // Owner: start/stop only; the guest's task cannot be changed by the guest.
    expect(text).toContain('(A;;FRFX;;;" + $OWNER_SID + ")"')
    // A re-run stops the instance still running the old wrapper (old tag, old PATH) before registering the new one.
    expect(text).toContain('if ($running.State -eq 4) { $running.Stop() }')
  })

  it('refuses more than one request and removes the request when it answers', () => {
    const text = processor()
    expect(text).toContain("if ($files.Count -ne 1)")
    expect(text).toContain('finally { Remove-Item -LiteralPath $files[0].FullName')
  })
})
