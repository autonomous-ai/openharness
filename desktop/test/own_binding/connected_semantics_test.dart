import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/connected_semantics.dart';

class _Binding extends AutomatedTestWidgetsFlutterBinding
    with ConnectedSemanticsBinding {
  bool guarded = true;
  final batches = <Map<int, Map<Symbol, dynamic>>>[];

  @override
  ui.SemanticsUpdateBuilder createPlatformSemanticsUpdateBuilder() =>
      _RecordingBuilder(batches);

  @override
  ui.SemanticsUpdateBuilder createSemanticsUpdateBuilder() => guarded
      ? super.createSemanticsUpdateBuilder()
      : createPlatformSemanticsUpdateBuilder();
}

class _RecordingBuilder implements ui.SemanticsUpdateBuilder {
  _RecordingBuilder(this.batches);
  final List<Map<int, Map<Symbol, dynamic>>> batches;
  final nodes = <int, Map<Symbol, dynamic>>{};
  final delegate = ui.SemanticsUpdateBuilder();

  @override
  dynamic noSuchMethod(Invocation call) {
    switch (call.memberName) {
      case #updateNode:
        nodes[call.namedArguments[#id] as int] = Map.of(call.namedArguments);
        return Function.apply(delegate.updateNode, [], call.namedArguments);
      case #updateCustomAction:
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
