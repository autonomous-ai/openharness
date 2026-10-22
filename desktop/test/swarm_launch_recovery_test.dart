import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/harness_launch_integration.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

void main() {
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
