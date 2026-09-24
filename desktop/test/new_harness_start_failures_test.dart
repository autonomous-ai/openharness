import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/first_task.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  bool catalogUnavailable = false, installed = false;
  final install = Completer<Map<String, dynamic>>();
  int installs = 0;
  final starts = <Map<String, dynamic>>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    switch (type) {
      case 'engines_probe':
        return {'engines': []};
      case 'git_project_info':
        return {'isGit': false};
      case 'fs_list_dir':
        return {'path': '/work', 'entries': []};
      case 'dsh_list':
        if (catalogUnavailable) {
          throw const WsRequestFailure(
            responseType: 'dsh_list',
            code: 'UNSUPPORTED',
          );
        }
        return {
          'dsh': [
            {
              'id': 'autonomous/blender',
              'name': 'Blender',
              'engine': 'claude',
              'installed': installed,
            },
          ],
        };
      case 'dsh_install':
        installs++;
        final reply = await install.future;
        installed = reply['ok'] == true;
        return reply;
      case 'agent_create':
        starts.add(Map.of(payload));
        return {
          'creationId': payload['creationId'],
          'state': 'created',
          'agent': {
            'id': 'created',
            'name': 'Created',
            'engine': payload['engine'],
          },
        };
      default:
        return {};
    }
  }
}

void main() {
  for (final failure in [false, true]) {
    test('a missing Store harness waits for installation (failure=$failure)', () async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'autonomous/blender',
        folder: '/work',
      );
      addTearDown(app.dispose);
      addTearDown(box.dispose);
      final creating = box.create();
      await Future<void>.delayed(Duration.zero);
      expect(box.status, startsWith('Installing Blender'));
      expect(box.busy, isTrue);
      expect(connection.installs, 1);
      expect(connection.starts, isEmpty);
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(box.requestDismiss(), isFalse);

      connection.install.complete(
        failure ? {'ok': false, 'detail': 'Disk is full'} : {'ok': true},
      );
      expect(
        await creating,
        failure ? NewHarnessOutcome.failed : NewHarnessOutcome.created,
      );
      expect(box.busy, isFalse);
      if (failure) {
        expect(box.error, 'Disk is full');
        expect(connection.starts, isEmpty);
        // An installation completed outside the dialog is discovered on retry.
        connection.installed = true;
        expect(await box.create(), NewHarnessOutcome.created);
      }
      expect(connection.installs, 1);
      expect(connection.starts, hasLength(1));
      expect(connection.starts.single['engine'], 'claude');
      expect(connection.starts.single['dsh'], 'autonomous/blender');
    });
  }

  test(
    'an unsupported Store catalog is actionable and does not launch',
    () async {
      final connection = _Connection()..catalogUnavailable = true;
      final app = createApp(connectionForTest: (_) => connection);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'autonomous/blender',
        folder: '/work',
      );
      addTearDown(app.dispose);
      addTearDown(box.dispose);
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(box.error, contains('Update Harness CLI'));
      expect(box.busy, isFalse);
      expect(connection.installs, 0);
      expect(connection.starts, isEmpty);
      connection.catalogUnavailable = false;
      connection.installed = true;
      expect(await box.create(), NewHarnessOutcome.created);
      expect(connection.starts, hasLength(1));
    },
  );

  test(
    'dismissal during installation cannot launch after the dialog is disposed',
    () async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'autonomous/blender',
        folder: '/work',
      );
      addTearDown(app.dispose);
      final creating = box.create();
      await Future<void>.delayed(Duration.zero);
      expect(connection.installs, 1);
      box.dispose();
      connection.install.complete({'ok': true});
      expect(await creating, NewHarnessOutcome.failed);
      expect(connection.starts, isEmpty);
    },
  );

  test(
    'an oversized carried task is retained and can be shortened before retry',
    () async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      final task = 'x' * (kFirstTaskMaxLength + 1);
      final box = NewHarnessController(
        app,
        machineId: 'm',
        engine: 'codex',
        folder: '/work',
        task: task,
      );
      addTearDown(app.dispose);
      addTearDown(box.dispose);
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(
        box.error,
        contains('A first message can be $kFirstTaskMaxLength'),
      );
      expect(box.task, task);
      expect(connection.starts, isEmpty);
      box.focusField(NewHarnessField.task);
      box.setQuery('shortened task');
      expect(await box.create(), NewHarnessOutcome.created);
      expect(connection.starts.single['prompt'], 'shortened task');
    },
  );
}
