# windows-sign.ps1 <release folder> <file>: Tauri's sign command, which only sign-windows's Bundle step gives
# (release-device.yml), with the absolute target/<target>/release folder. Tauri runs it once per file it signs in the
# NSIS bundle, and makensis once for the uninstaller it writes. Those files are the allowlist below and the only ones
# it signs, so nothing the build made can have itself signed.
# It signs through the ArtifactSigning module and the Azure CLI session the windows-signing action's step left in this
# job, with that action's settings (test_windows_sign.py holds them equal), and prints neither the session nor a token.
param(
    [Parameter(Mandatory, Position = 0)][string]$Release,
    [Parameter(Mandatory, Position = 1)][string]$File
)
$ErrorActionPreference = 'Stop'

$path = [IO.Path]::GetFullPath($File)

# A refusal fails the bundle; Tauri puts stderr into its error, so the reason reaches the step's log.
function Refuse([string]$reason) {
    [Console]::Error.WriteLine("windows-sign: refused ${path}: $reason")
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
$fixed = @([IO.Path]::Combine($folder, 'harness-device.exe'))
foreach ($arch in 'x64', 'arm64') {
    $plugins = [IO.Path]::Combine($folder, 'nsis', $arch, 'Plugins', 'x86-unicode')
    foreach ($dll in 'NSISdl.dll', 'StartMenu.dll', 'System.dll', 'nsDialogs.dll') {
        $fixed += [IO.Path]::Combine($plugins, $dll)
    }
    $fixed += [IO.Path]::Combine($plugins, 'additional', 'nsis_tauri_utils.dll')
}
$installer = (Same $parent ([IO.Path]::Combine($folder, 'bundle', 'nsis'))) -and
    $name -match '^Harness Device_[0-9]+\.[0-9]+\.[0-9]+_(x64|arm64)-setup\.exe\z'
# makensis writes the uninstaller to a GetTempFileName file before it stores it in the installer.
$uninstaller = (Same $parent (FullFolder ([IO.Path]::GetTempPath()))) -and $name -match '^nst[0-9A-F]{1,4}\.tmp\z'
if (-not (@($fixed | Where-Object { Same $_ $path }).Count -or $installer -or $uninstaller)) {
    Refuse 'not a file Tauri signs in this bundle'
}
if (-not [IO.File]::Exists($path)) { Refuse 'no such file' }

# Tauri hands over the exe the action already signed: it stays as it is.
$status = "$((Get-AuthenticodeSignature -LiteralPath $path).Status)"
if ($status -eq 'Valid') {
    Write-Output "windows-sign: already signed $path"
    exit 0
}
if ($status -ne 'NotSigned') { Refuse "a $status signature: it was changed after it was signed" }

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
Invoke-ArtifactSigning -Endpoint $env:SIGNING_ENDPOINT -CodeSigningAccountName $env:SIGNING_ACCOUNT `
    -CertificateProfileName $env:SIGNING_PROFILE -Files $path @signing

# Checked as the action checks. A failure fails the bundle, except for the uninstaller: makensis ignores this
# command's exit code there, so release-check.sh --signed is its gate.
$signature = Get-AuthenticodeSignature -LiteralPath $path
$signer = ''
if ($signature.SignerCertificate) { $signer = $signature.SignerCertificate.GetNameInfo('SimpleName', $false) }
if ($signature.Status -ne 'Valid') { Refuse "status $($signature.Status) after signing" }
# The certificate lives about three days, so the timestamp is what keeps the signature valid afterwards.
if (-not $signature.TimeStamperCertificate) { Refuse 'no timestamp' }
if ($signer -ne $env:WINDOWS_SIGNING_PUBLISHER) { Refuse "signed by '$signer', not '$env:WINDOWS_SIGNING_PUBLISHER'" }
Write-Output "windows-sign: signed $path"
