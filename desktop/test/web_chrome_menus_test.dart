import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/web/shell/web_chrome.dart';
import 'package:harness/widgets/account_menu.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/widgets/workspace_account_button.dart';

import 'support/capture.dart';
import 'support/real_fonts.dart';
import 'support/super_tab_phone.dart';
import 'swarm_state_test.dart' show createApp;

/// The web bar after Huy's ask (2026-11-02): no left menu; the avatar's account
/// menu; no Machines or Models on the bar (the footer has them); `+` opens a
/// small menu whose More keeps what a phone has no key for. `HARNESS_WEB_MENUS_CAPTURE_DIR` writes what it
/// draws.
const _wide = Size(1280, 800);
const _phone = Size(390, 844);
final _captureDir = Platform.environment['HARNESS_WEB_MENUS_CAPTURE_DIR'];

final _plus = find.byKey(const ValueKey('web-new-menu-button'));
final _avatar = find.byKey(const ValueKey('swarm-account-button'));
final _accountMenu = find.byKey(const ValueKey('account-menu'));
Finder _row(String id) => find.byKey(ValueKey('web-menu:$id'));
Finder _accountRow(String id) => find.byKey(ValueKey('account-menu-$id'));

AppNotifier _app({int panes = 3}) {
  final app = createApp()
    ..currentUser = const CurrentUserProfile(
      name: 'Huy Pham',
      email: 'huy@example.com',
    );
  const machine = Machine(
    machineId: 'm',
    name: 'box',
    authMode: MachineAuthMode.remote,
  );
  app.machines.add(machine);
  app.machineStates['m'] = MachineState(machine)
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected
    ..agents = [for (var i = 0; i < 4; i++) Agent(id: 'a$i', name: 'Agent $i')];
  app.newSwarm(newTabPage: true);
  app.activeSwarm.panes.addAll([
    for (var i = 0; i < panes; i++)
      TerminalPane(id: 100 + i, machineId: 'm', agentId: 'a$i'),
  ]);
  app.focusPane(100);
  return app;
}

Future<AppNotifier> _mount(
  WidgetTester tester,
  Size size, {
  AppNotifier? app,
  bool web = true,
  Brightness brightness = Brightness.dark,
}) async {
  final notifier = app ?? _app();
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      home: SwarmScreen(
        notifier: notifier,
        nativeTabs: false,
        chrome: web ? webWorkspaceChrome(notifier) : null,
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 200));
  return notifier;
}

Future<void> _tap(WidgetTester tester, Finder target) async {
  await tester.tap(target);
  await tester.pump(const Duration(milliseconds: 150));
}

/// Takes the workspace down with the page still up, as a sign-out or a lost
/// session does: the menus' overlay is the page's, not the workspace's.
Future<void> _signOutScreen(WidgetTester tester) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: const Scaffold(body: Text('Sign in')),
    ),
  );
  await tester.pump(const Duration(milliseconds: 100));
}

Future<void> _done(WidgetTester tester, AppNotifier app) async {
  expect(tester.takeException(), isNull);
  await tester.pumpWidget(const SizedBox.shrink());
  app.dispose();
}

void main() {
  setUpAll(() => loadCaptureFonts(_captureDir));

  group('the wide bar', () {
    testWidgets('has no left menu; Machines and Models are the footer\'s', (
      tester,
    ) async {
      final app = await _mount(tester, _wide);
      final bar = find.byKey(const ValueKey('workspace-tab-bar'));
      expect(find.byKey(const ValueKey('web-app-menu-button')), findsNothing);
      for (final button in [_plus, _avatar]) {
        expect(find.descendant(of: bar, matching: button), findsOneWidget);
      }
      for (final word in ['Machines', 'Models']) {
        expect(
          find.descendant(of: bar, matching: find.textContaining(word)),
          findsNothing,
          reason: word,
        );
      }
      // Still one click away, in the status bar.
      await _tap(tester, find.textContaining('Machines ').hitTestable());
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byType(SwarmSearchResults), findsOneWidget);
      await _done(tester, app);
    });

    testWidgets('the avatar sits at the right end, Store before it', (
      tester,
    ) async {
      final app = await _mount(tester, _wide);
      final store = find.byKey(const ValueKey('swarm-store-button'));
      expect(
        tester.getTopLeft(_avatar).dx,
        greaterThan(tester.getTopRight(store).dx - 1),
      );
      await _done(tester, app);
    });

    testWidgets('+ offers New tab, New Swarm, Split pane, History and More', (
      tester,
    ) async {
      final app = await _mount(tester, _wide);
      await _tap(tester, _plus);
      for (final id in [
        'swarm.new',
        'super_tab.new',
        'pane.split_right',
        'navigation.history',
        'web.more',
      ]) {
        expect(_row(id), findsOneWidget, reason: id);
      }
      expect(_row('app.store'), findsNothing);
      expect(find.text('All commands'), findsNothing);
      await captureWindow(tester, _captureDir, 'wide-dark-plus-menu');

      final tabs = app.swarms.length;
      await _tap(tester, _row('swarm.new'));
      expect(app.swarms, hasLength(tabs + 1));
      expect(_row('swarm.new'), findsNothing);
      await _done(tester, app);
    });

    testWidgets('a second press on + closes its menu', (tester) async {
      final app = await _mount(tester, _wide);
      await _tap(tester, _plus);
      expect(_row('swarm.new'), findsOneWidget);
      await _tap(tester, _plus);
      expect(_row('swarm.new'), findsNothing);
      await _done(tester, app);
    });

    testWidgets('the avatar opens the account menu with Add Phone', (
      tester,
    ) async {
      final app = await _mount(tester, _wide);
      await _tap(tester, _avatar);
      expect(_accountMenu, findsOneWidget);
      expect(find.text('Huy Pham'), findsOneWidget);
      expect(find.text('huy@example.com'), findsOneWidget);
      for (final choice in AccountMenuChoice.values) {
        expect(_accountRow(choice.name), findsOneWidget, reason: choice.name);
      }
      await captureWindow(tester, _captureDir, 'wide-dark-account-menu');
      await _tap(tester, _accountRow('settings'));
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byType(SettingsScreen), findsOneWidget);
      await _done(tester, app);
    });
  });

  group('the phone bar', () {
    testWidgets('the account menu has no Add Phone, and finger-tall rows', (
      tester,
    ) async {
      final app = await _mount(tester, _phone);
      await _tap(tester, _avatar);
      expect(_accountRow('addPhone'), findsNothing);
      for (final choice in [
        AccountMenuChoice.customize,
        AccountMenuChoice.notifications,
        AccountMenuChoice.settings,
        AccountMenuChoice.signOut,
      ]) {
        expect(
          tester.getSize(_accountRow(choice.name)).height,
          greaterThanOrEqualTo(44),
          reason: choice.name,
        );
      }
      await captureWindow(tester, _captureDir, 'phone-dark-account-menu');
      await _done(tester, app);
    });

    testWidgets('+ adds Store, and More holds zoom, move, layouts, reopen', (
      tester,
    ) async {
      final app = await _mount(tester, _phone);
      await _tap(tester, _plus);
      expect(_row('app.store'), findsOneWidget);
      await captureWindow(tester, _captureDir, 'phone-dark-plus-menu');
      await _tap(tester, _row('web.more'));
      expect(_row('swarm.new'), findsNothing);
      for (final id in [
        'pane.zoom',
        'pane.move_left',
        'pane.move_right',
        'pane.move_up',
        'pane.move_down',
        'pane.move_to_tab',
        'pane.layout',
      ]) {
        expect(_row(id), findsOneWidget, reason: id);
        expect(
          tester.getSize(_row(id)).height,
          greaterThanOrEqualTo(44),
          reason: id,
        );
      }
      await captureWindow(tester, _captureDir, 'phone-dark-more-menu');

      // A row of More runs: Zoom really zooms the focused pane.
      expect(app.zoomedPaneId, isNull);
      await _tap(tester, _row('pane.zoom'));
      expect(app.zoomedPaneId, 100);
      await _done(tester, app);
    });

    testWidgets('Move pane right and Reopen closed tab run from More', (
      tester,
    ) async {
      final app = await _mount(tester, _phone);
      final order = [for (final pane in app.panes) pane.id];
      await _tap(tester, _plus);
      await _tap(tester, _row('web.more'));
      await _tap(tester, _row('pane.move_right'));
      expect([
        for (final pane in app.panes) pane.id,
      ], isNot(orderedEquals(order)));

      await tester.runAsync(() => app.requestCloseSwarm(app.activeSwarmId));
      await tester.pump(const Duration(milliseconds: 200));
      expect(app.canReopenLastClosed, isTrue);
      final tabs = app.swarms.length;
      await _tap(tester, _plus);
      await _tap(tester, _row('web.more'));
      await _tap(tester, _row('swarm.reopen'));
      await tester.pump(const Duration(milliseconds: 200));
      expect(app.swarms, hasLength(tabs + 1));
      await _done(tester, app);
    });

    for (final width in [360.0, 390.0]) {
      testWidgets('every control fits and is a finger wide at $width', (
        tester,
      ) async {
        final app = await _mount(tester, Size(width, 740));
        final rects = <Rect>[];
        for (final key in [
          'web-tab-switcher',
          'web-new-menu-button',
          'swarm-search-button',
          'workspace-notifications-button',
          'swarm-account-button',
        ]) {
          final rect = tester.getRect(find.byKey(ValueKey(key)));
          expect(rect.width, greaterThanOrEqualTo(44), reason: key);
          expect(rect.height, greaterThanOrEqualTo(44), reason: key);
          expect(rect.right, lessThanOrEqualTo(width), reason: key);
          for (final other in rects) {
            expect(rect.overlaps(other), isFalse, reason: key);
          }
          rects.add(rect);
        }
        await captureWindow(tester, _captureDir, 'phone-$width-dark-bar');
        await _done(tester, app);
      });
    }

    // Huy, 2026-11-02: the phone bar's icons line up evenly and are one size.
    for (final width in [360.0, 390.0]) {
      for (final name in ['a', 'A tab with a very long name that cannot fit']) {
        testWidgets(
          'its icons line up evenly and match at $width, tab "$name"',
          (tester) async {
            final app = _app();
            app.renameSwarm(app.activeSwarmId, name);
            await _mount(tester, Size(width, 740), app: app);
            Finder icon(String key, Type type) => find.descendant(
              of: find.byKey(ValueKey(key)),
              matching: find.byType(type),
            );
            final cells = [
              for (final key in [
                'web-new-menu-button',
                'swarm-search-button',
                'workspace-notifications-button',
                'swarm-account-button',
              ])
                tester.getRect(find.byKey(ValueKey(key))),
            ];
            // Every icon has the same square, side by side, so the spacing is even.
            for (final cell in cells) {
              expect(cell.size, const Size(44, 44));
            }
            for (var i = 1; i < cells.length; i++) {
              expect(cells[i].left, cells[i - 1].right);
            }
            // And what is drawn in it is one size, the avatar's circle too.
            final drawn = [
              tester.getRect(icon('web-new-menu-button', Icon).first),
              tester.getRect(icon('swarm-search-button', Icon).first),
              tester.getRect(
                icon('workspace-notifications-button', Icon).first,
              ),
              tester.getRect(icon('swarm-account-button', AccountAvatar).first),
            ];
            for (final rect in drawn) {
              expect(rect.size, const Size(20, 20));
            }
            for (var i = 0; i < drawn.length; i++) {
              expect(drawn[i].center, cells[i].center);
            }
            // The row starts and ends the same distance from the screen's edges.
            final label = tester.getRect(icon('web-tab-switcher', Text).first);
            expect(label.left, 16);
            expect(drawn.last.right, width - 16);
            await _done(tester, app);
          },
        );
      }
    }

    // Huy, 2026-11-02: each row was even on its own, but not with the other.
    for (final width in [360.0, 390.0]) {
      testWidgets('the Swarm header under it shares its edges at $width', (
        tester,
      ) async {
        final size = Size(width, 740);
        final app = await _mount(tester, size);
        final name = tester.getRect(
          find
              .descendant(
                of: find.byKey(const ValueKey('web-tab-switcher')),
                matching: find.byType(Text),
              )
              .first,
        );
        final avatar = tester.getRect(
          find
              .descendant(of: _avatar, matching: find.byType(AccountAvatar))
              .first,
        );
        await _done(tester, app);

        final (_, controller) = await mountPhoneSuperTab(tester, size);
        Rect icon(String tooltip) => tester.getRect(
          find
              .descendant(
                of: find.byTooltip(tooltip),
                matching: find.byType(Icon),
              )
              .first,
        );
        expect(icon('Conversations').left, name.left);
        expect(icon('Members').center.dx, avatar.center.dx);
        expect(tester.takeException(), isNull);
        await unmountPhoneSuperTab(tester, controller);
      });
    }

    testWidgets('Machines and Models stay in the phone footer\'s menu', (
      tester,
    ) async {
      final app = await _mount(tester, _phone);
      await _tap(tester, find.byKey(const ValueKey('web-footer-menu-button')));
      final machines = find.textContaining('Machines ');
      expect(machines, findsOneWidget);
      expect(find.textContaining('Models '), findsOneWidget);
      await _tap(tester, machines);
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byType(SwarmSearchResults), findsOneWidget);
      await _done(tester, app);
    });

    testWidgets('a 320 px phone still fits the bar', (tester) async {
      final app = await _mount(tester, const Size(320, 640));
      expect(tester.getRect(_avatar).right, lessThanOrEqualTo(320));
      await _done(tester, app);
    });
  });

  group('access lost with a menu open', () {
    for (final (name, size) in [('wide', _wide), ('phone', _phone)]) {
      testWidgets('the account menu leaves no name or email on $name', (
        tester,
      ) async {
        final app = await _mount(tester, size);
        await _tap(tester, _avatar);
        expect(find.text('huy@example.com'), findsOneWidget);
        await _signOutScreen(tester);
        expect(_accountMenu, findsNothing);
        expect(find.text('Huy Pham'), findsNothing);
        expect(find.text('huy@example.com'), findsNothing);
        expect(find.text('Sign in'), findsOneWidget);
        await _done(tester, app);
      });

      testWidgets('the + menu goes with the workspace on $name', (
        tester,
      ) async {
        final app = await _mount(tester, size);
        await _tap(tester, _plus);
        expect(_row('swarm.new'), findsOneWidget);
        await _signOutScreen(tester);
        expect(_row('swarm.new'), findsNothing);
        await _done(tester, app);
      });

      testWidgets('More goes with the workspace on $name', (tester) async {
        final app = await _mount(tester, size);
        await _tap(tester, _plus);
        await _tap(tester, _row('web.more'));
        expect(_row('pane.layout'), findsOneWidget);
        await _signOutScreen(tester);
        expect(_row('pane.layout'), findsNothing);
        await _done(tester, app);
      });
    }

    testWidgets('Desktop keeps its + and has no web buttons', (tester) async {
      final app = await _mount(tester, _wide, web: false);
      final tabs = app.swarms.length;
      expect(_plus, findsNothing);
      await _tap(tester, find.byKey(const ValueKey('swarm-new-tab-button')));
      expect(app.swarms, hasLength(tabs + 1));
      await _done(tester, app);
    });
  });

  // The pictures for the pull request; the dark ones are taken above.
  testWidgets('light theme pictures', (tester) async {
    if (_captureDir == null) return;
    for (final (name, size) in [('wide', _wide), ('phone', _phone)]) {
      final app = await _mount(tester, size, brightness: Brightness.light);
      await _tap(tester, _plus);
      await captureWindow(tester, _captureDir, '$name-light-plus-menu');
      await _tap(tester, _row('web.more'));
      await captureWindow(tester, _captureDir, '$name-light-more-menu');
      await tester.tapAt(const Offset(5, 500));
      await tester.pump(const Duration(milliseconds: 100));
      await _tap(tester, _avatar);
      await captureWindow(tester, _captureDir, '$name-light-account-menu');
      await _done(tester, app);
    }
  });
}
