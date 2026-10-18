import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agents_page.dart';
import 'package:harness_mobile/phone/machine_profile_picker.dart';
import 'package:harness_mobile/phone/machines_tab.dart';
import 'package:harness_mobile/phone/phone_status.dart';
import 'package:harness_mobile/phone/terminal_title.dart';
import 'package:harness_mobile/state/app_state.dart';

/// One computer, one name for its state, on every phone screen: "offline" (the desktop's word) and
/// "locked" (the phone's Unlock), never "asleep" on one screen and "Offline" on the next, or
/// "locked" here and "Needs its password" there.
void main() {
  Machine machine(String id) =>
      Machine(machineId: id, authMode: MachineAuthMode.remote, name: id);

  void locked(MachineState state) {
    state
      ..nodeOnline = true
      ..needsLink = true;
  }

  void offline(MachineState state) {
    state.nodeOnline = false;
  }

  /// An account whose computers are [states], in that order, each set up by its function.
  AppNotifier appWith(Map<String, void Function(MachineState)> states) {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    addTearDown(app.dispose);
    app.machines = [for (final id in states.keys) machine(id)];
    for (final MapEntry(key: id, value: prepare) in states.entries) {
      prepare(app.machineStates[id] = MachineState(machine(id)));
    }
    return app;
  }

  Finder anyText(String text) => find.textContaining(text, findRichText: true);

  test('one word per state, from one place', () {
    expect(phoneMachineWord(PhoneMachineStatus.offline), 'offline');
    expect(phoneMachineWord(PhoneMachineStatus.needsPassword), 'locked');
    expect(phoneMachineWord(PhoneMachineStatus.connecting), 'connecting');
    expect(phoneMachineWord(PhoneMachineStatus.ready), 'ready');
  });

  test(
    'the New form and a computer\'s page say the same words, capitalised',
    () {
      MachineState stateOf(void Function(MachineState) prepare) {
        final state = MachineState(machine('m'));
        prepare(state);
        return state;
      }

      expect(phoneMachineSummary(stateOf(offline)).label, 'Offline');
      expect(phoneMachineSummary(stateOf(locked)).label, 'Locked');
      expect(
        phoneMachineSummary(stateOf((s) => s.nodeOnline = true)).label,
        'Connecting…',
      );
    },
  );

  testWidgets('Computers: a locked and an offline computer, each in its word', (
    tester,
  ) async {
    final app = appWith({'studio': locked, 'mini': offline});
    await tester.pumpWidget(MaterialApp(home: MachinesTab(notifier: app)));

    expect(find.text('locked', findRichText: true), findsOneWidget);
    expect(find.text('tap to unlock: scan its code'), findsOneWidget);
    expect(find.text('offline', findRichText: true), findsOneWidget);
    expect(find.text('turn it on, or run harness start there'), findsOneWidget);
    expect(anyText('asleep'), findsNothing);
  });

  testWidgets('Computers: a run of offline computers is named once, over it', (
    tester,
  ) async {
    final app = appWith({'studio': offline, 'mini': offline});
    await tester.pumpWidget(MaterialApp(home: MachinesTab(notifier: app)));

    expect(
      find.text(
        'offline · turn them on, or run harness start there',
        findRichText: true,
      ),
      findsOneWidget,
    );
    expect(anyText('asleep'), findsNothing);
  });

  testWidgets('Settings ▸ Profile: Computers\' words', (tester) async {
    final app = appWith({'studio': locked, 'mini': offline});
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showMachineProfilePicker(context, app),
              child: const Text('profile'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('profile'));
    await tester.pumpAndSettle();

    expect(find.text('Show tabs from'), findsOneWidget);
    expect(find.text('locked'), findsOneWidget);
    expect(find.text('offline'), findsOneWidget);
    expect(anyText('asleep'), findsNothing);
  });

  testWidgets('a computer\'s own page: Offline, or Locked, in its header', (
    tester,
  ) async {
    final app = appWith({'studio': locked, 'mini': offline});
    await tester.pumpWidget(
      MaterialApp(
        home: AgentsPage(notifier: app, machineId: 'mini'),
      ),
    );
    expect(find.text('Offline'), findsOneWidget);

    await tester.pumpWidget(
      MaterialApp(
        home: AgentsPage(notifier: app, machineId: 'studio'),
      ),
    );
    expect(find.text('Locked'), findsOneWidget);
    expect(find.text('Needs its password'), findsNothing);
  });

  testWidgets('a harness whose computer is away: "computer offline"', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TerminalTitle(
            name: 'fix-login',
            onTap: () {},
            onFind: () {},
            away: true,
          ),
        ),
      ),
    );
    expect(find.text('computer offline'), findsOneWidget);
    expect(anyText('asleep'), findsNothing);
  });
}
