# uia.ps1 [-Root App|Tray|Toasts|Menu|All] [-Process harness-desktop] [-Find <name, wildcards>] [-Type <ControlType>]
#         [-Do List|Exists|Rect|Invoke|Click|RightClick] [-Depth 14] [-TimeoutSec 10]
# Windows UI Automation, run in the desktop session (session-run.ps1): what a screen reader sees, so a check finds a
# control by its name instead of by pixels. Roots: App, the windows of -Process (Flutter turns its semantics tree on
# when a UIA client first asks, so the first answer can be thin: -Find waits up to -TimeoutSec); Tray, the taskbar
# and its hidden-icons flyout; Toasts, the notification popups; Menu, an open Win32 popup menu (the tray icon's); All,
# every top-level window. List prints the tree, one element a line: type "name" [automation id] (x,y,w,h). The other
# actions take the first element whose name matches -Find (and whose type is -Type, if given): Exists (exit 0 or 1),
# Rect, Invoke (its Invoke, Toggle, SelectionItem or ExpandCollapse pattern, else a click), Click, RightClick.
param(
  [ValidateSet('App', 'Tray', 'Toasts', 'Menu', 'All')][string]$Root = 'App',
  [string]$Process = 'harness-desktop',
  [string]$Find,
  [string]$Type,
  [ValidateSet('List', 'Exists', 'Rect', 'Invoke', 'Click', 'RightClick')][string]$Do = 'List',
  [int]$Depth = 14,
  [int]$TimeoutSec = 10
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ownership.ps1')
Assert-OwnedSession | Out-Null
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace HxE2E -Name Pointer -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
'@
[HxE2E.Pointer]::SetProcessDPIAware() | Out-Null
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$Any = [System.Windows.Automation.Condition]::TrueCondition
$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Get-Roots {
  $top = @($AE::RootElement.FindAll($Scope::Children, $Any))
  switch ($Root) {
    'App' {
      $ids = @(Get-Process -Name $Process -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
      return @($top | Where-Object { $ids -contains $_.Current.ProcessId })
    }
    'Tray' { return @($top | Where-Object { @('Shell_TrayWnd', 'NotifyIconOverflowWindow', 'TopLevelWindowForOverflowXamlIsland') -contains $_.Current.ClassName }) }
    'Toasts' { return @($top | Where-Object { $_.Current.ClassName -eq 'Windows.UI.Core.CoreWindow' -and $_.Current.Name -like '*notification*' }) }
    'Menu' { return @($top | Where-Object { $_.Current.ClassName -eq '#32768' }) }
    default { return $top }
  }
}

function Describe($Element) {
  $c = $Element.Current
  $r = $c.BoundingRectangle
  $box = if ($r.IsEmpty -or [double]::IsInfinity($r.Width)) { '' } else { '({0},{1},{2},{3})' -f [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height }
  '{0} "{1}" [{2}] {3}' -f $c.ControlType.ProgrammaticName.Replace('ControlType.', ''), $c.Name, $c.AutomationId, $box
}

function Show-Tree($Element, [string]$Indent, [int]$Left) {
  try { Write-Output ($Indent + (Describe $Element)) } catch { return }
  if ($Left -le 0) { return }
  $child = $Walker.GetFirstChild($Element)
  while ($null -ne $child) {
    Show-Tree $child ($Indent + '  ') ($Left - 1)
    $child = $Walker.GetNextSibling($child)
  }
}

function Find-First {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    foreach ($r in Get-Roots) {
      foreach ($e in @($r) + @($r.FindAll($Scope::Descendants, $Any))) {
        try {
          $c = $e.Current
          if ($c.Name -like $Find -and (-not $Type -or $c.ControlType.ProgrammaticName -eq "ControlType.$Type")) { return $e }
        } catch { }
      }
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  return $null
}

function Click-At($Element, [switch]$RightButton) {
  $r = $Element.Current.BoundingRectangle
  $x = [int]($r.X + $r.Width / 2)
  $y = [int]($r.Y + $r.Height / 2)
  [HxE2E.Pointer]::SetCursorPos($x, $y) | Out-Null
  $down, $up = if ($RightButton) { 0x0008, 0x0010 } else { 0x0002, 0x0004 }
  [HxE2E.Pointer]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
  [HxE2E.Pointer]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
  Write-Output "$(if ($RightButton) { 'right-' })clicked $x,$y"
}

if ($Do -eq 'List') {
  $roots = @(Get-Roots)
  if (-not $roots.Count) { Write-Output "no $Root window"; exit 1 }
  foreach ($r in $roots) { Show-Tree $r '' $Depth }
  exit 0
}
if (-not $Find) { Write-Output "-Do $Do needs -Find <name>"; exit 2 }
$element = Find-First
if ($null -eq $element) { Write-Output "not found: `"$Find`"$(if ($Type) { " ($Type)" }) in $Root"; exit 1 }
Write-Output ('found ' + (Describe $element))
switch ($Do) {
  'Exists' { exit 0 }
  'Rect' { exit 0 }
  'Click' { Click-At $element; exit 0 }
  'RightClick' { Click-At $element -RightButton; exit 0 }
  'Invoke' {
    $patterns = @(
      [System.Windows.Automation.InvokePattern]::Pattern,
      [System.Windows.Automation.TogglePattern]::Pattern,
      [System.Windows.Automation.SelectionItemPattern]::Pattern,
      [System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    foreach ($p in $patterns) {
      $pattern = $null
      if ($element.TryGetCurrentPattern($p, [ref]$pattern)) {
        switch ($pattern.GetType().Name) {
          'InvokePattern' { $pattern.Invoke() }
          'TogglePattern' { $pattern.Toggle() }
          'SelectionItemPattern' { $pattern.Select() }
          'ExpandCollapsePattern' { $pattern.Expand() }
        }
        Write-Output "invoked ($($pattern.GetType().Name))"
        exit 0
      }
    }
    Click-At $element
    exit 0
  }
}
