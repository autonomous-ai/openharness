import 'support/launch_menu.dart';

import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/prompt_style.dart';

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/core/models.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/auth/peer_link_client.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/widgets/new_harness_box.dart';
import 'package:harness/widgets/engine_identity.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;
import 'swarm_search_preview_test.dart' show seedPreviews;
import 'keymap_host_test.dart' show key;
import 'support/agent_picker.dart' show chooseAgent;
import 'support/mixed_agents.dart';
import 'support/password_cli.dart';
import 'support/machine_api.dart';
import 'support/rename_connection.dart';
import 'support/stop_connection.dart';
import 'support/fork_connection.dart';
import 'support/restart_connection.dart';
import 'terminal_find_test.dart' show findField, finishFind, output;

class _PreviewLink implements PeerLinkClient {
  final result = Completer<CliLinkConnectResult>();
  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
  }) {
    onProgress?.call('verifying');
    return result.future;
  }

  @override
  Future<CliLinkListResult> list() async => const CliLinkListResult(
    machines: [
      LinkedMachine(
        machineId: 'studio',
        fingerprint: 'AA24·B561·0B81·EF21',
        linkedAt: '2026-09-19 12:00',
      ),
    ],
  );
  @override
  Future<String?> unlink(String machineId) async => null;
}

class _PreviewConnection extends WsConn {
  _PreviewConnection({this.pendingCreation = false})
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final bool pendingCreation;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => switch (type) {
    'engines_probe' => {
      'engines': [
        for (final engine in allEngines)
          {
            'engine': engine.id,
            'installed': true,
            if (engine.id == 'codex') 'supportsCodexHome': true,
          },
      ],
    },
    'codex_profiles_list' => {
      'profiles': [
        {'path': '/home/developer/.codex-work', 'label': 'Work'},
      ],
    },
    'dsh_list' => {'dsh': []},
    'agent_create' =>
      pendingCreation
          ? throw const WsRequestTimeout('agent_create')
          : throw StateError('Rendering must never create an agent'),
    _ => {},
  };
}

/// PICTURES OF THE BOX, WITHOUT A SCREEN.
///
/// A widget test draws text in Ahem — solid blocks — so nobody can judge how a
/// surface LOOKS from one. This loads the real fonts and writes each state of
/// the box as a PNG, so the look can be reviewed on a machine whose display is
/// asleep or locked, in CI, or by a reviewer who cannot run the app.
///
/// Off unless asked for, because it depends on this Mac's system font:
///
///     BOX_RENDER_DIR=/tmp/box flutter test --update-goldens \\
///         test/box_render_preview_test.dart
Future<void> loadPreviewFonts() async {
  Future<void> load(String family, List<String> files) async {
    final loader = FontLoader(family);
    var any = false;
    for (final path in files) {
      final file = File(path);
      if (!file.existsSync()) continue;
      any = true;
      final bytes = file.readAsBytesSync();
      loader.addFont(Future.value(ByteData.view(bytes.buffer)));
    }
    if (any) await loader.load();
  }

  final flutterRoot = Platform.environment['FLUTTER_ROOT'] ?? '';
  final materialFonts = '$flutterRoot/bin/cache/artifacts/material_fonts';
  const system = '/System/Library/Fonts/SFNS.ttf';
  // Whatever the theme asks for, draw it in the system face.
  for (final family in ['Roboto', '.AppleSystemUIFont', '.SF NS', 'Inter']) {
    await load(family, [system, '$materialFonts/Roboto-Regular.ttf']);
  }
  for (final family in [
    '.AppleSystemUIFontMonospaced',
    'Menlo',
    'DejaVu Sans Mono',
    'monospace',
  ]) {
    await load(family, ['/System/Library/Fonts/Menlo.ttc']);
  }
  await load('MaterialIcons', ['$materialFonts/MaterialIcons-Regular.otf']);
  final home = Platform.environment['HOME'] ?? '';
  final lucideRoot = Directory('$home/.pub-cache/hosted/pub.dev')
      .listSync()
      .whereType<Directory>()
      .where((dir) => dir.path.contains('/lucide_icons_flutter-'))
      .map((dir) => dir.path)
      .fold<String?>(
        null,
        (best, path) => best == null || path.compareTo(best) > 0 ? path : best,
      );
  if (lucideRoot != null) {
    await load('packages/lucide_icons_flutter/Lucide', [
      '$lucideRoot/assets/lucide.ttf',
    ]);
    for (final weight in [100, 200, 300, 400, 500, 600]) {
      await load('packages/lucide_icons_flutter/Lucide$weight', [
        '$lucideRoot/assets/build_font/LucideVariable-w$weight.ttf',
      ]);
    }
  }
}

void main() {
  final dir = Platform.environment['BOX_RENDER_DIR'];

  testWidgets(
    'renders the box to PNGs',
    skip: dir == null,
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    (tester) async {
      await tester.runAsync(loadPreviewFonts);
      // Tests draw shadows as solid black slabs; a picture wants the real thing.
      debugDisableShadows = false;
      newHarnessOpensInBox = true;
      addTearDown(() => newHarnessOpensInBox = false);

      final app = createApp(connectionForTest: (_) => _PreviewConnection());
      app.machineStates['m']!.nodeOnline = true;
      for (final id in ['a0', 'a1']) {
        app.adoptSessionForTest(terminal(id, []));
        await app.addAgentToSwarm('m', id);
      }
      await mount(tester, app);

      Future<void> shot(String name) async {
        await tester.pump(const Duration(milliseconds: 50));
        await expectLater(
          find.byType(MaterialApp),
          matchesGoldenFile(Uri.file('$dir/$name.png')),
        );
      }

      Future<void> type(Finder input, String text) async {
        await tester.enterText(input, text);
        await tester.pump();
      }

      final search = find.byKey(const ValueKey('swarm-search-input'));
      await chord(tester, LogicalKeyboardKey.keyP);
      await shot('01-new-pane-empty');
      await type(search, 'age');
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
      await shot('02-new-pane-typed');
      await chord(tester, LogicalKeyboardKey.keyT);
      await shot('03-new-tab-empty');
      await type(search, 'Agent 12');
      await shot('04-new-tab-typed');
      await type(search, 'zzqq');
      await shot('05-new-tab-create-only');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();

      final line = find.byKey(const ValueKey('new-harness-input'));
      final contextPicker = tester
          .widget<NewHarnessBox>(find.byType(NewHarnessBox))
          .controller;
      contextPicker.setFolder('/work/payments');
      await app.projectHistory.select('m', '/work/payments');
      app.machineStates['m']!.localProjects = {
        for (final (index, name) in [
          'product-video',
          'website',
          'research',
        ].indexed)
          'a${index + 2}': AgentProject(name: name, cwd: '/work/$name'),
      };
      await shot('06-launch-menu');
      await key(tester, LogicalKeyboardKey.arrowDown);
      await shot('06-launch-agent-selected');
      await key(tester, LogicalKeyboardKey.arrowDown);
      await key(tester, LogicalKeyboardKey.arrowDown);
      await shot('06-launch-project-selected');
      tester.view.physicalSize = const Size(600, 680);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await tester.pumpAndSettle();
      await shot('06-launch-large-text');
      tester.view.physicalSize = const Size(1280, 800);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      await openLegacyTaskEditor(tester);
      await tester.pump();
      await type(line, '');
      await shot('07-new-tab-task-empty');
      await type(line, 'Plan the launch\nInclude the product demo');
      await shot('07-new-tab-task-multiline');
      await type(line, 'fix the flaky login test');
      await shot('07-new-tab-task-typed');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await openLaunchRow(tester, 'agent');
      await tester.pump();
      await shot('08-new-agent');
      await type(line, 'Claude Code');
      await key(tester, LogicalKeyboardKey.enter);
      await openLaunchRow(tester, 'agent');
      final previewAgent = tester
          .widget<NewHarnessBox>(find.byType(NewHarnessBox))
          .controller;
      for (
        var step = 0;
        previewAgent.selected?.id != 'codex' && step < 30;
        step++
      ) {
        await key(tester, LogicalKeyboardKey.arrowUp);
      }
      expect(previewAgent.selected?.id, 'codex');
      expect(previewAgent.engine, 'claude');
      await shot('08-codex-highlighted-from-claude');
      await type(line, 'co');
      await shot('09-new-agent-filtered');
      await openAgentSetting(
        tester,
        'codex',
        NewHarnessController.permissionsId,
      );
      await shot('09-agent-permissions');
      await type(line, 'ask');
      await key(tester, LogicalKeyboardKey.enter);
      await openAgentSetting(tester, 'codex', NewHarnessController.profileId);
      await tester.pump(const Duration(milliseconds: 200));
      await shot('09-codex-profiles');
      await type(line, 'Work');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await shot('09-configured-agent');
      await openLaunchRow(tester, 'project');
      await tester.pump();
      await shot('10-new-project');
      for (final name in [
        'payments',
        'website',
        'research',
        'robotics',
        'music',
        'documents',
        'analytics',
        'launch',
        'support',
        'design',
        'prototype',
        'experiments',
      ]) {
        await app.projectHistory.select(contextPicker.machineId, '/work/$name');
      }
      app.notifyListeners();
      await tester.pump(const Duration(milliseconds: 200));
      await shot('10-project-many-recents');
      await key(tester, LogicalKeyboardKey.pageUp);
      await key(tester, LogicalKeyboardKey.pageUp);
      await shot('10-project-older-recents');
      tester.view.physicalSize = const Size(600, 680);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await tester.pumpAndSettle();
      await shot('10-project-recents-large-text');
      tester.view.physicalSize = const Size(1280, 800);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      await type(line, 'pay');
      await shot('10-project-filtered');
      await type(line, 'no-matching-project');
      await shot('10-project-no-matches');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await shot('10-existing-project');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await shot('10-github-empty');
      await type(line, 'https://github.com/acme/payments');
      await shot('10-github-repository');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      contextPicker.accept(
        contextPicker.options.firstWhere(
          (row) => row.id == NewHarnessController.newProjectId,
        ),
      );
      await tester.pump();
      await shot('11-project-name-empty');
      await type(line, 'payments processing');
      await shot('11-new-project-named');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await shot('11-project-selected');
      await openLaunchRow(tester, 'machine');
      await tester.pump();
      await shot('12-project-machine');
      for (var i = 0; i < 1; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
      }
      contextPicker.focusField(NewHarnessField.task);
      contextPicker.setQuery('');
      contextPicker.focusField(NewHarnessField.agent);
      contextPicker.accept(const NewHarnessOption(id: 'pi', title: 'Pi'));
      await tester.pump();
      await shot('12-pi-task-availability');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byKey(const ValueKey('new-harness-box')), findsNothing);

      await chord(tester, LogicalKeyboardKey.keyP, shift: true);
      await shot('13-command-open');
      await type(search, '> spl');
      await shot('13-command-palette');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();

      await seedPreviews(app);
      final previousAppearance = appearancePrefsStore.value;
      addTearDown(() => appearancePrefsStore.value = previousAppearance);
      await chord(tester, LogicalKeyboardKey.keyP);
      for (final style in PromptStyle.values) {
        appearancePrefsStore.value = previousAppearance.copyWith(
          prompt: PromptPrefs(style: style),
        );
        await shot('14-prompt-${style.name}');
      }
      tester.view.physicalSize = const Size(600, 540);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await shot('14-prompt-powerline-narrow');
      tester.view.physicalSize = const Size(1280, 800);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      appearancePrefsStore.value = previousAppearance;
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await chord(tester, LogicalKeyboardKey.keyP);
      await type(search, 'Checkout');
      await shot('14-search-preview');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      tester.view.physicalSize = const Size(600, 800);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await chord(tester, LogicalKeyboardKey.keyT);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      final largeBox = tester
          .widget<NewHarnessBox>(find.byType(NewHarnessBox))
          .controller;
      largeBox.setFolder('/work/payments');
      await shot('15-create-large-text');
      await openLegacyTaskEditor(tester);
      await tester.pump();
      await shot('15-task-large-text');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await openLaunchRow(tester, 'project');
      await tester.pump();
      await shot('15-project-menu-large-text');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await openLaunchRow(tester, 'agent');
      await tester.pump();
      await shot('16-agent-large-text');

      tester.view.physicalSize = const Size(1280, 800);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      final create = tester
          .widget<NewHarnessBox>(find.byType(NewHarnessBox))
          .controller;
      create.focusField(NewHarnessField.projectName);
      create.setQuery('Super terminal');
      create.accept();
      create.focusField(NewHarnessField.mode);
      create.setQuery('Plan first');
      create.accept();
      await tester.pump();
      await chord(tester, LogicalKeyboardKey.period);
      await tester.pump(const Duration(milliseconds: 200));
      await shot('17-advanced-keeps-context');
      await tester.tap(find.byKey(const Key('new-agent-agent-field')));
      await tester.pump();
      await shot('18-advanced-agent-search');
      await key(tester, LogicalKeyboardKey.slash, ctrl: true);
      await shot('19-advanced-agent-preview');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      tester.view.physicalSize = const Size(600, 800);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await shot('20-advanced-large-text');

      tester.view.physicalSize = const Size(1280, 800);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      await tester.pump();
      await chooseAgent(tester, 'codex');
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('new-agent-task')),
        'Review the keyboard flow\nKeep the patch small',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byType(NewHarnessBox), findsOneWidget);
      await shot('21-returned-draft');
      tester.view.physicalSize = const Size(600, 800);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await shot('22-returned-draft-large-text');

      tester.view.physicalSize = const Size(1280, 800);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      await tester.pump();
      await chord(tester, LogicalKeyboardKey.period);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('new-agent-agent-field')));
      await tester.pump();
      await key(tester, LogicalKeyboardKey.slash, ctrl: true);
      tester.view.physicalSize = const Size(600, 800);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await shot('23-agent-search-resized-large-text');
      tester.view.physicalSize = const Size(700, 420);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      await shot('24-agent-search-resized-short');

      await tester.pumpWidget(const SizedBox());
      app.dispose();

      final catalogApp = createApp();
      seedMixedAgents(catalogApp);
      catalogApp.adoptSessionForTest(terminal('a0', []));
      await mount(tester, catalogApp);
      await chord(tester, LogicalKeyboardKey.keyP);
      await key(tester, LogicalKeyboardKey.slash, ctrl: true);
      await shot('25-mixed-catalog');
      await type(search, '?');
      await shot('25-quick-access-help');
      await type(search, '> zoom');
      await shot('25-quick-access-commands');
      await type(search, '# openharness');
      await shot('25-quick-access-projects');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await shot('25-quick-access-project-agents');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await type(search, '@ Office');
      await shot('25-quick-access-machines');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await shot('25-quick-access-machine-agents');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await type(search, 'login');
      await shot('26-matching-same-task');
      await key(tester, LogicalKeyboardKey.slash, ctrl: true);
      await shot('27-mixed-catalog-preview');
      await key(tester, LogicalKeyboardKey.slash, ctrl: true);
      tester.view.physicalSize = const Size(600, 800);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await shot('28-mixed-catalog-large-text');
      await tester.pumpWidget(const SizedBox());
      catalogApp.dispose();

      tester.platformDispatcher.clearTextScaleFactorTestValue();
      final pendingApp = createApp(
        connectionForTest: (_) => _PreviewConnection(pendingCreation: true),
      );
      pendingApp.machineStates['m']!.nodeOnline = true;
      pendingApp.adoptSessionForTest(terminal('a0', []));
      await mount(tester, pendingApp);
      await chord(tester, LogicalKeyboardKey.keyT);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await shot('29-pending-creation');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await chord(tester, LogicalKeyboardKey.keyP);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      tester.view.physicalSize = const Size(600, 800);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await shot('30-resumed-pending-large-text');
      await tester.pumpWidget(const SizedBox());
      pendingApp.dispose();

      tester.platformDispatcher.clearTextScaleFactorTestValue();
      final workspaceApp = createApp();
      seedMixedAgents(workspaceApp);
      for (var i = 0; i < 4; i++) {
        final session = terminal('a$i', []);
        session.agentName = workspaceApp.machineStates['m']!.agents[i].name;
        workspaceApp.adoptSessionForTest(session);
      }
      workspaceApp.setPreset(4, PanePreset.quad);
      workspaceApp.renameSwarm(workspaceApp.activeSwarmId, 'Feature work');
      await mount(tester, workspaceApp);
      await tester.pump(const Duration(milliseconds: 100));
      for (var i = 0; i < workspaceApp.panes.length; i++) {
        final session = workspaceApp.panes[i].session!;
        // This render fixture exercises the workspace frame; no PTY is run.
        session.terminal.write('\x1b[36m❯\x1b[0m ');
      }

      await chord(tester, LogicalKeyboardKey.keyP, shift: true);
      await type(search, '> resize panes');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await shot('31-keyboard-resize');
      tester.view.physicalSize = const Size(600, 800);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await shot('32-keyboard-resize-large-text');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      tester
          .widget<IconButton>(
            find.widgetWithIcon(IconButton, Icons.more_horiz).first,
          )
          .focusNode!
          .requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await shot('35-pane-actions-narrow');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      Focus.of(tester.element(find.byIcon(Icons.tune).first)).requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await shot('36-model-menu-narrow');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      tester.view.physicalSize = const Size(1280, 800);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      for (var i = 4; i < 16; i++) {
        workspaceApp.machineStates['m']!.agents = [
          ...workspaceApp.machineStates['m']!.agents,
          Agent(
            id: 'a$i',
            name: 'Feature ${i - 2}',
            engine: 'codex',
            terminalAvailable: true,
          ),
        ];
        workspaceApp.newSwarm(name: 'Feature ${i - 2}');
        workspaceApp.adoptSessionForTest(
          terminal('a$i', [])..agentName = 'Feature ${i - 2}',
        );
      }
      await tester.pump();
      await chord(tester, LogicalKeyboardKey.digit9);
      await shot('33-many-tabs-keyboard');
      tester.view.physicalSize = const Size(600, 800);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await shot('34-many-tabs-narrow');
      await tester.pumpWidget(const SizedBox());
      workspaceApp.dispose();

      tester.view.physicalSize = const Size(1280, 800);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      final findApp = createApp();
      seedMixedAgents(findApp);
      final readingSession = terminal('a0', [])
        ..agentName = 'Fix login redirect';
      findApp.adoptSessionForTest(readingSession);
      await mount(tester, findApp);
      await output(
        readingSession,
        0,
        'Reviewing the redirect handler\r\n'
        'checkpoint: original query survives authentication\r\n'
        'checkpoint: sessions stay attached\r\n'
        'ready> ',
        keyframe: true,
      );
      await chord(tester, LogicalKeyboardKey.keyF);
      await tester.enterText(findField, 'checkpoint');
      await finishFind(tester);
      await shot('37-output-find');
      tester.view.physicalSize = const Size(600, 800);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await shot('38-output-find-large-text');
      await tester.tap(find.byTooltip('Find options'));
      await tester.pump();
      await key(tester, LogicalKeyboardKey.arrowDown);
      await key(tester, LogicalKeyboardKey.arrowUp);
      await shot('39-output-find-options');
      await key(tester, LogicalKeyboardKey.escape);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpWidget(const SizedBox());
      findApp.dispose();

      tester.view.physicalSize = const Size(1280, 800);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      final links = _PreviewLink();
      final passwordCli = PasswordCli();
      final linkApp = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        peerLinks: links,
        cliLink: passwordCli,
      )..hasNavigationRail = false;
      seedMixedAgents(linkApp);
      linkApp.adoptSessionForTest(terminal('a0', []));
      linkApp.machineStates['studio']!.needsLink = true;
      linkApp.selectedMachineId = 'studio';
      await mount(tester, linkApp);
      await tester.pumpAndSettle();
      await shot('40-link-machine');
      await tester.enterText(
        find.byKey(const Key('remote-password-connect-field')),
        'fixture password',
      );
      await key(tester, LogicalKeyboardKey.enter);
      await shot('41-link-pending');
      links.result.complete(
        const CliLinkConnectResult(
          error: 'Incorrect password. Enter the password set on iMac · Office.',
        ),
      );
      await tester.pumpAndSettle();
      await shot('42-link-error');
      tester.view.physicalSize = const Size(600, 420);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await shot('43-link-small-large-text');
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      tester.view.physicalSize = const Size(1280, 800);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      linkApp.machineStates['m']!.localOnly = true;
      await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        '> link machine',
      );
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await shot('44-machine-chooser');
      final machineSearch = find.byKey(const Key('link-machine-search'));
      await tester.enterText(machineSearch, 'ssh');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await shot('45-machine-ssh-guide');
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await tester.enterText(machineSearch, 'desktop');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await shot('46-machine-desktop-guide');
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await tester.enterText(machineSearch, 'zzzz');
      await shot('47-machine-no-match');
      await tester.enterText(machineSearch, 'ssh');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      tester.view.physicalSize = const Size(600, 420);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await shot('48-machine-guide-small-large-text');
      await key(tester, LogicalKeyboardKey.escape);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      tester.view.physicalSize = const Size(1280, 800);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        '> link machine',
      );
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await tester.enterText(machineSearch, 'password');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await shot('49-own-password-prompt');
      passwordCli.setReply = Completer<RemotePasswordSetResult>();
      await tester.enterText(
        find.byKey(const Key('remote-password-field')),
        'fixture password',
      );
      await key(tester, LogicalKeyboardKey.enter);
      await tester.enterText(
        find.byKey(const Key('remote-password-confirm-field')),
        'fixture password',
      );
      await key(tester, LogicalKeyboardKey.enter);
      await shot('50-own-password-pending');
      passwordCli.setReply!.complete(
        const RemotePasswordSetResult(
          error: 'Could not reach the local service. Try again.',
        ),
      );
      await tester.pumpAndSettle();
      await shot('51-own-password-error');
      passwordCli.setReply = null;
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await shot('52-own-password-set');
      await tester.tap(find.byKey(const Key('remote-password-clear-button')));
      await tester.pumpAndSettle();
      await shot('53-own-password-clear');
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('remote-password-links-button')));
      await tester.pumpAndSettle();
      await shot('54-outgoing-links');
      await tester.tap(find.byKey(const Key('unlink-studio')));
      await tester.pumpAndSettle();
      await shot('55-unlink-machine');
      await key(tester, LogicalKeyboardKey.escape);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('remote-password-change-button')));
      await tester.pumpAndSettle();
      tester.view.physicalSize = const Size(480, 360);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await shot('56-own-password-small-large-text');
      await tester.pumpWidget(const SizedBox());
      linkApp.dispose();

      tester.view.physicalSize = const Size(1280, 800);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      final machineApi = MachineApi();
      final managerApp = createApp()..api = machineApi;
      seedMixedAgents(managerApp);
      managerApp.machineStates['m']!.localOnly = true;
      managerApp.adoptSessionForTest(terminal('a0', []));
      const shared = Machine(
        machineId: 'shared-fixture',
        name: 'Shared render server',
        authMode: MachineAuthMode.remote,
        isShared: true,
        ownerName: 'Morgan',
      );
      managerApp.machineStates['shared-fixture'] = MachineState(shared)
        ..nodeOnline = true;
      managerApp.machines.add(shared);
      await mount(tester, managerApp);
      await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        '> machines manager',
      );
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      final managerSearch = find.byKey(const Key('machines-manager-search'));
      await shot('57-machines-manager');
      await tester.enterText(managerSearch, 'office');
      await shot('58-machines-filtered');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await shot('59-machine-actions');
      await tester.enterText(managerSearch, 'rename');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      final renameInput = find.byKey(const Key('machine-rename-input'));
      await shot('60-machine-rename');
      machineApi.renameReply = Completer<String?>();
      await tester.enterText(renameInput, 'Office builder');
      await key(tester, LogicalKeyboardKey.enter);
      await shot('61-machine-rename-pending');
      machineApi.renameReply!.completeError(
        ApiException('Could not reach your account. Try again.'),
      );
      await tester.pumpAndSettle();
      await shot('62-machine-rename-error');
      machineApi.renameReply = null;
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await tester.enterText(managerSearch, 'delete');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await shot('63-machine-delete');
      machineApi.deleteFailure = ApiException(
        'Could not reach your account. Try again.',
      );
      await key(tester, LogicalKeyboardKey.tab);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await shot('64-machine-delete-error');
      await key(tester, LogicalKeyboardKey.escape);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await tester.enterText(managerSearch, 'shared');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await shot('65-shared-machine');
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await tester.enterText(managerSearch, 'office');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      tester.view.physicalSize = const Size(480, 360);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await shot('66-machine-actions-small-large-text');
      await tester.enterText(managerSearch, 'rename');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await shot('67-machine-rename-small-large-text');
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      managerApp.machineStates.remove('studio');
      managerApp.machines.removeWhere(
        (machine) => machine.machineId == 'studio',
      );
      managerApp.notifyListeners();
      await shot('68-machine-unavailable-small-large-text');
      await tester.pumpWidget(const SizedBox());
      managerApp.dispose();
      tester.view.physicalSize = const Size(1280, 800);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      final renameConnection = RenameConnection();
      final renameApp = createApp(connectionForTest: (_) => renameConnection);
      seedMixedAgents(renameApp);
      renameApp.adoptSessionForTest(terminal('a0', []));
      await mount(tester, renameApp);
      Future<void> renameCommand(String query) async {
        await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
        await tester.enterText(
          find.byKey(const ValueKey('swarm-search-input')),
          '> $query',
        );
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
      }

      await renameCommand('rename tab');
      await shot('69-tab-rename');
      await tester.enterText(find.byKey(const Key('tab-rename-input')), '');
      await key(tester, LogicalKeyboardKey.enter);
      await shot('70-tab-rename-validation');
      await key(tester, LogicalKeyboardKey.escape);
      await renameCommand('rename agent');
      final agentRename = find.byKey(const Key('agent-rename-input'));
      await shot('71-agent-rename');
      await tester.enterText(agentRename, 'Resolve parser edge cases');
      await key(tester, LogicalKeyboardKey.enter);
      await shot('72-agent-rename-pending');
      renameConnection.replies.single.complete({
        'error': 'OFFLINE',
        'detail': 'Reconnect and retry.',
      });
      await tester.pumpAndSettle();
      await shot('73-agent-rename-error');
      tester.view.physicalSize = const Size(480, 360);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await shot('74-agent-rename-small-large-text');
      await key(tester, LogicalKeyboardKey.escape);
      await renameCommand('rename tab');
      await shot('75-tab-rename-small-large-text');
      await tester.pumpWidget(const SizedBox());
      renameApp.dispose();
      tester.view.physicalSize = const Size(1280, 800);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      final stopConnection = StopConnection();
      final stopApp = createApp(connectionForTest: (_) => stopConnection);
      seedMixedAgents(stopApp);
      stopApp.adoptSessionForTest(terminal('a0', []));
      stopApp.adoptSessionForTest(terminal('a1', []));
      await mount(tester, stopApp);
      await renameCommand('stop');
      await shot('76-agent-stop');
      await key(tester, LogicalKeyboardKey.tab);
      await shot('77-agent-stop-confirm');
      await key(tester, LogicalKeyboardKey.enter);
      await shot('78-agent-stop-pending');
      await key(tester, LogicalKeyboardKey.escape);
      await renameCommand('stop');
      await shot('79-agent-stop-reopened');
      stopConnection.stopReplies.single.complete({
        'error': 'OFFLINE',
        'detail': 'Reconnect and retry.',
      });
      await tester.pumpAndSettle();
      await shot('80-agent-stop-error');
      tester.view.physicalSize = const Size(480, 360);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await shot('81-agent-stop-small-large-text');
      await key(tester, LogicalKeyboardKey.escape);
      stopApp.stateOf('m')!.agents = [
        const Agent(id: 'a1', name: 'Build shell', engine: 'terminal'),
      ];
      stopApp.notifyListeners();
      await renameCommand('stop');
      await shot('82-terminal-stop-small-large-text');
      await key(tester, LogicalKeyboardKey.pageDown);
      await key(tester, LogicalKeyboardKey.pageDown);
      await shot('83-terminal-stop-details-small-large-text');
      await tester.pumpWidget(const SizedBox());
      stopApp.dispose();
      tester.view.physicalSize = const Size(1280, 800);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      final forkConnection = ForkConnection();
      final forkApp = createApp(connectionForTest: (_) => forkConnection);
      seedMixedAgents(forkApp);
      forkApp.adoptSessionForTest(terminal('a0', []));
      await mount(tester, forkApp);
      await renameCommand('fork');
      await shot('84-fork-agent');
      final task = find.byKey(const ValueKey('fork-task'));
      await tester.enterText(
        task,
        'Try a smaller parser change\nKeep the public API stable.',
      );
      await shot('85-fork-task');
      await key(tester, LogicalKeyboardKey.enter);
      await shot('86-fork-pending');
      await key(tester, LogicalKeyboardKey.escape);
      await renameCommand('fork');
      await shot('87-fork-reopened');
      forkConnection.forkReplies.single.complete({
        'creationId': forkConnection.forks.last['creationId'],
        'state': 'failed',
        'failure': {
          'code': 'BUSY',
          'detail': 'Wait for the turn to finish, then fork.',
        },
      });
      await tester.pumpAndSettle();
      await shot('88-fork-error');
      await key(tester, LogicalKeyboardKey.enter);
      forkConnection.forkReplies.last.completeError(
        const WsRequestTimeout('agent_fork'),
      );
      await tester.pumpAndSettle();
      await shot('89-fork-unconfirmed');
      tester.view.physicalSize = const Size(480, 360);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await shot('90-fork-small-large-text');
      await key(tester, LogicalKeyboardKey.pageDown);
      await key(tester, LogicalKeyboardKey.pageDown);
      await shot('91-fork-details-small-large-text');
      await key(tester, LogicalKeyboardKey.escape);
      forkApp.discardForkAttempt('m', 'a0', forkApp.forkAttempt('m', 'a0'));
      forkApp.stateOf('m')!.agents = [
        const Agent(id: 'a0', name: 'Fix login redirect', engine: 'opencode'),
      ];
      forkApp.notifyListeners();
      tester.view.physicalSize = const Size(1280, 800);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      await renameCommand('fork');
      await shot('92-fork-handoff');
      await tester.pumpWidget(const SizedBox());
      forkApp.dispose();
      final restartConnection = RestartConnection();
      final restartApp = createApp(connectionForTest: (_) => restartConnection);
      seedMixedAgents(restartApp);
      restartApp.adoptSessionForTest(terminal('a0', []));
      await mount(tester, restartApp);
      await renameCommand('restart');
      await shot('93-restart-pending');
      await key(tester, LogicalKeyboardKey.escape);
      await renameCommand('restart');
      await shot('94-restart-reopened');
      restartConnection.restartReplies.single.complete({
        'creationId': restartConnection.requests.last['creationId'],
        'state': 'failed',
        'failure': {
          'code': 'AGENT_BUSY',
          'detail': 'Another operation is changing this agent. Wait for it to finish, then retry.',
        },
      });
      await tester.pumpAndSettle();
      await shot('95-restart-error');
      await key(tester, LogicalKeyboardKey.enter);
      restartConnection.restartReplies.last.completeError(
        const WsRequestTimeout('agent_restart'),
      );
      await tester.pumpAndSettle();
      await shot('96-restart-unconfirmed');
      await key(tester, LogicalKeyboardKey.tab);
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await shot('97-restart-again');
      tester.view.physicalSize = const Size(480, 360);
      tester.platformDispatcher.textScaleFactorTestValue = 1.7;
      await shot('98-restart-again-small-large-text');
      await key(tester, LogicalKeyboardKey.escape);
      await shot('99-restart-small-large-text');
      await key(tester, LogicalKeyboardKey.pageDown);
      await key(tester, LogicalKeyboardKey.pageDown);
      await shot('100-restart-details-small-large-text');
      tester.view.physicalSize = const Size(1280, 800);
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      await key(tester, LogicalKeyboardKey.enter);
      restartConnection.checkReplies.single.complete(
        restartReceipt(
          restartConnection.requests.last['creationId'] as String,
          resumed: false,
        ),
      );
      await tester.pumpAndSettle();
      await shot('101-restart-fresh-conversation');
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      restartApp.stateOf('m')!.agents = [
        const Agent(
          id: 'a0',
          name: 'Build shell',
          engine: 'terminal',
          terminalAvailable: true,
        ),
      ];
      restartApp.notifyListeners();
      await renameCommand('restart');
      await shot('102-restart-terminal');
      await tester.pumpWidget(const SizedBox());
      restartApp.dispose();
      debugDisableShadows = true;
    },
  );
}
