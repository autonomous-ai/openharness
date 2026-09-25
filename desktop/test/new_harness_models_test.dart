import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/codex_profiles.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/usage/models_menu_controller.dart';
import 'package:harness/usage/usage_accounts.dart';
import 'package:harness/usage/usage_controller.dart';
import 'package:harness/usage/usage_source.dart';
import 'package:harness/usage/usage_window.dart';
import 'package:harness/widgets/new_agent_dialog.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/agent_picker.dart';
import 'support/launch_menu.dart';
import 'support/mixed_agents.dart';
import 'swarm_state_test.dart' show createApp;

Map<String, dynamic> catalog() => {
  'supportsModelLaunch': true,
  'gridName': 'my-grid',
  'localModelEngines': ['codex', 'claude', 'opencode'],
  'grids': [
    {
      'name': 'my-grid',
      'own': true,
      'models': [
        {'id': 'Qwen-35B', 'node': 'Mac Studio'},
      ],
    },
    {
      'name': 'team-grid',
      'own': false,
      'models': [
        {'id': 'Qwen-35B', 'node': 'GPU Server'},
      ],
    },
  ],
};

class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  Map<String, dynamic> answer = catalog();
  Future<Map<String, dynamic>>? waiting;
  bool loseReply = false;
  final creates = <Map<String, dynamic>>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    switch (type) {
      case 'grid_models_list':
        return waiting ?? answer;
      case 'git_project_info':
        return {'isGit': false};
      case 'dsh_list':
        return {
          'dsh': [
            {
              'id': 'acme/scene',
              'name': 'Scene',
              'engine': 'claude',
              'engines': ['codex', 'claude'],
              'installed': true,
            },
          ],
        };
      case 'engines_probe':
        return {'engines': []};
      case 'agent_create':
        creates.add(Map.of(payload));
        if (loseReply) throw const WsRequestTimeout('agent_create');
        return {
          'creationId': payload['creationId'],
          'state': 'created',
          'agent': {
            'id': 'created',
            'name': 'Created',
            'engine': payload['engine'],
          },
        };
      case 'agent_create_status':
        return {
          'creationId': payload['creationId'],
          'state': 'created',
          'agent': {'id': 'created', 'name': 'Created', 'engine': 'codex'},
        };
      default:
        return {};
    }
  }
}

class _Source implements UsageSource {
  _Source(this.provider, this.account);
  @override
  final UsageProvider provider;
  final String account;
  @override
  Future<ProviderUsage> read() async => ProviderUsage(
    provider: provider,
    status: UsageStatus.ok,
    account: account,
    fetchedAt: DateTime.now(),
    windows: const [UsageWindow(label: 'Session', usedPercent: 25)],
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Map<String, _Connection> connections;
  late AppNotifier app;
  NewHarnessController controller({
    ModelsMenuController? usage,
    NewHarnessDraft? draft,
  }) {
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/work/scene',
      modelUsage: usage,
      draft: draft,
    );
    addTearDown(box.dispose);
    return box;
  }

  Future<void> load(NewHarnessController box) async {
    box.focusField(NewHarnessField.model);
    await box.refreshModels();
  }

  NewHarnessOption localChoice(
    NewHarnessController box, [
    String grid = 'my-grid',
  ]) => box.options.singleWhere((option) => option.model?.grid == grid);
  void select(NewHarnessController box, NewHarnessField field, String id) {
    box.focusField(field);
    box.applyOption(box.options.singleWhere((option) => option.id == id));
  }

  setUp(() {
    connections = {};
    app = createApp(
      connectionForTest: (machine) =>
          connections.putIfAbsent(machine, _Connection.new),
    );
    seedMixedAgents(app);
    app.gitProjectReaderForTest = (_, _) async => {'isGit': false};
    addTearDown(app.dispose);
  });
  test('creation rejects an old daemon, lost connection, unsupported engine and missing model before launching', () async {
    final connection = connections.putIfAbsent('m', _Connection.new);
    const model = GridModel(
      id: 'Qwen-35B',
      node: 'Mac Studio',
      grid: 'my-grid',
    );
    for (final (answer, engine, message) in [
      ({'error': 'OFFLINE'}, 'codex', 'Could not verify models'),
      ({'gridName': 'my-grid'}, 'codex', 'Update Harness CLI'),
      (catalog(), 'cursor', 'selected model is unavailable'),
      ({...catalog(), 'grids': []}, 'codex', 'selected model is unavailable'),
    ]) {
      connection.answer = answer;
      expect(
        await app.createAgent(
          'm',
          engine: engine,
          folder: '/work',
          model: model,
        ),
        contains(message),
      );
      expect(connection.creates, isEmpty);
    }
  });

  test('subscriptions and cross-machine models remain distinct, including duplicate model names on two grids', () async {
    final box = controller();
    await load(box);
    expect(box.options.where((o) => !o.synthetic).map((o) => o.group), [
      'Subscription',
      'On your machines',
      'Shared · team-grid',
    ]);
    final remote = localChoice(box, 'team-grid');
    box.applyOption(remote);
    expect(box.modelLabel, 'Qwen-35B · GPU Server');
    expect(box.machineId, 'm');
    expect(box.project.folder, '/work/scene');
    expect(box.isCurrent(remote), isTrue);
    expect(box.isCurrent(localChoice(box)), isFalse);
    expect(box.usesProfile, isFalse);
    box.setQuery('studio');
    expect(box.options.where((o) => !o.synthetic).single.detail, 'Mac Studio');
    box.setQuery('');
    box.applyOption(
      box.options.singleWhere(
        (o) => o.id == NewHarnessController.defaultModelId,
      ),
    );
    expect(box.model, isNull);
    expect(box.modelLabel, 'OpenAI');
    expect(box.usesProfile, isTrue);
  });
  test('inline choices reject an agent invalidated by a harness change and a profile from another machine', () async {
    final box = controller();
    await app.probeDsh('m', force: true);
    box.focusField(NewHarnessField.agent);
    final cursor = box.options.singleWhere((option) => option.id == 'cursor');
    select(box, NewHarnessField.harness, 'acme/scene');
    box.focusField(NewHarnessField.agent);
    box.applyOption(cursor);
    expect(box.engine, 'codex');
    expect(box.error, contains('compatible with Scene'));

    box.focusField(NewHarnessField.profile);
    final profile = box.options.singleWhere(
      (option) => option.id == NewHarnessController.defaultProfileId,
    );
    select(box, NewHarnessField.machine, 'studio');
    box.focusField(NewHarnessField.profile);
    box.applyOption(profile);
    expect(box.machineId, 'studio');
    expect(box.error, contains('machine has changed'));
    expect(
      connections.values.expand((connection) => connection.creates),
      isEmpty,
    );
  });

  for (final terminal in [false, true]) {
    testWidgets(
      'legacy model draft restores and launches correctly (terminal=$terminal)',
      (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(1300, 1100);
        addTearDown(tester.view.reset);
        final box = controller();
        await load(box);
        box.applyOption(localChoice(box));
        box.toggleAdvanced();
        NewHarnessDraft? returned;
        await tester.pumpWidget(
          MaterialApp(
            home: Builder(
              builder: (context) => Scaffold(
                body: TextButton(
                  onPressed: () => showNewAgentDialog(
                    context,
                    app,
                    'm',
                    source: 'test',
                    initialDraft: box.draft,
                    initiallyAdvanced: true,
                    onBack: (draft) => returned = draft,
                  ),
                  child: const Text('open'),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();
        expect(
          find.text('Model. Qwen-35B · Mac Studio', findRichText: true),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('new-agent-codex-profile-field')),
          findsNothing,
        );
        if (terminal) {
          await chooseAgent(tester, 'terminal');
          await tester.pumpAndSettle();
          expect(
            find.text('Model. Qwen-35B · Mac Studio', findRichText: true),
            findsNothing,
          );
        }
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(returned?.model, terminal ? isNull : same(box.model));
        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();
        if (terminal) await chooseAgent(tester, 'terminal');
        await tester.tap(find.text('New Harness').last);
        await tester.pumpAndSettle();
        expect(
          connections['m']!.creates.single['engine'],
          terminal ? 'terminal' : 'codex',
        );
        expect(
          connections['m']!.creates.single['gridModel'],
          terminal ? isNull : 'Qwen-35B',
        );
        expect(
          connections['m']!.creates.single.keys,
          isNot(contains('codexHome')),
        );
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
  test('an explicit model reaches the selected agent machine and harness without a credential', () async {
    final box = controller();
    await load(box);
    box.applyOption(localChoice(box));
    select(box, NewHarnessField.harness, 'acme/scene');
    expect(await box.create(), NewHarnessOutcome.created);
    final payload = connections['m']!.creates.single;
    expect(payload, containsPair('engine', 'codex'));
    expect(payload, containsPair('dsh', 'acme/scene'));
    expect(payload, containsPair('gridModel', 'Qwen-35B'));
    expect(payload, containsPair('gridName', 'my-grid'));
    expect(payload, containsPair('cwd', '/work/scene'));
    expect(payload.keys, isNot(contains('grid')));
    expect(payload.keys, isNot(contains('codexHome')));
  });
  test('subscription launches omit all model routing fields', () async {
    final box = controller();
    await load(box);
    expect(await box.create(), NewHarnessOutcome.created);
    expect(connections['m']!.creates.single.keys, isNot(contains('gridModel')));
    expect(connections['m']!.creates.single.keys, isNot(contains('gridName')));
  });
  testWidgets(
    'switching from a model to Terminal clears routing and still opens a shell',
    (tester) async {
      final box = controller();
      await load(box);
      box.applyOption(localChoice(box));
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: NewHarnessForm(
              controller: box,
              onClose: () {},
              onCreated: () {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await openLaunchRow(tester, 'agent');
      await typeHarnessQuery(tester, 'Terminal');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(box.engine, 'terminal');
      expect(box.model, isNull);
      expect(box.draft.model, isNull);
      expect(
        find.byKey(const ValueKey('new-harness-field-model')),
        findsNothing,
      );
      await startHarness(tester);
      await tester.pumpAndSettle();
      final payload = connections['m']!.creates.single;
      expect(payload['engine'], 'terminal');
      expect(payload.keys, isNot(contains('gridModel')));
      expect(payload.keys, isNot(contains('gridName')));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
  test('subscription details identify the selected Codex profile and retain it when returning from a model', () async {
    final box = controller(
      draft: const NewHarnessDraft(
        machineId: 'm',
        engine: 'codex',
        project: NewHarnessProject.folder('/work'),
        task: '',
        permissionMode: 'auto-approve',
        profile: LocalCodexProfile('/profiles/work', 'Work account'),
        profileChosen: true,
      ),
    );
    await load(box);
    final subscription = box.options.singleWhere(
      (option) => option.id == NewHarnessController.defaultModelId,
    );
    expect(subscription.detail, 'Work account on M2');
    box.applyOption(localChoice(box));
    expect(box.usesProfile, isFalse);
    box.applyOption(subscription);
    expect(box.usesProfile, isTrue);
    expect(box.draft.profile?.path, '/profiles/work');
  });
  test('a stopped model never falls back or creates an agent', () async {
    final box = controller();
    await load(box);
    box.applyOption(localChoice(box));
    connections['m']!.answer = {...catalog(), 'grids': []};
    expect(await box.create(), NewHarnessOutcome.failed);
    expect(box.error, contains('selected model is unavailable'));
    expect(box.model?.id, 'Qwen-35B');
    expect(connections['m']!.creates, isEmpty);
    expect(box.modelNotice, contains('selected model is unavailable'));
  });
  test(
    'changing agent preserves a chosen model but refuses incompatible launch',
    () async {
      final box = controller();
      await load(box);
      box.applyOption(localChoice(box));
      select(box, NewHarnessField.agent, 'cursor');
      expect(box.subscriptionLabel, 'Cursor');
      expect(box.modelNotice, contains('own login'));
      expect(await box.create(), NewHarnessOutcome.failed);
      await load(box);
      expect(box.options.where((o) => o.model != null), isEmpty);
      box.applyOption(
        box.options.firstWhere(
          (o) => o.id == NewHarnessController.defaultModelId,
        ),
      );
      expect(box.model, isNull);
    },
  );
  test('machine changes reject stale options and late catalogs while retaining an explicit model', () async {
    final box = controller();
    await load(box);
    final stale = localChoice(box);
    box.applyOption(stale);
    final delayed = Completer<Map<String, dynamic>>();
    connections['m']!.waiting = delayed.future;
    final pending = box.refreshModels();
    expect(box.modelNotice, 'Loading models…');
    select(box, NewHarnessField.machine, 'studio');
    await load(box);
    expect(box.model?.id, 'Qwen-35B');
    box.applyOption(stale);
    expect(box.error, contains('no longer available'));
    delayed.complete({'supportsModelLaunch': false});
    await pending;
    expect(box.options.any((o) => o.model?.id == 'Qwen-35B'), isTrue);
    expect(box.modelNotice, isNull);
    box.setFolder('/work/other');
    expect(await box.create(), NewHarnessOutcome.created);
    expect(connections['m']!.creates, isEmpty);
    expect(connections['studio']!.creates.single['gridName'], 'my-grid');
  });
  test('draft and uncertain creation retain the exact model and use status without relaunch', () async {
    final box = controller();
    await load(box);
    box.applyOption(localChoice(box));
    connections['m']!.loseReply = true;
    expect(await box.create(), NewHarnessOutcome.failed);
    expect(box.checking, isTrue);
    final restored = controller(draft: box.draft);
    expect(restored.model?.grid, 'my-grid');
    expect(await restored.create(), NewHarnessOutcome.created);
    expect(connections['m']!.creates, hasLength(1));
  });
  test('unreachable, old and empty daemons explain their state and allow a subscription', () async {
    final box = controller();
    expect(box.modelNotice, isNull);
    for (final (answer, notice) in [
      ({'error': 'OFFLINE'}, 'Could not load models'),
      ({'gridName': 'old', 'models': []}, 'Update Harness CLI'),
      ({...catalog(), 'grids': []}, 'No models are running'),
    ]) {
      connections.putIfAbsent('m', _Connection.new).answer = answer;
      await load(box);
      expect(box.modelNotice, contains(notice));
      expect(
        box.options.any((o) => o.id == NewHarnessController.defaultModelId),
        isTrue,
      );
    }
  });
  test('disposed controllers ignore outstanding model reads', () async {
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: '/work',
    );
    final delayed = Completer<Map<String, dynamic>>();
    connections.putIfAbsent('m', _Connection.new).waiting = delayed.future;
    final pending = box.refreshModels();
    box.dispose();
    delayed.complete(catalog());
    await pending;
    await box.refreshModels();
  });
  test('subscription usage matches the engine and selected machine, never another account', () async {
    final usage = UsageController(
      sources: [
        _Source(UsageProvider.codex, '1111111111111111'),
        _Source(UsageProvider.claude, '2222222222222222'),
      ],
      remote: () async => [
        MachineUsage(
          machineName: 'M2',
          readings: [
            ProviderUsage(
              provider: UsageProvider.codex,
              status: UsageStatus.ok,
              account: '3333333333333333',
              fetchedAt: DateTime.now(),
              windows: const [UsageWindow(label: 'Session', usedPercent: 40)],
            ),
          ],
        ),
      ],
      autoStart: false,
    );
    final menu = ModelsMenuController(usage: usage);
    addTearDown(menu.dispose);
    addTearDown(usage.dispose);
    await menu.refresh();
    expect(
      menu.subscriptionFor('codex', local: true, machineName: '')?['account'],
      '111111',
    );
    expect(
      menu.subscriptionFor(
        'codex',
        local: false,
        machineName: 'M2',
      )?['account'],
      '333333',
    );
    expect(
      menu.subscriptionFor('claude', local: false, machineName: 'M2'),
      isNull,
    );
    final box = controller(usage: menu);
    await load(box);
    expect(box.options.first.title, 'OpenAI');
    expect(box.options.first.detail, contains('60% remaining'));
    select(box, NewHarnessField.agent, 'claude');
    await load(box);
    expect(box.options.first.title, 'Anthropic');
    expect(box.options.first.detail, isNot(contains('60%')));
  });
  for (final width in [1100.0, 600.0]) {
    testWidgets(
      'Model picker keeps pairs together and launches across machines at width $width',
      (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = Size(width, 800);
        addTearDown(tester.view.reset);
        final box = controller();
        var managed = 0;
        final subscription = app.modelsRequests.listen((_) => managed++);
        addTearDown(subscription.cancel);
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: NewHarnessForm(
                controller: box,
                onClose: () {},
                onCreated: () {},
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await openLaunchRow(tester, 'advanced');
        final order = ['agent', 'project', 'model', 'branch', 'worktree'];
        final positions = [
          for (final name in order)
            tester
                .getTopLeft(find.byKey(ValueKey('new-harness-field-$name')))
                .dy,
        ];
        expect(positions, orderedEquals([...positions]..sort()));
        await openLaunchRow(tester, 'model');
        expect(find.text('Subscription'), findsOneWidget);
        expect(find.text('On your machines'), findsOneWidget);
        expect(find.text('Shared · team-grid'), findsOneWidget);
        await typeHarnessQuery(tester, 'studio');
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(box.modelLabel, 'Qwen-35B · Mac Studio');
        expect(box.machineId, 'm');
        final start = find.byKey(const ValueKey('new-harness-field-start'));
        expect(start.hitTestable(), findsOneWidget);
        final semantics = tester.ensureSemantics();
        expect(tester.getSemantics(start).rect.size, tester.getSize(start));
        expect(tester.getSemantics(start).label, 'New Harness');
        semantics.dispose();
        expect(
          find.byKey(const ValueKey('new-harness-field-profile')),
          findsNothing,
        );
        await openLaunchRow(tester, 'model');
        await tester.scrollUntilVisible(
          find.text('Refresh models'),
          60,
          scrollable: find.descendant(
            of: find.byKey(const ValueKey('new-harness-choices')),
            matching: find.byWidgetPredicate(
              (widget) =>
                  widget is Scrollable &&
                  widget.axisDirection == AxisDirection.down,
            ),
          ),
        );
        await tester.tap(find.text('Refresh models'));
        await tester.pumpAndSettle();
        await tester.scrollUntilVisible(
          find.text('Manage Models…'),
          60,
          scrollable: find.descendant(
            of: find.byKey(const ValueKey('new-harness-choices')),
            matching: find.byWidgetPredicate(
              (widget) =>
                  widget is Scrollable &&
                  widget.axisDirection == AxisDirection.down,
            ),
          ),
        );
        await tester.tap(find.text('Manage Models…'));
        await tester.pumpAndSettle();
        expect(managed, 1);
        await startHarness(tester);
        await tester.pumpAndSettle();
        expect(connections['m']!.creates.single['gridModel'], 'Qwen-35B');
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}
