import 'dart:async';

import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_inbox.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_rename.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Rename a Swarm on the phone (Tony's task 17), as the desktop's Rename Tab
/// does it with `tab.rename`: held from its row in Home's switcher, for
/// someone who may write there; the new name shows at once, and the old one
/// comes back when the server does not keep it.
void main() {
  /// The Swarm's name as the server has it.
  late String name;

  /// The reader's role in the Swarm.
  late String role;

  /// The next command waits for this, while set.
  Completer<void>? wait;

  /// The next command throws this instead of answering, while set.
  Object? refuse;

  var version = 1;

  FakeSwarm backend() {
    name = 'Phone Swarm';
    version = 1;
    wait = null;
    refuse = null;
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': name, 'ownerId': me, 'lastChangedAt': version},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        head: headData(name: name),
        lastChangedAt: version,
      ),
      'members': [part(me, 1, person(me, role: role))],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
      ...changes(cursor: 'c$version', lastChangedAt: version),
      'head': part('head', version, headData(name: name)),
    };
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/commands'] = (body) async {
      final command = body!['command'] as Map<String, dynamic>;
      if (wait case final waiting?) await waiting.future;
      if (refuse case final failure?) throw failure;
      if (command['type'] == 'tab.rename') {
        name = command['name'] as String;
        version++;
      }
      return {'ok': true};
    };
    return fake;
  }

  List<Map<String, dynamic>> renames(FakeSwarm fake) => [
    for (final command in fake.commands)
      if (command['type'] == 'tab.rename') command,
  ];

  group('SwarmInbox.rename', () {
    setUp(() => role = 'owner');

    Future<SwarmInbox> read(FakeSwarm fake) async {
      final inbox = SwarmInbox(accountId: me, request: fake.request);
      addTearDown(inbox.dispose);
      await inbox.refresh();
      expect(inbox.reader(tab)?.snapshot, isNotNull);
      return inbox;
    }

    String listed(SwarmInbox inbox) => inbox.swarms.single.name;

    test('shows the name at once, sends it trimmed as tab.rename, and keeps '
        'it once the server has', () async {
      final fake = backend();
      final inbox = await read(fake);
      wait = Completer<void>();

      final renaming = inbox.rename(tab, '  Lamp  ');
      expect(listed(inbox), 'Lamp', reason: 'before the server answers');

      wait!.complete();
      expect(await renaming, isNull);
      expect(listed(inbox), 'Lamp');
      expect(inbox.reader(tab)!.snapshot!.name, 'Lamp', reason: 'read again');
      expect(renames(fake), [
        {'type': 'tab.rename', 'name': 'Lamp'},
      ]);
    });

    test('a list read while it is on its way does not bring the old name '
        'back', () async {
      final fake = backend();
      final inbox = await read(fake);
      wait = Completer<void>();

      final renaming = inbox.rename(tab, 'Lamp');
      await inbox.refresh();
      expect(listed(inbox), 'Lamp', reason: 'the list still says the old');

      wait!.complete();
      expect(await renaming, isNull);
      expect(listed(inbox), 'Lamp');
    });

    test("a refusal brings the old name back, in the server's words", () async {
      final fake = backend();
      final inbox = await read(fake);
      refuse = const SuperTabFailure(
        'READ_ONLY',
        'This Super Tab is read-only for you.',
        statusCode: 403,
      );

      expect(
        await inbox.rename(tab, 'Lamp'),
        'This Super Tab is read-only for you.',
      );
      expect(listed(inbox), 'Phone Swarm');
    });

    test("a call lost on the way says the desktop's words", () async {
      final fake = backend();
      final inbox = await read(fake);
      refuse = StateError('socket closed');

      expect(await inbox.rename(tab, 'Lamp'), 'Could not rename the Swarm.');
      expect(listed(inbox), 'Phone Swarm');
    });

    test(
      'a newer rename settles it: an older refusal leaves the newer name',
      () async {
        final fake = backend();
        final inbox = await read(fake);
        final first = Completer<void>();
        wait = first;
        refuse = const SuperTabFailure('BUSY', 'Try again.');
        final older = inbox.rename(tab, 'Lamp');
        // The newer one is answered at once, and kept.
        wait = null;
        refuse = null;
        expect(await inbox.rename(tab, 'Spaceship'), isNull);

        refuse = const SuperTabFailure('BUSY', 'Try again.');
        first.complete();
        expect(await older, 'Try again.');
        expect(listed(inbox), 'Spaceship');
      },
    );

    test('the name it has, or none, sends nothing', () async {
      final fake = backend();
      final inbox = await read(fake);

      expect(await inbox.rename(tab, ' Phone Swarm '), isNull);
      expect(await inbox.rename(tab, '   '), 'Name cannot be empty');
      expect(renames(fake), isEmpty);
      expect(listed(inbox), 'Phone Swarm');
    });

    test('a viewer is told, and nothing is sent or shown', () async {
      role = 'viewer';
      final fake = backend();
      final inbox = await read(fake);

      expect(swarmMayRename(inbox, tab), isFalse);
      expect(swarmHasMenu(inbox, tab), isFalse, reason: 'nothing in it');
      expect(await inbox.rename(tab, 'Lamp'), 'You can’t rename this Swarm.');
      expect(renames(fake), isEmpty);
      expect(listed(inbox), 'Phone Swarm');
    });

    test('a collaborator may, as on the desktop', () async {
      role = 'collaborator';
      final inbox = await read(backend());
      expect(swarmMayRename(inbox, tab), isTrue);
      expect(swarmHasMenu(inbox, tab), isTrue);
    });

    test('a refusal once the Swarm was lost says nothing', () async {
      final fake = backend();
      final inbox = await read(fake);
      wait = Completer<void>();
      refuse = const SuperTabFailure('NOT_FOUND', 'Gone.', statusCode: 404);

      final renaming = inbox.rename(tab, 'Lamp');
      inbox.reader(tab)!.revoke();
      wait!.complete();
      expect(await renaming, isNull);
    });

    test('a Swarm it does not list is not renamed', () async {
      final fake = backend();
      final inbox = await read(fake);

      expect(await inbox.rename('tab-other', 'Lamp'), isNull);
      expect(swarmMayRename(inbox, 'tab-other'), isFalse);
      expect(swarmHasMenu(inbox, 'tab-other'), isFalse);
      expect(renames(fake), isEmpty);
    });
  });

  test("the desktop's checks: not empty, at most 80 characters", () {
    expect(swarmNameProblem('Lamp'), isNull);
    expect(swarmNameProblem('  '), 'Name cannot be empty');
    expect(swarmNameProblem('x' * 80), isNull);
    expect(swarmNameProblem(' ${'x' * 80} '), isNull, reason: 'trimmed');
    expect(swarmNameProblem('x' * 81), 'Use at most 80 characters.');
    // Characters, not code units: an emoji with its skin tone is one.
    expect(swarmNameProblem('👍🏽' * 80), isNull);
    expect(swarmNameProblem('👍🏽' * 81), 'Use at most 80 characters.');
  });

  group('on the phone', () {
    late FakeSwarm fake;
    late SwarmHost host;

    /// Swarm Home on an iPhone's screen (390 × 844), as `swarm_home_test`
    /// pumps it.
    Future<void> pump(WidgetTester tester, {String as = 'owner'}) async {
      role = as;
      fake = backend();
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      final account = ValueNotifier<String?>(me);
      host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
          ..value = {PhoneExperiment.swarm},
        readMarks: MemoryKeyValueStore(),
      )..foreground = false;
      addTearDown(host.dispose);
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) =>
              SwarmScope(notifier: host, child: child!),
          onGenerateRoute: (_) =>
              CupertinoPageRoute<void>(builder: (_) => const SwarmPage()),
        ),
      );
      await tester.pumpAndSettle();
    }

    Finder key(String value) => find.byKey(ValueKey(value));
    Finder title(String text) => find.descendant(
      of: key('swarm-title-button'),
      matching: find.text(text),
    );

    /// Holds the Swarm's row in the switcher, from Home's title.
    Future<void> hold(WidgetTester tester) async {
      await tester.tap(key('swarm-title-button'));
      await tester.pumpAndSettle();
      await tester.longPress(key('swarm-switch-$tab'));
      await tester.pumpAndSettle();
    }

    /// Rename Swarm, from the Swarm's menu.
    Future<void> open(WidgetTester tester) async {
      await hold(tester);
      await tester.tap(find.text('Rename Swarm'));
      await tester.pumpAndSettle();
      expect(key('swarm-rename-name'), findsOneWidget);
    }

    /// Half a second of frames, for a screen that cannot settle.
    Future<void> frames(WidgetTester tester) async {
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    String field(WidgetTester tester) =>
        tester.widget<TextField>(key('swarm-rename-name')).controller!.text;

    VoidCallback? save(WidgetTester tester) =>
        tester.widget<SwarmButton>(key('swarm-rename-save')).onPressed;

    testWidgets("holding the Swarm's row closes the switcher for its menu, "
        'Rename Swarm under its name', (tester) async {
      await pump(tester);
      await hold(tester);

      expect(key('swarm-switch-join'), findsNothing, reason: 'it closed');
      expect(find.text('Phone Swarm'), findsWidgets);
      expect(find.text('Rename Swarm'), findsOneWidget);
    });

    testWidgets('a viewer holds a slow tap: no menu', (tester) async {
      await pump(tester, as: 'viewer');
      await hold(tester);

      expect(find.text('Rename Swarm'), findsNothing);
      expect(key('swarm-rename-name'), findsNothing);
      expect(title('Phone Swarm'), findsOneWidget);
    });

    testWidgets('opens on the name, all of it selected, as the desktop does', (
      tester,
    ) async {
      await pump(tester);
      await open(tester);

      expect(find.text('Rename Swarm'), findsOneWidget);
      final controller = tester
          .widget<TextField>(key('swarm-rename-name'))
          .controller!;
      expect(controller.text, 'Phone Swarm');
      expect(
        controller.selection,
        const TextSelection(baseOffset: 0, extentOffset: 11),
      );
    });

    testWidgets('Save closes at once and Home says the new name before the '
        'server answers; it stays once it has', (tester) async {
      await pump(tester);
      await open(tester);
      wait = Completer<void>();

      await tester.enterText(key('swarm-rename-name'), '  Lamp  ');
      await tester.pump();
      await tester.tap(key('swarm-rename-save'));
      await tester.pumpAndSettle();

      expect(key('swarm-rename-name'), findsNothing, reason: 'it closed');
      expect(title('Lamp'), findsOneWidget);
      expect(renames(fake), [
        {'type': 'tab.rename', 'name': 'Lamp'},
      ]);

      wait!.complete();
      await tester.pumpAndSettle();
      expect(title('Lamp'), findsOneWidget);
      expect(key('swarm-rename-failed'), findsNothing);

      // The switcher says it too.
      await tester.tap(key('swarm-title-button'));
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: key('swarm-switch-$tab'),
          matching: find.text('Lamp'),
        ),
        findsOneWidget,
      );
    });

    testWidgets("a refusal brings the old name back and says why at the "
        'foot of Home', (tester) async {
      await pump(tester);
      await open(tester);
      wait = Completer<void>();
      refuse = const SuperTabFailure(
        'READ_ONLY',
        'This Super Tab is read-only for you.',
        statusCode: 403,
      );

      await tester.enterText(key('swarm-rename-name'), 'Lamp');
      await tester.pump();
      await tester.tap(key('swarm-rename-save'));
      await tester.pumpAndSettle();
      expect(title('Lamp'), findsOneWidget, reason: 'at once');

      wait!.complete();
      await tester.pumpAndSettle();
      expect(title('Phone Swarm'), findsOneWidget);
      expect(
        find.descendant(
          of: key('swarm-rename-failed'),
          matching: find.text('This Super Tab is read-only for you.'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('a call lost on the way: the old name, and the desktop\'s '
        'words', (tester) async {
      await pump(tester);
      await open(tester);
      refuse = StateError('socket closed');

      await tester.enterText(key('swarm-rename-name'), 'Lamp');
      await tester.pump();
      await tester.tap(key('swarm-rename-save'));
      await tester.pumpAndSettle();

      expect(title('Phone Swarm'), findsOneWidget);
      expect(find.text('Could not rename the Swarm.'), findsOneWidget);
    });

    testWidgets('an empty name: Save is off, and Done says why', (
      tester,
    ) async {
      await pump(tester);
      await open(tester);

      await tester.enterText(key('swarm-rename-name'), '   ');
      await tester.pump();
      expect(save(tester), isNull);

      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: key('swarm-rename-error'),
          matching: find.text('Name cannot be empty'),
          matchRoot: true,
        ),
        findsOneWidget,
      );
      expect(key('swarm-rename-name'), findsOneWidget, reason: 'still open');
      expect(renames(fake), isEmpty);

      await tester.enterText(key('swarm-rename-name'), 'L');
      await tester.pump();
      expect(key('swarm-rename-error'), findsNothing, reason: 'typing clears');
      expect(save(tester), isNotNull);
    });

    testWidgets('the field takes at most 80 characters', (tester) async {
      await pump(tester);
      await open(tester);

      await tester.enterText(key('swarm-rename-name'), 'x' * 100);
      await tester.pump();
      expect(field(tester), 'x' * 80);
    });

    testWidgets('Cancel, or the name it had, sends nothing', (tester) async {
      await pump(tester);
      await open(tester);
      await tester.tap(key('swarm-rename-cancel'));
      await tester.pumpAndSettle();
      expect(key('swarm-rename-name'), findsNothing);

      await open(tester);
      await tester.tap(key('swarm-rename-save'));
      await tester.pumpAndSettle();
      expect(key('swarm-rename-name'), findsNothing);
      expect(renames(fake), isEmpty);
      expect(title('Phone Swarm'), findsOneWidget);
    });

    testWidgets('it goes once the Swarm can no longer be read', (tester) async {
      await pump(tester);
      await open(tester);

      host.session!.inbox.reader(tab)!.revoke();
      // Home's placeholders breathe once the read is taken away.
      await frames(tester);

      expect(key('swarm-rename-name'), findsNothing);
      expect(renames(fake), isEmpty);
    });

    testWidgets("the Swarm's menu goes once the Swarm can no longer be read", (
      tester,
    ) async {
      await pump(tester);
      await hold(tester);
      expect(find.text('Rename Swarm'), findsOneWidget);

      host.session!.inbox.reader(tab)!.revoke();
      await frames(tester);

      expect(find.text('Rename Swarm'), findsNothing);
    });

    testWidgets('with the keyboard up, the field, its error and Save stay '
        'above the keys', (tester) async {
      await pump(tester);
      await open(tester);

      const keyboard = 300.0;
      tester.view.viewInsets = const FakeViewPadding(bottom: keyboard * 3);
      await tester.pumpAndSettle();
      await tester.enterText(key('swarm-rename-name'), '   ');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull, reason: 'nothing overflows');
      const above = 844 - keyboard;
      for (final k in [
        'swarm-rename-name',
        'swarm-rename-error',
        'swarm-rename-save',
      ]) {
        final rect = tester.getRect(key(k));
        expect(rect.bottom, lessThanOrEqualTo(above), reason: k);
        expect(rect.top, greaterThanOrEqualTo(0), reason: k);
      }
      expect(
        tester.getSize(key('swarm-rename-save')).height,
        greaterThanOrEqualTo(44),
      );
    });
  });
}
