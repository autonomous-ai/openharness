import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/out_of_sight.dart';

/// A part of the screen kept built out of sight stops listening, and draws
/// what changed meanwhile once it is shown again.
void main() {
  late _Count count;
  late ValueNotifier<bool> hidden;
  late int built;

  setUp(() {
    count = _Count();
    hidden = ValueNotifier(false);
    built = 0;
  });
  tearDown(() {
    count.dispose();
    hidden.dispose();
  });

  Future<void> pump(WidgetTester tester) => tester.pumpWidget(
    MaterialApp(
      home: ValueListenableBuilder(
        valueListenable: hidden,
        builder: (context, isHidden, _) => OutOfSight(
          hidden: isHidden,
          child: ListenWhileInSight(
            listenable: count,
            builder: (context) {
              built++;
              return Text('${count.value}');
            },
          ),
        ),
      ),
    ),
  );

  testWidgets('in sight, it builds on every change', (tester) async {
    await pump(tester);
    count.value = 1;
    await tester.pump();
    count.value = 2;
    await tester.pump();

    expect(find.text('2'), findsOneWidget);
    expect(built, 3);
  });

  testWidgets('out of sight, it neither listens nor builds', (tester) async {
    await pump(tester);
    hidden.value = true;
    await tester.pump();
    final before = built;

    count.value = 1;
    await tester.pump();
    count.value = 2;
    await tester.pump();

    expect(built, before);
    expect(find.text('0'), findsOneWidget, reason: 'what it drew last');
    expect(count.listened, isFalse);
  });

  testWidgets('shown again, it builds once, with what is there now', (
    tester,
  ) async {
    await pump(tester);
    hidden.value = true;
    await tester.pump();
    count.value = 5;
    await tester.pump();
    final before = built;

    hidden.value = false;
    await tester.pump();

    expect(find.text('5'), findsOneWidget);
    expect(built, before + 1);
    count.value = 6;
    await tester.pump();
    expect(find.text('6'), findsOneWidget, reason: 'listening again');
  });

  testWidgets('hidden, a rebuild from above draws nothing new', (tester) async {
    await pump(tester);
    hidden.value = true;
    await tester.pump();
    final before = built;

    await pump(tester);

    expect(built, before);
  });

  testWidgets('with no OutOfSight above, it is in sight', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: ListenWhileInSight(
          listenable: count,
          builder: (context) => Text('${count.value}'),
        ),
      ),
    );
    count.value = 3;
    await tester.pump();

    expect(find.text('3'), findsOneWidget);
  });

  testWidgets('lets go of what it listens to when it goes', (tester) async {
    await pump(tester);
    expect(count.listened, isTrue);

    await tester.pumpWidget(const SizedBox());

    expect(count.listened, isFalse);
  });

  testWidgets('kept in sight under a part out of sight, it is out of sight '
      'too, and in sight again with it', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: ValueListenableBuilder(
          valueListenable: hidden,
          builder: (context, isHidden, _) => KeptOutOfSight(
            hidden: isHidden,
            child: KeptOutOfSight(
              hidden: false,
              child: ListenWhileInSight(
                listenable: count,
                builder: (context) => Text('${count.value}'),
              ),
            ),
          ),
        ),
      ),
    );

    hidden.value = true;
    await tester.pump();

    expect(count.listened, isFalse);
    expect(find.text('0'), findsNothing, reason: 'offstage');

    count.value = 2;
    hidden.value = false;
    await tester.pump();

    expect(count.listened, isTrue);
    expect(find.text('2'), findsOneWidget);
  });
}

/// A number that says whether anything listens to it.
class _Count extends ValueNotifier<int> {
  _Count() : super(0);

  bool get listened => hasListeners;
}
