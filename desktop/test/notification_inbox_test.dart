import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/agent_git_context.dart';
import 'package:harness/core/models.dart';
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/notification_inbox.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/notification_inbox.dart';
import 'package:harness/widgets/workspace_notifications_button.dart';

import 'support/real_fonts.dart';
import 'swarm_attention_test.dart' show waitingQuestion;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;
import 'workspace_activity_test.dart' as activity;

void main() {
  final capture = Platform.environment['HARNESS_NOTIFICATION_CAPTURE_DIR'];
  final bell = find.byKey(const ValueKey('workspace-notifications-button'));
  final inbox = find.byKey(const ValueKey('notification-inbox'));
  Finder row(String agent) => find.byKey(ValueKey('notification:m/$agent'));

  Future<void> captureWorkspace(WidgetTester tester, String path) async {
    final oldShadows = debugDisableShadows;
    final view = tester.binding.renderViews.first;
    void repaint(RenderObject object) {
      object.markNeedsPaint();
      object.visitChildren(repaint);
    }

    try {
      debugDisableShadows = false;
      repaint(view);
      await tester.pumpAndSettle();
      await activity.captureWorkspace(tester, path);
    } finally {
      debugDisableShadows = oldShadows;
      repaint(view);
      await tester.pump();
    }
  }

  setUpAll(() async {
    await (FontLoader('packages/lucide_icons_flutter/Lucide')..addFont(
          rootBundle.load('packages/lucide_icons_flutter/assets/lucide.ttf'),
        ))
        .load();
    if (capture != null && Platform.isMacOS) {
      for (final (family, path) in [
        ('SF Mono', '/System/Library/Fonts/SFNSMono.ttf'),
        ('.AppleSystemUIFontMonospaced', '/System/Library/Fonts/SFNSMono.ttf'),
        ('Menlo', '/System/Library/Fonts/Menlo.ttc'),
        ('Apple Symbols', '/System/Library/Fonts/Apple Symbols.ttf'),
        ('.AppleSystemUIFont', '/System/Library/Fonts/SFNS.ttf'),
        ('Roboto', '/System/Library/Fonts/Supplemental/Arial.ttf'),
      ]) {
        final bytes = ByteData.sublistView(await File(path).readAsBytes());
        await (FontLoader(family)..addFont(Future.value(bytes))).load();
      }
    } else {
      await loadRealFonts();
    }
  });

  test(
    'keeps all nine results and questions, including restored questions',
    () {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      for (var i = 0; i < 9; i++) {
        final kind = i < 2
            ? AlertKind.done
            : i < 4
            ? AlertKind.failed
            : AlertKind.needsYou;
        app.agentUnread.mark('m', 'a$i', kind);
        app.rememberOpenedHarness('m', 'a$i');
        if (i >= 4) {
          app.stateOf('m')!.blockedAgents['a$i'] = waitingQuestion('a$i');
        }
      }
      final rows = notificationInbox(app);
      expect(rows, hasLength(9));
      expect(rows.where((r) => r.kind == AlertKind.needsYou), hasLength(5));
      expect(rows.where((r) => r.kind == AlertKind.failed), hasLength(2));
      expect(rows.where((r) => r.kind == AlertKind.done), hasLength(2));
      expect(rows.every((r) => r.unavailable == null), isTrue);
      app.agentUnread.clearAll();
      expect(
        notificationInbox(app),
        hasLength(5),
        reason: 'live questions survive missing unread marks',
      );
      app.stateOf('m')!.blockedAgents.clear();
      app.agentUnread.mark('m', 'a4', AlertKind.needsYou);
      expect(
        notificationInbox(app),
        isEmpty,
        reason: 'a closed question is not actionable',
      );
    },
  );

  test('notification context follows the current checkout and omits unknown fields', () {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final machine = app.stateOf('m')!;
    machine.agents = [
      const Agent(
        id: 'a0',
        name: 'Build notifications',
        project: AgentProject(
          name: 'old-checkout',
          cwd: '/work/old',
          root: '/work/old',
          remote: 'https://github.com/example/legacy.git',
          branch: 'old-branch',
        ),
        gitContext: AgentGitContext(
          state: 'single',
          current: AgentProject(
            name: 'generated-worktree',
            cwd: '/work/current',
            root: '/work/current',
            remote: 'https://github.com/example/openharness.git',
            branch: 'desktop-notifications',
          ),
        ),
      ),
      const Agent(id: 'a1', name: 'Choose a design'),
      const Agent(id: 'a2', name: 'No project'),
    ];
    machine.localProjects = const {
      'a1': AgentProject(
        name: 'website',
        cwd: '/work/website',
        branch: 'new-home',
      ),
    };
    machine.blockedAgents['a1'] = waitingQuestion(
      'a1',
      prompt: 'Which design?',
    );
    app.agentUnread.mark('m', 'a0', AlertKind.done);
    app.agentUnread.mark('m', 'a1', AlertKind.needsYou);
    app.agentUnread.mark('m', 'a2', AlertKind.failed);
    final rows = {for (final row in notificationInbox(app)) row.agentId: row};
    expect(rows['a0']!.title, 'Build notifications');
    expect(rows['a0']!.detail, 'Test host  openharness  desktop-notifications');
    expect(rows['a1']!.detail, 'Test host  website  new-home');
    expect(rows['a2']!.detail, 'Test host');
    machine.agents[0] = machine.agents[0].copyWith(
      gitContext: const AgentGitContext(state: 'unavailable'),
    );
    expect(
      notificationInbox(app).firstWhere((row) => row.agentId == 'a0').detail,
      'Test host  legacy  Git unavailable',
      reason: 'an unavailable checkout must not report the launch branch as current',
    );
  });

  test(
    'completed results are acknowledged independently of questions',
    () async {
      final app = createApp(connected: true)..watchedAgents = () => const [];
      addTearDown(app.dispose);
      await app.handleEventForTest('m', {
        'type': 'turn_summary',
        'agentId': 'a0',
        'payload': {
          'notification': {'id': 'result-a0', 'kind': 'done'},
        },
      });
      expect(app.agentUnread.kindFor('m', 'a0'), AlertKind.done);
      expect(notificationInbox(app).single.label, 'Finished');
      app.stateOf('m')!.blockedAgents['a1'] = waitingQuestion('a1');
      app.agentUnread.mark('m', 'a1', AlertKind.needsYou);
      app.markAgentSeen('m', 'a0');
      app.markAgentSeen('m', 'a1');
      expect(notificationInbox(app).single.agentId, 'a1');
      await app.handleEventForTest('m', {
        'type': 'commander_question_close',
        'agentId': 'a1',
        'payload': {'requestId': 'question'},
      });
      expect(notificationInbox(app), isEmpty);
    },
  );

  for (final native in [false, true]) {
    testWidgets(
      'bell opens the list; a result reuses its tab and question stays pending (native=$native)',
      (tester) async {
        final updates = <Map>[];
        const channel = MethodChannel('harness/swarm_tabs');
        final messenger = tester.binding.defaultBinaryMessenger;
        messenger.setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'update') updates.add(call.arguments as Map);
          return true;
        });
        addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
        final app = createApp(connected: true);
        final resultTab = app.activeSwarmId;
        final result = app.adoptSessionForTest(terminal('a8', []));
        app.newSwarm(name: 'Desktop');
        app.adoptSessionForTest(terminal('a0', []));
        app.agentUnread.mark('m', 'a8', AlertKind.failed);
        app.stateOf('m')!.blockedAgents['a9'] = waitingQuestion('a9');
        app.agentUnread.mark('m', 'a9', AlertKind.needsYou);
        await mount(tester, app, nativeTabs: native);
        await tester.pumpAndSettle();

        Future<void> open() async {
          if (native) {
            final done = Completer<void>();
            messenger.handlePlatformMessage(
              channel.name,
              const StandardMethodCodec().encodeMethodCall(
                const MethodCall('notificationInbox'),
              ),
              (_) => done.complete(),
            );
            await tester.pumpAndSettle();
            expect(done.isCompleted, isTrue);
          } else {
            await tester.tap(bell);
            await tester.pumpAndSettle();
          }
        }

        expect(
          native
              ? updates.last['unread']
              : tester.widget<WorkspaceNotificationsButton>(bell).count,
          2,
        );
        await open();
        expect(inbox, findsOneWidget);
        expect(
          app.agentUnread.count,
          2,
          reason: 'opening the list does not acknowledge its entries',
        );
        await tester.tap(row('a8'));
        await tester.pumpAndSettle();
        expect(inbox, findsNothing);
        expect(app.activeSwarmId, resultTab);
        expect(app.focusedPane, same(result));
        expect(app.allPanes.where((p) => p.agentId == 'a8'), hasLength(1));
        expect(app.agentUnread.kindFor('m', 'a8'), isNull);
        await open();
        await tester.tap(row('a9'));
        await tester.pumpAndSettle();
        expect(inbox, findsNothing);
        expect(app.focusedPane?.agentId, 'a9');
        expect(app.agentUnread.kindFor('m', 'a9'), isNull);
        expect(app.questionFor('m', 'a9'), isNotNull);
        expect(notificationInbox(app), isEmpty);
        await open();
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(inbox, findsNothing);
        expect(app.agentUnread.count, 0);
        await tester.pump(const Duration(milliseconds: 350));
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }

  testWidgets(
    'unavailable rows remain, navigation failure retains unread, and new rows append',
    (tester) async {
      final app = createApp(connected: true);
      app.agentUnread.mark('m', 'a0', AlertKind.failed);
      app.agentUnread.mark('m', 'a1', AlertKind.done);
      var attempts = 0;
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => unawaited(
                  showNotificationInbox(
                    context,
                    app: app,
                    onOpen: (_) async {
                      attempts++;
                      return false;
                    },
                  ),
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      final top = tester.getTopLeft(row('a1'));
      app.agentUnread.mark('m', 'a2', AlertKind.done);
      await tester.pump();
      expect(
        tester.getTopLeft(row('a1')),
        top,
        reason: 'arrivals cannot move a row under the pointer',
      );
      expect(
        tester.getTopLeft(row('a2')).dy,
        greaterThan(tester.getTopLeft(row('a0')).dy),
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(attempts, 1);
      expect(
        find.text('Could not open this harness. Try again.'),
        findsOneWidget,
      );
      expect(app.agentUnread.kindFor('m', 'a0'), AlertKind.failed);
      app.stateOf('m')!.nodeOnline = false;
      app.agentUnread.mark('m', 'a3', AlertKind.done);
      await tester.pump();
      expect(find.text('⊘'), findsWidgets);
      expect(find.byTooltip('Failed · Offline'), findsOneWidget);
      await tester.tap(row('a0'));
      await tester.pump();
      expect(attempts, 1, reason: 'offline notification cannot navigate');
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(
        inbox,
        findsNothing,
        reason: 'the close control remains keyboard accessible',
      );
      expect(app.agentUnread.count, 4);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets('nine notifications fit the toolbar popup and narrow windows', (
    tester,
  ) async {
    final app = createApp(connected: true);
    app.renameSwarm(app.activeSwarmId, 'desktop');
    app.adoptSessionForTest(terminal('a69', [])..agentName = 'Desktop polish');
    final machine = app.stateOf('m')!;
    const names = [
      'Authentication',
      'Documentation',
      'Reconnect tests',
      'Linux build',
      'Desktop layout',
      'Search results',
      'Device firmware',
      'API integration',
      'Release notes',
    ];
    machine.agents = [
      ...machine.agents.where(
        (a) => !names.asMap().containsKey(int.tryParse(a.id.substring(1))),
      ),
      for (var i = 0; i < names.length; i++)
        Agent(
          id: 'a$i',
          name: names[i],
          engine: 'codex',
          terminalAvailable: true,
          project: AgentProject(
            name: 'preview-$i',
            cwd: '/work/preview-$i',
            root: '/work/preview-$i',
            remote: 'https://github.com/example/openharness.git',
            branch: names[i].toLowerCase().replaceAll(' ', '-'),
          ),
        ),
    ];
    for (var i = 0; i < 9; i++) {
      final kind = i < 2
          ? AlertKind.done
          : i < 4
          ? AlertKind.failed
          : AlertKind.needsYou;
      app.agentUnread.mark('m', 'a$i', kind);
      if (i >= 4) {
        machine.blockedAgents['a$i'] = waitingQuestion(
          'a$i',
          prompt: 'Which approach should I use?',
        );
      }
    }
    await mount(tester, app);
    await tester.tap(bell);
    await tester.pumpAndSettle();
    expect(find.text('Notifications'), findsOneWidget);
    expect(
      find.descendant(of: inbox, matching: find.text('9')),
      findsOneWidget,
    );
    expect(find.byTooltip('Close notifications'), findsOneWidget);
    expect(tester.getSize(inbox).width, 440);
    expect(find.byTooltip('Needs input'), findsWidgets);
    expect(find.byTooltip('Failed'), findsWidgets);
    expect(find.text('Test host  openharness  release-notes'), findsOneWidget);
    expect(find.text('Which approach should I use?'), findsNothing);
    expect(tester.takeException(), isNull);
    if (capture != null) {
      await tester.runAsync(() => Directory(capture).create(recursive: true));
      await captureWorkspace(tester, '$capture/desktop-notifications.png');
    }
    tester.view.physicalSize = const Size(640, 480);
    terminalThemeStore.value = TerminalThemeChoice.tango;
    await tester.pump();
    expect(tester.takeException(), isNull);
    // Keyboard navigation scrolls all the way to the last result.
    for (var i = 0; i < 9; i++) {
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pump();
    }
    await tester.pumpAndSettle();
    expect(row('a0').hitTestable(), findsOneWidget);
    if (capture != null) {
      await captureWorkspace(
        tester,
        '$capture/desktop-notifications-narrow.png',
      );
    }
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    terminalThemeStore.value = TerminalThemeChoice.matchApp;
    await tester.pump(const Duration(milliseconds: 350));
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  for (final brightness in Brightness.values) {
    testWidgets(
      'desktop inbox fits enlarged text and live states in ${brightness.name}',
      (tester) async {
        final app = createApp(connected: true);
        addTearDown(app.dispose);
        final oldBrightness = grid.AppTheme.brightness.value;
        final oldFont = terminalFontStore.value;
        addTearDown(() {
          grid.AppTheme.brightness.value = oldBrightness;
          terminalFontStore.value = oldFont;
        });
        grid.AppTheme.brightness.value = brightness;
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(480, 420);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetPhysicalSize);
        final machine = app.stateOf('m')!;
        machine.agents = const [
          Agent(
            id: 'a0',
            name: 'Review the long onboarding flow for the product website',
            terminalAvailable: true,
            project: AgentProject(
              name: 'product-website',
              cwd: '/work/product-website',
              branch: 'onboarding-review',
            ),
          ),
          Agent(
            id: 'a1',
            name: 'Choose a homepage direction',
            terminalAvailable: true,
            project: AgentProject(
              name: 'website',
              cwd: '/work/website',
              branch: 'new-home',
            ),
          ),
        ];
        app.agentUnread.mark('m', 'a0', AlertKind.done);
        machine.blockedAgents['a1'] = waitingQuestion('a1');
        app.agentUnread.mark('m', 'a1', AlertKind.needsYou);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: const TextScaler.linear(1.6)),
              child: child!,
            ),
            home: Builder(
              builder: (context) => Scaffold(
                body: TextButton(
                  onPressed: () => unawaited(
                    showNotificationInbox(
                      context,
                      app: app,
                      topInset: 40,
                      onOpen: (_) async => false,
                    ),
                  ),
                  child: const Text('Open inbox'),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Open inbox'));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(tester.getRect(inbox).right, 464);
        expect(tester.getRect(inbox).top, 56);
        expect(tester.getSize(inbox).width, 440);
        expect(find.byType(DesktopDialogSurface), findsOneWidget);
        expect(app.agentUnread.count, 2);
        final title = tester.widget<Text>(
          find.text('Choose a homepage direction'),
        );
        expect(title.style!.fontFamily, grid.AppType.sansFamily);
        final header = tester.widget<Text>(find.text('Notifications'));
        expect(header.style!.fontFamily, grid.AppType.sansFamily);
        final before = tester.getSize(inbox);
        final rowBefore = tester.getSize(row('a0'));
        terminalFontStore.value = oldFont.copyWith(fontSize: 30);
        await tester.pumpAndSettle();
        expect(tester.getSize(inbox), before);
        expect(tester.getSize(row('a0')), rowBefore);

        if (capture != null) {
          await tester.runAsync(
            () => Directory(capture).create(recursive: true),
          );
          await captureWorkspace(
            tester,
            '$capture/desktop-notifications-${brightness.name}-enlarged.png',
          );
        }
        await tester.tap(row('a0'));
        await tester.pumpAndSettle();
        expect(
          find.text('Could not open this harness. Try again.'),
          findsOneWidget,
        );
        expect(app.agentUnread.count, 2);
        expect(tester.takeException(), isNull);
        if (capture != null) {
          await captureWorkspace(
            tester,
            '$capture/desktop-notifications-${brightness.name}-error.png',
          );
        }
        machine.blockedAgents.clear();
        app.agentUnread.clearAll();
        await tester.pumpAndSettle();
        expect(find.text('No notifications'), findsOneWidget);
        expect(
          find.text('Could not open this harness. Try again.'),
          findsNothing,
        );
        expect(find.byTooltip('Close notifications'), findsOneWidget);
        expect(tester.takeException(), isNull);
        if (capture != null) {
          await captureWorkspace(
            tester,
            '$capture/desktop-notifications-${brightness.name}-empty.png',
          );
        }
        await tester.tap(find.byTooltip('Close notifications'));
        await tester.pumpAndSettle();
        expect(inbox, findsNothing);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}
