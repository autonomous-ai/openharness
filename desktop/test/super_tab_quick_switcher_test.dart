import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'swarm_screen_test.dart' show mount;
import 'keymap_host_test.dart' show key, MemoryKeymap, terminalKeymapHost;
import 'support/super_tab_fixture.dart';

import 'package:harness/super_tabs/controller.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/screens/swarm_screen.dart';

import 'support/capture.dart';
import 'keymap_runtime_test.dart' show native;

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_commands.dart';

Future<(SuperTabLaunchFixture, SuperTabController)> setup(
  WidgetTester tester, {
  bool nativeTabs = false,
}) async {
  final f = SuperTabLaunchFixture(local: true);
  final groups = f.connection.server.state['conversations'] as List;
  groups.addAll(<Map<String, dynamic>>[
    {
      ...conversationFixture('release', 'Release checklist'),
      'number': 42,
      'lastMessageSequence': 8,
    },
    {
      ...conversationFixture('archive', 'Old migration'),
      'number': 7,
      'archived': true,
    },
    {
      ...conversationFixture('secret', 'Private payroll'),
      'audience': {
        'people': [
          {'id': 'other'},
        ],
      },
    },
    {
      ...conversationFixture('buddy-other', 'Other Buddy'),
      'kind': 'buddy',
      'buddyOwnerId': 'other',
    },
    {
      ...conversationFixture('buddy-mine', 'My Buddy'),
      'kind': 'buddy',
      'buddyOwnerId': 'owner',
    },
  ]);
  f.connection.server.state['agents'] = [
    {
      'id': 'casey',
      'name': 'Builder',
      'displayName': 'Casey',
      'projectId': 'lead',
      'machineId': 'm1',
      'harnessId': 'casey-harness',
      'contributorId': 'owner',
      'configuration': {'engine': 'claude', 'model': 'opus'},
    },
    {
      'id': 'private-buddy',
      'name': 'Hidden Buddy',
      'projectId': 'lead',
      'machineId': 'm1',
      'harnessId': 'buddy-harness',
      'contributorId': 'other',
      'buddyOf': {'personId': 'other'},
      'configuration': {'engine': 'claude', 'model': 'opus'},
    },
  ];
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
  final c = await f.app.superTabs.open(tabId);
  await c.refresh();
  await mount(tester, f.app, nativeTabs: nativeTabs);
  await tester.tap(find.byKey(const ValueKey('super-message-composer')));
  await tester.pump();
  return (f, c);
}

Future<void> close(
  WidgetTester tester,
  SuperTabLaunchFixture f,
  SuperTabController c,
) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  f.dispose();
}

Future<void> open(WidgetTester tester) async {
  await key(tester, LogicalKeyboardKey.keyK, cmd: true);
  await tester.pumpAndSettle();
  expect(find.byKey(const ValueKey('swarm-quick-query')), findsOneWidget);
}

void main() {
  testWidgets('Cmd+K opens and Escape restores the Swarm composer', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture(local: true);
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    await mount(tester, f.app);
    final composer = find.byKey(const ValueKey('super-message-composer'));
    await tester.tap(composer);
    await tester.pump();
    final before = FocusManager.instance.primaryFocus;
    await key(tester, LogicalKeyboardKey.keyK, cmd: true);
    await tester.pumpAndSettle();
    expect(find.text('Switch conversation'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('Switch conversation'), findsNothing);
    expect(FocusManager.instance.primaryFocus, same(before));
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.dispose();
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  testWidgets(
    'filters fuzzily, opens workgroup number, and arrows choose a result',
    (tester) async {
      final (f, c) = await setup(tester);
      await open(tester);
      final query = find.byKey(const ValueKey('swarm-quick-query'));
      await tester.enterText(query, 'rls chck');
      await tester.pump();
      expect(
        find.byKey(const ValueKey('swarm-quick-conversation:release')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('swarm-quick-conversation:offline')),
        findsNothing,
      );
      await tester.enterText(query, '42');
      await tester.pump();
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(c.selectedId, 'release');
      await open(tester);
      await key(tester, LogicalKeyboardKey.arrowDown);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(c.selectedId, 'lead');
      await open(tester);
      await tester.enterText(query, '');
      await tester.pump();
      await key(tester, LogicalKeyboardKey.arrowDown);
      await key(tester, LogicalKeyboardKey.arrowUp);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(c.selectedId, 'lead');
      await close(tester, f, c);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  testWidgets(
    'recents first, unread bold, hidden chats absent, archived only exact',
    (tester) async {
      final (f, c) = await setup(tester);
      await c.select('offline');
      await tester.pump();
      await c.select('release');
      await tester.pump();
      f.connection.server.append('New update', conversationId: 'offline');
      await c.refresh();
      await tester.pump();
      await open(tester);
      final unreadTitle = find.descendant(
        of: find.byKey(const ValueKey('swarm-quick-conversation:offline')),
        matching: find.text('Offline editing'),
      );
      expect(
        tester.widget<Text>(unreadTitle).style!.fontWeight,
        grid.AppFont.semibold,
      );
      final rows = tester
          .widgetList<InkWell>(
            find.byWidgetPredicate(
              (w) => w is InkWell && w.key.toString().contains('swarm-quick-'),
            ),
          )
          .toList();
      expect(rows.take(2).map((w) => w.key), [
        const ValueKey('swarm-quick-conversation:release'),
        const ValueKey('swarm-quick-conversation:offline'),
      ]);
      expect(
        find.byKey(const ValueKey('swarm-quick-conversation:secret')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('swarm-quick-conversation:buddy-other')),
        findsNothing,
      );
      expect(find.text('My Buddy'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('swarm-quick-conversation:archive')),
        findsNothing,
      );
      final query = find.byKey(const ValueKey('swarm-quick-query'));
      await tester.enterText(query, 'Old');
      await tester.pump();
      expect(
        find.byKey(const ValueKey('swarm-quick-conversation:archive')),
        findsNothing,
      );
      await tester.enterText(query, '#7');
      await tester.pump();
      expect(
        find.byKey(const ValueKey('swarm-quick-conversation:archive')),
        findsOneWidget,
      );
      await key(tester, LogicalKeyboardKey.escape);
      await close(tester, f, c);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  testWidgets(
    '500 conversations filter and keyboard selection reveal the last result',
    (tester) async {
      final (f, c) = await setup(tester);
      final groups = f.connection.server.state['conversations'] as List;
      for (var i = 0; i < 500; i++) {
        groups.add({
          ...conversationFixture(
            'scale-$i',
            'Task ${i.toString().padLeft(3, '0')}',
          ),
          'number': i + 1000,
        });
      }
      await c.refresh();
      await tester.pump();
      await open(tester);
      final query = find.byKey(const ValueKey('swarm-quick-query'));
      final watch = Stopwatch()..start();
      await tester.enterText(query, '1499');
      await tester.pump();
      watch.stop();
      expect(
        find.byKey(const ValueKey('swarm-quick-conversation:scale-499')),
        findsOneWidget,
      );
      expect(watch.elapsedMilliseconds, lessThan(1000));
      debugPrint(
        '500 conversations: filter and frame ${watch.elapsedMilliseconds} ms',
      );
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(c.selectedId, 'scale-499');
      await close(tester, f, c);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  testWidgets(
    'live revocation removes all switcher content and cannot open a stale row',
    (tester) async {
      final (f, c) = await setup(tester);
      await open(tester);
      c.revokeAccess('Membership ended');
      await tester.pump();
      expect(
        find.byKey(const ValueKey('swarm-quick-conversation:lead')),
        findsNothing,
      );
      expect(find.text('This Swarm is no longer available.'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.enter);
      expect(c.selectedId, 'lead');
      await key(tester, LogicalKeyboardKey.escape);
      await close(tester, f, c);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  testWidgets('native picker commands move and open a conversation', (
    tester,
  ) async {
    const channel = MethodChannel('harness/swarm_tabs');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      channel,
      (_) async => true,
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );
    final (f, c) = await setup(tester, nativeTabs: true);
    await tester.tap(find.byKey(const ValueKey('super-message-composer')));
    await native(tester, 'keymapCommand', {'command': 'swarm.quick_switcher'});
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('swarm-quick-query')), findsOneWidget);
    await tester.enterText(
      find.byKey(const ValueKey('swarm-quick-query')),
      '42',
    );
    await tester.pump();
    await native(tester, 'keymapCommand', {'command': 'picker.accept'});
    await tester.pumpAndSettle();
    expect(c.selectedId, 'release');
    await close(tester, f, c);
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  testWidgets(
    'recent conversations survive leaving and returning to the Swarm tab',
    (tester) async {
      final (f, c) = await setup(tester);
      final tab = f.app.activeSwarmId;
      await c.select('offline');
      await tester.pump();
      await c.select('release');
      await tester.pump();
      f.app.newSwarm(name: 'Other work');
      await tester.pump();
      f.app.selectSwarm(tab);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-message-composer')));
      await open(tester);
      await key(tester, LogicalKeyboardKey.arrowDown);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(c.selectedId, 'offline');
      await close(tester, f, c);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  testWidgets('terminal focus retains its existing Cmd+K action', (
    tester,
  ) async {
    final map = MemoryKeymap();
    final focus = FocusNode();
    var above = 0, switched = 0;
    await tester.pumpWidget(
      terminalKeymapHost(
        map,
        {
          'pane.focus_above': () => above++,
          'swarm.quick_switcher': () => switched++,
        },
        Focus(focusNode: focus, autofocus: true, child: const Text('Terminal')),
        terminalFocusNode: focus,
      ),
    );
    await tester.pump();
    await key(tester, LogicalKeyboardKey.keyK, cmd: true);
    expect(above, 1);
    expect(switched, 0);
    expect(focus.hasFocus, isTrue);
    await tester.pumpWidget(const SizedBox());
    focus.dispose();
    map.dispose();
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  for (final platform in [TargetPlatform.windows, TargetPlatform.linux]) {
    testWidgets('Ctrl+K opens the Swarm switcher on $platform', (tester) async {
      final (f, c) = await setup(tester);
      await key(tester, LogicalKeyboardKey.keyK, ctrl: true);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('swarm-quick-query')), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await close(tester, f, c);
    }, variant: TargetPlatformVariant.only(platform));
  }

  testWidgets(
    'people and agents open existing details without creating a chat',
    (tester) async {
      final (f, c) = await setup(tester);
      final before = f.connection.server.posts.length;
      await open(tester);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-quick-query')),
        'Casey',
      );
      await tester.pump();
      expect(
        find.byKey(const ValueKey('swarm-quick-agent:private-buddy')),
        findsNothing,
      );
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(find.text('Casey'), findsWidgets);
      expect(f.connection.server.posts.length, before);
      await key(tester, LogicalKeyboardKey.escape);
      await close(tester, f, c);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  testWidgets(
    'revoked private chat drops out live while the Swarm stays open',
    (tester) async {
      final (f, c) = await setup(tester);
      await open(tester);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-quick-query')),
        '42',
      );
      await tester.pump();
      expect(
        find.byKey(const ValueKey('swarm-quick-conversation:release')),
        findsOneWidget,
      );
      final group = (f.connection.server.state['conversations'] as List)
          .cast<Map>()
          .singleWhere((g) => g['id'] == 'release');
      group['audience'] = {
        'people': [
          {'id': 'other'},
        ],
      };
      f.connection.server.revision++;
      await c.refresh();
      await tester.pump();
      expect(
        find.byKey(const ValueKey('swarm-quick-conversation:release')),
        findsNothing,
      );
      expect(find.text('No matches'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.enter);
      expect(c.selectedId, 'lead');
      await key(tester, LogicalKeyboardKey.escape);
      await close(tester, f, c);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  testWidgets(
    'a person detail opened by the picker loses content on account revocation',
    (tester) async {
      final (f, c) = await setup(tester);
      (f.connection.server.state['people'] as List).add({
        'id': 'teammate',
        'email': 'teammate@example.com',
        'role': 'collaborator',
      });
      f.connection.server.revision++;
      await c.refresh();
      await tester.pump();
      await open(tester);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-quick-query')),
        'teammate',
      );
      await tester.pump();
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(
        find.text('teammate@example.com · Can collaborate'),
        findsOneWidget,
      );
      c.revokeAccess('The account changed.');
      await tester.pump();
      expect(find.text('teammate@example.com · Can collaborate'), findsNothing);
      await key(tester, LogicalKeyboardKey.escape);
      await close(tester, f, c);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  for (final held in [true, false]) {
    testWidgets(
      'Product Managers channel follows sidebar visibility (held=$held)',
      (tester) async {
        final (f, c) = await setup(tester);
        f.connection.server.state['leadsConversationId'] = 'managers';
        if (held) {
          (f.connection.server.state['conversations'] as List).add({
            ...conversationFixture('managers', 'Internal coordination title'),
            'kind': 'leads',
            'projectId': '',
          });
        }
        f.connection.server.revision++;
        await c.refresh();
        await tester.pump();
        expect(
          find.text('product-managers'),
          held ? findsOneWidget : findsNothing,
        );
        await open(tester);
        await tester.enterText(
          find.byKey(const ValueKey('swarm-quick-query')),
          'product-managers',
        );
        await tester.pump();
        expect(
          find.byKey(const ValueKey('swarm-quick-conversation:managers')),
          held ? findsOneWidget : findsNothing,
        );
        if (held) {
          expect(
            find.descendant(
              of: find.byKey(
                const ValueKey('swarm-quick-conversation:managers'),
              ),
              matching: find.text('product-managers'),
            ),
            findsOneWidget,
          );
          await key(tester, LogicalKeyboardKey.enter);
          await tester.pumpAndSettle();
          expect(c.selectedId, 'managers');
        } else {
          await key(tester, LogicalKeyboardKey.escape);
        }
        await close(tester, f, c);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );
  }

  final shots = Platform.environment['SWARM_QUICK_SWITCHER_SHOTS'];
  setUpAll(() => loadCaptureFonts(shots));
  for (final brightness in Brightness.values) {
    testWidgets(
      'switcher in ${brightness.name}, empty state and enlarged type',
      (tester) async {
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previous);
        final (f, c) = await setup(tester);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: SwarmScreen(notifier: f.app, nativeTabs: false),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('super-message-composer')));
        await open(tester);
        await captureWindow(tester, shots, 'switcher-${brightness.name}');
        final queryField = tester.widget<TextField>(
          find.byKey(const ValueKey('swarm-quick-query')),
        );
        queryField.controller!.value = const TextEditingValue(
          text: '42',
          composing: TextRange(start: 0, end: 2),
        );
        await tester.pump();
        await key(tester, LogicalKeyboardKey.enter);
        expect(find.byKey(const ValueKey('swarm-quick-query')), findsOneWidget);
        queryField.controller!.value = const TextEditingValue(text: '42');
        await tester.pump();
        await tester.enterText(
          find.byKey(const ValueKey('swarm-quick-query')),
          'zzzz no result',
        );
        await tester.pump();
        expect(find.text('No matches'), findsOneWidget);
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: const TextScaler.linear(2)),
              child: child!,
            ),
            home: SwarmScreen(notifier: f.app, nativeTabs: false),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('super-message-composer')));
        await open(tester);
        await captureWindow(tester, shots, 'switcher-${brightness.name}-large');
        expect(tester.takeException(), isNull);
        await key(tester, LogicalKeyboardKey.escape);
        await close(tester, f, c);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );
  }

  for (final platform in [
    TargetPlatform.macOS,
    TargetPlatform.windows,
    TargetPlatform.linux,
  ]) {
    test('Swarm switcher has a scoped default on $platform', () {
      debugDefaultTargetPlatformOverride = platform;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      final scope = KeymapContext.values
          .where((v) => v.name == 'swarmChat')
          .firstOrNull;
      expect(
        scope,
        isNotNull,
        reason: 'Swarm chat needs its own Cmd/Ctrl+K scope',
      );
      final key = KeyStroke.parse(
        platform == TargetPlatform.macOS ? 'cmd+k' : 'ctrl+k',
      );
      expect(
        harnessDefaultKeymap.match(scope!, [key]).command,
        'swarm.quick_switcher',
      );
      expect(
        harnessDefaultKeymap.match(KeymapContext.terminal, [key]).command,
        isNot('swarm.quick_switcher'),
      );
      expect(
        harnessDefaultKeymap.match(KeymapContext.workspace, [key]).command,
        isNot('swarm.quick_switcher'),
      );
    });
  }
}
