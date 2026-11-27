# windows-sign.ps1 <release folder> <file>: Tauri's sign command, which only sign-windows's Bundle step gives
# (release-device.yml), with the absolute target/<target>/release folder. Tauri runs it once per file it signs in the
# NSIS bundle, and makensis once for the uninstaller it writes. Those files are the allowlist below and, with the
# LangDLL.dll beside a plugin DLL, the only ones it signs, so nothing the build made can have itself signed.
# It signs through the ArtifactSigning module and the Azure CLI session the windows-signing action's step left in this
# job, with that action's settings (test_windows_sign.py holds them equal), and prints neither the session nor a token.
param(
    [Parameter(Mandatory, Position = 0)][string]$Release,
    [Parameter(Mandatory, Position = 1)][string]$File
)
$ErrorActionPreference = 'Stop'

$path = [IO.Path]::GetFullPath($File)

# A refusal fails the bundle; Tauri puts stderr into its error, so the reason reaches the step's log.
function Refuse([string]$reason, [string]$file = $path) {
    [Console]::Error.WriteLine("windows-sign: refused ${file}: $reason")
    exit 1
}

function Same([string]$a, [string]$b) { [string]::Equals($a, $b, [StringComparison]::OrdinalIgnoreCase) }

function FullFolder([string]$folder) {
    [IO.Path]::GetFullPath($folder).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

if (-not [IO.Path]::IsPathFullyQualified($Release) -or -not [IO.Directory]::Exists($Release)) {
    Refuse "the release folder $Release is not an absolute path to a folder"
}
# Invoke-ArtifactSigning -Files splits on commas, so one in the path would sign two other paths.
if ($path.Contains(',')) { Refuse 'the path holds a comma' }
$folder = FullFolder $Release
$parent = [IO.Path]::GetDirectoryName($path)
$name = [IO.Path]::GetFileName($path)
$app = Same $path ([IO.Path]::Combine($folder, 'harness-device.exe'))
# The copy of NSIS's Plugins/x86-unicode that holds the plugin DLL handed over, when it is one.
$plugins = $null
foreach ($arch in 'x64', 'arm64') {
    $x86Unicode = [IO.Path]::Combine($folder, 'nsis', $arch, 'Plugins', 'x86-unicode')
    $dlls = @([IO.Path]::Combine($x86Unicode, 'additional', 'nsis_tauri_utils.dll'))
    foreach ($dll in 'NSISdl.dll', 'StartMenu.dll', 'System.dll', 'nsDialogs.dll') {
        $dlls += [IO.Path]::Combine($x86Unicode, $dll)
    }
    if (@($dlls | Where-Object { Same $_ $path }).Count) { $plugins = $x86Unicode }
}
$installer = (Same $parent ([IO.Path]::Combine($folder, 'bundle', 'nsis'))) -and
    $name -match '^Harness Device_[0-9]+\.[0-9]+\.[0-9]+_(x64|arm64)-setup\.exe\z'
# makensis writes the uninstaller to a GetTempFileName file before it stores it in the installer.
$uninstaller = (Same $parent (FullFolder ([IO.Path]::GetTempPath()))) -and $name -match '^nst[0-9A-F]{1,4}\.tmp\z'
if (-not ($app -or $plugins -or $installer -or $uninstaller)) { Refuse 'not a file Tauri signs in this bundle' }
$files = @($path)
# Tauri's uninstaller loads NSIS's LangDLL.dll (MUI_UNGETLANGUAGE in un.onInit, with no language saved), but Tauri
# signs only the five plugin DLLs above, and release-check.sh --signed refuses it unsigned. Tauri hands a plugin DLL
# before makensis runs, so the uninstaller embeds the copy signed here.
if ($plugins) { $files += [IO.Path]::Combine($plugins, 'LangDLL.dll') }

# Every file's status before any is signed, so a refusal signs nothing. Tauri hands over the exe the action already
# signed, and each plugin DLL after the first finds LangDLL.dll signed: they stay as they are.
$unsigned = @()
foreach ($file in $files) {
    if (-not [IO.File]::Exists($file)) { Refuse 'no such file' $file }
    $status = "$((Get-AuthenticodeSignature -LiteralPath $file).Status)"
    if ($status -eq 'Valid') {
        Write-Output "windows-sign: already signed $file"
    } elseif ($status -eq 'NotSigned') {
        $unsigned += $file
    } else {
        Refuse "a $status signature: it was changed after it was signed" $file
    }
}
if (-not $unsigned.Count) { exit 0 }

$identifiers = [ordered]@{
    SIGNING_ENDPOINT = $env:SIGNING_ENDPOINT
    SIGNING_ACCOUNT = $env:SIGNING_ACCOUNT
    SIGNING_PROFILE = $env:SIGNING_PROFILE
    WINDOWS_SIGNING_PUBLISHER = $env:WINDOWS_SIGNING_PUBLISHER
}
foreach ($identifier in $identifiers.Keys) {
    if ([string]::IsNullOrWhiteSpace($identifiers[$identifier])) { Refuse "$identifier is not set" }
}
if (-not (Get-Command Invoke-ArtifactSigning -ErrorAction SilentlyContinue)) {
    Refuse 'no Invoke-ArtifactSigning: the windows-signing action has not run in this job'
}

# The windows-signing action's settings, its credential exclusions at the artifact-signing action's defaults where it
# sets none: only the Azure CLI session its login left, never another credential on the runner.
$signing = @{
    FileDigest = 'SHA256'
    TimestampRfc3161 = 'http://timestamp.acs.microsoft.com'
    TimestampDigest = 'SHA256'
    ExcludeEnvironmentCredential = $true
    ExcludeWorkloadIdentityCredential = $true
    ExcludeManagedIdentityCredential = $true
    ExcludeSharedTokenCacheCredential = $true
    ExcludeVisualStudioCredential = $true
    ExcludeVisualStudioCodeCredential = $true
    ExcludeAzureCliCredential = $false
    ExcludeAzurePowerShellCredential = $true
    ExcludeAzureDeveloperCliCredential = $true
    ExcludeInteractiveBrowserCredential = $true
}
foreach ($file in $unsigned) {
    Invoke-ArtifactSigning -Endpoint $env:SIGNING_ENDPOINT -CodeSigningAccountName $env:SIGNING_ACCOUNT `
        -CertificateProfileName $env:SIGNING_PROFILE -Files $file @signing

    # Checked as the action checks. A failure fails the bundle, except for the uninstaller: makensis ignores this
    # command's exit code there, so release-check.sh --signed is its gate.
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    $signer = ''
    if ($signature.SignerCertificate) { $signer = $signature.SignerCertificate.GetNameInfo('SimpleName', $false) }
    if ($signature.Status -ne 'Valid') { Refuse "status $($signature.Status) after signing" $file }
    # The certificate lives about three days, so the timestamp is what keeps the signature valid afterwards.
    if (-not $signature.TimeStamperCertificate) { Refuse 'no timestamp' $file }
    if ($signer -ne $env:WINDOWS_SIGNING_PUBLISHER) {
        Refuse "signed by '$signer', not '$env:WINDOWS_SIGNING_PUBLISHER'" $file
    }
    Write-Output "windows-sign: signed $file"
}
