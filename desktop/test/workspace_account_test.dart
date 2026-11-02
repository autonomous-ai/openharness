import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/widgets/sign_in_step.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/settings/settings_section.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/setting_row.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/account_menu.dart';
import 'package:harness/widgets/workspace_account_button.dart';

import 'support/capture.dart';
import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show createApp;

/// The tab row's right end, as in a browser's toolbar (owner, 2026-10-11):
/// Search, Devices and Harness Store are icons, and the last control is Sign
/// in while this computer holds no account, then the account's initial, whose
/// menu opens what the app already has. `HARNESS_ACCOUNT_CAPTURE_DIR` writes
/// what it draws.
final _captureDir = Platform.environment['HARNESS_ACCOUNT_CAPTURE_DIR'];

Future<void> _capture(WidgetTester tester, String name) =>
    captureWindow(tester, _captureDir, name);

final _search = find.byKey(const ValueKey('swarm-search-button'));
final _bell = find.byKey(const ValueKey('workspace-notifications-button'));
final _phone = find.byKey(const ValueKey('swarm-add-phone-button'));
final _devices = find.byKey(const ValueKey('swarm-devices-button'));
final _store = find.byKey(const ValueKey('swarm-store-button'));
final _signIn = find.byKey(const ValueKey('swarm-sign-in-button'));
final _avatar = find.byKey(const ValueKey('swarm-account-button'));
final _menu = find.byKey(const ValueKey('account-menu'));

AppNotifier _signedIn() => createApp()
  ..currentUser = const CurrentUserProfile(
    name: 'Dee Example',
    email: 'dee@example.com',
  );

Future<void> _mountMenu(
  WidgetTester tester, {
  String name = 'Dee Example',
  String email = 'dee@example.com',
  void Function(AccountMenuChoice?)? onChoice,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1280, 800);
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Builder(
        builder: (context) => Scaffold(
          body: TextButton(
            onPressed: () async {
              // Opened whether or not anyone listens for the answer.
              final choice = await showAccountMenu(
                context,
                name: name,
                email: email,
              );
              onChoice?.call(choice);
            },
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pump();
  await tester.pump();
}

void main() {
  setUpAll(() => loadCaptureFonts(_captureDir));

  testWidgets('not signed in, the row ends in Sign in, after its icons', (
    tester,
  ) async {
    final app = createApp()..signedIn = false;
    addTearDown(app.dispose);
    await mount(tester, app);

    expect(_signIn, findsOneWidget);
    expect(_avatar, findsNothing);
    // Where this app draws the row it carries the bell too; on a Mac that is
    // in the menu bar.
    final order = [
      for (final control in [_search, _bell, _phone, _devices, _store, _signIn])
        tester.getCenter(control).dx,
    ];
    expect(
      order,
      [...order]..sort(),
      reason: 'Search, Add Phone, Devices, Store, Sign in',
    );
    // The only control in the row with a word on it.
    expect(
      find.descendant(of: _signIn, matching: find.text('Sign in')),
      findsOneWidget,
    );
    for (final icon in [_search, _phone, _devices, _store]) {
      expect(
        find.descendant(of: icon, matching: find.byType(Text)),
        findsNothing,
      );
    }
    // Icons sit side by side; nothing is drawn between them and Sign in.
    expect(tester.getRect(_search).right, tester.getRect(_bell).left);
    expect(tester.getRect(_bell).right, tester.getRect(_phone).left);
    expect(tester.getRect(_phone).right, tester.getRect(_devices).left);
    expect(tester.getRect(_devices).right, tester.getRect(_store).left);
    expect(
      tester.getRect(_signIn).left - tester.getRect(_store).right,
      grid.AppDesktop.controlGap,
    );
    expect(
      tester.getRect(_signIn).right,
      1280 - grid.AppDesktop.tabBarTrailingInset,
    );
    expect(find.byTooltip('Sign in to Harness'), findsOneWidget);
    expect(find.byTooltip('Explore Harness Store · ⌃⌘S'), findsOneWidget);
    await _capture(tester, 'tab-row-sign-in');
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  testWidgets(
    'Sign in uses the onboarding page and stays until an account arrives',
    (tester) async {
      final app = createApp()..signedIn = false;
      addTearDown(app.dispose);
      await mount(tester, app);

      await tester.tap(_signIn);
      await tester.pump();
      await tester.pump();
      expect(find.byType(SignInStep), findsOneWidget);
      expect(find.text('Continue with Google'), findsOneWidget);
      // Email, GitHub and passkey are on this sign-in too, as a button of the
      // same width as the two above it (Scholes's test, 2026-10-31: small print
      // hid that it leads to GitHub and passkey too).
      final email = find.byKey(const Key('sign-in-step-email'));
      expect(email, findsOneWidget);
      expect(find.text('Email, GitHub or passkey'), findsOneWidget);
      expect(
        tester.getSize(email).width,
        tester.getSize(find.byKey(const Key('login-continue-google'))).width,
      );

      expect(find.byKey(const Key('login-close-button')), findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byType(SignInStep), findsOneWidget);
      app.signedIn = true;
      app.notifyListeners();
      await tester.pump();
      await tester.pump();
      expect(find.byType(SignInStep), findsNothing);
    },
  );

  testWidgets('signed in, the same place is the account\'s initial', (
    tester,
  ) async {
    final app = _signedIn();
    addTearDown(app.dispose);
    await mount(tester, app);

    expect(_signIn, findsNothing);
    expect(_avatar, findsOneWidget);
    expect(
      find.descendant(of: _avatar, matching: find.text('D')),
      findsOneWidget,
    );
    expect(find.byTooltip('Dee Example · dee@example.com'), findsOneWidget);
    expect(
      tester.getRect(_avatar).right,
      1280 - grid.AppDesktop.tabBarTrailingInset,
    );
    expect(
      tester.getRect(_avatar).left - tester.getRect(_store).right,
      grid.AppDesktop.controlGap,
    );

    // The profile has not been read yet: a person, not a letter or a blank.
    app.currentUser = null;
    app.notifyListeners();
    await tester.pump();
    expect(_avatar, findsOneWidget);
    expect(
      find.descendant(of: _avatar, matching: find.byType(Text)),
      findsNothing,
    );
    expect(
      find.descendant(of: _avatar, matching: find.byType(Icon)),
      findsOneWidget,
    );
  });

  testWidgets('the avatar opens its menu under the row, at the right', (
    tester,
  ) async {
    final app = _signedIn();
    addTearDown(app.dispose);
    await mount(tester, app);

    await tester.tap(_avatar);
    await tester.pump();
    await tester.pump();
    expect(_menu, findsOneWidget);
    expect(find.text('Dee Example'), findsOneWidget);
    expect(find.text('dee@example.com'), findsOneWidget);
    final menu = tester.getRect(_menu);
    expect(menu.top, greaterThanOrEqualTo(tester.getRect(_avatar).bottom));
    expect(menu.right, greaterThan(1280 - 24));
    await _capture(tester, 'tab-row-account-menu');

    // Escape puts it away and opens nothing.
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.pump();
    expect(_menu, findsNothing);
    expect(find.byType(SettingsScreen), findsNothing);
  });

  testWidgets('Notifications and Settings open Settings, each on its page', (
    tester,
  ) async {
    final app = _signedIn();
    addTearDown(app.dispose);
    await mount(tester, app);

    for (final (row, section) in [
      ('notifications', SettingsSection.notifications),
      ('settings', null),
    ]) {
      await tester.tap(_avatar);
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(ValueKey('account-menu-$row')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      // The menu has gone before what it opened arrives.
      expect(_menu, findsNothing);
      final settings = tester.widget<SettingsScreen>(
        find.byType(SettingsScreen),
      );
      expect(settings.initialSection, section, reason: row);
      Navigator.of(tester.element(find.byType(SettingsScreen))).pop();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byType(SettingsScreen), findsNothing);
    }
  });

  testWidgets('Settings says who is signed in, and an email only once', (
    tester,
  ) async {
    for (final (name, lines) in [
      ('Dee Example', ['Dee Example', 'dee@example.com']),
      // Signed up by email: the account is called by its address, which is
      // the line under the title already.
      (null, ['Signed in', 'dee@example.com']),
    ]) {
      final app = createApp()
        ..currentUser = CurrentUserProfile(
          name: name,
          email: 'dee@example.com',
        );
      await mount(tester, app);
      await tester.tap(_avatar);
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('account-menu-settings')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      Finder said(String text) => find.descendant(
        of: find.byType(SettingsScreen),
        matching: find.text(text),
      );
      for (final line in lines) {
        expect(said(line), findsOneWidget, reason: '$name: $line');
      }
      // Both are the same raised row: one with no second line is drawn bare.
      expect(
        tester.widget<SettingRow>(find.byType(SettingRow)).detail,
        'dee@example.com',
      );
      Navigator.of(tester.element(find.byType(SettingsScreen))).pop();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    }
  });

  testWidgets('the native tab row is told which of the two to draw', (
    tester,
  ) async {
    const channel = MethodChannel('harness/swarm_tabs');
    final updates = <Map>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      if (call.method == 'update') updates.add(call.arguments as Map);
      return true;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );
    final app = createApp()..signedIn = false;
    addTearDown(app.dispose);
    await mount(tester, app, nativeTabs: true);
    expect(updates.last['account'], {
      'kind': 'signIn',
      'tooltip': 'Sign in to Harness',
    });
    // AppKit draws the row, so this app draws none of it.
    expect(_signIn, findsNothing);

    app
      ..signedIn = true
      ..currentUser = const CurrentUserProfile(email: 'dee@example.com')
      ..notifyListeners();
    await tester.pump();
    expect(updates.last['account'], {
      'kind': 'avatar',
      // No name: the email's first letter.
      'initial': 'D',
      'tooltip': 'dee@example.com',
    });

    // A click there comes back as the native action.
    await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
      channel.name,
      channel.codec.encodeMethodCall(const MethodCall('account')),
      (_) {},
    );
    await tester.pump();
    await tester.pump();
    expect(_menu, findsOneWidget);
  });

  testWidgets('the menu: who, then five rows, no ellipses', (tester) async {
    await _mountMenu(tester);
    expect(find.text('Dee Example'), findsOneWidget);
    expect(find.text('dee@example.com'), findsOneWidget);
    final rows = [
      'Add Phone',
      'Appearance',
      'Notifications',
      'Settings',
      'Sign out',
    ];
    final tops = [for (final row in rows) tester.getTopLeft(find.text(row)).dy];
    expect(tops, [...tops]..sort(), reason: 'in this order');
    expect(find.textContaining('…'), findsNothing);
    expect(find.textContaining('...'), findsNothing);
    // Nothing the menu was offered and turned down.
    for (final absent in ['Machines', 'Your devices', 'Usage']) {
      expect(find.text(absent), findsNothing);
    }
  });

  testWidgets('each row answers with itself and closes the menu', (
    tester,
  ) async {
    for (final choice in AccountMenuChoice.values) {
      AccountMenuChoice? chosen;
      var answered = false;
      await _mountMenu(
        tester,
        onChoice: (value) {
          chosen = value;
          answered = true;
        },
      );
      await tester.tap(find.byKey(ValueKey('account-menu-${choice.name}')));
      await tester.pump();
      await tester.pump();
      expect(answered, isTrue);
      expect(chosen, choice);
      expect(_menu, findsNothing);
    }
  });

  testWidgets('opened, no row is lit; Down and Up walk them, Return takes '
      'the one it is on, a click outside takes none', (tester) async {
    AccountMenuChoice? chosen;
    var answers = 0;
    void answer(AccountMenuChoice? value) {
      chosen = value;
      answers++;
    }

    // Return on a menu just opened is no choice, and leaves it open.
    await _mountMenu(tester, onChoice: answer);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(answers, 0);
    expect(_menu, findsOneWidget);

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    await tester.pump();
    expect(chosen, AccountMenuChoice.addPhone);

    // Up from nothing is the last row, and Down from there the first again.
    await _mountMenu(tester, onChoice: answer);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    await tester.pump();
    expect(chosen, AccountMenuChoice.signOut);

    await _mountMenu(tester, onChoice: answer);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    await tester.pump();
    expect(chosen, AccountMenuChoice.customize);

    await _mountMenu(tester, onChoice: answer);
    await tester.tapAt(const Offset(40, 700));
    await tester.pump();
    await tester.pump();
    expect(answers, 4);
    expect(chosen, isNull);
    expect(_menu, findsNothing);
  });

  testWidgets('an account with no name says its email once; Add Phone is '
      'the first row whatever the account has', (tester) async {
    await _mountMenu(tester, name: '');
    expect(find.text('dee@example.com'), findsOneWidget);
    // It was hidden once the account had a phone, which the menu learned only
    // by being opened: there at the first click and gone at the second.
    expect(find.text('Add Phone'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.pump();
    expect(_menu, findsNothing);
    AccountMenuChoice? chosen;
    await _mountMenu(tester, onChoice: (value) => chosen = value);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    await tester.pump();
    expect(chosen, AccountMenuChoice.addPhone);
  });

  test('the one letter an account wears', () {
    expect(accountInitial('Dee Example', 'x@example.com'), 'D');
    expect(accountInitial(null, 'zoe@example.com'), 'Z');
    expect(accountInitial('  ', 'ada@example.com'), 'A');
    expect(accountInitial('élan', null), 'É');
    expect(accountInitial(null, null), '');
  });
}
