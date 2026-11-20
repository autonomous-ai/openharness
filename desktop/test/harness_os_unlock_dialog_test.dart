import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/harness_os/intern_unlock_dialog.dart';
import 'package:harness/state/app_state.dart';

import 'harness_os_setup_dialog_test.dart'
    show FakeAccount, FakeBox, internApp, message, press, pumpHost, wait;

void main() {
  late FakeBox box;
  late FakeAccount account;
  late AppNotifier app;

  const offline = Machine(
    machineId: 'm-box',
    authMode: MachineAuthMode.remote,
    status: 'offline',
    name: 'Den box',
  );

  setUp(() async {
    box = FakeBox();
    account = FakeAccount()..list = const [offline];
    app = internApp(account);
    await app.refreshMachines();
    // Seen before, encrypted: switched off and on, it waits at its disk's password.
    app.harnessOs.computers['m-box'] = (
      hotspot: 'Harness-EF78',
      encrypted: true,
    );
  });

  Future<void> open(WidgetTester tester) async {
    final hotspot = box.hotspot;
    await pumpHost(
      tester,
      (context) => showInternUnlock(context, app, 'm-box', hotspot: hotspot),
    );
    await tester.tap(find.text('Open'));
    await wait(tester);
    expect(find.text('Unlock Den box'), findsOneWidget);
    expect(
      find.text('Join “Harness-EF78” in this computer’s Wi-Fi menu.'),
      findsOneWidget,
    );
    // Nothing is asked of it until the person says this computer joined it.
    expect(message(tester), isNull);
    await press(tester, 'intern-unlock-connect');
    expect(box.calls, isEmpty);
    await press(tester, 'intern-unlock-joined');
    await press(tester, 'intern-unlock-connect');
    expect(message(tester), 'Looking for Den box…');
  }

  /// The person joins its hotspot and gives its password, checked there.
  Future<void> joinAndCheck(WidgetTester tester) async {
    await wait(tester, const Duration(seconds: 2));
    box.info = {'protocol': 3, 'hotspot': 'Harness-EF78', 'locked': true};
    await wait(tester, const Duration(seconds: 2));
    expect(
      find.text('Den box’s password, the one set when it was installed.'),
      findsOneWidget,
    );
    await tester.enterText(
      find.byKey(const Key('intern-unlock-secret')),
      'wrong',
    );
    await press(tester, 'intern-unlock-next');
    expect(message(tester), 'Wrong password.');
    await tester.enterText(
      find.byKey(const Key('intern-unlock-secret')),
      'open sesame',
    );
    await press(tester, 'intern-unlock-next');
    expect(box.checks, ['wrong', 'open sesame']);
    expect(box.unlocks, isEmpty);
  }

  testWidgets(
    'unlocked with another Wi-Fi: password checked, Wi-Fi chosen, online again',
    (tester) async {
      await open(tester);
      await joinAndCheck(tester);

      await press(tester, 'intern-unlock-change-wifi');
      expect(find.text('The Wi-Fi Den box sees.'), findsOneWidget);
      await press(tester, 'intern-network:Home');
      await tester.enterText(
        find.byKey(const Key('intern-unlock-wifi-password')),
        'hunter2222',
      );
      await press(tester, 'intern-unlock-with-wifi');
      expect(box.unlocks.single.password, 'open sesame');
      // Signed in already: no ticket, no account.
      expect(box.unlocks.single.setup, {
        'ssid': 'Home',
        'password': 'hunter2222',
        'security': 'WPA2',
      });
      expect(
        find.text('Unlocked. Den box is starting and joining “Home”.'),
        findsOneWidget,
      );

      await wait(tester, const Duration(seconds: 4));
      expect(find.text('Den box is online.'), findsNothing);
      account.list = [
        const Machine(
          machineId: 'm-box',
          authMode: MachineAuthMode.remote,
          status: 'running',
          name: 'Den box',
        ),
      ];
      await wait(tester, const Duration(seconds: 4));
      expect(find.text('Den box is online.'), findsOneWidget);
      await press(tester, 'intern-unlock-done');
      expect(find.text('Unlock Den box'), findsNothing);
      app.dispose();
    },
  );

  testWidgets(
    'unlocked on its own Wi-Fi but never online: Set up opens Set up Intern 3',
    (tester) async {
      await open(tester);
      await joinAndCheck(tester);
      await press(tester, 'intern-unlock-go');
      expect(box.unlocks.single.setup, isNull);
      expect(
        find.text('Unlocked. Den box is starting and going back on its Wi-Fi.'),
        findsOneWidget,
      );
      for (var i = 0; i < 45; i++) {
        await wait(tester, const Duration(seconds: 4));
      }
      expect(
        message(tester),
        'Den box is unlocked but not online. If it was signed out or lost its Wi-Fi, set it up again.',
      );
      expect(find.byKey(const Key('intern-unlock-retry')), findsOneWidget);
      await press(tester, 'intern-unlock-set-up');
      expect(find.text('Unlock Den box'), findsNothing);
      expect(find.text('Set up Intern 3'), findsOneWidget);
      await press(tester, 'intern-setup-close');
      app.dispose();
    },
  );

  testWidgets('not locked: said, with Retry', (tester) async {
    box.info = {'protocol': 3, 'hotspot': 'Harness-EF78', 'signedIn': true};
    await open(tester);
    await wait(tester, const Duration(seconds: 2));
    expect(
      message(tester),
      'Den box is not locked. It is starting, or waits to be set up.',
    );
    expect(find.widgetWithText(FilledButton, 'Retry'), findsOneWidget);
    expect(find.byKey(const Key('intern-unlock-set-up')), findsOneWidget);
    await press(tester, 'intern-unlock-close');
    expect(find.text('Unlock Den box'), findsNothing);
    app.dispose();
  });
}
