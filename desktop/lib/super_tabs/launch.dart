import 'dart:convert';
import 'dart:math' as math;

import 'package:dio/dio.dart' show CancelToken;
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:path/path.dart' as p;

import '../core/first_task.dart';
import '../core/models.dart';
import '../state/app_state.dart';
import '../state/harness_attachments.dart';
import '../state/harness_launch_integration.dart';
import '../state/lead_placement.dart';
import '../state/swarm.dart';
import 'attachment_upload.dart';
import 'controller.dart';
import 'machine_icon.dart';
import 'machine_status.dart';
import 'model.dart';
import 'launch_prompt.dart';
import 'identity.dart' show superTabPersonName;

/// Captures a conversation before opening New Harness. Its journal survives a
/// closed form or process; a recovered launch only reads the native receipt.
class SuperTabLaunch {
  SuperTabLaunch._(
    this.app,
    this.swarmId,
    this.accountId,
    this.key,
    this.saved,
  );
  final AppNotifier app;
  final String swarmId, accountId, key;
  final Map<String, dynamic> saved;

  static Future<HarnessLaunchIntegration> open(
    AppNotifier app,
    Swarm tab,
    String conversationId, {
    bool newProject = false,
  }) async {
    final account = app.currentUser?.id;
    if (account == null) {
      throw const SuperTabFailure('SIGNED_OUT', 'Sign in to create a Swarm.');
    }
    final key = 'super_tab.launch.$account.${tab.id}.$conversationId';
    final raw = await app.superTabs.storage.read(key);
    if (app.currentUser?.id != account) {
      throw const SuperTabFailure('ACCOUNT_CHANGED', 'The account changed.');
    }
    final saved = raw == null
        ? <String, dynamic>{
            'operationId': superTabOperationId(),
            'joinId': superTabOperationId(),
            'tabId': tab.superTabId,
            'conversationId': conversationId,
            'lead': tab.superTabId == null || newProject,
            'newSwarm': tab.superTabId == null,
            'newProject': newProject,
            'visibility': 'public',
            if (!newProject) 'projectId': 'lead',
          }
        : superTabMap(jsonDecode(raw));
    final launch = SuperTabLaunch._(app, tab.id, account, key, saved);
    final recovering =
        saved['phase'] == 'starting' || saved['phase'] == 'joining';
    List<HarnessLaunchRole>? roles;
    if (saved['lead'] != true && tab.superTabId != null) {
      final snapshot = await app.superTabs.readSnapshot(tab.superTabId!);
      final project = snapshot.projectFor(conversationId);
      if (project?.skillSet == 'custom') {
        roles = [
          for (final role in project?.roles ?? const <SuperTabRole>[])
            if (role.kind == 'builder' || role.kind == 'reviewer')
              HarnessLaunchRole(id: role.id, name: role.name, kind: role.kind),
        ];
      }
    }
    // A project's Product Manager starts on one of the Swarm's machines.
    // Read from the open Swarm when there is one; each submit reads afresh.
    List<LeadMachine>? leadMachines;
    LeadModelList? leadModels;
    if (saved['newProject'] == true && tab.superTabId != null) {
      final id = tab.superTabId!;
      final policy = launch.readRoutingPolicy(id);
      final snapshot =
          app.superTabs.peek(id)?.snapshot ??
          await app.superTabs.readSnapshot(id);
      leadMachines = launch.leadMachinesOf(snapshot);
      leadModels = LeadModelList.of(await policy);
    }
    final selectedRole =
        roles?.where((role) => role.id == saved['roleId']).firstOrNull ??
        roles?.where((role) => role.kind == 'builder').firstOrNull ??
        roles?.firstOrNull;
    late final HarnessLaunchIntegration integration;
    integration =
        HarnessLaunchIntegration(
            forcedPermissionMode: 'full',
            startInSwarm: leadMachines == null
                ? null
                : (start) async {
                    if (saved['projectPrepared'] != true &&
                        saved['creationRequest'] == null) {
                      saved['visibility'] =
                          integration.projectVisibility ?? 'public';
                    }
                    try {
                      // A start already sent is repeated as it is: the server may
                      // have committed it and taken the machine's last slot, so
                      // its answer decides, not a fresh check.
                      if (start.machineId case final machine?
                          when saved['leadStartRequest'] == null) {
                        await launch.recheckLeadMachine(
                          integration,
                          machine,
                          engine: start.engine,
                        );
                      }
                      await launch.startInSwarm(start);
                    } on SuperTabFailure catch (failure) {
                      // As prepare: a request validation refused leaves no project.
                      if (saved['projectPrepared'] != true &&
                          const {
                            'VALIDATION_ERROR',
                            'UPDATE_REQUIRED',
                          }.contains(failure.code)) {
                        saved.remove('creationRequest');
                        saved['operationId'] = superTabOperationId();
                        await launch.persist();
                      }
                      rethrow;
                    } finally {
                      integration.projectVisibilityLocked =
                          saved['projectPrepared'] == true ||
                          saved['creationRequest'] != null;
                    }
                  },
            creationId: saved['creationId'] as String? ?? superTabOperationId(),
            initialTask: saved['initialMessage'] as String?,
            swarmRole: saved['lead'] == true
                ? 'lead'
                : selectedRole?.swarmRole ??
                      (saved['roleKind'] == 'reviewer' ? 'review' : 'dev'),
            swarmSkillMode: saved['skillMode'] as String? ?? 'orchestration',
            roles: roles,
            roleId: recovering ? saved['roleId'] as String? : selectedRole?.id,
            actionLabel: saved['newProject'] == true
                ? 'New Project'
                : saved['lead'] == true
                ? 'New Swarm'
                : 'New Harness',
            // Routing reads quota for Claude Code and Codex only, so a Lead is one
            // of them; the agents it starts may be anything.
            engines: saved['lead'] == true ? const ['claude', 'codex'] : null,
            projectVisibility: saved['lead'] == true
                ? saved['visibility'] as String? ?? 'public'
                : null,
            projectVisibilityLocked:
                saved['projectPrepared'] == true ||
                saved['creationRequest'] != null,
            prepare: (machine, task, engine) async {
              if (integration.leadMachines != null) {
                await launch.recheckLeadMachine(
                  integration,
                  machine,
                  engine: engine,
                );
              }
              if (integration.roles != null) {
                final chosen = integration.roles!
                    .where((role) => role.id == integration.roleId)
                    .firstOrNull;
                if (chosen == null) {
                  throw const SuperTabFailure(
                    'ROLE_UNAVAILABLE',
                    'Choose a role before starting this agent.',
                  );
                }
                saved['roleId'] = chosen.id;
                saved['roleKind'] = chosen.kind;
              }
              if (saved['projectPrepared'] != true &&
                  saved['creationRequest'] == null) {
                saved['visibility'] = integration.projectVisibility ?? 'public';
              }
              try {
                final prompt = await launch.prepare(machine, task);
                integration.swarmSkillMode =
                    saved['skillMode'] as String? ?? 'orchestration';
                integration.swarmRole = saved['lead'] == true
                    ? 'lead'
                    : saved['roleKind'] == 'reviewer'
                    ? 'review'
                    : 'dev';
                return prompt;
              } on SuperTabFailure catch (failure) {
                if (failure.code == 'PROJECT_UNAVAILABLE' && launch.started) {
                  integration.discard = launch.discard;
                }
                // Validation rejects the request before applying it. A lost response
                // stays locked so retrying cannot create a second project or change
                // the visibility of a project that may already exist.
                if (saved['projectPrepared'] != true &&
                    const {
                      'VALIDATION_ERROR',
                      'UPDATE_REQUIRED',
                    }.contains(failure.code)) {
                  saved.remove('creationRequest');
                  saved['operationId'] = superTabOperationId();
                  await launch.persist();
                }
                rethrow;
              } finally {
                integration.projectVisibilityLocked =
                    saved['projectPrepared'] == true ||
                    saved['creationRequest'] != null;
              }
            },
            beforeSubmit: (machine, receipt) async {
              saved['machineId'] = machine;
              saved['creationId'] = receipt;
              saved['phase'] = 'starting';
              saved['engine'] = integration.engine;
              saved['folder'] = integration.folder;
              await launch.persist();
            },
            complete: (machine, harnessId) async {
              try {
                await launch.join(machine, harnessId);
              } catch (_) {
                // The harness exists and its join did not finish: the journal now
                // holds it, and the person may rather drop it than retry.
                integration.discard = launch.discard;
                rethrow;
              }
            },
            stageAttachments: launch.stageAttachments,
            needsAttachmentReview: () => saved['filesState'] == 'sending',
            resolveAttachments: (resend) async {
              launch.checkAccount();
              saved['filesState'] = resend ? 'pending' : 'delivered';
              await launch.persist();
              await launch.resume();
            },
            resume: recovering
                ? () async {
                    try {
                      await launch.resume();
                    } on SuperTabFailure catch (failure) {
                      if (failure.code == 'CREATION_FAILED') {
                        saved.remove('phase');
                        saved.remove('creationId');
                        await launch.persist();
                        integration.pending = false;
                        integration.resume = null;
                      }
                      rethrow;
                    }
                  }
                : null,
          )
          ..pending = recovering
          ..leadMachines = leadMachines
          ..leadModels = leadModels;
    if (recovering) {
      integration
        ..machineId = saved['machineId'] as String?
        ..engine = saved['engine'] as String?
        ..folder = saved['folder'] as String?
        ..pendingNote = saved['phase'] == 'joining'
            ? launch.startedNote
            : launch.waitingNote
        ..discard = launch.discard;
    }
    return integration;
  }

  /// A native start was asked for, so the journal must outlive this form.
  bool get started =>
      saved['phase'] == 'starting' || saved['phase'] == 'joining';
  String get who => saved['lead'] == true ? 'Lead' : 'harness';
  String get machineName {
    final machine = saved['machineId'] as String?;
    if (machine == null) return 'the machine';
    return machineNameOf(machine);
  }

  String machineNameOf(String machine) =>
      app.stateOf(machine)?.machine.displayName ?? machine;

  String get startedNote =>
      'The $who started on $machineName. Check status to add it to the project.';
  String get waitingNote {
    final title =
        saved['title'] ??
        (saved['newProject'] == true ? 'New project' : 'Swarm');
    return saved['lead'] == true
        ? 'Waiting for $machineName to start the Lead for “$title”.'
        : 'Waiting for $machineName to start the harness.';
  }

  /// The Swarm's machines, one row per computer, then the person's others,
  /// best first. A new project's Product Manager starts only on one of the
  /// person's own, connected to this Desktop: it runs on its owner's machine,
  /// in their account (Ken, 10-28; docs/swarms.md), so teammates' rows only
  /// say why not.
  List<LeadMachine> leadMachinesOf(SuperTabSnapshot snapshot, {DateTime? now}) {
    final at = (now ?? DateTime.now()).millisecondsSinceEpoch;
    // A machine reports readiness and resources only once it has them.
    Map<String, dynamic> part(Object? value) =>
        value is Map ? superTabMap(value) : const {};
    LeadMachine row(String id, Map<String, dynamic> pool) {
      final reading = snapshot.readingPoolOf(id, accountId) ?? pool;
      final observation = part(reading['observation']);
      final name = pool['name'] as String? ?? id;
      final own = pool['contributorId'] == accountId;
      final connected = app.stateOf(id) != null;
      // Its host says it can start a Product Manager (backend leadStart.ts).
      final capable =
          (observation['capabilities'] as List?)?.contains('leadStart') == true;
      // Another person's Mac runs one only in its Harness Team account.
      final team =
          !own &&
          (reading['hostMachineId'] != null ||
              observation['sessionKind'] == 'team');
      final received = observation['receivedAt'];
      final online =
          received is num &&
          at - received < kSuperTabMachineOfflineAfter.inMilliseconds;
      final running = observation['runningHarnessIds'];
      final max = reading['maxAgents'];
      final checkouts = part(observation['readiness'])['checkouts'];
      final engineRefusals = leadEngineRefusals(
        offered: switch (reading['engines']) {
          final List engines => engines.whereType<String>().toSet(),
          _ => null,
        },
        readiness: {
          for (final raw
              in part(observation['readiness'])['engines'] as List? ?? const [])
            if (part(raw) case {'engine': final String engine} && final row)
              engine: (
                installed: row['installed'] as bool?,
                signedIn: row['signedIn'] as bool?,
              ),
        },
        usedPercents: {
          for (final raw in observation['quotas'] as List? ?? const [])
            if (part(raw) case {
              'engine': final String engine,
              'known': true,
              'windows': final List windows,
            })
              engine: [
                for (final window in windows)
                  if (part(window)['usedPercent'] case final num used) used,
              ],
        },
        // Read by servers with engine health (#2192); absent before.
        suspended: {
          for (final source in [pool, reading])
            if (source['suspendedEngines'] case final Map raw)
              for (final MapEntry(:key, :value) in raw.entries)
                if ((key, value) case (final String engine, final String why))
                  engine: why,
        },
      );
      final device = part(observation['resources'])['deviceType'];
      return LeadMachine(
        id: id,
        name: name,
        online: online,
        // The server's count: it also holds pending starts and the Team
        // account sharing a Mac. A backend without it: slots minus running.
        freeAgents: switch (reading['availableSlots']) {
          final num slots => math.max(0, slots.toInt()),
          _ => math.max(
            0,
            (max is num ? max.toInt() : 0) -
                (running is List ? running.length : 0),
          ),
        },
        repositories: {
          if (checkouts is List)
            for (final checkout in checkouts)
              ?leadRepositoryKey(switch (part(checkout)['repository']) {
                final String repository => repository,
                _ => null,
              }),
        },
        // The Swarm's clone of each project there: its folder in the
        // machine's Swarm folder, in that machine's own path style.
        folders: {
          if (pool['cwd'] case final String root when checkouts is List)
            for (final checkout in checkouts.map(part))
              if ((
                    leadRepositoryKey(switch (checkout['repository']) {
                      final String repository => repository,
                      _ => null,
                    }),
                    checkout['folder'],
                  )
                  case (final String key, final String folder))
                key: (root.contains('\\') ? p.windows : p.posix).join(
                  root,
                  folder,
                ),
        },
        maySleep:
            superTabMachineSymbol(device is String ? device : null) ==
            'laptopcomputer',
        own: own,
        native: own && connected,
        team: team,
        engineRefusals: engineRefusals,
        unavailable: snapshot.paused
            ? kLeadSwarmPaused
            : own
            ? (connected
                  ? (pool['paused'] == true ? 'Paused in this Swarm' : null)
                  : capable
                  ? null
                  : 'Not connected to this computer')
            : !team
            ? switch (snapshot.people
                  .where((person) => person.id == pool['contributorId'])
                  .firstOrNull) {
                final person? =>
                  '${superTabPersonName(person.email)}’s personal account: '
                      'runs only ${superTabPersonName(person.email)}’s '
                      'projects. $_yoursNeed',
                null => '$name runs only its owner’s projects. $_yoursNeed',
              }
            : switch (reading['teamWork']) {
                {'allowed': false, 'reason': final String reason} => reason,
                _ when !capable =>
                  'Update Harness on $name to run a Product Manager there.',
                _ => null,
              },
      );
    }

    final listed = [
      for (final pool in snapshot.machines)
        if (pool['machineId'] case final String id
            when snapshot.placeOf(id) == id && pool['removal'] == null)
          row(id, pool),
    ];
    return rankLeadMachines([
      ...listed,
      // A person's start may still name a machine of theirs the Swarm does
      // not list (backend agent.start), as New Project always could.
      for (final state in app.machineStates.values)
        if (!state.belongsToOtherAccount &&
            !listed.any((m) => m.id == state.machine.machineId))
          LeadMachine(
            id: state.machine.machineId,
            name: state.machine.displayName,
            online: !state.needsLink && !state.isOffline,
            freeAgents: null,
            inSwarm: false,
            unavailable: snapshot.paused ? kLeadSwarmPaused : null,
            // The Swarm reads nothing of it: this computer's own probe says
            // which engines are there. One that installs on Create runs.
            engineRefusals: leadEngineRefusals(
              readiness: {
                for (final engine in kLeadEngines)
                  if (state.engines[engine] case final known?)
                    engine: (
                      installed: known.installed || known.installable,
                      signedIn: known.signedIn,
                    ),
              },
            ),
          ),
    ], null);
  }

  /// The Swarm's routing policy, or null when it cannot be read: nothing is
  /// then ruled out by it.
  Future<Map<String, dynamic>?> readRoutingPolicy(String tabId) async {
    try {
      final answer = await app.superTabs.map(
        'GET',
        '/api/super-tabs/$tabId/routing-policy',
      );
      return answer['policy'] is Map ? superTabMap(answer['policy']) : null;
    } catch (_) {
      return null;
    }
  }

  /// Reads the Swarm again and refuses [machine] when it cannot take the
  /// Product Manager now: the list from when the form opened may be stale.
  /// With no fresh read nothing is created, since the machine is unchecked.
  Future<void> recheckLeadMachine(
    HarnessLaunchIntegration integration,
    String machine, {
    String? engine,
  }) async {
    final name =
        integration.leadMachines
            ?.where((m) => m.id == machine)
            .firstOrNull
            ?.name ??
        machineNameOf(machine);
    final SuperTabSnapshot fresh;
    try {
      fresh = await app.superTabs.readSnapshot(saved['tabId'] as String);
    } on SuperTabFailure catch (failure) {
      if (failure.code == 'ACCOUNT_CHANGED') rethrow;
      throw SuperTabFailure(
        'SWARM_UNREADABLE',
        'Couldn’t check $name for the Product Manager: ${failure.message} '
            'Try again.',
      );
    } catch (_) {
      throw SuperTabFailure(
        'SWARM_UNREADABLE',
        'Couldn’t check $name for the Product Manager: the Swarm didn’t '
            'answer. Try again.',
      );
    }
    checkAccount();
    integration.leadMachines = leadMachinesOf(fresh);
    checkLeadMachine(integration.leadMachines!, machine, engine: engine);
  }

  /// The upload a Swarm-started Product Manager's files take, in tests.
  @visibleForTesting
  static SuperTabUpload? uploadForTest;

  /// New Project's Product Manager started by the Swarm, not this Desktop
  /// (backend leadStart.ts): creates the project, posts the task and files
  /// to its chat, where such a Product Manager reads its request, and asks
  /// the Swarm to start it on [LeadSwarmStart.machineId], or on the first
  /// free machine. Each step keeps its receipt in the journal, so a retry
  /// repeats none of them.
  Future<void> startInSwarm(LeadSwarmStart start) async {
    checkAccount();
    saved['initialMessage'] = start.task;
    await _createProject(start.task);
    final tabId = saved['tabId'] as String;
    final conversationId = saved['conversationId'] as String;
    Future<Map<String, dynamic>> send(String operationId, Map command) =>
        app.superTabs.map(
          'POST',
          '/api/super-tabs/$tabId/commands',
          body: {'operationId': operationId, 'command': command},
        );
    if (saved['taskPosted'] != true &&
        (start.task.isNotEmpty || start.files.isNotEmpty)) {
      // Written once, with its files' ids: a retry after a lost reply sends
      // this very request, so nothing is uploaded again.
      if (saved['taskRequest'] == null) {
        final upload = uploadForTest ?? app.superTabs.upload;
        final ids = [
          for (final file in start.files)
            superTabMap(
                  (await upload(
                    tabId: tabId,
                    conversationId: conversationId,
                    name: file.name,
                    mime: mimeForName(file.name),
                    bytes: file.bytes,
                    cancel: CancelToken(),
                    onProgress: (_) {},
                  ))['attachment'],
                )['id']
                as String,
        ];
        checkAccount();
        saved['taskRequest'] = {
          'operationId': superTabOperationId(),
          'command': {
            'type': 'message.send',
            'conversationId': conversationId,
            'text': start.task,
            'replyTo': null,
            'recipientIds': const <String>[],
            if (ids.isNotEmpty) 'attachmentIds': ids,
          },
        };
        await persist();
      }
      await _replay('taskRequest');
      saved['taskPosted'] = true;
      saved.remove('taskRequest');
      await persist();
    }
    // Kept as first sent until the Swarm answers it: after an unclear failure
    // a retry repeats it, perhaps already committed, rather than asking again.
    saved['leadStartRequest'] ??= {
      'operationId': superTabOperationId(),
      'command': {
        'type': 'lead.start',
        'projectId': saved['projectId'],
        'machineId': start.machineId,
        'engine': start.engine,
        'repositoryUrl': ?start.repositoryUrl,
      },
    };
    await persist();
    await _replay('leadStartRequest');
    final title = start.title ?? 'New project';
    saved['title'] = title;
    await persist();
    await send('${saved['joinId']}-name', {
      'type': 'project.rename',
      'projectId': saved['projectId'],
      'name': title,
    });
    final controller = await app.superTabs.open(tabId);
    await controller.refresh();
    checkAccount();
    controller.select(conversationId);
    await app.superTabs.storage.delete(key);
  }

  /// Sends the journal's request [key] exactly as it was first written: the
  /// server answers a repeated operation with its receipt, and refuses one
  /// whose request changed. Only a definite refusal drops it, so the next
  /// attempt (perhaps to another machine) is a new request; any other failure
  /// may have been committed and keeps it.
  Future<void> _replay(String key) async {
    try {
      await app.superTabs.map(
        'POST',
        '/api/super-tabs/${saved['tabId']}/commands',
        body: superTabMap(saved[key]),
      );
    } on SuperTabFailure catch (failure) {
      if (_refusedOutright(failure)) {
        saved.remove(key);
        await persist();
      }
      rethrow;
    }
  }

  /// The Swarm said no and wrote nothing: a 4xx answer other than a timeout
  /// or a rate limit. A transport failure or a 5xx may have been committed.
  static bool _refusedOutright(SuperTabFailure failure) =>
      failure.statusCode >= 400 &&
      failure.statusCode < 500 &&
      failure.statusCode != 408 &&
      failure.statusCode != 429;

  /// Refuses a machine the list cannot start the Product Manager on now.
  /// Refuses [machine] when it cannot start the Product Manager now, with
  /// [engine] when it is known.
  void checkLeadMachine(
    List<LeadMachine> machines,
    String machine, {
    String? engine,
  }) {
    final chosen = machines.where((m) => m.id == machine).firstOrNull;
    if (chosen == null) {
      throw const SuperTabFailure(
        'MACHINE_NOT_LISTED',
        'Choose one of this Swarm’s machines.',
      );
    }
    final refusal = engine == null ? null : chosen.engineRefusals[engine];
    if (chosen.startable && refusal == null) return;
    throw SuperTabFailure(
      'MACHINE_UNAVAILABLE',
      chosen.unavailable != null
          ? '${chosen.name}: ${chosen.unavailable}. Choose another machine.'
          : !chosen.online
          ? '${chosen.name} is offline. Choose another machine.'
          : chosen.leadEngines.isEmpty
          ? '${chosen.name}: ${leadMachineDetail(chosen, null)}. '
                'Choose another machine.'
          : !chosen.startable
          ? '${chosen.name} has no free agents. Choose another machine.'
          : '${chosen.name} can’t run ${leadEngineLabel(engine!)}: $refusal. '
                'Choose another engine under Advanced.',
    );
  }

  void checkAccount() {
    if (app.currentUser?.id != accountId) {
      throw const SuperTabFailure('ACCOUNT_CHANGED', 'The account changed.');
    }
  }

  Future<void> persist() async {
    checkAccount();
    await app.superTabs.storage.write(key, jsonEncode(saved));
    checkAccount();
  }

  Future<String> prepare(String machine, String task) async {
    checkAccount();
    if (app.stateOf(machine)?.belongsToOtherAccount == true) {
      throw const SuperTabFailure(
        'CONTRIBUTION_REQUIRED',
        'Choose one of your machines. To use another person’s machine in this Swarm, ask its owner to add the machine or an agent.',
      );
    }
    saved['initialMessage'] = task;
    saved['machineId'] = machine;
    await persist();
    if (saved['tabId'] == null) {
      saved['creationRequest'] ??= {
        'operationId': saved['operationId'],
        'name': 'Swarm',
        'projectVisibility': saved['visibility'] ?? 'public',
      };
      await persist();
      final created = await app.superTabs.map(
        'POST',
        '/api/super-tabs',
        body: superTabMap(saved['creationRequest']),
      );
      saved['tabId'] = created['id'];
      saved['projectPrepared'] = true;
      app.superTabs.deferTabDiscovery(saved['tabId'] as String);
      await persist();
    }
    await _createProject(task);
    app.superTabs.deferTabDiscovery(saved['tabId'] as String);
    // Revalidate a journal's destination before native submission. A project
    // deleted on another computer must not leave an unattached native session.
    final snapshot = await app.superTabs.readSnapshot(saved['tabId'] as String);
    checkAccount();
    final conversationId = saved['conversationId'] as String;
    if (snapshot.conversation(conversationId) == null) {
      if (started) throw projectUnavailable;
      // Nothing can still be starting: reopening New Project should get a
      // fresh destination instead of loading this deleted project forever.
      await app.superTabs.storage.delete(key);
      checkAccount();
      throw const SuperTabFailure(
        'PROJECT_UNAVAILABLE',
        'This project is no longer available. Close this form and create a new project.',
      );
    }
    saved['skillMode'] =
        snapshot.projectFor(conversationId)?.skillMode ?? 'orchestration';
    final project = snapshot.projectFor(conversationId);
    if (project?.skillSet == 'custom') {
      final chosen = project?.roles
          ?.where((role) => role.id == saved['roleId'])
          .firstOrNull;
      if (chosen == null || chosen.kind != saved['roleKind']) {
        throw const SuperTabFailure(
          'ROLE_UNAVAILABLE',
          'This role changed or is no longer available. Close this form and choose a role again.',
        );
      }
    } else {
      saved.remove('roleId');
      saved.remove('roleKind');
    }
    final prompt = superTabLaunchPrompt(
      tabId: saved['tabId'] as String,
      conversationId: saved['conversationId'] as String,
      lead: saved['lead'] == true,
    );
    saved['launchPrompt'] = prompt;
    await persist();
    return prompt;
  }

  /// A new project's creation, once: its receipt stays in the journal.
  Future<void> _createProject(String task) async {
    if (saved['newProject'] == true && saved['projectPrepared'] != true) {
      saved['creationRequest'] ??= {
        'operationId': saved['operationId'],
        'command': {
          'type': 'project.create',
          'name': 'New project',
          'visibility': saved['visibility'] ?? 'public',
          'brief': String.fromCharCodes(task.runes.take(4000)),
        },
      };
      await persist();
      final created = await app.superTabs.map(
        'POST',
        '/api/super-tabs/${saved['tabId']}/commands',
        body: superTabMap(saved['creationRequest']),
      );
      final result = superTabMap(created['result']);
      saved['projectId'] = result['projectId'];
      saved['conversationId'] = result['conversationId'];
      saved['projectPrepared'] = true;
      await persist();
    }
  }

  // A started request's journal stays until the person discards it.
  static const projectUnavailable = SuperTabFailure(
    'PROJECT_UNAVAILABLE',
    'This project is no longer available. Discard this request, then create a new project.',
  );

  Future<void> stageAttachments(
    List<HarnessAttachment> files,
    String prompt,
  ) async {
    checkAccount();
    saved['files'] = [
      for (final file in files)
        {'name': file.name, 'bytes': base64Encode(file.bytes)},
    ];
    saved['launchPrompt'] = prompt;
    saved['filesState'] = 'pending';
    await persist();
  }

  Future<void> complete(
    String machine,
    String harnessId, {
    Agent? recovered,
  }) async {
    checkAccount();
    saved['machineId'] = machine;
    saved['harnessId'] = harnessId;
    saved['phase'] = 'joining';
    final native =
        recovered ??
        app
            .stateOf(machine)
            ?.agents
            .where((a) => a.id == harnessId)
            .firstOrNull;
    if (native == null) {
      throw const SuperTabFailure(
        'AGENT_UNAVAILABLE',
        'Waiting for the new harness to appear on its machine.',
      );
    }
    final project = native.project ?? app.stateOf(machine)?.projectOf(native);
    saved['command'] ??= {
      'type': 'agent.add',
      'conversationId': saved['conversationId'],
      'machineId': machine,
      'harnessId': harnessId,
      'name': saved['lead'] == true ? 'Lead' : native.displayName,
      'lead': saved['lead'],
      if (saved['roleId'] case final String roleId) 'roleId': roleId,
      if (saved['lead'] == true && project != null)
        'project': {
          'cwd': project.root ?? project.cwd,
          'repositoryUrl': superTabRepositoryUrl(project.remote),
        },
      'configuration': {
        'engine': native.engine ?? '',
        'model': native.modelName,
        'effort': native.modelEffort,
        'contextWindow': null,
        'engineVersion': null,
      },
      if ((saved['initialMessage'] as String? ?? '').isNotEmpty)
        'initialMessage': saved['initialMessage'],
    };
    await persist();
    final tabId = saved['tabId'] as String;
    await app.superTabs.map(
      'POST',
      '/api/super-tabs/$tabId/commands',
      body: {'operationId': saved['joinId'], 'command': saved['command']},
    );
    // Waking the exact host starts only its authorized contributions. It is
    // safe to retry, and never grants machine access to the tab's members.
    await app.wakeSuperTabHost(machine);
    if (saved['lead'] == true) {
      final name = Swarm.titleFor(native);
      final title =
          saved['title'] as String? ??
          (name == Swarm.defaultName ? 'New project' : name);
      saved['title'] = title;
      await persist();
      await app.superTabs.map(
        'POST',
        '/api/super-tabs/$tabId/commands',
        body: {
          'operationId': '${saved['joinId']}-name',
          'command': {
            'type': 'project.rename',
            'projectId': saved['projectId'] ?? 'lead',
            'name': title,
          },
        },
      );
      checkAccount();
      if (saved['newProject'] != true) {
        await app.superTabs.map(
          'POST',
          '/api/super-tabs/$tabId/commands',
          body: {
            'operationId': '${saved['joinId']}-swarm-name',
            'command': {
              'type': 'tab.rename',
              'name': saved['visibility'] == 'private' ? 'Swarm' : title,
            },
          },
        );
      }
    }
    final controller = await app.superTabs.open(tabId);
    await controller.refresh();
    checkAccount();
    final files = (saved['files'] as List? ?? []).map((value) {
      final file = superTabMap(value);
      return HarnessAttachment(
        file['name'] as String,
        base64Decode(file['bytes'] as String),
      );
    }).toList();
    if (files.isNotEmpty && saved['filesState'] != 'delivered') {
      if (saved['filesState'] == 'sending') {
        throw const SuperTabFailure(
          'FILES_UNCONFIRMED',
          'The harness started, but file delivery was interrupted. Open its terminal to check before sending the files or request again.',
        );
      }
      saved['filesState'] = 'sending';
      await persist();
      final problem = await app.deliverBackgroundAttachments(
        machineId: machine,
        agentId: harnessId,
        files: files,
        task: saved['launchPrompt'] as String,
      );
      checkAccount();
      if (problem != null) throw SuperTabFailure('FILES_UNCONFIRMED', problem);
      saved['filesState'] = 'delivered';
      saved.remove('files');
      await persist();
    }
    if (saved['lead'] == true && saved['newProject'] != true) {
      app.bindSuperTab(
        swarmId,
        tabId,
        saved['visibility'] == 'private' ? 'Swarm' : saved['title'] as String,
      );
    }
    controller.select(saved['conversationId'] as String);
    await app.superTabs.storage.delete(key);
  }

  /// [complete] in the person's words. The harness exists, so whatever went
  /// wrong is the join, which Check status retries with the same receipt.
  Future<void> join(
    String machine,
    String harnessId, {
    Agent? recovered,
  }) async {
    try {
      await complete(machine, harnessId, recovered: recovered);
    } on SuperTabFailure catch (failure) {
      // The backend no longer has the project's conversation.
      if (failure.code == 'NOT_FOUND') throw projectUnavailable;
      if (const {
        'ACCOUNT_CHANGED',
        'AGENT_UNAVAILABLE',
        'FILES_UNCONFIRMED',
      }.contains(failure.code)) {
        rethrow;
      }
      throw _joinFailed(failure);
    } catch (failure) {
      throw _joinFailed(failure);
    }
  }

  SuperTabFailure _joinFailed(Object failure) => SuperTabFailure(
    'JOIN_FAILED',
    'The $who started on $machineName. Joining it to the project failed: '
        '${'$failure'.replaceFirst(RegExp(r'\.$'), '')}. Check status to try again.',
  );

  Future<void> resume() async {
    checkAccount();
    final machine = saved['machineId'] as String;
    final Agent native;
    try {
      native = await app.recoverSuperTabCreation(
        machine,
        saved['creationId'] as String,
        cancelIfMissing:
            saved['phase'] == 'starting' &&
            (saved['launchPrompt'] as String? ?? '').trim().length >
                kFirstTaskMaxLength &&
            (saved['files'] as List? ?? const []).isEmpty,
      );
    } on SuperTabFailure catch (failure) {
      if (failure.code != 'CREATION_PENDING') rethrow;
      throw SuperTabFailure(
        'CREATION_PENDING',
        '$machineName has not started the $who yet.',
      );
    } catch (_) {
      throw SuperTabFailure(
        'MACHINE_UNREACHABLE',
        'Could not reach $machineName. Check that it is online, then check status again.',
      );
    }
    await join(machine, native.id, recovered: native);
  }

  /// [HarnessLaunchIntegration.discard]: a request that has not started is
  /// cancelled on its machine first; one that started keeps running there.
  Future<String?> discard({bool anyway = false}) async {
    checkAccount();
    // Its project goes too only when nothing can still join it: a started
    // Lead keeps running and points at it, and one that may still start would.
    var nothingWillJoin =
        saved['phase'] != 'starting' && saved['phase'] != 'joining';
    if (saved['phase'] == 'joining' && !anyway) {
      return 'The $who keeps running on $machineName. Remove this request?';
    }
    if (saved['phase'] == 'starting' && !anyway) {
      final creationId = saved['creationId'] as String;
      final Map<String, dynamic> receipt;
      try {
        receipt = await app.cancelSuperTabCreation(
          saved['machineId'] as String,
          creationId,
        );
      } on SuperTabFailure {
        rethrow;
      } catch (_) {
        return 'Could not reach $machineName, so it may still start the $who. Discard anyway?';
      }
      final state = receipt['creationId'] == creationId
          ? receipt['state']
          : null;
      // A started harness can still join, so the request stays.
      if (state == 'created') {
        throw SuperTabFailure('CREATION_STARTED', startedNote);
      }
      // Unavailable: it started and is gone again, so nothing is left to keep.
      if (!const {
        'cancelled',
        'missing',
        'failed',
        'unavailable',
      }.contains(state)) {
        return '$machineName is already starting the $who and could not stop it. Discard anyway?';
      }
      nothingWillJoin = true;
    }
    if (nothingWillJoin) await _deleteEmptyProject();
    await app.superTabs.storage.delete(key);
    checkAccount();
    return null;
  }

  /// A new project nothing joined is only a name in the Swarm. Best effort:
  /// a project left behind can still be deleted from its options, and must
  /// not keep the person in this request.
  Future<void> _deleteEmptyProject() async {
    final projectId = saved['projectId'];
    if (saved['newProject'] != true ||
        saved['projectPrepared'] != true ||
        projectId is! String) {
      return;
    }
    try {
      final snapshot = await app.superTabs.readSnapshot(
        saved['tabId'] as String,
      );
      checkAccount();
      if (!snapshot.projects.any((p) => p.id == projectId) ||
          snapshot.agents.any((a) => a.projectId == projectId)) {
        return;
      }
      await app.superTabs.map(
        'POST',
        '/api/super-tabs/${saved['tabId']}/commands',
        body: {
          'operationId': '${saved['operationId']}-discard',
          'command': {'type': 'project.delete', 'projectId': projectId},
        },
      );
    } catch (_) {
      // Unreachable, busy or not the owner's: the project stays.
    }
    checkAccount();
  }
}

/// Where a teammate's project's Product Manager may run instead.
const _yoursNeed = 'Yours need your own computer or a Team account machine';
