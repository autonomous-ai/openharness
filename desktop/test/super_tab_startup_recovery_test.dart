import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/first_task.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/super_tabs/launch_prompt.dart';

import 'super_tab_launch_test.dart';

Future<String> legacyLaunch(
  SuperTabLaunchFixture f, {
  String task = 'Discuss the architecture.',
  String phase = 'starting',
  bool files = false,
  bool oversized = true,
  bool newProject = false,
}) async {
  if (newProject) f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
  final box = await f.box(task: task, newProject: newProject);
  await box.integration!.prepare('m', task, box.engine);
  final key = f.store.values.keys.singleWhere(
    (key) => key.startsWith('super_tab.launch.'),
  );
  final saved = jsonDecode(f.store.values[key]!) as Map<String, dynamic>;
  saved.addAll({
    'phase': phase,
    'creationId': 'legacy-launch',
    'launchPrompt': oversized ? 'x' * (kFirstTaskMaxLength + 1) : 'short',
    'files': [
      if (files) {'name': 'test.txt', 'bytes': 'aGk='},
    ],
  });
  f.store.values[key] = jsonEncode(saved);
  return key;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('bootstrap fits native limit with maximum server IDs', () {
    for (final lead in [true, false]) {
      final prompt = superTabLaunchPrompt(
        tabId: 'a' * 160,
        conversationId: 'b' * 160,
        lead: lead,
      );
      expect(
        prompt.length,
        lessThanOrEqualTo(kFirstTaskMaxLength),
        reason:
            '${lead ? 'Lead' : 'Builder'} bootstrap must fit native creation',
      );
      expect(
        prompt,
        contains('harness super-tab --tab ${'a' * 160} instructions'),
      );
      for (final gone in [
        'swarm-lead',
        'swarm-dev',
        'swarm-review',
        'Discuss first',
        'Coordinate:',
        'Route only',
        'Do not review yet',
        'assign work',
        'decide reuse',
        'Each task needs',
      ]) {
        expect(prompt, isNot(contains(gone)), reason: gone);
      }
    }
  });

  test('lead bootstrap keeps report reading and the reply rules', () {
    final prompt = superTabLaunchPrompt(
      tabId: 'a' * 160,
      conversationId: 'b' * 160,
      lead: true,
    );
    expect(prompt, contains('read new reports'));
    expect(prompt, contains('No per-turn summarizer'));
    expect(prompt, contains('On scheduled requests use project.report'));
    expect(prompt, contains('text:null when nothing changed'));
  });

  for (final engine in ['codex', 'claude']) {
    for (final newProject in [false, true]) {
      for (final task in ['', 'hi', '文🙂\n' * 500]) {
        test(
          '$engine ${newProject ? 'project' : 'swarm'} preserves ${task.length}-unit request',
          () async {
            final f = SuperTabLaunchFixture();
            if (newProject) {
              f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
            }
            final box = await f.box(
              engine: engine,
              newProject: newProject,
              task: task,
            );
            expect(
              await box.create(),
              NewHarnessOutcome.created,
              reason: box.error,
            );
            final create = f.connection.calls.singleWhere(
              (c) => c.$1 == 'agent_create',
            );
            expect(
              (create.$2['prompt'] as String).length,
              lessThanOrEqualTo(kFirstTaskMaxLength),
            );
            expect(create.$2['swarmRole'], 'lead');
            final messages = f.connection.server.messages;
            expect(messages, hasLength(task.trim().isEmpty ? 0 : 1));
            if (messages.isNotEmpty) {
              expect(messages.single['text'], task.trim());
            }
            expect(f.connection.joins, hasLength(1));
          },
        );
      }
    }
  }

  test('legacy refusal is fenced before retrying the same project with its saved task', () async {
    final f = SuperTabLaunchFixture();
    final task = '文🙂\n' * 500;
    await legacyLaunch(f, task: task, newProject: true);
    final box = await f.box(task: '', newProject: true);
    expect(box.task, task);
    expect(await box.create(), NewHarnessOutcome.failed);
    expect(box.error, contains('previous startup request was cancelled'));
    expect(box.checking, isFalse);
    expect(f.connection.calls.where((c) => c.$1 == 'agent_create'), isEmpty);
    final cancel = f.connection.calls.singleWhere(
      (c) => c.$1 == 'agent_create_cancel',
    );
    expect(cancel.$2['creationId'], 'legacy-launch');
    expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
    expect(
      f.connection.server.posts.where(
        (p) => (p['command'] as Map)['type'] == 'project.create',
      ),
      hasLength(1),
    );
    expect(f.connection.server.messages.single['text'], task.trim());
    final created = f.connection.calls.singleWhere(
      (c) => c.$1 == 'agent_create',
    );
    expect(created.$2['creationId'], isNot('legacy-launch'));
  });

  test(
    'lost cancellation reply stays locked until its durable receipt is read',
    () async {
      final f = SuperTabLaunchFixture();
      await legacyLaunch(f);
      f.connection.creationRecovery = (type, payload) async {
        if (type == 'agent_create_cancel') {
          f.connection.cancelledCreation = true;
          throw TimeoutException('Lost cancellation reply');
        }
        return {'creationId': payload['creationId'], 'state': 'missing'};
      };
      final first = await f.box();
      expect(await first.create(), NewHarnessOutcome.failed);
      expect(first.checking, isTrue);
      f.connection.creationRecovery = null;
      final reopened = await f.box();
      expect(await reopened.create(), NewHarnessOutcome.failed);
      expect(reopened.checking, isFalse);
      expect(
        f.connection.calls.where((c) => c.$1 == 'agent_create_cancel'),
        hasLength(1),
      );
      expect(
        await reopened.create(),
        NewHarnessOutcome.created,
        reason: reopened.error,
      );
    },
  );

  test('a cancellation race that returns a created harness completes that exact launch', () async {
    final f = SuperTabLaunchFixture();
    await legacyLaunch(f);
    f.connection.creationRecovery = (type, payload) async {
      if (type == 'agent_create_status') {
        return {'creationId': payload['creationId'], 'state': 'missing'};
      }
      f.connection.native = {
        'id': 'race-agent',
        'engine': 'codex',
        'name': 'Recovered lead',
        'project': {'cwd': '/work/project', 'label': 'Project'},
      };
      return {
        'creationId': payload['creationId'],
        'state': 'created',
        'agent': f.connection.native,
      };
    };
    final box = await f.box();
    expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
    expect(f.connection.joins.single['command']['harnessId'], 'race-agent');
    expect(f.connection.calls.where((c) => c.$1 == 'agent_create'), isEmpty);
  });

  for (final state in ['pending', 'missing', 'wrong-id', 'error']) {
    test(
      'unconfirmed cancellation $state cannot unlock or launch a duplicate',
      () async {
        final f = SuperTabLaunchFixture();
        await legacyLaunch(f);
        f.connection.creationRecovery = (type, payload) async {
          if (type == 'agent_create_status') {
            return {'creationId': payload['creationId'], 'state': 'missing'};
          }
          if (state == 'error') throw StateError('Connection lost');
          return {
            'creationId': state == 'wrong-id'
                ? 'someone-else'
                : payload['creationId'],
            'state': state == 'wrong-id' ? 'cancelled' : state,
          };
        };
        final box = await f.box();
        expect(await box.create(), NewHarnessOutcome.failed);
        expect(box.checking, isTrue);
        expect(
          f.connection.calls.where((c) => c.$1 == 'agent_create'),
          isEmpty,
        );
      },
    );
  }

  for (final changeAt in ['agent_create_status', 'agent_create_cancel']) {
    test(
      'account change after $changeAt cannot unlock the old request',
      () async {
        final f = SuperTabLaunchFixture();
        await legacyLaunch(f);
        f.connection.creationRecovery = (type, payload) async {
          if (type == changeAt) {
            f.app.currentUser = const CurrentUserProfile(
              id: 'other',
              email: 'other@example.com',
            );
          }
          return {
            'creationId': payload['creationId'],
            'state': type == 'agent_create_status' ? 'missing' : 'cancelled',
          };
        };
        final box = await f.box();
        expect(await box.create(), NewHarnessOutcome.failed);
        expect(box.error, contains('account changed'));
        expect(box.checking, isTrue);
        expect(
          f.connection.calls.where((c) => c.$1 == 'agent_create'),
          isEmpty,
        );
        if (changeAt == 'agent_create_status') {
          expect(
            f.connection.calls.where((c) => c.$1 == 'agent_create_cancel'),
            isEmpty,
          );
        }
      },
    );
  }

  for (final kind in ['joining', 'files', 'bounded']) {
    test('$kind recovery does not cancel an unknown native launch', () async {
      final f = SuperTabLaunchFixture();
      await legacyLaunch(
        f,
        phase: kind == 'joining' ? 'joining' : 'starting',
        files: kind == 'files',
        oversized: kind != 'bounded',
      );
      final box = await f.box();
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(box.checking, isTrue);
      expect(
        f.connection.calls.where(
          (c) => c.$1 == 'agent_create_cancel' || c.$1 == 'agent_create',
        ),
        isEmpty,
      );
    });
  }

  test(
    'a deleted destination blocks native submission from an old journal',
    () async {
      final f = SuperTabLaunchFixture();
      await legacyLaunch(f, newProject: true);
      final box = await f.box(newProject: true);
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(box.checking, isFalse);
      (f.connection.server.state['conversations'] as List).removeWhere(
        (g) => (g as Map)['projectId'] != null,
      );
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(box.error, contains('project is no longer available'));
      expect(f.connection.calls.where((c) => c.$1 == 'agent_create'), isEmpty);
      final fresh = await f.box(newProject: true);
      expect(
        await fresh.create(),
        NewHarnessOutcome.created,
        reason: fresh.error,
      );
      expect(
        f.connection.calls.where((c) => c.$1 == 'agent_create'),
        hasLength(1),
      );
    },
  );
}
