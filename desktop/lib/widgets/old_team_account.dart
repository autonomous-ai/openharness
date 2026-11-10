import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../core/harness_cli_runner.dart';
import '../core/runtime_platform.dart';
import '../core/test_run.dart';
import '../logging/app_log.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'desktop_chrome.dart';
import 'desktop_prompt_surface.dart';
import 'terminal_prompt.dart';

// An old Harness Team account: a separate OS user that computers set up
// before 2026-11-07 still have, idle, with a boot job (Swarm v3 has none,
// #4221). The owner asked for every one to be removed (anh Dee, 2026-11-10):
// when the workspace opens on such a computer, a dialog asks at once, and its
// one action removes the account behind the system's administrator prompt
// (CLI `harness __remove-team-account`, team/remove.ts). Cancelled or failed,
// it asks again at the next launch, never more often.

/// Where Team setup left its root-owned config, which every account may read
/// (CLI team/layout.ts `TEAM_CONFIG_FILES`).
String? teamConfigPath() => RuntimePlatform.isMacOS
    ? '/Library/Application Support/Harness/team.json'
    : RuntimePlatform.isLinux
    ? '/etc/harness/team.json'
    : RuntimePlatform.isWindows
    ? r'C:\ProgramData\Harness\team.json'
    : null;

/// Whether this computer has an old Team account for this person to remove:
/// its config is there and names this account as the computer's owner (a
/// config that cannot be read is the CLI's to judge). Another account on the
/// same computer is not asked about the owner's.
Future<bool> oldTeamAccountHere({
  String? path,
  String? user,
  bool? windows,
}) async {
  final file = path ?? teamConfigPath();
  if (file == null) return false;
  final String text;
  try {
    text = await File(file).readAsString();
  } on FileSystemException {
    return false;
  }
  final env = RuntimePlatform.environment;
  final isWindows = windows ?? RuntimePlatform.isWindows;
  final me = user ?? (isWindows ? env['USERNAME'] : env['USER']);
  Object? owner;
  try {
    final config = jsonDecode(text);
    owner = config is Map ? config['owner'] : null;
  } on FormatException {
    return true;
  }
  if (owner is! String || me == null || me.isEmpty) return true;
  // Windows' account names are not case-sensitive.
  return isWindows ? owner.toLowerCase() == me.toLowerCase() : owner == me;
}

/// What the CLI answered for the removal (team/remove.ts `TeamRemoval`).
@immutable
class TeamAccountRemoval {
  const TeamAccountRemoval.removed({this.left}) : code = null, message = null;
  const TeamAccountRemoval.failed(String this.code, String this.message)
    : left = null;

  /// Null when removed; else `CANCELLED`, `NO_PROMPT`, `KEPT` or `FAILED`.
  final String? code;
  final String? message;

  /// What the system removes only later (Windows' held profile), when said.
  final String? left;

  bool get removed => code == null;

  /// The CLI's one JSON line, the last on [stdout].
  static TeamAccountRemoval parse(String stdout, String stderr) {
    final line = const LineSplitter()
        .convert(stdout)
        .lastWhere((l) => l.trimLeft().startsWith('{'), orElse: () => '');
    try {
      final json = jsonDecode(line) as Map<String, Object?>;
      if (json['ok'] == true) {
        return TeamAccountRemoval.removed(left: json['left'] as String?);
      }
      return TeamAccountRemoval.failed(
        json['code'] as String? ?? 'FAILED',
        json['message'] as String? ?? 'The removal stopped.',
      );
    } catch (_) {
      // A CLI older than the command answers "Unknown command"; it updates
      // itself, and the next launch asks again.
      if (stderr.contains('Unknown command')) {
        return const TeamAccountRemoval.failed(
          'FAILED',
          'Harness on this computer needs its update first. Try again later.',
        );
      }
      final said = stderr.trim().split('\n').last.trim();
      return TeamAccountRemoval.failed(
        'FAILED',
        said.isEmpty ? 'Harness could not run the removal.' : said,
      );
    }
  }
}

/// Runs the removal with this app's own CLI, hidden (`runHidden`: no console
/// window on Windows). It waits as long as the person takes at the prompt.
Future<TeamAccountRemoval> removeOldTeamAccount({
  HarnessCliRunner? runner,
}) async {
  final cli =
      runner ?? HarnessCliRunner(runTimeout: const Duration(minutes: 16));
  try {
    final result = await cli.run(const ['__remove-team-account']);
    return TeamAccountRemoval.parse('${result.stdout}', '${result.stderr}');
  } on ProcessException catch (error) {
    return TeamAccountRemoval.failed('FAILED', error.message);
  }
}

/// Asks about an old Team account once per launch, over the workspace it wraps.
class OldTeamAccountAsk extends StatefulWidget {
  const OldTeamAccountAsk({
    super.key,
    required this.child,
    this.here,
    this.remove,
  });

  final Widget child;

  /// Whether to ask; by default [oldTeamAccountHere], and never under
  /// `flutter test` or on the web unless a test gives its own.
  final Future<bool> Function()? here;
  final Future<TeamAccountRemoval> Function()? remove;

  /// Set once this launch has asked: the workspace can be built again (a
  /// sign-out and back) without asking twice.
  @visibleForTesting
  static bool askedThisLaunch = false;

  @override
  State<OldTeamAccountAsk> createState() => _OldTeamAccountAskState();
}

class _OldTeamAccountAskState extends State<OldTeamAccountAsk> {
  @override
  void initState() {
    super.initState();
    final here =
        widget.here ?? (kUnderTest || kIsWeb ? null : oldTeamAccountHere);
    if (here == null || OldTeamAccountAsk.askedThisLaunch) return;
    OldTeamAccountAsk.askedThisLaunch = true;
    unawaited(_ask(here));
  }

  Future<void> _ask(Future<bool> Function() here) async {
    if (!await here() || !mounted) return;
    appLog.info('team', 'an old Team account is on this computer: asking');
    await showTerminalPrompt<void>(
      context,
      builder: (_) =>
          OldTeamAccountPrompt(remove: widget.remove ?? removeOldTeamAccount),
    );
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

enum _Step { ask, removing, removed, failed }

/// The dialog: one action until it has run, then its result.
class OldTeamAccountPrompt extends StatefulWidget {
  const OldTeamAccountPrompt({super.key, required this.remove});
  final Future<TeamAccountRemoval> Function() remove;

  @override
  State<OldTeamAccountPrompt> createState() => _OldTeamAccountPromptState();
}

class _OldTeamAccountPromptState extends State<OldTeamAccountPrompt> {
  var _step = _Step.ask;
  TeamAccountRemoval? _result;
  final _focus = FocusNode(debugLabel: 'Old Team account');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focus.requestFocus();
    });
  }

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  Future<void> _remove() async {
    if (_step == _Step.removing) return;
    setState(() => _step = _Step.removing);
    final result = await widget.remove();
    if (result.removed) {
      appLog.info('team', 'old Team account removed');
    } else {
      appLog.warn(
        'team',
        'old Team account not removed: ${result.code}: ${result.message}',
      );
    }
    if (!mounted) return;
    setState(() {
      _result = result;
      _step = result.removed ? _Step.removed : _Step.failed;
    });
  }

  // Escape closes only once the removal has run: the account is to go.
  void _close() {
    if (_step == _Step.removed || _step == _Step.failed) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final danger = Theme.of(context).colorScheme.error;
    final result = _result;
    final footer = switch (_step) {
      _Step.ask => null,
      _Step.removing => DesktopPromptMessage(
        'Waiting for the administrator prompt…',
        color: DesktopChrome.muted,
      ),
      _Step.removed => DesktopPromptMessage(
        result?.left == null ? 'Removed.' : 'Removed. ${result!.left}.',
        color: DesktopChrome.muted,
      ),
      _Step.failed => DesktopPromptMessage(
        result?.message ?? 'Not removed.',
        color: danger,
      ),
    };
    return TerminalPromptKeys(
      focusNode: _focus,
      cancel: _close,
      child: DesktopPromptSurface(
        body: DesktopPromptScrollBody(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Old Team Account', style: DesktopChrome.heading()),
              const SizedBox(height: DesktopChrome.groupGap),
              Text(
                'An old Harness Team account is still on this computer. Remove it.',
                style: DesktopChrome.text(size: 13),
              ),
            ],
          ),
        ),
        footer: footer == null
            ? null
            : Semantics(liveRegion: true, child: footer),
        actions: [
          if (_step == _Step.removed || _step == _Step.failed)
            TextButton(
              key: const Key('old-team-account-close'),
              onPressed: _close,
              child: const Text('Close'),
            ),
          if (_step == _Step.ask || _step == _Step.failed)
            FilledButton(
              key: const Key('old-team-account-remove'),
              onPressed: _remove,
              child: Text(_step == _Step.ask ? 'Remove' : 'Retry'),
            ),
        ],
      ),
    );
  }
}
