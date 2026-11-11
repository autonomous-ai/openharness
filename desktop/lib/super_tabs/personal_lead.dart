import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';

import '../core/project_folder.dart';
import '../state/app_state.dart';
import '../state/new_harness.dart' show kLeadModel;
import 'controller.dart';
import 'launch.dart';
import 'model.dart';
import 'personal_projects.dart';

/// How long a start this Desktop asked for, or saw another of the person's
/// machines claim, shows as starting: the server's claim holds as long
/// (backend leadStart.ts LEAD_CLAIM_MS).
const kPersonalLeadStartWindow = Duration(minutes: 10);

/// Where a project's Lead starts: the person's machine, its engine, and the
/// repo's folder there, or null for a new folder in the Harness projects one.
typedef PersonalLeadPlan = ({
  String machineId,
  String engine,
  String? folder,
  String projectName,
});

/// What this Desktop knows of a project chat's Lead start: starting since
/// [at], or failed with [reason].
@immutable
class PersonalLeadStatus {
  const PersonalLeadStatus.starting(this.at) : reason = null;
  const PersonalLeadStatus.failed(String this.reason) : at = null;
  final DateTime? at;
  final String? reason;
  bool get failed => reason != null;
}

/// A Personal Swarm project's PM, started by this Desktop from the project's
/// channel (task #2633, Huy 11-04: "Not sent, this chat has no Lead" was the
/// first thing a new person met). Only Desktop knows a Personal project's
/// folder (personal_projects.dart), so the PM starts here, as Add a Lead's
/// own-machine start does, without its form: on this computer, or the
/// person's computer whose pane holds the project's repo, in that repo's
/// folder, else in a new folder of the Harness projects folder. One claim
/// (lead.claim) keeps two of the person's Desktops from starting two, and
/// answers the PM's own 1:1 chat (backend pmChat.ts), which opens at once:
/// the person talks to it there while it starts, and the server keeps what
/// they send for it. A Team Swarm starts nothing.
class PersonalLeadStarter extends ChangeNotifier {
  PersonalLeadStarter._(this.app);
  static final _of = Expando<PersonalLeadStarter>();
  static PersonalLeadStarter of(AppNotifier app) =>
      _of[app] ??= PersonalLeadStarter._(app);

  final AppNotifier app;
  final _status = <String, PersonalLeadStatus>{};

  /// The native start and join, in tests.
  @visibleForTesting
  static Future<void> Function(
    SuperTabController c,
    String conversationId,
    PersonalLeadPlan plan,
  )?
  launchForTest;

  String _key(SuperTabController c, String conversationId) =>
      '${c.accountId}/${c.tabId}/$conversationId';

  /// The start of [conversationId]'s Lead as this Desktop knows it: one
  /// starting for longer than the claim holds is no longer shown.
  PersonalLeadStatus? statusOf(SuperTabController c, String conversationId) {
    final status = _status[_key(c, conversationId)];
    if (status?.at case final at?
        when clock.now().difference(at) >= kPersonalLeadStartWindow) {
      return null;
    }
    return status;
  }

  /// Sets [conversationId]'s start as a test reads it.
  @visibleForTesting
  void setStatusForTest(
    SuperTabController c,
    String conversationId,
    PersonalLeadStatus status,
  ) => _set(_key(c, conversationId), status);

  void _set(String key, PersonalLeadStatus status) {
    _status[key] = status;
    notifyListeners();
  }

  /// Whether [conversationId] of [c] offers to start its project's PM: the
  /// signed-in person's own Personal Swarm, a project's channel, and no PM
  /// there.
  bool wants(SuperTabController c, String conversationId) {
    if (!PersonalProjects.of(app).eligible(c)) return false;
    final snapshot = c.snapshot!;
    final group = snapshot.conversation(conversationId);
    if (group == null || group.archived) return false;
    if (!snapshot.isProjectLead(conversationId)) return false;
    final project = snapshot.projectFor(conversationId);
    return project != null && snapshot.leadOf(project.id) == null;
  }

  /// Starts [conversationId]'s PM from its channel's card (task #2815), once:
  /// a start already running here, or one another of the person's machines
  /// claimed, is the one. The PM's own chat opens as soon as the claim
  /// answers it, before the PM is up.
  Future<void> start(SuperTabController c, String conversationId) async {
    final key = _key(c, conversationId);
    if (statusOf(c, conversationId) case final status? when !status.failed) {
      return;
    }
    _set(key, PersonalLeadStatus.starting(clock.now()));
    try {
      final project = c.snapshot?.projectFor(conversationId);
      if (project == null) {
        throw const SuperTabFailure(
          'PROJECT_UNAVAILABLE',
          'this project is no longer available',
        );
      }
      final plan = planFor(c, conversationId);
      final claim = await c.request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(c.tabId)}/commands',
        body: {
          'operationId': superTabOperationId(),
          'command': {
            'type': 'lead.claim',
            'projectId': project.id,
            'machineId': plan.machineId,
          },
        },
      );
      final answer = superTabMap(claim['result']);
      // Its own chat opens now, unless its person moved on meanwhile. A
      // backend before it opens none until the PM joins; the start goes on.
      final chatId = answer['chatId'] as String?;
      if (chatId != null && c.selectedId == conversationId) {
        await c.select(chatId);
      }
      // Another of the person's machines starts it: its join ends the note.
      if (answer['leadStart'] == 'waiting') return;
      try {
        await (launchForTest ?? _launch)(c, conversationId, plan);
      } catch (_) {
        // Back to the channel, whose card says why and starts it again.
        if (chatId != null && c.selectedId == chatId) {
          unawaited(c.select(conversationId));
        }
        rethrow;
      }
      // Starting until the chat reads its PM.
      unawaited(c.refresh().catchError((Object _) {}));
    } on SuperTabFailure catch (failure) {
      _set(key, PersonalLeadStatus.failed(_reason(failure)));
    } catch (error) {
      _set(key, PersonalLeadStatus.failed(_trim('$error')));
    }
  }

  bool _usable(MachineState? m) =>
      m != null &&
      !m.belongsToOtherAccount &&
      !m.machine.isTeamAccount &&
      !m.isOffline;

  /// The person's own computers a PM can start on: connected, this one first.
  List<MachineState> _machinesFor() => [
    ...app.machineStates.values.where((m) => _usable(m) && m.isLocalMachine),
    ...app.machineStates.values.where((m) => _usable(m) && !m.isLocalMachine),
  ];

  /// Where [conversationId]'s PM starts, or throws why it cannot: the repo's
  /// folder on this computer, else on the person's computer whose pane holds
  /// it; with no repo, this computer, else another of theirs connected.
  PersonalLeadPlan planFor(SuperTabController c, String conversationId) {
    final project = c.snapshot!.projectFor(conversationId)!;
    String? repoFolder(String machineId, String? agentId) {
      final agent = app
          .stateOf(machineId)
          ?.agents
          .where((a) => a.id == agentId)
          .firstOrNull;
      final where = agent?.project;
      if (where == null ||
          (normalizedRemote(where.repository) ??
                  normalizedRemote(where.remote)) ==
              null) {
        return null;
      }
      return where.root ?? where.cwd;
    }

    final machines = _machinesFor();
    final local = machines.where((m) => m.isLocalMachine).firstOrNull;
    final repos = [
      for (final pane in PersonalProjects.of(app).panesFor(c, conversationId))
        if (_usable(app.stateOf(pane.machineId)))
          if (repoFolder(pane.machineId, pane.agentId) case final folder?)
            (machineId: pane.machineId, folder: folder),
    ];
    final repo =
        repos
            .where((r) => r.machineId == local?.machine.machineId)
            .firstOrNull ??
        repos.firstOrNull;
    final machine = repo != null
        ? app.stateOf(repo.machineId)!
        : local ?? machines.firstOrNull;
    if (machine == null) {
      throw const SuperTabFailure(
        'NO_MACHINE',
        'none of your computers is online',
      );
    }
    final chosen = _engineOn(machine);
    if (chosen == null) {
      throw SuperTabFailure(
        'NO_ENGINE',
        'Claude Code and Codex aren’t signed in on '
            '${machine.machine.displayName}',
      );
    }
    return (
      machineId: machine.machine.machineId,
      engine: chosen,
      folder: repo?.folder,
      projectName: project.name,
    );
  }

  /// Claude Code first, else Codex: one installed (or that installs on
  /// start) and not signed out. An engine list not read yet tries Claude
  /// Code, whose start then says what is missing.
  String? _engineOn(MachineState machine) {
    final engines = machine.engines;
    if (!engines.loaded) return 'claude';
    for (final engine in const ['claude', 'codex']) {
      final known = engines[engine];
      if (known != null &&
          (known.installed || known.installable) &&
          known.signedIn != false) {
        return engine;
      }
    }
    return null;
  }

  /// The Lead's own-machine start, as Add a Lead's New Harness runs it
  /// (launch.dart): its journal, the native start, then its join as Lead.
  Future<void> _launch(
    SuperTabController c,
    String conversationId,
    PersonalLeadPlan plan,
  ) async {
    final tab = app.swarms.where((s) => s.superTabId == c.tabId).firstOrNull;
    if (tab == null) {
      throw const SuperTabFailure(
        'SWARM_UNAVAILABLE',
        'open your Personal Swarm in a tab first',
      );
    }
    final integration = await SuperTabLaunch.open(app, tab, conversationId);
    // A start of this chat's Lead from before is finished, not repeated.
    if (integration.pending) {
      await integration.resume!();
      return;
    }
    final prompt = await integration.prepare(plan.machineId, '', plan.engine);
    final attempt = AgentCreationAttempt(
      background: true,
      beforeSubmit: integration.beforeSubmit,
      launchModel: plan.engine == 'claude'
          ? (model: kLeadModel.model, effort: kLeadModel.effort)
          : null,
    );
    integration
      ..engine = plan.engine
      ..folder = plan.folder;
    final failure = await app.createAgent(
      plan.machineId,
      engine: plan.engine,
      folder: plan.folder,
      // A suggested name: a folder of it already there (an earlier start's)
      // is numbered past, not refused.
      projectFolder: plan.folder == null
          ? ProjectFolderRequest.generated(
              label: 'Lead',
              at: clock.now(),
              name: plan.projectName,
            )
          : null,
      swarmId: tab.id,
      // No dialog, so no mode the person chose: the PM starts with its owner's
      // own permission settings (Swarm v3, task #4215).
      bypassPermission: false,
      swarmRole: integration.swarmRole,
      prompt: prompt,
      attempt: attempt,
    );
    if (failure != null) throw SuperTabFailure('CREATE_FAILED', failure);
    final harnessId = attempt.agentId;
    if (harnessId == null) {
      throw const SuperTabFailure(
        'CREATE_FAILED',
        'the computer didn’t say which harness it started',
      );
    }
    integration.launchModelRefused = attempt.launchModelRefused;
    await integration.complete(plan.machineId, harnessId);
  }

  /// A failure in the receipt's words: an older server that does not know the
  /// claim says so, any other its own reason, without a final full stop.
  String _reason(SuperTabFailure failure) => failure.code == 'VALIDATION_ERROR'
      ? 'this Swarm’s server needs an update'
      : _trim(failure.message);

  String _trim(String text) {
    final line = text.trim().split('\n').first;
    return line.endsWith('.') ? line.substring(0, line.length - 1) : line;
  }
}
