import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/link_another_machine_dialog.dart'
    show kHarnessDownloadUrl, kLinkServerInstallCommand;
import 'controller.dart';
import 'detail_dialog.dart';
import 'dialog_scope.dart';

/// Sharing a person's own computers with a Swarm (Dee, 2026-10-29): "Share this Mac" the first time, a checklist
/// for someone with several computers, and how to add one that is not listed yet. There are no agent slots here:
/// a computer is shared with as many agents as its memory allows, and its owner can set At most in its settings.
///
/// A Mac shared from here sets up its Harness Team account at once, so macOS asks for the password the person was
/// told about; teammates' agents only ever run in that account (backend `teamWorkCheck`), never as the person.
/// Another computer finishes on itself: its own Harness asks once (cli/src/team/autoSetup.ts).

/// The two engines a Swarm runs, and the names its subscriptions go by.
const _swarmEngines = {'claude': 'Claude', 'codex': 'Codex'};

/// One of the person's own computers that is not in this Swarm yet.
class ShareCandidate {
  const ShareCandidate({
    required this.id,
    required this.name,
    required this.isThisComputer,
    this.unavailable,
    this.subscriptions = const [],
  });

  final String id;

  /// As the list shows it: "This Mac (name)" for this one.
  final String name;
  final bool isThisComputer;

  /// Why it cannot be shared right now, or null when it can.
  final String? unavailable;

  /// The subscriptions its Claude Code and Codex are signed in to, which a Team account there would use.
  final List<String> subscriptions;
}

/// The person's own computers [c]'s Swarm does not have yet, this one first. One per computer: a Mac's Harness Team
/// account goes with its Mac ([SuperTabSnapshot.placeOf]), and another account's computers are never offered.
List<ShareCandidate> shareCandidates(AppNotifier app, SuperTabController c) {
  final snapshot = c.snapshot;
  final inSwarm = {
    for (final m in snapshot?.machines ?? const <Map<String, dynamic>>[])
      m['machineId'] as String,
  };
  final mac = app.teamAccountsHere;
  final candidates = <ShareCandidate>[];
  for (final m in app.machineStates.values) {
    final id = m.machine.machineId;
    if (m.belongsToOtherAccount || inSwarm.contains(id)) continue;
    if ((snapshot?.placeOf(id) ?? id) != id) continue;
    final name = m.machine.displayName;
    candidates.add(
      ShareCandidate(
        id: id,
        name: m.isLocalMachine
            ? '${mac ? 'This Mac' : 'This computer'} ($name)'
            : name,
        isThisComputer: m.isLocalMachine,
        unavailable: m.needsLink
            ? 'Not linked. Link this computer from Machines.'
            : m.isOffline
            ? 'Share when it’s on'
            : null,
        subscriptions: [
          for (final MapEntry(key: engine, value: label)
              in _swarmEngines.entries)
            if (m.engines.byEngine[engine]?.signedIn == true) label,
        ],
      ),
    );
  }
  candidates.sort(
    (a, b) => a.isThisComputer != b.isThisComputer
        ? (a.isThisComputer ? -1 : 1)
        : a.name.toLowerCase().compareTo(b.name.toLowerCase()),
  );
  return candidates;
}

/// "Claude", "Claude and Codex".
String _joined(List<String> names) => names.length < 2
    ? names.join()
    : '${names.sublist(0, names.length - 1).join(', ')} and ${names.last}';

/// Shares computer [id]: its project folder and engines set up there, then added to the Swarm with as many agents
/// as its memory allows. [setupId] is the preparation's receipt, kept across a retry of a setup still running.
///
/// An earlier attempt whose reply was lost holds its own receipt, and only one action may be in flight: it is
/// checked first, and when it was this computer's, that confirmation is the share. Throws [SuperTabFailure].
Future<void> shareSwarmComputer(
  AppNotifier app,
  SuperTabController c,
  String id, {
  required String setupId,
  required bool Function() mounted,
}) async {
  final pending = c.pendingCommand;
  if (pending?['type'] == 'machine.contribute') {
    if (await c.retry() == null) {
      throw SuperTabFailure(
        c.operationErrorCode ?? 'CONTRIBUTION_FAILED',
        c.operationError ?? 'The earlier attempt is still not confirmed. Try again to check it.',
      );
    }
    if (pending?['machineId'] == id) return;
  }
  final deadline = DateTime.now().add(const Duration(minutes: 5));
  Map<String, dynamic> prepared;
  while (true) {
    if (!mounted() || !c.canWrite) throw const _Closed();
    prepared = await app.superTabMachineRequest(id, {
      'action': 'prepareContribution',
      'tabId': c.tabId,
      'scope': 'swarm',
      'operationId': setupId,
    });
    if (prepared['state'] == 'ready' && prepared['scope'] == 'swarm') break;
    if (prepared['state'] != 'preparing') {
      throw const SuperTabFailure(
        'UPDATE_REQUIRED',
        'Update Harness on this computer, then try again.',
      );
    }
    if (DateTime.now().isAfter(deadline)) {
      throw const SuperTabFailure(
        'SETUP_PENDING',
        'Project setup is still running. Try again to check its progress.',
      );
    }
    await Future<void>.delayed(const Duration(seconds: 1));
  }
  if (!mounted() || !c.canWrite) throw const _Closed();
  final engines =
      (prepared['engines'] as List?)
          ?.whereType<String>()
          .where(_swarmEngines.containsKey)
          .toSet()
          .toList() ??
      <String>[];
  if (engines.isEmpty) {
    throw const SuperTabFailure(
      'NO_SWARM_ENGINE',
      'Install Claude Code or Codex on this computer, then try again.',
    );
  }
  // As many as memory allows: setup's own maximum, measured on the computer
  // just now, or the number an older Harness's setup offered.
  final maximum = prepared['maxAvailableAgents'] ?? prepared['maxAgents'];
  final result = await c.command({
    'type': 'machine.contribute',
    'machineId': id,
    'name': app.stateOf(id)?.machine.displayName ?? id,
    'cwd': prepared['cwd'],
    if (prepared['scope'] != null) 'scope': prepared['scope'],
    'engines': engines,
    'maxAgents': maximum is num ? maximum.toInt().clamp(1, 1024) : 4,
  });
  if (result == null) {
    throw SuperTabFailure(
      c.operationErrorCode ?? 'CONTRIBUTION_FAILED',
      c.operationError ?? 'Could not share this computer.',
    );
  }
  unawaited(app.wakeSuperTabHost(id).catchError((_) {}));
}

/// The dialog closed, or the Swarm can no longer be written, while sharing.
class _Closed implements Exception {
  const _Closed();
}

/// What this Mac's Harness Team account setup answered, as one line; null when there is nothing to add.
String? _teamSetupNote(String state) => switch (state) {
  'started' || 'running' =>
    'macOS is asking for your password in a window titled “osascript”.',
  'exists' => null,
  'update' => 'Update Harness on this Mac to finish: its Team account can’t be set up from here.',
  _ => 'Its Team account can’t be set up right now. Set it up from this Mac’s row in Machines.',
};

/// The share flow for [c]'s Swarm: "Share this Mac" when this Mac is the only computer to share, the checklist
/// otherwise. [only] narrows it to those computers (a quiet line's Share).
Future<void> showSwarmShare(
  BuildContext context,
  AppNotifier app,
  SuperTabController c, {
  Set<String>? only,
}) => showAppDialog<void>(
  context: context,
  builder: (context) => SuperTabDialogScope(
    controller: c,
    child: _ShareDialog(app: app, controller: c, only: only),
  ),
);

enum _Stage { choosing, sharing, finished }

class _ShareDialog extends StatefulWidget {
  const _ShareDialog({required this.app, required this.controller, this.only});

  final AppNotifier app;
  final SuperTabController controller;
  final Set<String>? only;

  @override
  State<_ShareDialog> createState() => _ShareDialogState();
}

class _ShareDialogState extends State<_ShareDialog> {
  AppNotifier get app => widget.app;
  SuperTabController get c => widget.controller;

  var _stage = _Stage.choosing;

  /// Computers the person unticked; every other available one is ticked, so one that signs in while the list is
  /// open arrives ticked.
  final _unticked = <String>{};

  /// What happened to each computer once Share was pressed: its line, and whether it failed.
  final _outcome = <String, ({String line, bool failed})>{};

  /// Each computer's preparation receipt, kept while its setup is still running.
  final _setupIds = <String, String>{};

  /// The computers Share went to, in order; fixed once pressed.
  List<String>? _shared;
  bool _addOpen = false;
  String? _copied;

  /// The list as of this build, before Share was pressed; afterwards, the computers it went to.
  List<ShareCandidate> _candidates() {
    final all = shareCandidates(app, c);
    final only = widget.only;
    return only == null ? all : all.where((m) => only.contains(m.id)).toList();
  }

  bool _ticked(ShareCandidate m) =>
      m.unavailable == null && !_unticked.contains(m.id);

  @override
  void initState() {
    super.initState();
    // Whose subscriptions a Team account would use is read from each computer's own engines.
    for (final m in _candidates()) {
      if (m.unavailable == null) unawaited(app.probeEngines(m.id));
    }
  }

  Future<void> _share(List<String> ids) async {
    setState(() {
      _stage = _Stage.sharing;
      _shared ??= ids;
      for (final id in ids) {
        _outcome.remove(id);
      }
    });
    for (final id in ids) {
      if (!mounted) return;
      final setupId = _setupIds[id] ??= superTabOperationId();
      String line;
      var failed = false;
      try {
        await shareSwarmComputer(
          app,
          c,
          id,
          setupId: setupId,
          mounted: () => mounted,
        );
        _setupIds.remove(id);
        if (app.stateOf(id)?.isLocalMachine == true && app.teamAccountsHere) {
          String state;
          try {
            state = await app.setUpTeamAccount();
          } on SuperTabFailure catch (failure) {
            state = 'failed:${failure.message}';
          } catch (_) {
            state = 'failed';
          }
          line = state.startsWith('failed:')
              ? state.substring('failed:'.length)
              : _teamSetupNote(state) ?? 'Shared.';
        } else if (app.stateOf(id)?.isLocalMachine == true) {
          line = 'Shared.';
        } else {
          line = 'Finish on that computer: Harness there asks once.';
        }
      } on _Closed {
        return;
      } on SuperTabFailure catch (failure) {
        if (failure.code != 'SETUP_PENDING') _setupIds.remove(id);
        line = failure.message;
        failed = true;
      } catch (error) {
        _setupIds.remove(id);
        line = error.toString();
        failed = true;
      }
      if (!mounted) return;
      setState(() => _outcome[id] = (line: line, failed: failed));
    }
    if (!mounted) return;
    setState(() => _stage = _Stage.finished);
  }

  List<String> get _failed => [
    for (final id in _shared ?? const <String>[])
      if (_outcome[id]?.failed == true) id,
  ];

  Future<void> _copy(String text) async {
    try {
      await Clipboard.setData(ClipboardData(text: text));
      if (mounted) setState(() => _copied = 'Copied.');
    } catch (_) {
      if (mounted) {
        setState(() => _copied = 'Could not copy. Select the text to copy it.');
      }
    }
  }

  Future<void> _download() async {
    try {
      if (await launchUrl(
        kHarnessDownloadUrl,
        mode: LaunchMode.externalApplication,
      )) {
        return;
      }
    } catch (_) {
      // The address is on screen to copy instead.
    }
    if (mounted) {
      setState(
        () =>
            _copied = 'Could not open the browser. Go to $kHarnessDownloadUrl',
      );
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([app, c]),
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final candidates = _shared == null
          ? _candidates()
          : [
              for (final id in _shared!)
                ..._candidates().where((m) => m.id == id),
              // A computer that joined the Swarm drops out of the candidates; keep its row.
              for (final id in _shared!)
                if (!_candidates().any((m) => m.id == id))
                  ShareCandidate(
                    id: id,
                    name: _nameOf(id),
                    isThisComputer: app.stateOf(id)?.isLocalMachine == true,
                  ),
            ];
      final thisMacAlone =
          app.teamAccountsHere &&
          candidates.length == 1 &&
          candidates.single.isThisComputer &&
          !_addOpen;
      return thisMacAlone
          ? _thisMac(context, candidates.single)
          : _checklist(context, candidates);
    },
  );

  String _nameOf(String id) {
    final m = app.stateOf(id);
    if (m == null) return id;
    return m.isLocalMachine
        ? 'This Mac (${m.machine.displayName})'
        : m.machine.displayName;
  }

  /// The first time, with this Mac alone: one question, what it means, one password.
  Widget _thisMac(BuildContext context, ShareCandidate mac) {
    final outcome = _outcome[mac.id];
    final shared = outcome != null && !outcome.failed;
    final busy = _stage == _Stage.sharing;
    return SuperTabDetailDialog(
      title: 'Share this Mac with your team?',
      body: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (shared) ...[
            Text(
              'This Mac is shared. You can stop anytime in Machines.',
              style: DesktopChrome.text(),
            ),
            if (outcome.line != 'Shared.') ...[
              const SizedBox(height: grid.AppDesktop.controlGap),
              Text(outcome.line, style: DesktopChrome.metadata()),
            ],
          ] else ...[
            Text(
              'When it’s free, your teammates’ agents can work here. They run in a separate account on this Mac '
              'and can’t see your files, mail or logins.',
              style: DesktopChrome.text(),
            ),
            if (mac.subscriptions.isNotEmpty) ...[
              const SizedBox(height: grid.AppDesktop.controlGap),
              Text(
                'Their agents use your ${_joined(mac.subscriptions)} '
                'subscription${mac.subscriptions.length > 1 ? 's' : ''} on this Mac.',
                style: DesktopChrome.text(),
              ),
            ],
            const SizedBox(height: grid.AppDesktop.controlGap),
            Text(
              'macOS will ask for your password once.',
              style: DesktopChrome.metadata(),
            ),
            if (mac.unavailable != null) ...[
              const SizedBox(height: grid.AppDesktop.controlGap),
              Text(mac.unavailable!, style: DesktopChrome.metadata()),
            ],
            if (outcome != null) ...[
              const SizedBox(height: grid.AppDesktop.controlGap),
              Text(outcome.line, style: DesktopChrome.metadata()),
            ],
          ],
        ],
      ),
      actions: shared
          ? [
              FilledButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('Done'),
              ),
            ]
          : [
              TextButton(
                onPressed: busy ? null : () => Navigator.pop(context),
                child: const Text('Not now'),
              ),
              FilledButton(
                onPressed: busy || mac.unavailable != null || !c.canWrite
                    ? null
                    : () => unawaited(_share([mac.id])),
                child: Text(busy ? 'Sharing…' : 'Share this Mac'),
              ),
            ],
    );
  }

  /// Several computers: each ticked unless it cannot be shared now, and each finishing on its own once shared.
  Widget _checklist(BuildContext context, List<ShareCandidate> candidates) {
    final choosing = _shared == null;
    final ticked = [
      for (final m in candidates)
        if (_ticked(m)) m.id,
    ];
    final busy = _stage == _Stage.sharing;
    final failed = _failed;
    final swarm = c.snapshot?.name;
    return SuperTabDetailDialog(
      title: swarm == null || swarm.isEmpty
          ? 'Share your computers'
          : 'Share your computers with $swarm',
      body: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'When they’re free, your teammates’ agents can work on them. They run in a separate account and '
            'can’t see your files, mail or logins.',
            style: DesktopChrome.text(),
          ),
          const SizedBox(height: grid.AppDesktop.groupGap),
          if (candidates.isEmpty)
            Text(
              'All your computers are shared. Add another below.',
              style: DesktopChrome.metadata(),
            ),
          for (final m in candidates) _row(m, choosing && !busy),
          if (choosing) ...[
            const SizedBox(height: grid.AppDesktop.controlGap),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                style: superTabQuietAction,
                onPressed: () => setState(() => _addOpen = !_addOpen),
                child: const Text('Add a computer that isn’t listed…'),
              ),
            ),
            if (_addOpen) _addComputer(),
          ],
        ],
      ),
      actions: switch (_stage) {
        _Stage.finished when failed.isEmpty => [
          FilledButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Done'),
          ),
        ],
        _Stage.finished => [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Close'),
          ),
          FilledButton(
            onPressed: c.canWrite ? () => unawaited(_share(failed)) : null,
            child: const Text('Try again'),
          ),
        ],
        _ => [
          FilledButton(
            onPressed: busy || ticked.isEmpty || !c.canWrite
                ? null
                : () => unawaited(_share(ticked)),
            child: Text(
              busy
                  ? 'Sharing…'
                  : ticked.isEmpty
                  ? 'Share'
                  : 'Share ${ticked.length} computer${ticked.length == 1 ? '' : 's'}',
            ),
          ),
        ],
      },
    );
  }

  Widget _row(ShareCandidate m, bool editable) {
    final outcome = _outcome[m.id];
    final sharing =
        _stage == _Stage.sharing &&
        outcome == null &&
        (_shared?.contains(m.id) ?? false);
    final note =
        outcome?.line ??
        (sharing
            ? 'Sharing…'
            : m.unavailable ??
                  (m.subscriptions.isEmpty
                      ? null
                      : 'Uses your ${_joined(m.subscriptions)} subscription'
                            '${m.subscriptions.length > 1 ? 's' : ''}'));
    return MergeSemantics(
      child: InkWell(
        onTap: editable && m.unavailable == null
            ? () => setState(() {
                if (!_unticked.remove(m.id)) _unticked.add(m.id);
              })
            : null,
        borderRadius: BorderRadius.circular(grid.AppControl.radius),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Checkbox(
              key: ValueKey('share-computer-${m.id}'),
              value: _shared == null ? _ticked(m) : _shared!.contains(m.id),
              onChanged: editable && m.unavailable != null
                  ? null
                  : editable
                  ? (value) => setState(() {
                      value == true
                          ? _unticked.remove(m.id)
                          : _unticked.add(m.id);
                    })
                  : null,
            ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  vertical: grid.AppDesktop.controlGap,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      m.name,
                      key: const ValueKey('share-computer-name'),
                      style: DesktopChrome.text(),
                    ),
                    if (note != null)
                      Text(
                        note,
                        style: DesktopChrome.metadata(
                          color: outcome?.failed == true
                              ? Theme.of(context).colorScheme.error
                              : null,
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// A computer that is not listed: Harness installed there and signed in to this account, and it joins the list.
  Widget _addComputer() {
    final email = app.currentUser?.email;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('1. Install Harness on it.', style: DesktopChrome.text()),
        const SizedBox(height: grid.AppDesktop.controlGap),
        Align(
          alignment: Alignment.centerLeft,
          child: OutlinedButton(
            onPressed: () => unawaited(_download()),
            child: const Text('Download for Mac or Windows'),
          ),
        ),
        const SizedBox(height: grid.AppDesktop.controlGap),
        Text('On Linux, run:', style: DesktopChrome.metadata()),
        Row(
          children: [
            Expanded(
              child: SelectableText(
                kLinkServerInstallCommand,
                style: grid.AppType.mono(),
              ),
            ),
            AppIconButton(
              icon: AppIcons.copy,
              size: grid.AppControl.iconSize,
              tooltip: 'Copy command',
              onPressed: () => unawaited(_copy(kLinkServerInstallCommand)),
            ),
          ],
        ),
        if (_copied != null) Text(_copied!, style: DesktopChrome.metadata()),
        const SizedBox(height: grid.AppDesktop.controlGap),
        Text(
          '2. Sign in there${email == null ? ' with this account' : ' as $email'}. '
          'On a computer with no screen, harness login shows a code to scan with your phone.',
          style: DesktopChrome.text(),
        ),
        const SizedBox(height: grid.AppDesktop.controlGap),
        Text(
          '3. It appears in this list, ticked.',
          style: DesktopChrome.text(),
        ),
      ],
    );
  }
}
