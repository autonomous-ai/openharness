import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/harness_launch_integration.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/super_tabs/launch.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

Map<String, dynamic>? journal(SuperTabLaunchFixture f) => f.store.values.entries
    .where((e) => e.key.startsWith('super_tab.launch.'))
    .map((e) => jsonDecode(e.value) as Map<String, dynamic>)
    .firstOrNull;

/// A New project whose launch reply was lost: its journal is `starting`.
Future<SuperTabLaunchFixture> stuckProject() async {
  final f = SuperTabLaunchFixture()..connection.loseCreate = true;
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
  final first = await f.box(engine: 'claude', newProject: true);
  expect(await first.create(), NewHarnessOutcome.failed);
  expect(journal(f)!['phase'], 'starting');
  return f;
}

/// New project opened again, by default on another machine and agent than
/// the request's.
Future<NewHarnessController> reopen(
  SuperTabLaunchFixture f, {
  String machineId = 'elsewhere',
}) async {
  final box = NewHarnessController(
    f.app,
    machineId: machineId,
    engine: 'codex',
    folder: '/elsewhere',
    integration: await SuperTabLaunch.open(
      f.app,
      f.app.activeSwarm,
      'new-project',
      newProject: true,
    ),
  );
  addTearDown(box.dispose);
  await pumpEventQueue();
  return box;
}

void main() {
  testWidgets('a stuck New project shows its own machine and is discarded '
      'there, and the next one starts fresh', (tester) async {
    late SuperTabLaunchFixture f;
    late NewHarnessController box;
    late Map<String, dynamic> saved;
    await tester.runAsync(() async {
      f = await stuckProject();
      // The request never reached the machine's launcher.
      f.connection.native = null;
      saved = journal(f)!;
      box = await reopen(f);
    });
    expect(box.checking, isTrue);
    expect(box.locked, isTrue);
    expect(box.machineId, 'm');
    expect(box.engine, 'claude');
    expect(box.launchProjectLabel, 'Test host:/work/project');
    var closed = 0;
    await tester.binding.setSurfaceSize(const Size(1200, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 850,
              height: 500,
              child: NewHarnessForm(
                controller: box,
                desktop: true,
                onClose: () => closed++,
                onCreated: () {},
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(
      find.text('Waiting for Test host to start the Lead for “New project”.'),
      findsOneWidget,
    );
    await tester.tap(find.text('Discard request'));
    await tester.runAsync(pumpEventQueue);
    await tester.pump();
    expect(closed, 1);
    expect(
      f.connection.calls
          .where((c) => c.$1 == 'agent_create_cancel')
          .map((c) => c.$2['creationId']),
      [saved['creationId']],
    );
    expect(journal(f), isNull);
    // Nothing joined the project, so it goes too.
    expect(
      (f.connection.server.state['projects'] as List).map((p) => p['id']),
      isNot(contains(saved['projectId'])),
    );
    await tester.pumpWidget(const SizedBox());

    await tester.runAsync(() async {
      final next = await reopen(f, machineId: 'm');
      expect(next.checking, isFalse);
      expect(next.integration!.creationId, isNot(saved['creationId']));
      expect(
        await next.create(),
        NewHarnessOutcome.created,
        reason: next.error,
      );
      final creations = f.connection.server.posts
          .where((p) => (p['command'] as Map)['type'] == 'project.create')
          .toList();
      expect(creations, hasLength(2));
      expect(creations.last['operationId'], isNot(saved['operationId']));
    });
  });

  test('Discard keeps a request whose Lead already started', () async {
    final f = await stuckProject();
    final box = await reopen(f);
    expect(await box.discardPending(), isNull);
    expect(box.discarded, isFalse);
    expect(
      box.error,
      'The Lead started on Test host. Check status to add it to the project.',
    );
    expect(journal(f)!['phase'], 'starting');
    expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
    expect(journal(f), isNull);
  });

  test('Discard after a failed join leaves the Lead running', () async {
    final f = await stuckProject();
    final box = await reopen(f);
    f.connection.server.refuse = {
      'code': 'INTERNAL',
      'message': 'An internal server error occurred',
    };
    expect(await box.create(), NewHarnessOutcome.failed);
    expect(
      box.error,
      'The Lead started on Test host. Joining it to the project failed: '
      'An internal server error occurred. Check status to try again.',
    );
    expect(journal(f)!['phase'], 'joining');
    expect(
      await box.discardPending(),
      'The Lead keeps running on Test host. Remove this request?',
    );
    expect(journal(f), isNotNull);
    final projectId = journal(f)!['projectId'];
    expect(await box.discardPending(anyway: true), isNull);
    expect(box.discarded, isTrue);
    expect(journal(f), isNull);
    expect(
      f.connection.calls.map((c) => c.$1),
      isNot(anyOf(contains('agent_create_cancel'), contains('agent_close'))),
    );
    // The running Lead points at its project, so the project stays.
    expect(
      (f.connection.server.state['projects'] as List).map((p) => p['id']),
      contains(projectId),
    );
  });

  test('a failed creation gives the form back without Discard', () async {
    final f = await stuckProject();
    final box = await reopen(f);
    expect(box.canDiscardPending, isTrue);
    f.connection.creationRecovery = (_, payload) async => {
      'creationId': payload['creationId'],
      'state': 'cancelled',
    };
    expect(await box.create(), NewHarnessOutcome.failed);
    expect(
      box.error,
      'This startup request was cancelled. Try again to start this project.',
    );
    expect(box.checking, isFalse);
    expect(box.canDiscardPending, isFalse);
  });

  test(
    'an unreachable machine keeps the request unless discarded anyway',
    () async {
      final f = await stuckProject();
      final box = await reopen(f);
      f.connection.creationRecovery = (_, _) async =>
          throw StateError('Connection lost');
      expect(
        await box.discardPending(),
        'Could not reach Test host, so it may still start the Lead. Discard anyway?',
      );
      expect(journal(f), isNotNull);
      expect(await box.discardPending(anyway: true), isNull);
      expect(journal(f), isNull);
    },
  );

  testWidgets('Discard asks before dropping a request on an unreachable '
      'machine, and Keep request keeps it', (tester) async {
    late SuperTabLaunchFixture f;
    late NewHarnessController box;
    await tester.runAsync(() async {
      f = await stuckProject();
      box = await reopen(f);
    });
    f.connection.creationRecovery = (_, _) async =>
        throw StateError('Connection lost');
    var closed = 0;
    await tester.binding.setSurfaceSize(const Size(1200, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 850,
              height: 500,
              child: NewHarnessForm(
                controller: box,
                desktop: true,
                onClose: () => closed++,
                onCreated: () {},
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    const question =
        'Could not reach Test host, so it may still start the Lead. '
        'Discard anyway?';

    await tester.tap(find.text('Discard request'));
    await tester.runAsync(pumpEventQueue);
    await tester.pumpAndSettle();
    expect(find.text(question), findsOneWidget);
    await tester.tap(find.text('Keep request'));
    await tester.pumpAndSettle();
    expect(find.text(question), findsNothing);
    expect(closed, 0);
    expect(journal(f), isNotNull);

    await tester.tap(find.text('Discard request'));
    await tester.runAsync(pumpEventQueue);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Discard anyway'));
    await tester.runAsync(pumpEventQueue);
    await tester.pumpAndSettle();
    expect(closed, 1);
    expect(journal(f), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  test('a deleted project offers Discard instead of a stuck request', () async {
    final f = await stuckProject();
    final projectId = journal(f)!['projectId'];
    await f.connection.server.request(
      'POST',
      '/api/super-tabs/$tabId/commands',
      body: {
        'operationId': 'deleted-elsewhere',
        'command': {'type': 'project.delete', 'projectId': projectId},
      },
    );
    final box = await reopen(f);
    expect(await box.create(), NewHarnessOutcome.failed);
    expect(
      box.error,
      'This project is no longer available. Discard this request, then create a new project.',
    );
    expect(box.canDiscardPending, isTrue);
    expect(await box.discardPending(anyway: true), isNull);
    expect(journal(f), isNull);
  });

  for (final resend in [false, true]) {
    testWidgets(
      'uncertain Swarm files require an explicit resend=$resend choice',
      (tester) async {
        final f = SuperTabLaunchFixture();
        final choices = <bool>[];
        var created = 0;
        final integration = HarnessLaunchIntegration(
          creationId: 'file-review',
          prepare: (_, task) async => task,
          complete: (_, _) async {},
          beforeSubmit: (_, _) async {},
          needsAttachmentReview: () => true,
          resolveAttachments: (resend) async => choices.add(resend),
        )..pending = true;
        final box = NewHarnessController(
          f.app,
          machineId: 'm',
          engine: 'claude',
          folder: '/work/project',
          integration: integration,
        );
        addTearDown(box.dispose);
        await tester.binding.setSurfaceSize(const Size(1200, 800));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Center(
                child: SizedBox(
                  width: 850,
                  height: 500,
                  child: NewHarnessForm(
                    controller: box,
                    desktop: true,
                    onClose: () {},
                    onCreated: () => created++,
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('Review files'));
        await tester.pumpAndSettle();
        expect(find.text('Check file delivery'), findsOneWidget);
        await tester.tap(find.text('Cancel'));
        await tester.pumpAndSettle();
        expect(choices, isEmpty);
        expect(created, 0);
        await tester.tap(find.text('Review files'));
        await tester.pumpAndSettle();
        await tester.tap(find.text(resend ? 'Send again' : 'Already sent'));
        await tester.pumpAndSettle();
        expect(choices, [resend]);
        expect(created, 1);
        expect(
          f.connection.calls.where((c) => c.$1 == 'agent_create'),
          isEmpty,
        );
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  test(
    'a Swarm rejects a terminal-only agent before creating a native session',
    () async {
      // A new Lead cannot choose a terminal at all; an agent joining it can.
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      final box = await f.box(engine: 'terminal');
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(box.error, contains('Choose an agent that runs on a machine'));
      expect(f.connection.calls.where((c) => c.$1 == 'agent_create'), isEmpty);
    },
  );

  test(
    'failure to persist staged Swarm files prevents native launch',
    () async {
      final f = SuperTabLaunchFixture();
      final box = NewHarnessController(
        f.app,
        machineId: 'm',
        engine: 'claude',
        folder: '/work/project',
        integration: HarnessLaunchIntegration(
          creationId: 'stage-files',
          prepare: (_, task) async => task,
          beforeSubmit: (_, _) async {},
          complete: (_, _) async {},
          stageAttachments: (_, _) async =>
              throw StateError('Cannot save staged files'),
        ),
      );
      addTearDown(box.dispose);
      await pumpEventQueue();
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(box.error, contains('Cannot save staged files'));
      expect(f.connection.calls.where((c) => c.$1 == 'agent_create'), isEmpty);
    },
  );
}
