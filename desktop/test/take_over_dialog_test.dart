import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/take_over_dialog.dart';

void main() {
  Future<TakeOver?> ask(
    WidgetTester tester, {
    required String engine,
    required bool busy,
    String? pick,
    Brightness brightness = Brightness.dark,
    double scale = 1,
    Size size = const Size(800, 600),
  }) async {
    TakeOver? chosen;
    var answered = false;
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.reset);
    final oldBrightness = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = oldBrightness);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () async {
              chosen = await askTakeOver(
                context,
                title: 'Retention cohorts',
                engine: engine,
                busy: busy,
                machine: 'M2',
              );
              answered = true;
            },
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    if (pick != null) {
      await tester.tap(find.byKey(Key(pick)));
      await tester.pumpAndSettle();
      expect(answered, isTrue);
    }
    return chosen;
  }

  testWidgets(
    'an idle session is moved; the engine is named as people call it',
    (tester) async {
      final chosen = await ask(
        tester,
        engine: 'claude',
        busy: false,
        pick: 'take-over-move',
      );
      expect(chosen, TakeOver.idle);
    },
  );

  testWidgets(
    'mid-turn, the prompt promises "continue" only to an engine that can take one',
    (tester) async {
      await ask(tester, engine: 'codex', busy: true);
      expect(
        find.text('Codex is working on it in a terminal.'),
        findsOneWidget,
      );
      expect(find.textContaining('tells it to continue'), findsOneWidget);
      await tester.tap(find.byKey(const Key('take-over-now')));
      await tester.pumpAndSettle();

      await ask(tester, engine: 'grok', busy: true);
      expect(find.text('Grok is working on it in a terminal.'), findsOneWidget);
      expect(find.textContaining('tells it to continue'), findsNothing);
      expect(find.textContaining('it picks up when you ask'), findsOneWidget);
      expect(find.text('M2'), findsOneWidget);
    },
  );

  testWidgets('Wait waits, and Cancel leaves it where it is', (tester) async {
    expect(
      await ask(tester, engine: 'opencode', busy: true, pick: 'take-over-wait'),
      TakeOver.wait,
    );
    await ask(tester, engine: 'pi', busy: false);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(find.text('Move to Harness'), findsNothing);
  });

  for (final brightness in Brightness.values) {
    testWidgets(
      'takeover keeps its safe default and visible choices in a short ${brightness.name} window',
      (tester) async {
        await ask(
          tester,
          engine: 'codex',
          busy: true,
          brightness: brightness,
          scale: 1.7,
          size: const Size(440, 360),
        );
        final wait = find.byKey(const Key('take-over-wait'));
        expect(
          tester.widget<FilledButton>(wait).focusNode!.hasPrimaryFocus,
          isTrue,
        );
        expect(wait.hitTestable(), findsOneWidget);
        expect(
          find.byKey(const Key('take-over-now')).hitTestable(),
          findsOneWidget,
        );
        expect(find.text('Cancel').hitTestable(), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.tap(find.text('Cancel'));
        await tester.pumpAndSettle();
        expect(find.text('Move to Harness'), findsNothing);
      },
    );
  }
}
