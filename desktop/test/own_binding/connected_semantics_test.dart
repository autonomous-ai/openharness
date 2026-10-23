import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/connected_semantics.dart';

class _Binding extends AutomatedTestWidgetsFlutterBinding
    with ConnectedSemanticsBinding {
  bool guarded = true;
  final batches = <Map<int, Map<Symbol, dynamic>>>[];
  final customActions = <int, Map<Symbol, dynamic>>{};

  @override
  ui.SemanticsUpdateBuilder createPlatformSemanticsUpdateBuilder() =>
      _RecordingBuilder(batches, customActions);

  @override
  ui.SemanticsUpdateBuilder createSemanticsUpdateBuilder() => guarded
      ? super.createSemanticsUpdateBuilder()
      : createPlatformSemanticsUpdateBuilder();
}

class _RecordingBuilder implements ui.SemanticsUpdateBuilder {
  _RecordingBuilder(this.batches, this.customActions);
  final List<Map<int, Map<Symbol, dynamic>>> batches;
  final Map<int, Map<Symbol, dynamic>> customActions;
  final nodes = <int, Map<Symbol, dynamic>>{};
  final delegate = ui.SemanticsUpdateBuilder();

  @override
  dynamic noSuchMethod(Invocation call) {
    switch (call.memberName) {
      case #updateNode:
        nodes[call.namedArguments[#id] as int] = Map.of(call.namedArguments);
        return Function.apply(delegate.updateNode, [], call.namedArguments);
      case #updateCustomAction:
        customActions[call.namedArguments[#id] as int] = Map.of(
          call.namedArguments,
        );
        return Function.apply(
          delegate.updateCustomAction,
          [],
          call.namedArguments,
        );
      case #build:
        batches.add(nodes);
        return delegate.build();
    }
    return super.noSuchMethod(call);
  }
}

// Model the native bridge's retained tree. Flutter's regular widget semantics
// assertions inspect the framework tree and miss extra nodes in the wire update.
List<int> _disconnectedUpdates(List<Map<int, Map<Symbol, dynamic>>> batches) {
  final tree = <int, List<int>>{};
  final disconnected = <int>[];
  for (final batch in batches) {
    for (final entry in batch.entries) {
      tree[entry.key] = List<int>.from(entry.value[#childrenInTraversalOrder]);
    }
    final connected = <int>{};
    void visit(int id) {
      expect(connected.add(id), isTrue, reason: 'Cycle or duplicate child $id');
      expect(tree.containsKey(id), isTrue, reason: 'Missing child $id');
      for (final child in tree[id]!) {
        visit(child);
      }
    }

    if (tree.containsKey(0)) visit(0);
    disconnected.addAll(batch.keys.where((id) => !connected.contains(id)));
    tree.removeWhere((id, _) => !connected.contains(id));
  }
  return disconnected;
}

Widget _sliders(int selected) => MaterialApp(
  home: Scaffold(
    body: IndexedStack(
      index: selected,
      children: [
        Center(
          child: Slider(
            value: .5,
            onChanged: (_) {},
            semanticFormatterCallback: (_) => 'First slider',
          ),
        ),
        Center(
          child: Slider(
            value: .5,
            onChanged: (_) {},
            semanticFormatterCallback: (_) => 'Second slider',
          ),
        ),
      ],
    ),
  ),
);

void axTest(String name, WidgetTesterCallback body) => testWidgets(
  name,
  body,
  variant: const TargetPlatformVariant({
    TargetPlatform.macOS,
    TargetPlatform.windows,
  }),
);

void main() {
  final binding = _Binding()
    // The suite's two-minute cap (test/flutter_test_config.dart), which this directory opts out of.
    ..defaultTestTimeout = const Timeout(Duration(minutes: 2));
  setUp(() {
    binding.guarded = true;
    binding.batches.clear();
    binding.customActions.clear();
  });
  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
  });

  axTest('fixture exposes the unguarded hidden-slider update', (tester) async {
    binding.guarded = false;
    final semantics = tester.ensureSemantics();
    try {
      await tester.pumpWidget(_sliders(0));
      expect(_disconnectedUpdates(binding.batches), isNotEmpty);
    } finally {
      semantics.dispose();
    }
  });

  axTest(
    'hidden sliders never reach the native tree when resizing or switching',
    (tester) async {
      final semantics = tester.ensureSemantics();
      try {
        for (var i = 0; i < 30; i++) {
          await tester.binding.setSurfaceSize(
            Size(800 + (i % 3) * 80, 600 + (i % 4) * 60),
          );
          await tester.pumpWidget(_sliders(i % 2));
          expect(_disconnectedUpdates(binding.batches), isEmpty);
          final visible = binding.batches.last.values.where(
            (node) =>
                node[#value] == (i.isEven ? 'First slider' : 'Second slider'),
          );
          expect(visible, hasLength(1));
          expect(
            visible.single[#actions] & ui.SemanticsAction.increase.index,
            isNonZero,
          );
          expect(
            visible.single[#actions] & ui.SemanticsAction.decrease.index,
            isNonZero,
          );
        }
        expect(tester.takeException(), isNull);
      } finally {
        semantics.dispose();
        await tester.binding.setSurfaceSize(null);
      }
    },
  );

  axTest('switching without resize restores clean portal nodes', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    try {
      for (var i = 0; i < 30; i++) {
        await tester.pumpWidget(_sliders(i % 2));
        await tester.pumpAndSettle();
        expect(_disconnectedUpdates(binding.batches), isEmpty);
      }
    } finally {
      semantics.dispose();
    }
  });

  axTest('dialogs and editable controls keep their labels and actions', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    final controller = TextEditingController(text: 'Draft');
    try {
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: Column(
                children: [
                  TextField(
                    controller: controller,
                    decoration: const InputDecoration(labelText: 'Message'),
                  ),
                  TextButton(
                    onPressed: () => showDialog<void>(
                      context: context,
                      builder: (context) => AlertDialog(
                        title: const Text('Question'),
                        actions: [
                          TextButton(
                            onPressed: () => Navigator.pop(context),
                            child: const Text('Answer'),
                          ),
                        ],
                      ),
                    ),
                    child: const Text('Ask'),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byType(TextField));
      await tester.pumpAndSettle();
      final fields = binding.batches
          .expand((b) => b.values)
          .where((n) => n[#value] == 'Draft');
      expect(fields, isNotEmpty);
      expect(
        fields.any(
          (node) => node[#actions] & ui.SemanticsAction.setText.index != 0,
        ),
        isTrue,
      );
      for (var i = 0; i < 5; i++) {
        await tester.tap(find.text('Ask'));
        await tester.pumpAndSettle();
        expect(tester.getSemantics(find.text('Question')).label, 'Question');
        await tester.tap(find.text('Answer'));
        await tester.pumpAndSettle();
      }
      expect(_disconnectedUpdates(binding.batches), isEmpty);
      expect(find.text('Draft'), findsOneWidget);
      expect(tester.takeException(), isNull);
    } finally {
      semantics.dispose();
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    }
  });

  axTest('rebuilding semantics uses current IDs after disable and enable', (
    tester,
  ) async {
    for (var i = 0; i < 5; i++) {
      final semantics = tester.ensureSemantics();
      binding.batches.clear();
      try {
        await tester.pumpWidget(_sliders(i % 2));
        await tester.pump();
        expect(binding.batches, isNotEmpty);
        expect(_disconnectedUpdates(binding.batches), isEmpty);
      } finally {
        semantics.dispose();
      }
      await tester.pumpWidget(const SizedBox());
    }
  });

  for (final (changeWhileDisabled, disableBeforeFrame) in [
    (false, false),
    (true, false),
    (false, true),
  ]) {
    axTest('a fresh native bridge receives the retained semantics tree '
        '(change while disabled: $changeWhileDisabled, '
        'disable before frame: $disableBeforeFrame)', (tester) async {
      final semantics = tester.ensureSemantics();
      final label = ValueNotifier('Initial activity');
      const activityKey = ValueKey('retained-activity');
      const controlKey = ValueKey('retained-control');
      try {
        tester.platformDispatcher.semanticsEnabledTestValue = true;
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Column(
                children: [
                  Semantics(
                    key: controlKey,
                    container: true,
                    label: 'Unchanged control',
                    button: true,
                    onTap: () {},
                    customSemanticsActions: {
                      const CustomSemanticsAction(label: 'Inspect task'): () {},
                    },
                    child: const SizedBox(width: 100, height: 40),
                  ),
                  ValueListenableBuilder(
                    valueListenable: label,
                    builder: (context, value, _) => Semantics(
                      key: activityKey,
                      container: true,
                      label: value,
                      child: const SizedBox(width: 100, height: 40),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(_disconnectedUpdates(binding.batches), isEmpty);
        final root =
            binding.renderViews.single.owner!.semanticsOwner!.rootSemanticsNode;
        final controlId = tester.getSemantics(find.byKey(controlKey)).id;
        final activityId = tester.getSemantics(find.byKey(activityKey)).id;

        // Native disable destroys the bridge, but an outstanding framework
        // handle keeps its owner, IDs and clean nodes alive. Any updates in
        // this interval are dropped by native and must not count as delivered.
        tester.platformDispatcher.semanticsEnabledTestValue = false;
        if (changeWhileDisabled) label.value = 'Changed while disabled';
        await tester.pumpAndSettle();
        expect(binding.semanticsEnabled, isTrue);
        expect(
          binding.renderViews.single.owner!.semanticsOwner!.rootSemanticsNode,
          same(root),
        );
        expect(tester.getSemantics(find.byKey(controlKey)).id, controlId);
        expect(tester.getSemantics(find.byKey(activityKey)).id, activityId);

        // Model a newly created, empty native tree. No widget changes are
        // needed to trigger a full replay when the platform enables semantics.
        binding.batches.clear();
        binding.customActions.clear();
        if (disableBeforeFrame) {
          tester.platformDispatcher.semanticsEnabledTestValue = true;
          tester.platformDispatcher.semanticsEnabledTestValue = false;
          await tester.pumpAndSettle();
          expect(
            binding.batches,
            isEmpty,
            reason:
                'A scheduled replay must not target a bridge disabled again',
          );
        }
        tester.platformDispatcher.semanticsEnabledTestValue = true;
        await tester.pumpAndSettle();
        expect(
          binding.batches,
          isNotEmpty,
          reason: 'A new native bridge needs the retained root and clean nodes',
        );
        expect(binding.batches.first, contains(0));
        expect(_disconnectedUpdates(binding.batches), isEmpty);
        final replayed = {for (final batch in binding.batches) ...batch};
        expect(replayed[controlId]?[#label], 'Unchanged control');
        expect(
          replayed[controlId]?[#actions] & ui.SemanticsAction.tap.index,
          isNonZero,
        );
        final customActionIds =
            replayed[controlId]![#additionalActions] as List<int>;
        expect(customActionIds, hasLength(1));
        expect(
          binding.customActions[customActionIds.single]?[#label],
          'Inspect task',
          reason: 'A new native bridge needs the custom action definition too',
        );
        expect(
          replayed[activityId]?[#label],
          changeWhileDisabled ? 'Changed while disabled' : 'Initial activity',
        );

        // A later partial leaf update must attach to the replayed tree,
        // rather than become a substitute native root.
        label.value = 'Changed after enable';
        await tester.pumpAndSettle();
        expect(_disconnectedUpdates(binding.batches), isEmpty);
        expect(
          binding.batches.last[activityId]?[#label],
          'Changed after enable',
        );
        expect(binding.batches.last, isNot(contains(0)));
        expect(binding.batches.last, isNot(contains(controlId)));
        expect(tester.takeException(), isNull);
      } finally {
        tester.platformDispatcher.clearSemanticsEnabledTestValue();
        semantics.dispose();
        await tester.pumpWidget(const SizedBox());
        label.dispose();
      }
    });
  }

  testWidgets('unaffected platforms retain the standard builder', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.linux;
    expect(binding.createSemanticsUpdateBuilder(), isA<_RecordingBuilder>());
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
    expect(
      binding.createSemanticsUpdateBuilder(),
      isNot(isA<_RecordingBuilder>()),
    );
    debugDefaultTargetPlatformOverride = null;
  });
}
