import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/join_dialog.dart';
import 'package:harness/super_tabs/join_link.dart';

import 'support/capture.dart';
import 'swarm_join_any_test.dart' show newMember, expectNoEnrollment;
import 'super_tab_launch_test.dart' show tabId;

import 'dart:async';
import 'dart:io';

import 'package:harness/ws/ws_conn.dart';

const bringAgentIntro =
    'Your Buddy is your own agent in Pilot: it runs on your computer, under '
    'your sign-in, and you can also start it later from your Buddy chat.';

void main() {
  final shots = Platform.environment['HARNESS_V3_JOIN_SHOTS'];
  setUpAll(() => loadCaptureFonts(shots));
  for (final brightness in Brightness.values) {
    testWidgets('new membership brings own agent in ${brightness.name}', (
      tester,
    ) async {
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      final f = newMember();
      await tester.binding.setSurfaceSize(const Size(1000, 760));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: SwarmJoinHost(app: f.app, child: const Scaffold()),
        ),
      );
      late Future<void> joining;
      await tester.runAsync(() async {
        joining = f.app.addMachineOnJoin(tabId, role: 'collaborator');
        await pumpEventQueue();
      });
      await tester.pump();
      await tester.runAsync(() async => pumpEventQueue());
      await tester.pumpAndSettle();
      // Task #4196: the Cmd-N form, its agent and computer, for a Buddy.
      expect(find.byType(NewHarnessForm), findsOneWidget);
      expect(find.text('Bring agent'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('new-harness-field-project')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('new-harness-field-agent-kind')),
        findsNothing,
      );
      expect(find.text('Separate Harness Team account'), findsNothing);
      expect(find.text('Add machine'), findsNothing);
      // Audit finding 10 (#4442): it names the Swarm, says what it does and
      // that it can wait.
      expect(find.text('Bring your agent to Pilot'), findsOneWidget);
      expect(find.text(bringAgentIntro), findsOneWidget);
      expect(find.text('Not now'), findsOneWidget);
      await captureWindow(tester, shots, 'bring-agent-${brightness.name}');
      if (brightness == Brightness.dark) {
        // A stray click outside keeps the offer; Not now closes it.
        await tester.tapAt(const Offset(4, 4));
        await tester.pumpAndSettle();
        expect(find.byType(NewHarnessForm), findsOneWidget);
        await tester.tap(find.text('Not now'));
        await tester.pumpAndSettle();
        expect(find.byType(NewHarnessForm), findsNothing);
        await tester.runAsync(() => joining);
        expectNoEnrollment(f);
      } else {
        await tester.runAsync(() async {
          await tester.tap(find.text('Bring agent'));
          await pumpEventQueue();
        });
        // The computer answers its first ask "preparing", as a real one does
        // for a Swarm that doesn't list it yet: one click still starts the
        // Buddy (audit finding 2, #4442).
        // The ask again is a second later, in real time: wait for the form
        // to close, up to ten seconds.
        for (
          var i = 0;
          i < 100 && find.byType(NewHarnessForm).evaluate().isNotEmpty;
          i++
        ) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 100)),
          );
          await tester.pump();
        }
        // Past the opened Swarm's view save.
        await tester.pump(const Duration(seconds: 1));
        await tester.pumpAndSettle();
        expect(find.textContaining('still being prepared'), findsNothing);
        expect(find.byType(NewHarnessForm), findsNothing);
        await tester.runAsync(() => joining);
        final starts = f.connection.server.posts.where(
          (post) => (post['command'] as Map)['type'] == 'buddy.create',
        );
        expect(starts, hasLength(1));
        expect(f.app.activeSwarm.superTabId, tabId);
        expect(starts.single['command'], containsPair('engine', 'claude'));
        expect(starts.single['command'], containsPair('machineId', 'm'));
        expect(
          f.connection.server.posts.where(
            (post) => (post['command'] as Map)['type'] == 'machine.contribute',
          ),
          isEmpty,
        );
      }
      await tester.pumpWidget(const SizedBox());
      f.dispose();
    });
  }

  // Audit findings 2 and 10 (#4442): while the computer prepares the form
  // keeps "Starting your Buddy…"; a refused start says the server's reason,
  // not "not confirmed".
  for (final brightness in Brightness.values) {
    testWidgets(
      'a refused Bring agent shows the server\'s reason in ${brightness.name}',
      (tester) async {
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
        final f = newMember();
        await tester.binding.setSurfaceSize(const Size(1000, 760));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: SwarmJoinHost(app: f.app, child: const Scaffold()),
          ),
        );
        late Future<void> joining;
        await tester.runAsync(() async {
          joining = f.app.addMachineOnJoin(tabId, role: 'collaborator');
          await pumpEventQueue();
        });
        await tester.pump();
        await tester.runAsync(() async => pumpEventQueue());
        await tester.pumpAndSettle();
        f.connection
          ..backendFailureOnCommandsOnly = true
          ..backendFailure = const WsRequestFailure(
            responseType: 'super_tabs_result',
            code: 'MACHINE_FULL',
            detail: 'My Mac is running as many agents as it allows.',
            payload: {'status': 409},
          );
        await tester.runAsync(() async {
          await tester.tap(find.text('Bring agent'));
          await pumpEventQueue();
        });
        await tester.pump();
        // The first ask answered "preparing": it waits, saying so.
        expect(find.textContaining('Starting your Buddy on'), findsOneWidget);
        await captureWindow(
          tester,
          shots,
          'bring-agent-preparing-${brightness.name}',
        );
        const reason = 'My Mac is running as many agents as it allows.';
        for (var i = 0; i < 100 && find.text(reason).evaluate().isEmpty; i++) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 100)),
          );
          await tester.pump();
        }
        expect(find.text(reason), findsOneWidget);
        expect(find.textContaining('not confirmed'), findsNothing);
        await captureWindow(
          tester,
          shots,
          'bring-agent-refused-${brightness.name}',
        );
        await tester.tap(find.text('Not now'));
        await tester.pumpAndSettle();
        await tester.runAsync(() => joining);
        await tester.pumpWidget(const SizedBox());
        f.dispose();
      },
    );
  }

  // Review of #4442: a computer that stays preparing never holds the form
  // open; Not now closes it at once and nothing starts.
  testWidgets('Not now while the computer prepares closes and starts nothing', (
    tester,
  ) async {
    final f = newMember();
    await tester.binding.setSurfaceSize(const Size(1000, 760));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: SwarmJoinHost(app: f.app, child: const Scaffold()),
      ),
    );
    late Future<void> joining;
    await tester.runAsync(() async {
      joining = f.app.addMachineOnJoin(tabId, role: 'collaborator');
      await pumpEventQueue();
    });
    await tester.pump();
    await tester.runAsync(() async => pumpEventQueue());
    await tester.pumpAndSettle();
    f.connection.keepPreparing = true;
    await tester.runAsync(() async {
      await tester.tap(find.text('Bring agent'));
      await pumpEventQueue();
    });
    await tester.pump();
    expect(find.textContaining('Starting your Buddy on'), findsOneWidget);
    await tester.tap(find.text('Not now'));
    await tester.pump();
    await tester.pump();
    expect(find.textContaining('Still working on it'), findsNothing);
    expect(find.byType(NewHarnessForm), findsNothing);
    // Ready now, in real time past the next ask: the closed form starts nothing.
    f.connection.keepPreparing = false;
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 1500)),
    );
    await tester.pump();
    await tester.runAsync(() => joining);
    expect(
      f.connection.server.posts.where(
        (post) => (post['command'] as Map)['type'] == 'buddy.create',
      ),
      isEmpty,
    );
    await tester.pumpWidget(const SizedBox());
    f.dispose();
  });

  // Audit finding 13 (#4442), in both themes for the pull request.
  for (final brightness in Brightness.values) {
    testWidgets('join dialog loading and dead link in ${brightness.name}', (
      tester,
    ) async {
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await tester.binding.setSurfaceSize(const Size(720, 420));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      Future<void> show(String name, SuperTabRequest request) async {
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: Scaffold(
              body: Center(
                child: SizedBox(
                  width: 480,
                  child: SwarmJoinDialog(
                    key: ValueKey(name),
                    link: const SwarmJoinLink('tab', token: 'invite'),
                    accountEmail: 'leo@example.com',
                    isCurrent: () => true,
                    onJoined: (_, _) {},
                    request: request,
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pump();
        await captureWindow(tester, shots, 'join-$name-${brightness.name}');
      }

      final loading = Completer<Map<String, dynamic>>();
      await show('loading', (_, _, {body}) => loading.future);
      expect(find.text('Join Swarm'), findsWidgets);
      expect(find.text('Retry'), findsNothing);
      await show(
        'dead-link',
        (_, _, {body}) async =>
            throw const SuperTabFailure('LINK_REVOKED', 'x', statusCode: 410),
      );
      expect(find.text('Close'), findsOneWidget);
      expect(find.text('Retry'), findsNothing);
      loading.complete({'id': 'tab', 'name': 'Pilot', 'role': 'viewer'});
      await tester.pumpWidget(const SizedBox());
    });
  }
}
