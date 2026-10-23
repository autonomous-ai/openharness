import 'dart:convert';

import '../core/first_task.dart';
import '../core/models.dart';
import '../state/app_state.dart';
import '../state/harness_attachments.dart';
import '../state/harness_launch_integration.dart';
import '../state/swarm.dart';
import 'controller.dart';
import 'model.dart';
import 'launch_prompt.dart';

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
      final current = await app.superTabs.map(
        'GET',
        '/api/super-tabs/${tab.superTabId}',
      );
      final snapshot = SuperTabSnapshot.fromJson(superTabMap(current['state']));
      final project = snapshot.projectFor(conversationId);
      if (project?.skillSet == 'custom') {
        roles = [
          for (final role in project?.roles ?? const <SuperTabRole>[])
            if (role.kind == 'builder' || role.kind == 'reviewer')
              HarnessLaunchRole(id: role.id, name: role.name, kind: role.kind),
        ];
      }
    }
    final selectedRole =
        roles?.where((role) => role.id == saved['roleId']).firstOrNull ??
        roles?.where((role) => role.kind == 'builder').firstOrNull ??
        roles?.firstOrNull;
    late final HarnessLaunchIntegration integration;
    integration = HarnessLaunchIntegration(
      forcedPermissionMode: 'full',
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
          saved['projectPrepared'] == true || saved['creationRequest'] != null,
      prepare: (machine, task) async {
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
          return prompt;
        } on SuperTabFailure catch (failure) {
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
        await launch.persist();
      },
      complete: launch.complete,
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
    )..pending = recovering;
    return integration;
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
    app.superTabs.deferTabDiscovery(saved['tabId'] as String);
    // Revalidate a journal's destination before native submission. A project
    // deleted on another computer must not leave an unattached native session.
    final current = await app.superTabs.map(
      'GET',
      '/api/super-tabs/${saved['tabId']}',
    );
    checkAccount();
    final snapshot = SuperTabSnapshot.fromJson(superTabMap(current['state']));
    final conversationId = saved['conversationId'] as String;
    if (snapshot.conversation(conversationId) == null) {
      if (saved['phase'] != 'starting' && saved['phase'] != 'joining') {
        // Nothing can still be starting: reopening New Project should get a
        // fresh destination instead of loading this deleted project forever.
        await app.superTabs.storage.delete(key);
        checkAccount();
      }
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

  Future<void> resume() async {
    checkAccount();
    final machine = saved['machineId'] as String;
    final native = await app.recoverSuperTabCreation(
      machine,
      saved['creationId'] as String,
      cancelIfMissing:
          saved['phase'] == 'starting' &&
          (saved['launchPrompt'] as String? ?? '').trim().length >
              kFirstTaskMaxLength &&
          (saved['files'] as List? ?? const []).isEmpty,
    );
    await complete(machine, native.id, recovered: native);
  }
}
