import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../core/harness_cli_runner.dart';
import '../core/home_dir.dart';
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
/// its config is there and names this account as the computer's owner, by
/// name or by home folder (a config that cannot be read is the CLI's to
/// judge). Another account on the same computer is not asked about the
/// owner's.
Future<bool> oldTeamAccountHere({
  String? path,
  String? user,
  String? home,
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
  final myHome = home ?? maybeHomeDir(isWindows: isWindows);
  Map<Object?, Object?>? config;
  try {
    final read = jsonDecode(text);
    if (read is Map) config = read;
  } on FormatException {
    return true;
  }
  final owner = config?['owner'], ownerHome = config?['ownerHome'];
  // Windows' account names and paths are not case-sensitive.
  bool same(Object? a, String? b) =>
      a is String &&
      b != null &&
      (isWindows ? a.toLowerCase() == b.toLowerCase() : a == b);
  if (owner is! String && ownerHome is! String) return true;
  if ((me == null || me.isEmpty) && myHome == null) return true;
  return same(owner, me) || same(ownerHome, myHome);
}

/// What the CLI answered for the removal (team/remove.ts `TeamRemoval`).
@immutable
class TeamAccountRemoval {
  const TeamAccountRemoval.removed({this.left, this.wasThere = true})
    : code = null,
      message = null;
  const TeamAccountRemoval.failed(String this.code, String this.message)
    : left = null,
      wasThere = true;

  /// Null when removed; else `CANCELLED`, `NO_PROMPT`, `KEPT` or `FAILED`.
  final String? code;
  final String? message;

  /// What the system removes only later (Windows' held profile), when said.
  final String? left;

  /// False when the CLI found no account to remove (gone meanwhile).
  final bool wasThere;

  bool get removed => code == null;

  /// The CLI's one JSON line, the last on [stdout]; [exitCode] when there is
  /// none.
  static TeamAccountRemoval parse(String stdout, String stderr, int exitCode) {
    final line = const LineSplitter()
        .convert(stdout)
        .lastWhere((l) => l.trimLeft().startsWith('{'), orElse: () => '');
    Object? json;
    try {
      json = jsonDecode(line);
    } on FormatException {
      json = null;
    }
    if (json is Map) {
      String? text(String key) =>
          json is Map && json[key] is String ? json[key] as String : null;
      if (json['ok'] == true) {
        return TeamAccountRemoval.removed(
          left: text('left'),
          wasThere: json['removed'] != false,
        );
      }
      return TeamAccountRemoval.failed(
        text('code') ?? 'FAILED',
        text('message') ?? 'The removal stopped.',
      );
    }
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
      said.isEmpty
          ? 'Harness could not run the removal (exit $exitCode).'
          : said,
    );
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
    return TeamAccountRemoval.parse(
      '${result.stdout}',
      '${result.stderr}',
      result.exitCode,
    );
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

  /// Set once this launch has its answer (asked, or nothing to ask): the
  /// workspace can be built again (a sign-out and back) without asking twice.
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
    unawaited(_ask(here));
  }

  Future<void> _ask(Future<bool> Function() here) async {
    try {
      final there = await here();
      // Gone before the answer (signed out): the next workspace asks. Asked
      // meanwhile by a workspace built again: once is enough.
      if (!mounted || OldTeamAccountAsk.askedThisLaunch) return;
      OldTeamAccountAsk.askedThisLaunch = true;
      if (!there) return;
      appLog.info('team', 'an old Team account is on this computer: asking');
      await showTerminalPrompt<void>(
        context,
        builder: (_) =>
            OldTeamAccountPrompt(remove: widget.remove ?? removeOldTeamAccount),
      );
    } catch (error) {
      appLog.warn(
        'team',
        'could not ask about an old Team account',
        error: error,
      );
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// [text] as a sentence of its own: a capital first, one full stop last.
String _sentence(String text) {
  final trimmed = text.trim();
  if (trimmed.isEmpty) return trimmed;
  final capital = trimmed[0].toUpperCase() + trimmed.substring(1);
  return capital.endsWith('.') ? capital : '$capital.';
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
    // The button goes while it runs: keep the keys in the dialog.
    _focus.requestFocus();
    setState(() => _step = _Step.removing);
    final result = await widget.remove();
    // The code alone: the CLI's reason can name accounts and folders.
    if (!result.removed) {
      appLog.warn('team', 'old Team account not removed: ${result.code}');
    } else {
      appLog.info(
        'team',
        result.wasThere
            ? 'old Team account removed'
            : 'no old Team account to remove',
      );
    }
    if (!mounted) return;
    setState(() {
      _result = result;
      _step = result.removed ? _Step.removed : _Step.failed;
    });
    // The keys come back to the dialog, where Escape now closes it.
    _focus.requestFocus();
  }

  // Escape closes once Remove was pressed: the account is to go, but the
  // person is never held while the system's prompt waits, which can open out
  // of sight (anh Dee, 2026-11-11: "it's stuck at 'waiting for the admin
  // prompt..'"). Closed while it waits, the removal goes on to the prompt's
  // answer, which the log keeps; one that did not happen asks again at the next
  // launch.
  void _close() {
    if (_step != _Step.ask) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final danger = Theme.of(context).colorScheme.error;
    final result = _result;
    final footer = switch (_step) {
      _Step.ask => null,
      _Step.removing => DesktopPromptMessage(
        "Enter your password in the system's window. It may be behind Harness.",
        color: DesktopChrome.muted,
      ),
      _Step.removed => DesktopPromptMessage(
        result?.wasThere == false
            ? 'Already removed.'
            : result?.left == null
            ? 'Removed.'
            : 'Removed. ${_sentence(result!.left!)}',
        color: DesktopChrome.muted,
      ),
      _Step.failed => DesktopPromptMessage(
        result?.message ?? 'Not removed.',
        color: danger,
      ),
    };
    // Nothing closes it before Remove is pressed: not Escape, not a click on
    // the veil outside it.
    return PopScope(
      canPop: _step != _Step.ask,
      child: TerminalPromptKeys(
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
            if (_step != _Step.ask)
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
      ),
    );
  }
}
