import 'package:path/path.dart' as p;

import '../core/git_worktree.dart';
import '../core/launch_setup.dart';
import '../core/permission_modes.dart';
import '../core/project_folder.dart';
import '../core/models.dart' show Agent, AgentProject, ConnectionStatus;
import 'session_preview.dart';
import '../widgets/engine_identity.dart';
import 'app_state.dart';
import 'new_harness.dart' show gitFolderRequest, worktreeByDefault;

/// What ⌘B tells the router (docs/design/2026-10-09-auto-router.md, cli/src/services/router.ts): the
/// sessions this app can see on every machine — the router reaches none itself — and, for new work, the
/// person's project folders and the agents they use. The ids come back untouched.
class TaskRouteChoices {
  const TaskRouteChoices(this.sessions, this.projects, this.agents);

  /// id → the session, as this app knows it. Plain terminals and shared views are not among them:
  /// a shell is not somewhere a task is sent, and a shared view takes no input.
  final Map<String, TaskRouteSession> sessions;

  /// id → (machine, folder). The id is what the daemon hands back.
  final Map<String, ({String machineId, String folder, String name})> projects;

  /// Engine ids, with the names the models read.
  final Map<String, String> agents;

  Map<String, dynamic> toPayload() => {
    'sessions': [
      for (final MapEntry(:key, :value) in sessions.entries)
        {
          'id': key,
          'name': value.name,
          'asks': value.asks,
          if (value.about != null) 'about': value.about,
          if (value.stoppedFor case final stopped?)
            'stoppedAgoMs': stopped.inMilliseconds,
        },
    ],
    'projects': [
      for (final MapEntry(:key, :value) in projects.entries)
        {'id': key, 'name': value.name},
    ],
    'agents': [
      for (final MapEntry(:key, :value) in agents.entries)
        {'id': key, 'name': value},
    ],
  };
}

/// The folder a session's work belongs to: the repository, not a temporary worktree of it.
String? _projectFolder(AgentProject? project) => project == null
    ? null
    : project.worktree && project.root != null
    ? project.root
    : project.cwd;

bool _usable(String folder) =>
    p.isAbsolute(folder) &&
    !isInternalLaunchFolder(folder) &&
    !folder.contains('/harnesses/worktrees/') &&
    // Harness's own folders (a Store fork's `project`, say) are not where a person's new work starts.
    !folder.contains('/.harness/') &&
    folder.length <= 4096;

const _sessionCap = 40;

/// How long a stopped session stays one a task can be for. The rail keeps every stopped session it ever
/// ran; a week is what a person picks back up ("the lamp work from Tuesday"), and past it the list only
/// spreads Jev thinner over work nobody is coming back to.
const stoppedSessionsWithin = Duration(days: 7);

Duration _atLeastZero(Duration d) => d.isNegative ? Duration.zero : d;

/// The sessions, projects and agents ⌘B's router chooses from. [now] is for tests.
TaskRouteChoices taskRouteChoices(AppNotifier app, {DateTime? now}) {
  final since = (now ?? DateTime.now()).subtract(stoppedSessionsWithin);
  final machines =
      [
            ...app.machineStates.values.where((m) => m.isLocalMachine),
            ...app.machineStates.values.where((m) => !m.isLocalMachine),
          ]
          // Machines a task can reach now: the app also remembers the sessions of machines that are off.
          .where(
            (m) =>
                !m.machine.isShared &&
                !m.needsLink &&
                m.nodeOnline != false &&
                m.connectionStatus == ConnectionStatus.connected,
          )
          .toList();
  final found = <({String machineId, String machine, String folder})>[];
  final seen = <String>{};
  for (final machine in machines) {
    final id = machine.machine.machineId;
    for (final folder in [
      ...app.projectHistory.recent(id),
      for (final agent in machine.agents.reversed)
        ?_projectFolder(machine.projectOf(agent)),
    ]) {
      if (!_usable(folder) || !seen.add('$id\n${p.normalize(folder)}')) {
        continue;
      }
      found.add((
        machineId: id,
        machine: machine.machine.displayName,
        folder: p.normalize(folder),
      ));
    }
  }
  // A folder's name is what the models read. Two of the same name are told apart by their machine.
  final named = <String, int>{};
  for (final row in found) {
    named.update(p.basename(row.folder), (n) => n + 1, ifAbsent: () => 1);
  }
  final projects = {
    for (final row in found)
      '${row.machineId}\n${row.folder}': (
        machineId: row.machineId,
        folder: row.folder,
        name: named[p.basename(row.folder)]! > 1
            ? '${p.basename(row.folder)} on ${row.machine}'
            : p.basename(row.folder),
      ),
  };
  // Live sessions, and stopped ones active in the last [stoppedSessionsWithin] that can resume their own
  // conversation — a follow-up typed into a fresh one would land with none of what it follows. The most
  // recently active first, and at most [_sessionCap]: the first try sent all two hundred the rail keeps,
  // and the one the task was for was not among the forty Jev was shown.
  final live =
      [
        for (final machine in machines)
          for (final agent in machine.agents)
            if (agent.engine != null &&
                !isTerminalEngine(agent.engine) &&
                (!agent.isStopped ||
                    (agent.canResumeConversation &&
                        agent.lastActivityAt?.isAfter(since) == true)))
              (machine: machine, agent: agent),
      ]..sort((a, b) {
        final at = a.agent.lastActivityAt, bt = b.agent.lastActivityAt;
        return bt == null
            ? (at == null ? 0 : -1)
            : at == null
            ? 1
            : bt.compareTo(at);
      });
  final sessions = {
    for (final (:machine, :agent) in live.take(_sessionCap))
      taskRouteSessionId(machine.machine.machineId, agent.id): (
        machineId: machine.machine.machineId,
        agentId: agent.id,
        name: agent.displayName,
        machine: machine.machine.displayName,
        engine: agent.engine!,
        asks:
            _recent[app]?['${machine.machine.machineId}\n${agent.id}']?.asks ??
            [
              ...?_preview(
                app,
                machine.machine.machineId,
                agent,
              )?.requests.take(2),
            ],
        about:
            _recent[app]?['${machine.machine.machineId}\n${agent.id}']?.about ??
            _about(_preview(app, machine.machine.machineId, agent)),
        // Never less than nothing: a machine whose clock runs ahead would otherwise read as live.
        stoppedFor: agent.isStopped
            ? _atLeastZero(
                (now ?? DateTime.now()).difference(agent.lastActivityAt!),
              )
            : null,
      ),
  };
  final engines = <String>{'claude', 'codex'};
  for (final machine in machines) {
    for (final agent in machine.agents) {
      final engine = agent.engine;
      if (engine != null && engine.isNotEmpty && !isTerminalEngine(engine)) {
        engines.add(engine);
      }
    }
  }
  return TaskRouteChoices(sessions, projects, {
    for (final engine in engines) engine: engineIdentity(engine).label,
  });
}

/// What each session was last asked and last did, as its machine told the router's box: the router
/// decides from it. Read for every session the box offers when it opens — all at once, not the preview
/// store's two at a time — and kept a couple of minutes.
final _recent =
    Expando<Map<String, ({DateTime at, List<String> asks, String? about})>>();
const _recentFresh = Duration(minutes: 2);

/// ⌘B opened: read what each session is about while the person types. Resolves once every read has answered (each is bounded by its own deadline).
///
/// 2026-10-10, "what's d30 retention on harness": with only names to go on Jev gave the right session
/// 0.53, under its bar, and the task became new work; with each session's last prompt and summary the
/// same question was sure.
Future<void> warmTaskRoute(AppNotifier app) {
  final cache = _recent[app] ??= {};
  final now = DateTime.now();
  return Future.wait([
    for (final MapEntry(:key, :value) in taskRouteChoices(app).sessions.entries)
      if (cache[key] == null || now.difference(cache[key]!.at) > _recentFresh)
        app.readRecentTurns(value.machineId, value.agentId).then((reply) {
          final asks = reply['asks'];
          final events = reply['events'];
          // Its last three turns, summarised: the newest alone often names nothing ("Tomorrow we'll
          // compare…"), the two before it name the topic ("activation and repeat use").
          final turns = events is List
              ? [
                  for (final e in events.whereType<Map>())
                    if ((e['recap'] ?? e['text']) case final String said)
                      said.replaceAll(RegExp(r'\s+'), ' ').trim(),
                ].where((said) => said.isNotEmpty).take(3)
              : const <String>[];
          final about = turns.isEmpty
              ? null
              : turns
                    .map(
                      (said) =>
                          said.length <= 140 ? said : said.substring(0, 140),
                    )
                    .join(' / ');
          cache[key] = (
            at: DateTime.now(),
            asks: [
              if (asks is List)
                for (final ask in asks.take(2))
                  if (ask is String && ask.isNotEmpty) ask,
            ],
            about: about,
          );
        }),
    // A Future<void> in fact, not a Future<List<Null>> typed as one: the box puts a timeout on it, and
    // a timeout's fallback is checked against the runtime type.
  ]).then((_) {});
}

/// The new harness when neither model was sure of its setup: the pane the person is in — its machine,
/// its agent and its project — as ⌘N then Return would make it. Null when there is no folder to start
/// in at all; New Harness then asks.
({String machineId, String engine, String folder})? taskRouteDefault(
  AppNotifier app,
) {
  final pane = app.focusedPane;
  final machine = pane == null
      ? app.localMachineState
      : app.stateOf(pane.machineId);
  if (machine == null) return null;
  final agent = pane == null
      ? null
      : machine.agents.where((a) => a.id == pane.agentId).firstOrNull;
  final used = agent?.engine;
  final engine = used == null || used.isEmpty || isTerminalEngine(used)
      ? 'claude'
      : used;
  final id = machine.machine.machineId;
  // The pane's own folder even when it is a worktree: newWorkFolder starts from its repository.
  final paneFolder = agent == null
      ? null
      : _projectFolder(machine.projectOf(agent));
  final folder =
      (paneFolder != null && p.isAbsolute(paneFolder) ? paneFolder : null) ??
      app.projectHistory.recent(id).where(_usable).firstOrNull;
  return folder == null
      ? null
      : (machineId: id, engine: engine, folder: p.normalize(folder));
}

typedef TaskRouteSession = ({
  String machineId,
  String agentId,
  String name,
  String machine,
  String engine,
  List<String> asks,
  String? about,

  /// How long ago a stopped session was last active; null for a live one. Jev is told, so a live "lamp
  /// v2" is not mistaken for the stopped "lamp v1" of last week.
  Duration? stoppedFor,
});

SessionPreview? _preview(AppNotifier app, String machineId, Agent agent) =>
    app.sessionPreviews.read((
      machineId: machineId,
      agentId: agent.id,
      sessionId: agent.sessionId,
    ));

/// Its latest turn, summarised, in a line: often the only place a session's topic is said.
String? _about(SessionPreview? preview) {
  final text = preview?.response?.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (text == null || text.isEmpty) return null;
  return text.length <= 240 ? text : text.substring(0, 240);
}

/// The router's answer, read against the lists it was given: a session of [TaskRouteChoices.sessions],
/// or new work with the project and agent a model was sure of (either may be null).
class TaskRouteDecision {
  const TaskRouteDecision._({
    this.session,
    this.sessionId,
    this.project,
    this.engine,
    required this.via,
    this.unavailableBecause,
  });

  /// Jev could not be asked — no key, no network, no credit — so nothing was decided, and the box says so
  /// rather than guessing.
  const TaskRouteDecision.unavailable(String because)
    : this._(via: '', unavailableBecause: because);

  final String? unavailableBecause;

  final TaskRouteSession? session;
  final String? sessionId;
  final ({String machineId, String folder, String name})? project;
  final String? engine;

  /// 'jev' when Jev was sure, 'unsure' when it was not and the task became new work.
  final String via;

  bool get isNew => session == null && unavailableBecause == null;

  /// Null for an answer that is not a decision (an error, or a session it was not given).
  static TaskRouteDecision? fromJson(
    Map<String, dynamic> json,
    TaskRouteChoices choices,
  ) {
    final via = json['via'] is String ? json['via'] as String : '';
    switch (json['decided']) {
      case 'session':
        final id = json['id'];
        final session = id is String ? choices.sessions[id] : null;
        return session == null
            ? null
            : TaskRouteDecision._(
                session: session,
                sessionId: id as String,
                via: via,
              );
      case 'new':
        final project = json['project'];
        final agent = json['agent'];
        return TaskRouteDecision._(
          project: project is String ? choices.projects[project] : null,
          engine: agent is String && choices.agents.containsKey(agent)
              ? agent
              : null,
          via: via,
        );
    }
    return null;
  }
}

/// Where new work starts, as ⌘N then Return would start it: in a Git project, a fresh worktree from its
/// main branch — never inside a checkout another harness may be working in — and in [folder]'s
/// repository when [folder] is itself a worktree. Outside Git, the folder as it is.
///
/// Null when the folder could not be read (a machine slow to answer, a folder gone): "not read" is not
/// "not Git", and taking it for that would start the work in the repository's own checkout.
Future<({String folder, ProjectFolderRequest? request})?> newWorkFolder(
  AppNotifier app,
  String machineId,
  String folder,
) async {
  var info = GitProjectInfo.fromJson(
    await app.readGitProject(machineId, folder),
  );
  var root = folder;
  if (info.mainFolder case final main?
      when info.error == null && p.normalize(main) != p.normalize(folder)) {
    root = main;
    info = GitProjectInfo.fromJson(await app.readGitProject(machineId, main));
  }
  if (info.error != null) return null;
  if (!info.isGit) return (folder: root, request: null);
  return (
    folder: root,
    request: gitFolderRequest(
      root,
      info,
      worktree: worktreeByDefault(info),
      branchRef: null,
      branchName: null,
      placeholder: placeholderBranch([for (final b in info.branches) b.name]),
    ),
  );
}

/// The permission mode New Harness would start [engine] in: the one the person last started it with,
/// else the default; null for an agent that has no modes. A spoken or typed task must not start an
/// agent that approves its own actions for someone who chose to be asked.
String? taskRoutePermission(AppNotifier app, String engine) {
  if (permissionModesOf(engine).isEmpty) return null;
  final last = app.agentPreference.successfulLaunch;
  return (last?.engine == engine ? last?.permissionMode : null) ??
      kDefaultPermissionMode;
}

/// A session as the router names it: its machine and its agent.
String taskRouteSessionId(String machineId, String agentId) =>
    '$machineId\n$agentId';
