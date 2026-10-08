import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import '../core/permission_modes.dart';
import '../core/project_folder.dart';
import '../terminal/terminal_session.dart';
import 'app_state.dart';
import 'harness_placement.dart';
import 'pane_preset.dart';
import 'session_content_search.dart';
import 'swarm_navigation.dart';
import 'terminal_pane.dart';

/// One Claude Code or Codex conversation on this computer that Harness did not start, and that
/// nothing is running: what the first workspace opens for someone who already uses those agents.
@immutable
class ArrivalSession {
  const ArrivalSession({
    required this.engine,
    required this.sessionId,
    required this.cwd,
    required this.lastAt,
    this.title = '',
  });

  final String engine, sessionId, cwd, title;
  final DateTime lastAt;

  @override
  String toString() => '$engine:$sessionId';
}

/// What the first workspace opens: [tabs] of conversations to resume, or a single tab of [fresh]
/// agents in a new project. Empty opens nothing, and the person gets the New Harness box.
@immutable
class FirstArrivalPlan {
  const FirstArrivalPlan({this.tabs = const [], this.fresh = const []});

  final List<List<ArrivalSession>> tabs;

  /// Engines started side by side in one new project, in pane order.
  final List<String> fresh;

  bool get isEmpty => tabs.isEmpty && fresh.isEmpty;

  /// OpenCode leads a fresh tab with the starter task typed into its box, not sent.
  bool get typesStarterTask => fresh.isNotEmpty && fresh.first == 'opencode';

  @override
  String toString() => 'FirstArrivalPlan(tabs: $tabs, fresh: $fresh)';
}

/// The first workspace on a computer new to Harness (the owner's onboarding, 2026-10-08): no
/// empty box asking what to type, but agents already open.
///
/// Someone with no agent at all (setup downloaded OpenCode, Codex and Claude Code) gets one tab with
/// OpenCode full height on the left, a starter task typed into its box but not sent, and Codex and
/// Claude Code stacked on the right, each on its own sign-in. Someone who already uses Claude Code or
/// Codex gets their recent conversations that nothing is running ("open the recent ones that are NOT
/// running so we can bring them into harness without interrupting user work"), most recent first by
/// last activity, as ⌘P and the ⌘T recents order them: the latest of each agent in the first tab, so
/// both agents show side by side, and the next three in a second, mixing the agents where it can.
/// Someone with an agent but no conversations gets a fresh pane on each agent they have.
///
/// It runs once: [begin] marks a computer that is setting up the Harness CLI for the first time,
/// and the mark is spent when the workspace has opened, or found the person's desk already full.
class FirstArrival {
  FirstArrival(this._storage, {DateTime Function()? now})
    : _now = now ?? DateTime.now;

  static const key = 'first_arrival_v1';

  /// Typed into OpenCode's box for someone with no agent, so the first thing they see is not a
  /// blank they have to fill (the owner: "most people don't know what to type").
  static const starterTask = "make a small web page that shows today's date";

  /// How far back a conversation counts as recent: the welcome page's window.
  static const window = Duration(days: 30);

  final LocalKeyValueStore? _storage;
  final DateTime Function() _now;

  /// `new` (setup downloaded the agents), `agents` (the computer had one), `done`, or null.
  String? _state;
  bool _running = false;

  /// Whether the next empty workspace is this computer's first.
  bool get pending => !_running && (_state == 'new' || _state == 'agents');

  /// Reads the mark once signed in. A [begin] from this launch's setup stands: its write may not
  /// have landed yet.
  Future<void> restore() async {
    String? stored;
    try {
      stored = await _storage?.read(key);
    } catch (_) {
      stored = null;
    }
    _state ??= stored;
  }

  /// Setup is putting the Harness CLI on this computer for the first time. [downloads] says it is
  /// also downloading the agents, because the computer had none.
  void begin({required bool downloads}) {
    if (_state == 'done') return;
    _state = downloads ? 'new' : 'agents';
    unawaited(_write(_state!));
  }

  void _finish() {
    _state = 'done';
    unawaited(_write('done'));
  }

  Future<void> _write(String value) async {
    try {
      await _storage?.write(key, value);
    } catch (_) {
      // A mark that could not be saved costs at most a second first workspace, never this one.
    }
  }

  /// Opens the first workspace. True when it opened at least one pane; false leaves the empty tab
  /// to the New Harness box, as on any later launch.
  Future<bool> run(
    AppNotifier app, {
    Duration machineWait = const Duration(seconds: 30),
    Duration indexWait = const Duration(seconds: 15),
    Duration starterWait = const Duration(minutes: 3),
  }) async {
    if (!pending) return false;
    _running = true;
    try {
      // Someone whose account already has a desk elsewhere keeps it.
      if (app.allPanes.isNotEmpty) {
        _finish();
        return false;
      }
      final machine = await _localMachine(app, machineWait);
      if (machine == null) return false;
      final machineId = machine.machine.machineId;
      final sessions = await recentSessions(app, machineId, budget: indexWait);
      await app.probeEngines(machineId);
      final installed = {
        for (final engine in const ['claude', 'codex', 'opencode'])
          if (machine.engines[engine]?.installed == true) engine,
      };
      final plan = planFirstArrival(
        newUser: _state == 'new',
        sessions: sessions,
        installed: installed,
      );
      debugPrint('first arrival: $plan');
      if (plan.isEmpty || app.allPanes.isNotEmpty) {
        _finish();
        return false;
      }
      final opened = plan.fresh.isNotEmpty
          ? await _openFresh(app, machineId, plan, starterWait)
          : await _openSessions(app, machineId, plan.tabs);
      _finish();
      return opened;
    } finally {
      _running = false;
    }
  }

  Future<MachineState?> _localMachine(AppNotifier app, Duration wait) async {
    final deadline = _now().add(wait);
    while (true) {
      final machine = app.localMachineState;
      if (machine != null &&
          app.searchableMachineIds.contains(machine.machine.machineId)) {
        return machine;
      }
      if (!_now().isBefore(deadline)) return null;
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }
  }

  /// This computer's Claude Code and Codex conversations from the last [window] that nothing is
  /// running and whose folder is still here, most recent first. Asked like the welcome page asks
  /// (`session_search` with a time and no words), but given longer: on a computer Harness has just
  /// reached, the index is still reading every transcript for the first time.
  Future<List<ArrivalSession>> recentSessions(
    AppNotifier app,
    String machineId, {
    required Duration budget,
  }) async {
    final at = _now();
    final hits = await app.searchSessions(
      machineId,
      '',
      when: (
        from: at.subtract(window),
        to: at,
        phrase: 'last ${window.inDays} days',
      ),
      limit: 30,
      budget: budget,
    );
    return sessionsFromHits(hits ?? const [], folderExists: _folderExists);
  }

  static bool _folderExists(String path) {
    try {
      return path.isNotEmpty && Directory(path).existsSync();
    } catch (_) {
      return false;
    }
  }

  Future<bool> _openSessions(
    AppNotifier app,
    String machineId,
    List<List<ArrivalSession>> tabs,
  ) async {
    String? firstTab;
    for (final tab in tabs) {
      String? tabId;
      for (final session in tab) {
        // The first tab is the empty one the person is looking at; the second is a new one.
        final placement = tabId == null && firstTab != null
            ? HarnessPlacement.newTab
            : HarnessPlacement.currentTab;
        final (:error, :refusal) = await app.resumeConversation(
          machineId,
          engine: session.engine,
          folder: session.cwd,
          sessionId: session.sessionId,
          name: session.title.isEmpty ? null : session.title,
          swarmId: tabId ?? (firstTab == null ? app.activeSwarmId : null),
          placement: placement,
        );
        if (error != null) {
          // Started since it was listed, or its folder went: the rest still open.
          debugPrint('first arrival: $session not opened: ${refusal ?? error}');
          continue;
        }
        tabId ??= app.activeSwarmId;
      }
      firstTab ??= tabId;
    }
    if (firstTab == null) return false;
    _show(app, firstTab);
    return true;
  }

  Future<bool> _openFresh(
    AppNotifier app,
    String machineId,
    FirstArrivalPlan plan,
    Duration starterWait,
  ) async {
    final String folder;
    try {
      folder = await app.prepareLocalProjectFolder(
        ProjectFolderRequest.generated(
          label: externalEngineName(plan.fresh.first),
          at: _now(),
          task: plan.typesStarterTask ? starterTask : null,
        ),
        label: externalEngineName(plan.fresh.first),
      );
    } catch (error) {
      debugPrint('first arrival: no project folder: $error');
      return false;
    }
    final tabId = app.activeSwarmId;
    TerminalPane? lead;
    for (final engine in plan.fresh) {
      final before = {for (final pane in app.allPanes) pane.id};
      final error = await app.createAgent(
        machineId,
        engine: engine,
        folder: folder,
        permissionMode: kDefaultPermissionMode,
        swarmId: tabId,
        placement: HarnessPlacement.currentTab,
      );
      if (error != null) {
        debugPrint('first arrival: $engine not started: $error');
        continue;
      }
      lead ??= app.allPanes
          .where((pane) => !before.contains(pane.id))
          .firstOrNull;
    }
    if (lead == null) return false;
    _show(app, tabId);
    final count =
        app.swarms.where((tab) => tab.id == tabId).firstOrNull?.panes.length ??
        0;
    // OpenCode the full height on the left, the other two stacked on the right.
    if (count == 3 && app.activeSwarmId == tabId) {
      app.setPreset(3, PanePreset.mainLeft);
    }
    app.focusPane(lead.id);
    if (plan.typesStarterTask) {
      unawaited(typeWhenReady(lead, starterTask, wait: starterWait));
    }
    return true;
  }

  void _show(AppNotifier app, String tabId) {
    if (app.activeSwarmId != tabId &&
        app.swarms.any((tab) => tab.id == tabId)) {
      app.selectSwarm(tabId);
    }
    final first = app.swarms
        .where((tab) => tab.id == tabId)
        .firstOrNull
        ?.panes
        .firstOrNull;
    if (first != null) app.focusPane(first.id);
  }

  /// Types [text] into [pane]'s agent once its own screen is up, without Enter: the person reads
  /// it, changes it or sends it. Typed, not pasted, so the agent's box shows the words rather than a
  /// paste marker. Gives up after [wait]: an agent still installing in its pane must not have the
  /// words land in its installer.
  static Future<bool> typeWhenReady(
    TerminalPane pane,
    String text, {
    Duration wait = const Duration(minutes: 3),
    Duration poll = const Duration(milliseconds: 500),
    bool Function(String screen) ready = openCodeReady,
  }) async {
    final deadline = DateTime.now().add(wait);
    while (DateTime.now().isBefore(deadline)) {
      final session = pane.session;
      if (session != null && session.acceptsInput && ready(_screen(session))) {
        // A moment for the box to take focus after its first frame.
        await Future<void>.delayed(const Duration(milliseconds: 800));
        if (pane.session != session || !session.acceptsInput) continue;
        session.terminal.textInput(text);
        return true;
      }
      await Future<void>.delayed(poll);
    }
    return false;
  }

  static String _screen(TerminalSession session) {
    final buffer = session.terminal.buffer;
    final lines = <String>[];
    final start = buffer.height - session.terminal.viewHeight;
    for (var row = start < 0 ? 0 : start; row < buffer.height; row++) {
      lines.add(buffer.lines[row].toString());
    }
    return lines.join('\n');
  }

  /// OpenCode's home screen: its prompt box and the key hints beneath it.
  static bool openCodeReady(String screen) {
    final text = screen.toLowerCase();
    return text.contains('ctrl+p') ||
        text.contains('ask anything') ||
        (text.contains('tab') && text.contains('agent'));
  }
}

/// Recent conversations from a `session_search` answer: Claude Code and Codex only, Harness's own
/// left out, none that a process anywhere has open, none whose folder has gone, once each.
List<ArrivalSession> sessionsFromHits(
  List<SessionContentHit> hits, {
  required bool Function(String path) folderExists,
}) {
  final seen = <String>{};
  final sessions = <ArrivalSession>[];
  for (final hit in hits) {
    final ref = hit.external;
    final at = hit.lastAt ?? hit.at;
    if (ref == null || ref.open || at == null) continue;
    if (ref.engine != 'claude' && ref.engine != 'codex') continue;
    if (!seen.add('${ref.engine}:${ref.sessionId}')) continue;
    if (!folderExists(ref.cwd)) continue;
    sessions.add(
      ArrivalSession(
        engine: ref.engine,
        sessionId: ref.sessionId,
        cwd: ref.cwd,
        title: ref.title,
        lastAt: at,
      ),
    );
  }
  sessions.sort((a, b) => b.lastAt.compareTo(a.lastAt));
  return sessions;
}

/// The owner's rules (2026-10-08). Conversations first: the latest Claude Code and the latest Codex
/// side by side, or the two latest of the one agent there is, then the next three in a second tab,
/// with both agents in it when both have one left. Without conversations, someone setup gave the
/// three agents gets them in one tab, OpenCode first; someone with agents gets a fresh pane on each
/// of Claude Code and Codex they have, or on OpenCode when that is all they have.
FirstArrivalPlan planFirstArrival({
  required bool newUser,
  required List<ArrivalSession> sessions,
  required Set<String> installed,
}) {
  if (sessions.isNotEmpty) return FirstArrivalPlan(tabs: recentTabs(sessions));
  if (newUser) {
    return const FirstArrivalPlan(fresh: ['opencode', 'codex', 'claude']);
  }
  final fresh = [
    for (final engine in const ['claude', 'codex'])
      if (installed.contains(engine)) engine,
  ];
  if (fresh.isNotEmpty) return FirstArrivalPlan(fresh: fresh);
  if (installed.contains('opencode')) {
    return const FirstArrivalPlan(fresh: ['opencode']);
  }
  return const FirstArrivalPlan();
}

/// [sessions] into at most two tabs of two and three, by the rules on [planFirstArrival].
List<List<ArrivalSession>> recentTabs(List<ArrivalSession> sessions) {
  final sorted = [...sessions]..sort((a, b) => b.lastAt.compareTo(a.lastAt));
  if (sorted.isEmpty) return const [];
  final latest = <String, ArrivalSession>{};
  for (final session in sorted) {
    latest.putIfAbsent(session.engine, () => session);
  }
  final first = latest.length >= 2
      ? (latest.values.take(2).toList()
          ..sort((a, b) => b.lastAt.compareTo(a.lastAt)))
      : sorted.take(2).toList();
  final rest = [
    for (final session in sorted)
      if (!first.contains(session)) session,
  ];
  final second = rest.take(3).toList();
  if (second.length == 3 &&
      second.every((session) => session.engine == second.first.engine)) {
    final other = rest
        .skip(3)
        .where((session) => session.engine != second.first.engine)
        .firstOrNull;
    if (other != null) {
      second
        ..[2] = other
        ..sort((a, b) => b.lastAt.compareTo(a.lastAt));
    }
  }
  return [first, if (second.isNotEmpty) second];
}
