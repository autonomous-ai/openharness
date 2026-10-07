import 'dart:io';
import 'dart:ui' as ui;
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/shared/theme/prompt_style.dart';
import 'package:harness/shared/theme/status_line_style.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/state/workspace_status.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/usage/models_menu_controller.dart';
import 'package:harness/widgets/workspace_subscription_usage.dart';
import 'package:harness/widgets/desktop_search_panel.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:xterm/xterm.dart' show TerminalStyle;
import 'package:harness/widgets/grid_model_picker.dart';
import 'package:harness/widgets/workspace_bar_control.dart';
import 'package:harness/widgets/pane_header_text_button.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:harness/widgets/agent_drag.dart';
import 'package:harness/widgets/status_line.dart';
import 'package:harness/widgets/workspace_pull_request_label.dart';
import 'package:harness/shared/theme/pull_request_icon.dart';
import 'package:harness/widgets/pull_request_badge.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp, MemoryStore;
import 'swarm_screen_test.dart' show mount, terminal;
import 'support/real_fonts.dart';

class _FooterSubscriptions extends ModelsMenuController {
  List<Map<String, Object?>> values = [];
  @override
  List<Map<String, Object?>> get rows => values;
  @override
  Future<void> refresh() async {}
  void update(List<Map<String, Object?>> value) {
    values = value;
    notifyListeners();
  }
}

Map<String, Object?> subscription(
  String engine,
  String account,
  num? remaining, {
  String? status,
}) => {
  'engine': engine,
  'title': engine == 'claude' ? 'Anthropic' : 'OpenAI',
  'account': account,
  'remainingPercent': remaining,
  'status': status ?? '$remaining% remaining',
  'details': ['Weekly limit'],
};

class _PRConnection extends WsConn {
  _PRConnection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  int reads = 0;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'git_pull_request') return {};
    reads++;
    return {
      'status': 'found',
      'number': 298,
      'state': 'Merged',
      'url': 'https://github.com/acme/repo/pull/298',
    };
  }
}

/// A daemon that answers `window_name` from [replies] in order, the last one
/// for every question after it, and remembers what it was asked.
class _WindowNameConnection extends _PRConnection {
  final asked = <List<String>>[];
  final replies = <Map<String, dynamic>>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'window_name') {
      return super.request(type, payload: payload, timeout: timeout);
    }
    asked.add([...(payload['agentIds'] as List).cast<String>()]);
    if (replies.isEmpty) return {'name': null};
    return replies.length == 1 ? replies.first : replies.removeAt(0);
  }
}

class _PaneModelConnection extends _PRConnection {
  final retargets = <Map<String, dynamic>>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'agent_retarget') {
      retargets.add(payload);
      return {};
    }
    if (type == 'grid_models_list') {
      return {
        'gridName': 'fixture',
        'models': [
          {'id': 'Local-Test-Model', 'node': 'local', 'grid': 'fixture'},
        ],
      };
    }
    return super.request(type, payload: payload, timeout: timeout);
  }
}

Future<void> captureControls(
  WidgetTester tester,
  String name, {
  double? height,
}) async {
  final directory =
      Platform.environment['HARNESS_WORKSPACE_CONTROLS_CAPTURE_DIR'];
  if (directory == null) return;
  final view = tester.binding.renderViews.first;
  final layer = view.debugLayer! as OffsetLayer;
  await tester.runAsync(() async {
    final image = await layer.toImage(
      Rect.fromLTWH(0, 0, view.size.width, height ?? view.size.height),
    );
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    final file = File('$directory/$name.png');
    await file.parent.create(recursive: true);
    await file.writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  setUpAll(() async {
    if (Platform.environment['HARNESS_WORKSPACE_CONTROLS_CAPTURE_DIR'] !=
        null) {
      await loadRealFonts();
      await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
            rootBundle.load(
              'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
            ),
          ))
          .load();
      if (Platform.isMacOS) {
        await (FontLoader('Apple Symbols')..addFont(
              Future.value(
                ByteData.sublistView(
                  await File('/System/Library/Fonts/Apple Symbols.ttf')
                      .readAsBytes(),
                ),
              ),
            ))
            .load();
        final bytes = ByteData.sublistView(
          await File('/System/Library/Fonts/SFNSMono.ttf').readAsBytes(),
        );
        for (final family in ['SF Mono', '.AppleSystemUIFontMonospaced']) {
          await (FontLoader(family)..addFont(Future.value(bytes))).load();
        }
      }
    }
  });
  for (final brightness in Brightness.values) {
    for (final count in [4, 9]) {
      testWidgets('$count pane toolbars stay aligned in ${brightness.name}', (
        tester,
      ) async {
        final oldBrightness = grid.AppTheme.brightness.value;
        final oldPalette = grid.AppTheme.palette.value;
        grid.AppTheme.palette.value = brightness == Brightness.dark
            ? HarnessPalette.graphite
            : HarnessPalette.paper;
        addTearDown(() => grid.AppTheme.palette.value = oldPalette);
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = oldBrightness);
        final app = createApp();
        final names = [
          'Composer polish',
          'Review changes',
          'API cleanup',
          'Improve search',
          'Keyboard shortcuts',
          'Docs',
          'Release notes',
          'Test coverage',
          'Model picker',
        ];
        app.machineStates['m']!.localOnly = true;
        app.machineStates['m']!.nodeOnline = true;
        app.machineStates['m']!.agents = [
          for (var i = 0; i < count; i++)
            Agent.fromJson({
              'id': 'a$i',
              'name': names[i],
              'engine': i.isEven ? 'codex' : 'claude',
              'selectedModel': i.isEven
                  ? 'runtime-v1:a$i:codex:gpt-6-astra@high'
                  : 'runtime-v1:a$i:claude:fable@high',
              'terminal': {'available': true},
            }),
        ];
        for (var i = 0; i < count; i++) {
          final session = terminal('a$i', [])..agentName = names[i];
          session.terminal.write('~/code/harness\r\n\r\nReady.\r\n');
          app.adoptSessionForTest(session);
        }
        app.setPreset(count, count == 4 ? PanePreset.quad : PanePreset.cols3);
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(1560, 1000);
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: SwarmScreen(notifier: app),
          ),
        );
        await tester.pump(const Duration(milliseconds: 100));
        for (final pane in app.panes) {
          final cell = find.byKey(pane.cellKey);
          final selectors = find.descendant(
            of: cell,
            matching: find.byType(PaneHeaderTextButton),
          );
          expect(selectors, findsNWidgets(2));
          final labels = tester
              .widgetList<Text>(
                find.descendant(of: selectors, matching: find.byType(Text)),
              )
              .toList();
          for (final label in labels) {
            expect(label.style!.fontFamily, labels.first.style!.fontFamily);
            expect(label.style!.fontSize, 13);
            expect(label.style!.fontWeight, FontWeight.normal);
            expect(label.style!.height, labels.first.style!.height);
          }
          expect(labels[0].style!.fontWeight, FontWeight.normal);
          expect(
            find.descendant(of: selectors, matching: find.byType(Icon)),
            findsNothing,
          );
          final controls = [
            find.byKey(ValueKey(('pane-model', 'm', pane.agentId!))),
            find.descendant(of: cell, matching: find.byType(PaneCloseButton)),
          ];
          expect(find.byKey(const ValueKey('pane-zoom')), findsNothing);
          for (final key in ['pane-split-down', 'pane-split-right']) {
            expect(
              find
                  .descendant(of: cell, matching: find.byKey(ValueKey(key)))
                  .hitTestable(),
              findsNothing,
            );
          }
          for (var i = 1; i < controls.length; i++) {
            final previous = tester.getRect(controls[i - 1]);
            final rect = tester.getRect(controls[i]);
            expect(rect.left, greaterThanOrEqualTo(previous.right));
            expect(rect.center.dy, closeTo(previous.center.dy, .1));
            expect(rect.width, 28);
            expect(rect.height, greaterThanOrEqualTo(28));
          }
          final close = tester.getRect(controls.last);
          expect(close.right, lessThan(tester.getRect(cell).right));
        }
        expect(tester.takeException(), isNull);
        await tester.pump(const Duration(milliseconds: 100));
        await captureControls(tester, 'pane-toolbar-$count-${brightness.name}');
        final first = tester.getRect(find.byKey(app.panes.first.cellKey));
        final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
        await mouse.addPointer(location: first.center);
        for (final direction in ['right', 'down']) {
          await mouse.moveTo(
            direction == 'right'
                ? Offset(first.right - 2, first.center.dy)
                : Offset(first.center.dx, first.bottom - 2),
          );
          await tester.pump(const Duration(milliseconds: 150));
          expect(
            find.byKey(ValueKey('pane-split-$direction')).hitTestable(),
            findsOneWidget,
          );
          await captureControls(
            tester,
            'pane-edge-$direction-$count-${brightness.name}',
          );
        }
        await mouse.removePointer();
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      });
    }
  }
  for (final native in [false, true]) {
    testWidgets(
      'pane model opens shared picker for its harness (native=$native)',
      (tester) async {
        final updates = <Map>[];
        const channel = MethodChannel('harness/swarm_tabs');
        final messenger = tester.binding.defaultBinaryMessenger;
        messenger.setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'update') updates.add(call.arguments as Map);
          return true;
        });
        addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
        final connection = _PaneModelConnection();
        final app = createApp(connectionForTest: (_) => connection);
        addTearDown(app.dispose);
        app.machineStates['m']!.nodeOnline = true;
        app.modelManager.models = await app.readGridPicture('m');
        app.machineStates['m']!.agents = [
          Agent.fromJson({
            'id': 'a0',
            'engine': 'claude',
            'selectedModel': 'runtime-v1:a0:claude:fable@high',
            'terminal': {'available': true},
          }),
          Agent.fromJson({
            'id': 'a1',
            'engine': 'codex',
            'selectedModel': 'runtime-v1:a1:codex:gpt-6-astra@high',
            'terminal': {'available': true},
          }),
        ];
        final first = app.adoptSessionForTest(terminal('a0', []));
        final second = app.adoptSessionForTest(terminal('a1', []));
        await mount(tester, app, nativeTabs: native);
        final selectors = find.byType(GridModelPicker);
        Finder selector(String agent) =>
            find.byKey(ValueKey(('pane-model', 'm', agent)));
        expect(selectors, findsNWidgets(2));
        expect(find.text('GPT-6 Astra'), findsOneWidget);
        expect(find.text('Fable'), findsOneWidget);
        expect(find.textContaining('High'), findsNothing);
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('workspace-status-bar')),
            matching: selectors,
          ),
          findsNothing,
        );
        if (native) expect(updates.last['focusedModel'], isNull);
        for (final width in [1280.0, 720.0]) {
          tester.view.physicalSize = Size(width, 800);
          await tester.pump();
          for (final pane in [first, second]) {
            final close = find.descendant(
              of: find.byKey(pane.cellKey),
              matching: find.byType(PaneCloseButton),
            );
            expect(close.hitTestable(), findsOneWidget);
            final modelRect = tester.getRect(selector(pane.agentId!));
            final closeRect = tester.getRect(close);
            expect(modelRect.right, lessThanOrEqualTo(closeRect.left));
            expect(modelRect.center.dy, closeTo(closeRect.center.dy, .1));
          }
          expect(tester.takeException(), isNull);
          if (!native) await captureControls(tester, 'pane-model-$width');
        }
        tester.view.physicalSize = const Size(1280, 800);
        await tester.pump();
        expect(app.focusedPane, same(second));
        await tester.tap(selector('a0'));
        await tester.pumpAndSettle();
        expect(app.focusedPane, same(first));
        final modelSearch = find.byKey(const ValueKey('swarm-search-input'));
        expect(modelSearch, findsOneWidget);
        expect(tester.widget<TextField>(modelSearch).controller!.text, ':');
        await tester.enterText(modelSearch, ':Local-Test-Model');
        await tester.pumpAndSettle();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(connection.retargets.single['agentId'], 'a0');
        expect(connection.retargets.single['gridModel'], 'Local-Test-Model');
        expect(app.panes, containsAll([first, second]));

        await tester.tap(selector('a0'));
        await tester.pumpAndSettle();
        app.focusPane(second.id);
        await tester.pumpAndSettle();
        if (modelSearch.evaluate().isNotEmpty) {
          await tester.enterText(modelSearch, ':Local-Test-Model');
          await tester.pumpAndSettle();
          await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          await tester.pumpAndSettle();
          expect(connection.retargets, hasLength(1));
          await tester.sendKeyEvent(LogicalKeyboardKey.escape);
          await tester.pumpAndSettle();
        }
        final stale = tester.widget<GridModelPicker>(selector('a0')).onOpen!;
        app.closePane(first.id);
        await tester.pump();
        stale();
        await tester.pump();
        expect(modelSearch, findsNothing);
        expect(connection.retargets, hasLength(1));
        app.machineStates['m']!.nodeOnline = false;
        app.focusPane(second.id, reveal: true);
        await tester.pump();
        expect(tester.widget<GridModelPicker>(selector('a1')).enabled, isFalse);
        app.newSwarm();
        await tester.pump();
        expect(selectors, findsNothing);
        if (native) expect(updates.last['focusedModel'], isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  test(
    'footer distinguishes exhausted, unknown and separate subscriptions',
    () {
      expect(
        WorkspaceSubscriptionUsage.fromRows([
          subscription('claude', 'aaaaaa', 0),
          subscription('codex', 'bbbbbb', 50),
        ]).text,
        'Claude Code 0%   Codex 50%',
      );
      final all = WorkspaceSubscriptionUsage.fromRows([
        subscription('claude', 'aaaaaa', 0),
        subscription('claude', 'cccccc', .3, status: '<1% remaining'),
        subscription('codex', 'bbbbbb', null, status: 'Usage unavailable'),
      ]);
      expect(all.text, 'Claude Code 0%   Claude Code <1%   Codex —');
      expect(all.accounts, hasLength(3));
      expect(all.accounts[1].detail, contains('Account: cccccc'));
      expect(all.accounts.last.detail, contains('Usage unavailable'));
      expect(all.segments.map((part) => part.tone), [
        WorkspaceUsageTone.normal,
        WorkspaceUsageTone.exhausted,
        WorkspaceUsageTone.normal,
        WorkspaceUsageTone.exhausted,
        WorkspaceUsageTone.normal,
        WorkspaceUsageTone.normal,
      ]);
      expect(all.detail, contains('Weekly limit'));
      expect(
        WorkspaceSubscriptionUsage.fromRows([
          subscription('claude', '', null, status: 'Not signed in'),
        ]).text,
        'Subscriptions',
      );
    },
  );

  test(
    'rounded allowance thresholds and account identities stay consistent',
    () {
      final usage = WorkspaceSubscriptionUsage.fromRows([
        {
          ...subscription('claude', 'aaaaaa', 20.9),
          'accountKey': 'aaaaaa0000000001',
        },
        {
          ...subscription('claude', 'aaaaaa', 5.9),
          'accountKey': 'aaaaaa0000000002',
        },
        subscription('codex', 'b', double.nan),
      ]);
      expect(usage.accounts.map((a) => a.figure), ['20%', '5%', '—']);
      expect(usage.accounts.map((a) => a.tone), [
        WorkspaceUsageTone.low,
        WorkspaceUsageTone.exhausted,
        WorkspaceUsageTone.normal,
      ]);
      expect(usage.accounts.map((a) => a.searchId).toSet(), hasLength(3));
      expect(usage.detail, isNot(contains('aaaaaa0000000001')));
    },
  );

  test(
    'only low and critical percentages change ink, with readable contrast',
    () {
      final oldBrightness = grid.AppTheme.brightness.value;
      addTearDown(() => grid.AppTheme.brightness.value = oldBrightness);
      final usage = WorkspaceSubscriptionUsage.fromRows([
        subscription('claude', '', 0),
        subscription('codex', '', 20),
        subscription('other', '', 21),
      ]);
      for (final brightness in Brightness.values) {
        grid.AppTheme.brightness.value = brightness;
        for (final palette in HarnessPalette.values) {
          final parts = usage.paintSegments(
            foreground: palette.foreground,
            surface: palette.workspace,
          );
          expect(parts[0].foreground, palette.foreground);
          expect(parts[1].foreground, isNot(palette.foreground));
          expect(parts[2].foreground, palette.foreground);
          expect(parts[3].foreground, isNot(palette.foreground));
          expect(parts[5].foreground, palette.foreground);
          for (final part in parts) {
            final ink = part.foreground.computeLuminance();
            final ground = palette.workspace.computeLuminance();
            expect(
              ink > ground
                  ? (ink + .05) / (ground + .05)
                  : (ground + .05) / (ink + .05),
              greaterThanOrEqualTo(4.5),
            );
          }
        }
      }
    },
  );

  for (final native in [false, true]) {
    testWidgets(
      'footer shows inventory and remaining accounts beside focused work (native=$native)',
      (tester) async {
        final updates = <Map>[];
        const channel = MethodChannel('harness/swarm_tabs');
        final messenger = tester.binding.defaultBinaryMessenger;
        messenger.setMockMethodCallHandler(channel, (call) async {
          if (call.method == 'update') updates.add(call.arguments as Map);
          return true;
        });
        addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
        final subscriptions = _FooterSubscriptions()
          ..values = [
            subscription('claude', 'aaaaaa', 68),
            subscription('claude', 'cccccc', 18),
            subscription('codex', 'bbbbbb', 4),
          ];
        final app = createApp();
        app.machineStates['m']!.localOnly = true;
        final pane = app.adoptSessionForTest(terminal('a0', []));
        addTearDown(app.dispose);
        addTearDown(subscriptions.dispose);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        for (final width in [1280.0, 640.0, 480.0]) {
          tester.view.physicalSize = Size(width, 800);
          await tester.pumpWidget(
            MaterialApp(
              theme: grid.buildAppTheme(brightness: Brightness.dark),
              home: SwarmScreen(
                notifier: app,
                nativeTabs: native,
                modelsMenu: subscriptions,
              ),
            ),
          );
          await tester.pumpAndSettle();
          if (native) {
            expect(updates.last['subscriptionUsage']['fields'], hasLength(3));
            expect(
              updates.last['subscriptionUsage']['fields'][0]['text'],
              '68%',
            );
            expect(
              updates.last['subscriptionUsage']['fields'][1]['detail'],
              contains('cccccc'),
            );
            expect(
              updates.last['footerMachines']['text'],
              startsWith('Machines '),
            );
            expect(updates.last['footerModels']['text'], startsWith('Models '));
            expect(updates.last['machineResources'], isNull);
            expect(updates.last['harnessMonitor']['text'], 'Harnesses 0');
          } else {
            expect(
              find.byKey(const ValueKey('workspace-subscription-usage')),
              findsOneWidget,
            );
            expect(
              find.byKey(const ValueKey('workspace-machine-resources')),
              findsNothing,
            );
            final monitor = find.byKey(
              const ValueKey('workspace-harness-monitor'),
            );
            final context = find.byKey(
              const ValueKey('workspace-pane-context'),
            );
            expect(monitor, findsOneWidget);
            expect(
              find.byKey(const ValueKey('workspace-machines')),
              findsOneWidget,
            );
            expect(
              find.byKey(const ValueKey('workspace-models')),
              findsOneWidget,
            );
            expect(
              tester.getRect(monitor).right,
              lessThan(tester.getRect(context).left),
            );
            if (width == 1280) {
              await captureControls(tester, 'inventory-allowance-footer');
            }
          }
          expect(tester.takeException(), isNull);
        }
        if (!native) {
          tester.view.physicalSize = const Size(1280, 800);
          await tester.pumpAndSettle();
          DesktopSearchPanel picker() => tester.widget<DesktopSearchPanel>(
            find.byType(DesktopSearchPanel),
          );
          await tester.tap(find.byKey(const ValueKey('workspace-machines')));
          await tester.pumpAndSettle();
          expect(picker().search.scopePrefix, '@');
          picker().onClose();
          await tester.pumpAndSettle();
          await tester.tap(find.byKey(const ValueKey('workspace-models')));
          await tester.pumpAndSettle();
          expect(picker().search.query, ':local');
          picker().onClose();
          await tester.pumpAndSettle();
          await tester.tap(
            find.byKey(
              const ValueKey('workspace-subscription:claude:cccccc:0'),
            ),
          );
          await tester.pumpAndSettle();
          expect(
            picker().search.selected?.id,
            'model:subscription:claude:Anthropic:cccccc',
          );
          expect(picker().search.previewVisible, isTrue);
          picker().onClose();
          await tester.pumpAndSettle();
        }
        subscriptions.update([subscription('codex', 'bbbbbb', 27)]);
        await tester.pump();
        if (native) {
          expect(
            updates.last['subscriptionUsage']['fields'].single['text'],
            '27%',
          );
        }
        expect(app.focusedPane, same(pane));
        expect(app.panes, [pane]);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets('visible close belongs to its pane without moving the title', (
    tester,
  ) async {
    final app = createApp();
    addTearDown(app.dispose);
    final first = app.adoptSessionForTest(terminal('a0', []));
    final second = app.adoptSessionForTest(terminal('a1', []));
    await mount(tester, app);
    final titles = find.byKey(const ValueKey('terminal-pane-title'));
    final titleRects = [
      for (var i = 0; i < 2; i++) tester.getRect(titles.at(i)),
    ];
    final close = find.byType(PaneCloseButton);
    expect(close, findsNWidgets(2));
    expect(close.hitTestable(), findsNWidgets(2));
    final restingIcon = tester.widget<Icon>(
      find.descendant(of: close.first, matching: find.byIcon(AppIcons.close)),
    );
    expect(restingIcon.size, AppIcons.closeSize);
    expect(restingIcon.color!.a, .45);
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(titles.first));
    await tester.pump();
    expect(close.hitTestable(), findsNWidgets(2));
    for (var i = 0; i < 2; i++) {
      expect(tester.getRect(titles.at(i)), titleRects[i]);
    }
    await mouse.moveTo(tester.getCenter(close.first));
    await tester.pump();
    final closeIcon = find.descendant(
      of: close.first,
      matching: find.byIcon(AppIcons.close),
    );
    expect(tester.widget<Icon>(closeIcon).color!.a, 1);
    expect(tester.widget<Icon>(closeIcon).size, AppIcons.closeSize);
    expect(
      find.descendant(of: close.first, matching: find.byType(ColoredBox)),
      findsNothing,
    );
    for (var i = 0; i < 2; i++) {
      expect(tester.getRect(titles.at(i)), titleRects[i]);
    }
    await tester.pump(const Duration(milliseconds: 100));
    await captureControls(tester, 'pane-visible-close');
    await tester.tap(close.first);
    await tester.pump();
    expect(find.byKey(first.cellKey), findsNothing);
    expect(app.panes, [second]);
    expect(app.allPanes, isNot(contains(first)));
    expect(second.session!.agentId, 'a1');
    await mouse.removePointer();
    // Closing a tile resizes the remaining terminal through its 50 ms debounce.
    await tester.pump(const Duration(milliseconds: 60));
    await tester.pumpWidget(const SizedBox());
  });

  for (final native in [false, true]) {
    testWidgets(
      'focused PR stays compact beside every theme without duplicate lookups (native=$native)',
      (tester) async {
        final updates = <Map>[];
        const channel = MethodChannel('harness/swarm_tabs');
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          (call) async {
            if (call.method == 'update') updates.add(call.arguments as Map);
            return null;
          },
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            channel,
            null,
          ),
        );
        final original = appearancePrefsStore.value;
        addTearDown(() => appearancePrefsStore.value = original);
        final connection = _PRConnection();
        final app = createApp(connectionForTest: (_) => connection);
        addTearDown(app.dispose);
        app.stateOf('m')!.nodeOnline = true;
        app.stateOf('m')!.agents = const [
          Agent(
            id: 'a0',
            name: 'Feature',
            engine: 'codex',
            modelName: 'GPT-6 Astra',
            modelEffort: 'max',
            terminalAvailable: true,
            project: AgentProject(
              name: 'repo',
              cwd: '/repo',
              root: '/repo',
              branch: 'feature',
            ),
          ),
        ];
        final pane = app.adoptSessionForTest(terminal('a0', []));
        await mount(tester, app, nativeTabs: native);
        await tester.pump();
        expect(find.byType(PullRequestBadge), findsNothing);
        for (final style in StatusLineStyle.values) {
          appearancePrefsStore.value = original.copyWith(
            prompt: PromptPrefs(statusStyle: style),
          );
          await tester.pump();
          if (native) {
            final pr = updates.last['pullRequest'] as Map;
            expect(pr['text'], '#298');
            expect(pr['label'], '#298 Merged');
            expect(pr['iconAsset'], pullRequestIconAsset('Merged'));
            expect(pr['iconColor'], 0xffbc8cff);
            expect(pr['url'], 'https://github.com/acme/repo/pull/298');
            expect(pr['segmented'], style.segmented);
            expect(pr['roundedStart'], isFalse);
            final context = updates.last['focusedContext'] as Map;
            final fields = context['fields'] as List;
            expect((fields.first as Map)['roundedStart'], style.roundedStart);
            expect(
              fields
                  .skip(1)
                  .every((field) => (field as Map)['roundedStart'] == false),
              isTrue,
            );
            final branch = fields.cast<Map>().singleWhere(
              (field) => field['field'] == 'branch',
            );
            expect(
              (branch['segments'] as List)
                  .where((s) => (s as Map)['branchSymbol'] == true)
                  .length,
              style.branchSymbol ? 1 : 0,
            );
            final capture =
                Platform.environment['HARNESS_NATIVE_STATUS_CAPTURE_DIR'];
            if (capture != null) {
              await tester.runAsync(() async {
                await Directory(capture).create(recursive: true);
                await File('$capture/${style.name}.json')
                    .writeAsString(jsonEncode(updates.last));
                if (style == StatusLineStyle.standard) {
                  await File('$capture/catalog.json').writeAsString(
                    jsonEncode([
                      for (final choice in StatusLineStyle.values)
                        {'id': choice.name, 'label': choice.label},
                    ]),
                  );
                }
              });
            }

            expect(
              (pr['segments'] as List).any(
                (s) => (s as Map)['background'] != null,
              ),
              style.segmented,
            );
          } else {
            final badge = find.byKey(const ValueKey('workspace-pull-request'));
            final rendered = tester.widget<WorkspacePullRequestLabel>(
              find.descendant(
                of: badge,
                matching: find.byType(WorkspacePullRequestLabel),
              ),
            );
            expect(rendered.number, 298);
            expect(rendered.state, 'Merged');
            expect(rendered.style, style);
            for (final width in [520.0, 1280.0]) {
              tester.view.physicalSize = Size(width, 800);
              await tester.pump(const Duration(milliseconds: 100));
              expect(tester.takeException(), isNull);
              final contextRight = tester
                  .getRect(find.byKey(const ValueKey('workspace-pane-context')))
                  .right;
              expect(
                tester.getRect(badge).left,
                style.segmented
                    ? closeTo(contextRight, .01)
                    : greaterThan(contextRight),
              );
            }
            final controls = find.descendant(
              of: find.byKey(const ValueKey('workspace-status-bar')),
              matching: find.byType(WorkspaceBarControl),
            );
            final controlsBefore = controls
                .evaluate()
                .map((element) => tester.getRect(find.byWidget(element.widget)))
                .toList();
            final mouse = await tester.createGesture(
              kind: PointerDeviceKind.mouse,
            );
            await mouse.addPointer(location: Offset.zero);
            for (final key in [
              'workspace-context-project',
              'workspace-pull-request',
            ]) {
              final target = find.byKey(ValueKey(key));
              await mouse.moveTo(tester.getCenter(target));
              await tester.pump();
              if (key == 'workspace-pull-request') {
                expect(
                  tester
                      .widget<WorkspacePullRequestLabel>(
                        find.descendant(
                          of: target,
                          matching: find.byType(WorkspacePullRequestLabel),
                        ),
                      )
                      .emphasized,
                  isTrue,
                );
              } else {
                expect(
                  tester
                      .widget<StatusLine>(
                        find.descendant(
                          of: target,
                          matching: find.byType(StatusLine),
                        ),
                      )
                      .emphasized,
                  isTrue,
                );
              }
              expect(
                find.descendant(of: target, matching: find.byType(ColoredBox)),
                findsNothing,
              );
              expect(
                controls.evaluate().map(
                  (element) => tester.getRect(find.byWidget(element.widget)),
                ),
                controlsBefore,
              );
              if (key == 'workspace-pull-request') {
                expect(
                  tester
                      .widget<StatusLine>(
                        find.descendant(
                          of: find.byKey(
                            const ValueKey('workspace-context-project'),
                          ),
                          matching: find.byType(StatusLine),
                        ),
                      )
                      .emphasized,
                  isFalse,
                );
                await captureControls(tester, 'bar-hover-${style.name}');
              }
            }
            await mouse.removePointer();
            await tester.pump();
          }
        }
        expect(connection.reads, 1);
        app.renameSwarm(app.activeSwarmId, 'Release');
        // Let the terminal finish its resize debounce after the last layout.
        await tester.pump(const Duration(milliseconds: 100));
        if (native) {
          expect(
            ((updates.last['tabs'] as List).single as Map)['label'],
            'Release',
          );
        } else {
          expect(find.text('Release'), findsOneWidget);
        }
        app.newSwarm();
        await tester.pump();
        if (native) {
          expect(updates.last['pullRequest'], isNull);
        } else {
          expect(
            find.byKey(const ValueKey('workspace-pull-request')),
            findsNothing,
          );
        }
        expect(app.allPanes, contains(pane));
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  test(
    'custom tab labels survive pane changes, closing, and saved layout restore',
    () async {
      final storage = MemoryStore();
      final app = createApp(store: storage);
      await app.addAgentToSwarm('m', 'a0');
      final id = app.activeSwarmId;
      app.renameSwarm(id, 'My release');
      await app.addAgentToSwarm('m', 'a1');
      expect(workspaceTabNames(app)[id], 'My release');
      await app.closeSwarm(id);
      app.reopenClosedSwarm();
      expect(workspaceTabNames(app)[id], 'My release');
      await app.flushPaneLayout();
      app.dispose();
      final restored = createApp(store: storage);
      addTearDown(restored.dispose);
      await restored.restorePaneLayoutForTest();
      expect(workspaceTabNames(restored)[id], 'My release');
      expect(
        restored.swarms.singleWhere((s) => s.id == id).nameIsCustom,
        isTrue,
      );
    },
  );

  test(
    'status project names follow remote, subfolder, and ordinary folder rules',
    () {
      const root = AgentProject(
        name: 'local-clone',
        cwd: '/work/local-clone',
        root: '/work/local-clone',
        remote: 'github.com/team/api',
        branch: 'main',
      );
      const linked = AgentProject(
        name: 'local-clone',
        cwd: '/worktrees/random-name',
        root: '/worktrees/random-name',
        remote: 'github.com/team/api',
        branch: 'fix',
        worktree: true,
      );
      const subfolder = AgentProject(
        name: 'local-clone',
        cwd: '/work/local-clone/desktop/',
        root: '/work/local-clone',
        remote: 'github.com/team/api',
      );
      const local = AgentProject(
        name: 'local-repo',
        cwd: '/local-repo',
        root: '/local-repo',
      );
      const folder = AgentProject(name: 'notes', cwd: '/work/notes');
      expect(
        [root.label, linked.label, subfolder.label, local.label, folder.label],
        ['api', 'api', 'desktop', 'local-repo', 'notes'],
      );
      final app = createApp();
      addTearDown(app.dispose);
      app.stateOf('m')!.agents = const [
        Agent(id: 'a', name: 'Fix', engine: 'codex', project: linked),
      ];
      app.activeSwarm.panes.add(
        TerminalPane(id: 1, machineId: 'm', agentId: 'a'),
      );
      app.activeSwarm.focusedPaneId = 1;
      final context = WorkspacePaneContext.focused(app)!;
      expect(context.text, 'Test host:api  (fix)');
      expect(context.detail, isNot(contains('/worktrees/random-name')));
      for (final style in StatusLineStyle.values) {
        final text = context.format(PromptPrefs(statusStyle: style)).text;
        expect(text, isNot(contains('random-name')));
        expect(text, isNot(contains('[worktree]')));
      }
    },
  );

  for (final custom in [false, true]) {
    test(
      'closing term keeps the revealed office tab name (custom=$custom)',
      () async {
        final storage = MemoryStore();
        final app = createApp(store: storage);
        addTearDown(app.dispose);
        final machine = app.stateOf('m')!;
        machine.agents = const [
          Agent(id: 'a0', name: 'Code', engine: 'codex'),
          Agent(id: 'a1', name: 'Terminal', engine: 'terminal'),
          Agent(id: 'a2', name: 'Other terminal', engine: 'terminal'),
        ];
        app.renameSwarm(app.activeSwarmId, 'growth');
        app.newSwarm(name: 'term');
        final term = app.activeSwarm;
        await app.addAgentToSwarm('m', 'a2');
        app.newSwarm();
        final office = app.activeSwarm;
        await app.addAgentToSwarm('m', 'a0');
        await app.addAgentToSwarm('m', 'a1');
        if (custom) app.renameSwarm(office.id, 'office');
        final expected = custom ? 'office' : 'Test host';
        final panes = office.panes.toList();
        expect(workspaceTabNames(app)[office.id], expected);

        app.selectSwarm(term.id);
        await app.closeSwarm(term.id);
        expect(app.activeSwarm, same(office));
        expect(workspaceTabNames(app)[office.id], expected);
        expect(office.panes, orderedEquals(panes));
        expect(office.nameIsCustom, custom);

        app.reopenClosedSwarm();
        expect(workspaceTabNames(app)[term.id], 'term');
        expect(workspaceTabNames(app)[office.id], expected);
        await app.closeSwarm(term.id);
        await app.flushPaneLayout();

        final restored = createApp(store: storage);
        addTearDown(restored.dispose);
        restored.stateOf('m')!.agents = machine.agents;
        await restored.restorePaneLayoutForTest();
        expect(workspaceTabNames(restored)[office.id], expected);
        expect(restored.swarms.any((tab) => tab.id == term.id), isFalse);
        expect(
          restored.swarms
              .singleWhere((tab) => tab.id == office.id)
              .nameIsCustom,
          custom,
        );
      },
    );
  }

  test('project names distinguish code tabs while a distinct harness keeps its type', () {
    final app = createApp();
    addTearDown(app.dispose);
    app.stateOf('m')!.agents = const [
      Agent(
        id: 'a',
        name: 'a',
        engine: 'codex',
        project: AgentProject(name: 'api', cwd: '/api'),
      ),
      Agent(
        id: 'b',
        name: 'b',
        engine: 'claude',
        project: AgentProject(name: 'web', cwd: '/web'),
      ),
      Agent(
        id: 'c',
        name: 'c',
        engine: 'claude',
        dsh: 'autonomous/blender',
        project: AgentProject(name: 'scene', cwd: '/scene'),
      ),
    ];
    app.swarms.clear();
    for (final id in ['a', 'b', 'c']) {
      app.swarms.add(
        Swarm(id: id)
          ..panes.add(
            TerminalPane(id: id.codeUnitAt(0), machineId: 'm', agentId: id),
          ),
      );
    }
    expect(workspaceTabNames(app), {'a': 'api', 'b': 'web', 'c': 'blender'});
    final scene = app.swarms.last;
    for (var id = 0; id < 4; id++) {
      scene.panes.add(
        TerminalPane(
          id: id,
          machineId: 'm',
          kind: PaneKind.web,
          ownerAgentId: 'a',
        ),
      );
      scene.focusedPaneId = id;
      expect(workspaceTabNames(app)['c'], 'blender');
    }
    app.renameSwarm('a', 'My workspace');
    expect(workspaceTabNames(app)['a'], 'My workspace');
    expect(app.swarms.first.name, 'My workspace');
  });

  test('machine names distinguish the same project on different machines', () {
    final app = createApp();
    addTearDown(app.dispose);
    app.swarms.clear();
    for (final id in ['laptop', 'server']) {
      final machine = Machine(
        machineId: id,
        name: id,
        authMode: MachineAuthMode.remote,
      );
      app.machineStates[id] = MachineState(machine)
        ..agents = const [
          Agent(
            id: 'a',
            name: 'a',
            engine: 'codex',
            project: AgentProject(name: 'api', cwd: '/api'),
          ),
        ];
      app.swarms.add(
        Swarm(id: id)
          ..panes.add(TerminalPane(id: 1, machineId: id, agentId: 'a')),
      );
    }
    expect(workspaceTabNames(app), {'laptop': 'laptop', 'server': 'server'});
  });

  test('a shared machine wins over a minority project or harness type', () {
    final app = createApp();
    addTearDown(app.dispose);
    app.stateOf('m')!.agents = const [
      Agent(
        id: 'a',
        name: 'a',
        engine: 'codex',
        project: AgentProject(name: 'api', cwd: '/api'),
      ),
      Agent(
        id: 'b',
        name: 'b',
        engine: 'claude',
        project: AgentProject(name: 'web', cwd: '/web'),
      ),
      Agent(id: 'c', name: 'c', engine: 'claude', dsh: 'autonomous/blender'),
    ];
    app.activeSwarm.panes.addAll([
      for (final id in ['a', 'b', 'c'])
        TerminalPane(id: id.codeUnitAt(0), machineId: 'm', agentId: id),
    ]);
    expect(workspaceTabNames(app).values.single, 'Test host');
  });

  group('Auto rename', () {
    late AppearancePrefs saved;
    setUp(() => saved = appearancePrefsStore.value);
    tearDown(() => appearancePrefsStore.value = saved);
    void autoRename(bool on) => appearancePrefsStore.value =
        appearancePrefsStore.value.copyWith(autoRenameTabs: on);

    const repo = AgentProject(
      name: 'harness',
      cwd: '/harness',
      root: '/harness',
      branch: 'main',
    );
    const folder = AgentProject(name: 'notes', cwd: '/notes');
    Agent agent(
      String id, {
      String? name,
      AgentProject? project = repo,
      String engine = 'claude',
    }) => Agent(
      id: id,
      name: name ?? 'Work $id',
      engine: engine,
      project: project,
    );
    TerminalPane pane(int id, String machineId, String agentId) =>
        TerminalPane(id: id, machineId: machineId, agentId: agentId);

    /// Machine `m` and a second connected machine `b`, each answered by its
    /// own daemon in [daemons]. Both are local unless [relayed] says `b` is
    /// reached through the relay.
    AppNotifier appWith(
      Map<String, _WindowNameConnection> daemons, {
      bool relayed = false,
    }) {
      final app = createApp(
        connectionForTest: (id) =>
            daemons.putIfAbsent(id, _WindowNameConnection.new),
        connected: true,
      );
      const box = Machine(
        machineId: 'b',
        authMode: MachineAuthMode.remote,
        name: 'Box',
      );
      app.machines = [...app.machines, box];
      app.machineStates['m']!.localOnly = true;
      app.machineStates['b'] = MachineState(box)
        ..localOnly = !relayed
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded;
      return app;
    }

    List<List<String>> asked(
      Map<String, _WindowNameConnection> daemons,
      String machineId,
    ) => daemons[machineId]?.asked ?? const [];

    test('off asks nothing and leaves every label as it was', () async {
      final daemons = <String, _WindowNameConnection>{};
      final app = appWith(daemons);
      addTearDown(app.dispose);
      app.stateOf('m')!.agents = [agent('x'), agent('y')];
      app.activeSwarm.panes.addAll([pane(1, 'm', 'x'), pane(2, 'm', 'y')]);
      final id = app.activeSwarmId;
      autoRename(false);
      expect(workspaceTabNames(app)[id], 'code');
      await pumpEventQueue();
      expect(asked(daemons, 'm'), isEmpty);

      // A daemon with no name for it keeps the label too, and is not asked
      // again for the same panes.
      autoRename(true);
      expect(workspaceTabNames(app)[id], 'code');
      await pumpEventQueue();
      expect(workspaceTabNames(app)[id], 'code');
      await pumpEventQueue();
      expect(asked(daemons, 'm'), hasLength(1));

      daemons['m']!.replies.add({'name': 'Harness Tabs'});
      app.stateOf('m')!.agents = [agent('x', name: 'Fix tabs'), agent('y')];
      autoRename(false);
      expect(workspaceTabNames(app)[id], 'code');
      await pumpEventQueue();
      expect(asked(daemons, 'm'), hasLength(1));
    });

    test('on asks the machine of the repo panes, in pane order, and shows its name', () async {
      final daemons = <String, _WindowNameConnection>{};
      final app = appWith(daemons);
      addTearDown(app.dispose);
      app.stateOf('m')!.agents = [
        agent('t', engine: 'terminal'),
        agent('x'),
        agent('y', engine: 'codex'),
      ];
      app.stateOf('b')!.agents = [agent('z', project: folder)];
      app.activeSwarm.panes.addAll([
        pane(1, 'm', 't'),
        pane(2, 'b', 'z'),
        pane(3, 'm', 'x'),
        TerminalPane(
          id: 4,
          machineId: 'm',
          kind: PaneKind.web,
          ownerAgentId: 'x',
        ),
        pane(5, 'm', 'y'),
      ]);
      final id = app.activeSwarmId;
      daemons.putIfAbsent('m', _WindowNameConnection.new).replies.add({
        'name': 'Harness TUI LMStudio',
      });
      autoRename(true);
      var notified = 0;
      app.addListener(() => notified++);
      final today = workspaceTabNames(app)[id];
      expect(today, isNot('Harness TUI LMStudio'));
      // Read again before the answer: still one question in flight.
      expect(workspaceTabNames(app)[id], today);
      await pumpEventQueue();
      expect(asked(daemons, 'm'), [
        ['t', 'x', 'y'],
      ]);
      expect(asked(daemons, 'b'), isEmpty);
      expect(notified, greaterThan(0));
      expect(workspaceTabNames(app)[id], 'Harness TUI LMStudio');
      await pumpEventQueue();
      expect(asked(daemons, 'm'), hasLength(1));

      autoRename(false);
      expect(workspaceTabNames(app)[id], today);
    });

    test('a custom name wins and is never asked about', () async {
      final daemons = <String, _WindowNameConnection>{};
      final app = appWith(daemons);
      addTearDown(app.dispose);
      app.stateOf('m')!.agents = [agent('x')];
      app.activeSwarm.panes.add(pane(1, 'm', 'x'));
      final id = app.activeSwarmId;
      app.renameSwarm(id, 'My release');
      daemons.putIfAbsent('m', _WindowNameConnection.new).replies.add({
        'name': 'Harness Tabs',
      });
      autoRename(true);
      expect(workspaceTabNames(app)[id], 'My release');
      await pumpEventQueue();
      expect(asked(daemons, 'm'), isEmpty);
      expect(workspaceTabNames(app)[id], 'My release');
    });

    test('pending is asked again once, five seconds later', () {
      fakeAsync((async) {
        final daemons = <String, _WindowNameConnection>{};
        final app = appWith(daemons);
        app.stateOf('m')!.agents = [agent('x')];
        app.activeSwarm.panes.add(pane(1, 'm', 'x'));
        final id = app.activeSwarmId;
        daemons.putIfAbsent('m', _WindowNameConnection.new).replies.addAll([
          {'name': null, 'pending': true},
          {'name': 'Mobile Test'},
        ]);
        autoRename(true);
        final today = workspaceTabNames(app)[id];
        async.flushMicrotasks();
        expect(asked(daemons, 'm'), hasLength(1));
        for (var i = 0; i < 20; i++) {
          expect(workspaceTabNames(app)[id], today);
          async.elapse(const Duration(milliseconds: 200));
        }
        expect(asked(daemons, 'm'), hasLength(1));
        async.elapse(const Duration(seconds: 1));
        workspaceTabNames(app);
        async.flushMicrotasks();
        expect(asked(daemons, 'm'), hasLength(2));
        expect(workspaceTabNames(app)[id], 'Mobile Test');
        app.dispose();
      });
    });

    test('no name is asked about again only after ten minutes', () {
      fakeAsync((async) {
        final daemons = <String, _WindowNameConnection>{};
        final app = appWith(daemons);
        app.stateOf('m')!.agents = [agent('x')];
        app.activeSwarm.panes.add(pane(1, 'm', 'x'));
        final id = app.activeSwarmId;
        daemons.putIfAbsent('m', _WindowNameConnection.new).replies.addAll([
          {'name': null},
          {'name': 'Harness Tabs'},
        ]);
        autoRename(true);
        final today = workspaceTabNames(app)[id];
        async.flushMicrotasks();
        async.elapse(const Duration(minutes: 9));
        expect(workspaceTabNames(app)[id], today);
        async.flushMicrotasks();
        expect(asked(daemons, 'm'), hasLength(1));
        async.elapse(const Duration(minutes: 1));
        workspaceTabNames(app);
        async.flushMicrotasks();
        expect(asked(daemons, 'm'), hasLength(2));
        expect(workspaceTabNames(app)[id], 'Harness Tabs');
        app.dispose();
      });
    });

    test('an error keeps the label and quiets that machine for a while', () {
      fakeAsync((async) {
        final daemons = <String, _WindowNameConnection>{};
        final app = appWith(daemons);
        app.stateOf('m')!.agents = [agent('x'), agent('y')];
        app.activeSwarm.panes.add(pane(1, 'm', 'x'));
        app.newSwarm();
        app.activeSwarm.panes.add(pane(2, 'm', 'y'));
        daemons.putIfAbsent('m', _WindowNameConnection.new).replies.add({
          'name': null,
          'error': 'UNSUPPORTED',
        });
        autoRename(false);
        final today = workspaceTabNames(app);
        autoRename(true);
        expect(workspaceTabNames(app), today);
        async.flushMicrotasks();
        // Both tabs asked at once; neither, nor anything after, again.
        expect(asked(daemons, 'm'), hasLength(2));
        for (var i = 0; i < 30; i++) {
          expect(workspaceTabNames(app), today);
          async.elapse(const Duration(seconds: 1));
        }
        app.stateOf('m')!.agents = [agent('x', name: 'Fix tabs'), agent('y')];
        expect(workspaceTabNames(app), today);
        async.flushMicrotasks();
        expect(asked(daemons, 'm'), hasLength(2));

        async.elapse(const Duration(minutes: 10));
        workspaceTabNames(app);
        async.flushMicrotasks();
        expect(asked(daemons, 'm'), hasLength(4));
        app.dispose();
      });
    });

    test('a pane title change asks again', () async {
      final daemons = <String, _WindowNameConnection>{};
      final app = appWith(daemons);
      addTearDown(app.dispose);
      app.stateOf('m')!.agents = [agent('x'), agent('y')];
      app.activeSwarm.panes.addAll([pane(1, 'm', 'x'), pane(2, 'm', 'y')]);
      final id = app.activeSwarmId;
      daemons.putIfAbsent('m', _WindowNameConnection.new).replies.addAll([
        {'name': 'Harness Tabs'},
        {'name': 'Harness Rename'},
      ]);
      autoRename(true);
      workspaceTabNames(app);
      await pumpEventQueue();
      expect(workspaceTabNames(app)[id], 'Harness Tabs');

      app.stateOf('m')!.agents = [agent('x', name: 'Rename tabs'), agent('y')];
      // The old name stays while the new question is out.
      expect(workspaceTabNames(app)[id], 'Harness Tabs');
      await pumpEventQueue();
      expect(asked(daemons, 'm'), [
        ['x', 'y'],
        ['x', 'y'],
      ]);
      expect(workspaceTabNames(app)[id], 'Harness Rename');
    });

    test('the machine with the most repo panes is asked, not the one with the most panes', () async {
      final daemons = <String, _WindowNameConnection>{};
      final app = appWith(daemons);
      addTearDown(app.dispose);
      app.stateOf('m')!.agents = [
        agent('p', project: folder),
        agent('q', project: null),
        agent('s', engine: 'terminal'),
      ];
      app.stateOf('b')!.agents = [agent('r'), agent('v')];
      app.activeSwarm.panes.addAll([
        pane(1, 'm', 'p'),
        pane(2, 'm', 'q'),
        pane(3, 'm', 's'),
        pane(4, 'b', 'r'),
      ]);
      // A tie goes to the machine of the first repo pane.
      app.newSwarm();
      app.stateOf('m')!.agents = [...app.stateOf('m')!.agents, agent('w')];
      app.activeSwarm.panes.addAll([pane(5, 'b', 'v'), pane(6, 'm', 'w')]);
      autoRename(true);
      workspaceTabNames(app);
      await pumpEventQueue();
      expect(asked(daemons, 'b'), [
        ['r'],
        ['v'],
      ]);
      expect(asked(daemons, 'm'), isEmpty);
    });

    test(
      'a relayed machine is not asked until window_name is sealed',
      () async {
        final daemons = <String, _WindowNameConnection>{};
        final app = appWith(daemons, relayed: true);
        addTearDown(app.dispose);
        app.stateOf('b')!.agents = [agent('r')];
        app.activeSwarm.panes.add(pane(1, 'b', 'r'));
        final id = app.activeSwarmId;
        daemons.putIfAbsent('b', _WindowNameConnection.new).replies.add({
          'name': 'Harness Tabs',
        });
        autoRename(false);
        final today = workspaceTabNames(app)[id];
        autoRename(true);
        expect(workspaceTabNames(app)[id], today);
        await pumpEventQueue();
        expect(asked(daemons, 'b'), isEmpty);
        expect(workspaceTabNames(app)[id], today);
      },
    );

    test('a tab with no harness in a repo asks nothing', () async {
      final daemons = <String, _WindowNameConnection>{};
      final app = appWith(daemons);
      addTearDown(app.dispose);
      app.stateOf('m')!.agents = [
        agent('p', project: folder),
        agent('q', project: null),
        agent('s', engine: 'terminal'),
        agent(
          'u',
          project: const AgentProject(
            name: 'harness',
            cwd: '/harness',
            branch: '',
          ),
        ),
      ];
      app.activeSwarm.panes.addAll([
        for (final (index, id) in ['p', 'q', 's', 'u'].indexed)
          pane(index + 1, 'm', id),
      ]);
      final id = app.activeSwarmId;
      autoRename(false);
      final today = workspaceTabNames(app)[id];
      autoRename(true);
      expect(workspaceTabNames(app)[id], today);
      await pumpEventQueue();
      expect(asked(daemons, 'm'), isEmpty);
    });
  });

  test('status presets retain real metadata and omit missing Git context', () {
    const expected = {
      StatusLineStyle.standard: 'OpenAI  M2:app  (main)',
      StatusLineStyle.robbyrussell: 'OpenAI  M2  ➜ app git:(main)',
      StatusLineStyle.pure: 'OpenAI  M2  app main ❯',
      StatusLineStyle.agnoster: 'OpenAI M2  app  main',
      StatusLineStyle.powerlevel10k: 'OpenAI  M2  app  main >',
      StatusLineStyle.spaceship: 'OpenAI  M2 in app on main',
      StatusLineStyle.starship: 'OpenAI  M2 app on main ❯',
      StatusLineStyle.powerlevel10kRainbow: 'OpenAI M2  app  main',
      StatusLineStyle.pastelPowerline: 'OpenAI M2  app  main',
      StatusLineStyle.catppuccinPowerline: 'OpenAI M2  app  main',
      StatusLineStyle.tokyoNight: 'OpenAI M2  app  main',
      StatusLineStyle.gruvboxRainbow: 'OpenAI M2  app  main',
    };
    for (final format in StatusLineStyle.values) {
      expect(
        statusLineParts(
          provider: 'OpenAI',
          machine: 'M2',
          project: 'app',
          branch: 'main',
          style: format,
        ).text,
        expected[format],
      );
      expect(
        statusLineParts(
          provider: 'OpenAI',
          machine: '',
          project: 'notes',
          style: format,
        ).text,
        isNot(anyOf(contains('git'), contains('()'), contains('[worktree]'))),
      );
      final prefs = PromptPrefs(
        statusStyle: format,
        machine: false,
        color: false,
      );
      expect(PromptPrefs.fromJson(prefs.toJson()), prefs);
    }
    expect(
      PromptPrefs.fromJson({'statusStyle': 'future'}).statusStyle,
      StatusLineStyle.standard,
    );
    expect(
      PromptPrefs.fromJson({'style': 'powerline'}).statusStyle,
      StatusLineStyle.standard,
    );
  });

  test('dominant type groups code engines, excludes viewers, and breaks ties by pane order', () {
    final app = createApp();
    addTearDown(app.dispose);
    app.stateOf('m')!.agents = const [
      Agent(id: 'a', name: 'Code', engine: 'codex'),
      Agent(id: 'b', name: 'Code', engine: 'claude'),
      Agent(
        id: 'c',
        name: 'Scene',
        engine: 'claude',
        dsh: 'autonomous/blender',
      ),
      Agent(id: 'd', name: 'Scene', engine: 'codex', dsh: 'autonomous/blender'),
    ];
    final tab = app.activeSwarm;
    tab.panes.addAll([
      TerminalPane(id: 1, machineId: 'm', agentId: 'a'),
      TerminalPane(id: 2, machineId: 'm', agentId: 'b'),
      TerminalPane(id: 3, machineId: 'm', agentId: 'c'),
      for (var index = 4; index < 8; index++)
        TerminalPane(
          id: index,
          machineId: 'm',
          kind: PaneKind.web,
          ownerAgentId: 'c',
        ),
    ]);
    expect(tabHarnessType(app, tab), 'code');
    tab.panes.add(TerminalPane(id: 8, machineId: 'm', agentId: 'd'));
    for (final pane in tab.panes) {
      tab.focusedPaneId = pane.id;
      expect(tabHarnessType(app, tab), 'code');
    }
    tab.panes.removeAt(0);
    expect(tabHarnessType(app, tab), 'blender');
    tab.panes.removeWhere((pane) => !pane.isWeb);
    expect(tabHarnessType(app, tab), 'new');
    expect(tabHarnessType(app, Swarm(id: 'store', kind: 'store')), 'store');
  });

  test('focused viewers inherit owner context, using the compact project name and full path tooltip', () {
    final app = createApp();
    addTearDown(app.dispose);
    app.stateOf('m')!.agents = const [
      Agent(
        id: 'a',
        name: 'Scene',
        engine: 'claude',
        dsh: 'autonomous/blender',
        project: AgentProject(
          name: 'scene',
          cwd: '/worktrees/scene-light',
          root: '/worktrees/scene-light',
          branch: 'lighting',
        ),
      ),
      Agent(
        id: 'b',
        name: 'Notes',
        engine: 'codex',
        project: AgentProject(name: 'notes', cwd: '/work/notes'),
      ),
    ];
    final tab = app.activeSwarm;
    tab.panes.addAll([
      TerminalPane(id: 1, machineId: 'm', agentId: 'a'),
      TerminalPane(
        id: 2,
        machineId: 'm',
        kind: PaneKind.web,
        ownerAgentId: 'a',
      ),
      TerminalPane(id: 3, machineId: 'm', agentId: 'b'),
    ]);
    tab.focusedPaneId = 1;
    final owner = WorkspacePaneContext.focused(app)!;
    expect(owner.text, 'Test host:scene  (lighting)');
    tab.focusedPaneId = 2;
    expect(WorkspacePaneContext.focused(app)!.text, owner.text);
    expect(WorkspacePaneContext.focused(app)!.agentId, 'a');
    tab.focusedPaneId = 3;
    expect(WorkspacePaneContext.focused(app)!.text, 'Test host:notes');
    tab.panes.clear();
    expect(WorkspacePaneContext.focused(app), isNull);
  });

  testWidgets(
    'top navigation and bottom context stay separate while switching workspaces',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      app.adoptSessionForTest(terminal('a0', []));
      final first = app.activeSwarm;
      app.newSwarm();
      app.adoptSessionForTest(terminal('a1', []));
      await mount(tester, app);
      expect(find.text('code'), findsNWidgets(2));
      expect(find.text('1:'), findsNothing);
      expect(find.text('2:'), findsNothing);
      final context = find.byKey(const ValueKey('workspace-pane-context'));
      expect(
        tester.getRect(context).top,
        greaterThan(
          tester.getRect(find.byKey(ValueKey(app.activeSwarmId))).bottom,
        ),
      );
      final secondTab = find.byKey(ValueKey(app.activeSwarmId));
      final barControls = find.byType(WorkspaceBarControl);
      final bar = find.byKey(const ValueKey('workspace-tab-bar'));
      final footer = tester.getRect(
        find.byKey(const ValueKey('workspace-status-bar')),
      );
      expect(footer.bottom, 800);
      expect(footer.height, 37.5);
      expect(tester.getRect(context).center.dy, footer.center.dy);
      expect(footer.contains(tester.getRect(context).center), isTrue);
      for (final element in barControls.evaluate()) {
        final control = element.widget as WorkspaceBarControl;
        final rect = tester.getRect(find.byWidget(control));
        if (control.label == 'Harness Store') {
          final label = find.descendant(
            of: find.byWidget(control),
            matching: find.text('Harness Store'),
          );
          expect(
            tester.widget<Text>(label).style!.fontFamily,
            grid.AppType.sansFamily,
          );
          expect(
            rect.height,
            greaterThanOrEqualTo(tester.getSize(label).height + 12),
          );
        } else {
          expect(
            rect.height,
            control.selectedBackground == null
                ? 28
                : tester.getSize(bar).height,
          );
        }
        if (control.selected == true) {
          final fill = find.descendant(
            of: find.byWidget(control),
            matching: find.byType(ColoredBox),
          );
          expect(
            tester.widget<ColoredBox>(fill).color,
            grid.AppPalette.swarmWelcome,
          );
          expect(tester.getRect(fill).top, tester.getRect(bar).top);
          expect(tester.getRect(fill).bottom, tester.getRect(bar).bottom);
        }
      }
      expect(
        tester.getSize(secondTab).width,
        tester.getSize(find.byKey(ValueKey(first.id))).width,
        reason: 'workspace tabs share one width',
      );
      expect(
        tester.getSize(secondTab).width,
        lessThanOrEqualTo(grid.AppDesktop.tabMaxWidth),
        reason: 'tabs stop growing at the shared maximum in a roomy window',
      );
      expect(find.byKey(const ValueKey('swarm-search-button')), findsOneWidget);
      expect(find.byKey(const ValueKey('swarm-store-button')), findsOneWidget);
      for (final old in ['harnesses', 'machines', 'models', 'help']) {
        expect(find.byKey(ValueKey('swarm-$old-button')), findsNothing);
      }
      expect(
        find.descendant(
          of: find.byType(TerminalPanel),
          matching: find.byType(GridModelPicker),
        ),
        findsWidgets,
      );
      await tester.tap(find.byKey(ValueKey(first.id)));
      await tester.pump(const Duration(milliseconds: 350));
      expect(app.activeSwarm, same(first));
      final originalFont = terminalFontStore.value;
      addTearDown(() => terminalFontStore.value = originalFont);
      for (final size in [originalFont.fontSize, 18.0]) {
        terminalFontStore.value = TerminalStyle(
          fontSize: size,
          fontFamily: originalFont.fontFamily,
          fontFamilyFallback: originalFont.fontFamilyFallback,
        );
        for (final width in [400.0, 480.0, 520.0, 880.0, 1280.0]) {
          tester.view.physicalSize = Size(width, 800);
          await tester.pump(const Duration(milliseconds: 100));
          expect(tester.takeException(), isNull);
          // Daemons are off here (no zoo): nothing is kept for their slot.
          expect(find.byKey(const ValueKey('daemon-slot')), findsNothing);
          expect(tester.getRect(context).right, lessThan(width));
        }
      }
      await captureControls(tester, 'workspace-bottom-bar');
      final workspace = tester.widget<SwarmScreen>(find.byType(SwarmScreen));
      for (final scale in [1.0, 2.0]) {
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
            home: workspace,
          ),
        );
        await tester.pump(const Duration(milliseconds: 100));
        final store = find.byKey(const ValueKey('swarm-store-button'));
        expect(
          MediaQuery.textScalerOf(tester.element(store)).scale(13),
          13 * scale,
        );
        final label = find.descendant(
          of: store,
          matching: find.text('Harness Store'),
        );
        expect(
          tester.renderObject<RenderParagraph>(label).didExceedMaxLines,
          isFalse,
        );
        expect(
          tester.getSize(store).height,
          greaterThanOrEqualTo(tester.getSize(label).height + 12),
        );
        expect(
          tester.widget<Text>(label).style!.fontFamily,
          grid.AppType.sansFamily,
        );
        expect(tester.takeException(), isNull);
        await captureControls(
          tester,
          'store-navigation-$scale',
          height: tester.getSize(bar).height,
        );
      }
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'native status payload follows focus and keeps the type label short',
    (tester) async {
      final updates = <Map<String, dynamic>>[];
      const channel = MethodChannel('harness/swarm_tabs');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            if (call.method == 'update') {
              updates.add(Map<String, dynamic>.from(call.arguments as Map));
            }
            return null;
          });
      addTearDown(
        () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null),
      );
      final app = createApp();
      addTearDown(app.dispose);
      app.adoptSessionForTest(terminal('a0', []));
      app.adoptSessionForTest(terminal('a1', []));
      await mount(tester, app, nativeTabs: true);
      final tab = (updates.last['tabs'] as List).single as Map;
      expect(tab['label'], 'code');
      expect(tab['shortcutHint'], '⌘1');
      expect((updates.last['focusedContext'] as Map)['text'], 'Test host');
      expect(updates.last['barStyle'], containsPair('family', isA<String>()));
      final originalPrefs = appearancePrefsStore.value;
      addTearDown(() => appearancePrefsStore.value = originalPrefs);
      appearancePrefsStore.value = originalPrefs.copyWith(
        prompt: originalPrefs.prompt.copyWith(
          statusStyle: StatusLineStyle.pure,
          machine: false,
          color: false,
        ),
      );
      await tester.pump();
      expect((updates.last['focusedContext'] as Map)['text'], '');
      final colors = updates.last['barStyle'] as Map;
      final segments =
          (updates.last['focusedContext'] as Map)['segments'] as List;
      expect(
        segments.map((part) => (part as Map)['foreground']),
        everyElement(colors['foreground']),
      );
      app.newSwarm();
      await tester.pump();
      expect(updates.last['focusedContext'], isNull);
      expect(((updates.last['tabs'] as List).last as Map)['label'], 'New Tab');
      await tester.pumpWidget(const SizedBox());
    },
  );
}
