/// How far a new harness may go without asking — New Harness ▸ Approvals.
///
/// Mirrors the CLI's `PERMISSION_MODES` (cli/src/lib/engineLaunch.ts) mode for mode: this is the
/// menu, the CLI is what turns a mode into flags and refuses one an engine lacks. An engine absent
/// here offers no choice. Keep both tables in step.
///
/// ⚠️ **A copy of `desktop/lib/core/permission_modes.dart`, and it has to stay one.** The two apps
/// send the same `permissionMode` to the same daemon, so a mode worded differently on a phone is
/// the same launch described two ways — and a mode present on one side only is a harness a person
/// cannot make from the other. This file is the phone's half; change neither alone.
library;

class PermissionMode {
  const PermissionMode(this.id, this.label, this.detail, {this.risky = false});

  /// What the machine is sent (`agent_create`'s `permissionMode`).
  final String id;
  final String label;
  final String detail;

  /// Turns off the engine's own safety net; worded as such in the menu.
  final bool risky;
}

/// The default for every engine that has modes.
const kDefaultPermissionMode = 'auto';

const _auto = 'auto';
const _ask = 'ask';

const Map<String, List<PermissionMode>> kEnginePermissionModes = {
  'claude': [
    PermissionMode(
      _auto,
      'Auto-approve',
      'Approves routine actions, checks risky ones',
    ),
    PermissionMode(
      'acceptEdits',
      'Accept edits',
      'Edits files freely, asks before commands',
    ),
    PermissionMode(
      'plan',
      'Plan first',
      'Reads and plans, changes nothing until you agree',
    ),
    PermissionMode(
      _ask,
      'Ask first',
      'Asks before acting, as Claude Code does',
    ),
    PermissionMode(
      'full',
      'Skip all checks',
      'No approvals and no safety checks. Risky',
      risky: true,
    ),
  ],
  'codex': [
    PermissionMode(
      'readOnly',
      'Read only',
      'Reads and suggests, asks before any change',
    ),
    PermissionMode(_ask, 'Ask first', 'Asks before acting, as Codex does'),
    PermissionMode(
      _auto,
      'Auto-approve',
      'Approves routine actions in the sandbox',
    ),
    PermissionMode(
      'full',
      'Full access',
      'No approvals and no sandbox. Risky',
      risky: true,
    ),
  ],
  'cursor': [
    PermissionMode(_auto, 'Auto-approve', 'Runs commands without asking'),
    PermissionMode(_ask, 'Ask first', 'Asks before running commands'),
  ],
  'opencode': [
    PermissionMode(_auto, 'Auto-approve', 'Approves actions on its own'),
    PermissionMode(_ask, 'Ask first', 'Asks before acting'),
  ],
};

/// The modes [engine] offers, or empty when it has none to choose between.
List<PermissionMode> permissionModesOf(String engine) =>
    kEnginePermissionModes[engine] ?? const [];

/// Whether [mode] lets the agent act without stopping to ask — the yes/no a daemon that predates
/// modes understands (`bypassPermission`). Plan and Read only read as no, so an older machine asks
/// rather than approving on their behalf; Skip all checks reads as yes and gets Auto-approve there.
bool permissionModeApproves(String mode) => mode == _auto || mode == 'full';
