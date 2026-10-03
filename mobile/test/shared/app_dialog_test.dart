import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/widgets/app_dialog.dart';

/// The veil every dialog on the phone stands on — the rename dialog, the phone
/// name, the folder picker, every confirmation. It draws its own barrier, so
/// the three things Material would otherwise have done for it — a tap outside,
/// Escape, and the focus a field inside asks for — are all its own to get
/// right.
void main() {
  late ValueNotifier<Object?> result;

  Future<void> open(
    WidgetTester tester,
    WidgetBuilder builder, {
    bool barrierDismissible = true,
  }) async {
    result = ValueNotifier<Object?>('<closed>');
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () async {
                  result.value = '<open>';
                  result.value = await showAppDialog<Object?>(
                    context: context,
                    barrierDismissible: barrierDismissible,
                    builder: builder,
                  );
                },
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
  }

  Widget card(Widget child) => Dialog(
    child: Padding(padding: const EdgeInsets.all(20), child: child),
  );

  testWidgets(
    'a field that asks for focus gets it — and the keyboard with it',
    (tester) async {
      final focus = FocusNode();
      addTearDown(focus.dispose);
      await open(
        tester,
        (_) => card(TextField(focusNode: focus, autofocus: true)),
      );
      // The veil's own Escape handler must not take the focus a field inside
      // asked for: that is how the rename dialog opened with no caret.
      expect(focus.hasPrimaryFocus, isTrue);
      expect(tester.testTextInput.hasAnyClients, isTrue);

      // Escape still reaches the veil from inside the field.
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(result.value, isNull);
    },
  );

  testWidgets('with nothing focusable inside, Escape still closes it', (
    tester,
  ) async {
    await open(tester, (_) => card(const Text('Delete this harness?')));
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('Delete this harness?'), findsNothing);
    expect(result.value, isNull);
  });

  testWidgets('Escape still closes it after a field has let go of focus', (
    tester,
  ) async {
    final focus = FocusNode();
    addTearDown(focus.dispose);
    await open(
      tester,
      (_) => card(TextField(focusNode: focus, autofocus: true)),
    );
    // What the folder picker does to put the keyboard away.
    focus.unfocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(result.value, isNull);
  });

  testWidgets('a tap on the veil closes it; a tap on the panel does not', (
    tester,
  ) async {
    await open(
      tester,
      (_) => card(const SizedBox(width: 200, height: 120, child: Text('Hi'))),
    );
    await tester.tap(find.text('Hi'));
    await tester.pumpAndSettle();
    expect(find.text('Hi'), findsOneWidget);

    await tester.tapAt(const Offset(4, 4));
    await tester.pumpAndSettle();
    expect(find.text('Hi'), findsNothing);
    expect(result.value, isNull);
  });

  testWidgets('a dialog that opted out of dismissal ignores the veil and '
      'Escape alike', (tester) async {
    await open(
      tester,
      barrierDismissible: false,
      (context) => card(
        TextButton(
          onPressed: () => Navigator.of(context).pop('done'),
          child: const Text('Done'),
        ),
      ),
    );
    await tester.tapAt(const Offset(4, 4));
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.text('Done'), findsOneWidget);

    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(result.value, 'done');
  });

  testWidgets('the veil is a tint with no blur on the phone', (tester) async {
    await open(tester, (_) => card(const Text('Hi')));
    // A blur re-filters the streaming terminal behind it every frame.
    expect(kDialogVeilBlur, 0);
    expect(find.byType(BackdropFilter), findsNothing);
    expect(
      find.byWidgetPredicate(
        (widget) => widget is ColoredBox && widget.color == kDialogVeilTint,
      ),
      findsOneWidget,
    );
  });

  testWidgets('a dialog button is thumb-sized, on the dialog corner', (
    tester,
  ) async {
    final style = appDialogButtonStyle(
      background: Colors.blue,
      foreground: Colors.white,
      disabledBackground: Colors.grey,
      disabledForeground: Colors.black,
    );
    expect(style.minimumSize!.resolve({}), const Size.fromHeight(46));
    expect(
      (style.shape!.resolve({}) as RoundedRectangleBorder).borderRadius,
      BorderRadius.circular(kDialogControlRadius),
    );
    expect(style.backgroundColor!.resolve({WidgetState.disabled}), Colors.grey);
    expect(style.textStyle!.resolve({})!.fontSize, 16);
  });
}
