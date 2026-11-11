// Flutter's key simulator uses these same entry points, with timestamps fixed
// at zero. The pause check supplies elapsed time through the real dispatch path.
// ignore_for_file: deprecated_member_use

import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/shared/widgets/app_select_field.dart';

import 'support/real_fonts.dart';

const _machines = [
  SelectOption(value: 'local', label: 'This computer'),
  SelectOption(value: 'book', label: 'MacBook Pro'),
  SelectOption(value: 'mini', label: 'Mac mini'),
  SelectOption(value: 'office', label: 'Office workstation'),
  SelectOption(value: 'workshop', label: 'Workshop machine'),
];

Finder _row(String label) => find.widgetWithText(AppMenuItem, label);
FocusNode _focus(WidgetTester tester, String label) => Focus.of(
  tester.element(find.descendant(of: _row(label), matching: find.text(label))),
);

Future<void> _type(WidgetTester tester, String text) async {
  for (final code in text.codeUnits) {
    await tester.sendKeyEvent(
      LogicalKeyboardKey(code),
      character: String.fromCharCode(code),
    );
  }
}

Future<void> _mount(WidgetTester tester, {required Widget child}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: Align(
          alignment: Alignment.topCenter,
          child: SizedBox(width: 280, child: child),
        ),
      ),
    ),
  );
  await tester.sendKeyEvent(LogicalKeyboardKey.tab);
  await tester.pump();
}

void main() {
  setUpAll(loadRealFonts);

  for (final accept in [true, false]) {
    testWidgets(
      'immediate ${accept ? 'Enter' : 'Escape'} belongs to the opening menu',
      (tester) async {
        var outerEscapes = 0;
        final picked = <String>[];
        await _mount(
          tester,
          child: CallbackShortcuts(
            bindings: {
              const SingleActivator(LogicalKeyboardKey.escape): () =>
                  outerEscapes++,
            },
            child: AppSelectField<String>(
              value: 'local',
              options: _machines,
              onChanged: picked.add,
            ),
          ),
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await _type(tester, 'work');
        await tester.sendKeyEvent(
          accept ? LogicalKeyboardKey.enter : LogicalKeyboardKey.escape,
        );
        await tester.pumpAndSettle();
        expect(picked, accept ? ['workshop'] : isEmpty);
        expect(outerEscapes, 0);
        expect(find.byType(AppMenuItem), findsNothing);
      },
    );
  }

  testWidgets(
    'typing before opening paint and after reopening keeps the match',
    (tester) async {
      final picked = <String>[];
      await _mount(
        tester,
        child: AppSelectField<String>(
          value: 'local',
          options: _machines,
          onChanged: picked.add,
        ),
      );
      for (var opening = 0; opening < 2; opening++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        // No frame between opening and typing a different destination.
        await _type(tester, 'work');
        await tester.pumpAndSettle();
        expect(_focus(tester, 'Workshop machine').hasPrimaryFocus, isTrue);
        expect(picked, isEmpty);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(find.byType(AppMenuItem), findsNothing);
      }
      expect(tester.takeException(), isNull);
    },
    variant: const TargetPlatformVariant({
      TargetPlatform.macOS,
      TargetPlatform.linux,
    }),
  );

  testWidgets('repeated initials cycle; names with spaces do not activate', (
    tester,
  ) async {
    final picked = <String>[];
    await _mount(
      tester,
      child: AppSelectField<String>(
        value: 'local',
        options: _machines,
        onChanged: picked.add,
      ),
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    for (final label in ['MacBook Pro', 'Mac mini', 'MacBook Pro']) {
      await _type(tester, 'm');
      await tester.pump();
      expect(_focus(tester, label).hasPrimaryFocus, isTrue);
    }
    await _type(tester, 'ac mi');
    await tester.pump();
    expect(_focus(tester, 'Mac mini').hasPrimaryFocus, isTrue);
    expect(picked, isEmpty);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(picked, ['mini']);
  });

  testWidgets('typing pause and arrow navigation start a new name', (
    tester,
  ) async {
    await _mount(
      tester,
      child: AppSelectField<String>(
        value: 'local',
        options: _machines,
        onChanged: (_) {},
      ),
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    await _type(tester, 'mac');
    await tester.pump();
    const elapsed = Duration(seconds: 2);
    for (final down in [true, false]) {
      tester.binding.keyEventManager.handleKeyData(
        ui.KeyData(
          physical: PhysicalKeyboardKey.keyO.usbHidUsage,
          logical: LogicalKeyboardKey.keyO.keyId,
          type: down ? ui.KeyEventType.down : ui.KeyEventType.up,
          character: down ? 'o' : null,
          timeStamp: elapsed,
          synthesized: false,
        ),
      );
      await tester.binding.keyEventManager.handleRawKeyMessage(
        KeyEventSimulator.getKeyData(
          LogicalKeyboardKey.keyO,
          platform: 'macos',
          isDown: down,
          character: down ? 'o' : null,
        ),
      );
    }
    await tester.pump();
    expect(_focus(tester, 'Office workstation').hasPrimaryFocus, isTrue);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    await _type(tester, 'm');
    await tester.pump();
    expect(_focus(tester, 'MacBook Pro').hasPrimaryFocus, isTrue);
  });

  testWidgets('modifier chords do not change the highlighted choice', (
    tester,
  ) async {
    await _mount(
      tester,
      child: AppSelectField<String>(
        value: 'local',
        options: _machines,
        onChanged: (_) {},
      ),
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    for (final modifier in [
      LogicalKeyboardKey.metaLeft,
      LogicalKeyboardKey.controlLeft,
      LogicalKeyboardKey.altLeft,
    ]) {
      await tester.sendKeyDownEvent(modifier);
      await _type(tester, 'w');
      await tester.sendKeyUpEvent(modifier);
      await tester.pump();
      expect(_focus(tester, 'This computer').hasPrimaryFocus, isTrue);
    }
    await _type(tester, 'w');
    await tester.pump();
    expect(_focus(tester, 'Workshop machine').hasPrimaryFocus, isTrue);
  });

  testWidgets('long menus reveal the named row and support nullable choices', (
    tester,
  ) async {
    final picked = <String?>[];
    await _mount(
      tester,
      child: AppSelectField<String?>(
        // Typeahead's path: a list past the threshold otherwise gets a search.
        filterable: false,
        value: '0',
        options: [
          for (var i = 0; i < 40; i++)
            SelectOption(value: '$i', label: 'Machine $i'),
          const SelectOption(value: null, label: 'System default'),
        ],
        onChanged: picked.add,
      ),
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    await _type(tester, 'sys');
    await tester.pumpAndSettle();
    expect(_focus(tester, 'System default').hasPrimaryFocus, isTrue);
    expect(_row('System default').hitTestable(), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(picked, [null]);
  });

  testWidgets(
    'discovery preserves focused identity and recovers when it leaves',
    (tester) async {
      var options = _machines;
      late StateSetter refresh;
      await _mount(
        tester,
        child: StatefulBuilder(
          builder: (_, setState) {
            refresh = setState;
            return AppSelectField<String>(
              value: 'local',
              options: options,
              onChanged: (_) {},
            );
          },
        ),
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await _type(tester, 'w');
      await tester.pump();
      refresh(
        () => options = [
          const SelectOption(value: 'workshop', label: 'Workshop renamed'),
          ..._machines.take(4),
        ],
      );
      await tester.pumpAndSettle();
      expect(_focus(tester, 'Workshop renamed').hasPrimaryFocus, isTrue);
      refresh(() => options = _machines.take(4).toList());
      await tester.pumpAndSettle();
      expect(_focus(tester, 'This computer').hasPrimaryFocus, isTrue);
      await _type(tester, 'o');
      await tester.pump();
      expect(_focus(tester, 'Office workstation').hasPrimaryFocus, isTrue);
      refresh(() => options = []);
      await tester.pumpAndSettle();
      expect(find.byType(AppMenuItem), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
}
