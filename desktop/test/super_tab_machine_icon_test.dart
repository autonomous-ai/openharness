import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/system_symbols.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/super_tabs/machine_icon.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'support/super_tab_fixture.dart';

/// A real 1×1 PNG, so the image decodes as AppKit's would.
final _png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
);

/// Answers the AppKit channel as a Mac would: [missing] names have no symbol.
List<String> fakeAppKit({Set<String> missing = const {}, bool fail = false}) {
  final asked = <String>[];
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(
        const MethodChannel(SystemSymbols.channelName),
        (call) async {
          expect(call.method, 'png');
          final name = (call.arguments as Map)['name'] as String;
          asked.add(name);
          if (fail) throw PlatformException(code: 'BROKEN');
          return missing.contains(name) ? null : _png;
        },
      );
  addTearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel(SystemSymbols.channelName),
          null,
        ),
  );
  return asked;
}

Future<void> showIcon(
  WidgetTester tester,
  String? deviceType,
  SystemSymbols symbols,
) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Center(
        child: SuperTabMachineIcon(
          deviceType: deviceType,
          color: const Color(0xFF123456),
          symbols: symbols,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

/// What the icon draws: an AppKit symbol's picture, or a catalogue icon.
Object drawn(WidgetTester tester) {
  final images = find.descendant(
    of: find.byType(SuperTabMachineIcon),
    matching: find.byType(Image),
  );
  if (images.evaluate().isNotEmpty) return 'symbol';
  return tester
      .widget<Icon>(
        find.descendant(
          of: find.byType(SuperTabMachineIcon),
          matching: find.byType(Icon),
        ),
      )
      .icon!;
}

void main() {
  test('each Mac draws its own symbol; anything else a plain display', () {
    expect(superTabMachineSymbol('MacBook Pro'), 'laptopcomputer');
    expect(superTabMachineSymbol('MacBook Air'), 'laptopcomputer');
    expect(superTabMachineSymbol('MacBook'), 'laptopcomputer');
    expect(superTabMachineSymbol('Mac Studio'), 'macstudio');
    expect(superTabMachineSymbol('Mac mini'), 'macmini');
    expect(superTabMachineSymbol('iMac'), 'desktopcomputer');
    expect(superTabMachineSymbol('Mac Pro'), 'display');
    expect(superTabMachineSymbol('ThinkPad X1 Carbon Gen 11'), 'display');
    expect(superTabMachineSymbol(''), 'display');
    expect(superTabMachineSymbol(null), 'display');
  });

  testWidgets('on a Mac the symbol is AppKit\'s own, in the row\'s ink', (
    tester,
  ) async {
    final asked = fakeAppKit();
    await showIcon(tester, 'Mac Studio', SystemSymbols());
    expect(asked, ['macstudio']);
    expect(drawn(tester), 'symbol');
    final image = tester.widget<Image>(find.byType(Image));
    expect(image.color, const Color(0xFF123456));
    expect(image.colorBlendMode, BlendMode.srcIn);
    expect(image.width, 16);
    expect(image.height, 16);
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  testWidgets(
    'while AppKit\'s picture decodes, the catalogue\'s icon holds its place',
    (tester) async {
      fakeAppKit();
      await showIcon(tester, 'Mac Studio', SystemSymbols());
      // A widget test never decodes an image outside runAsync: still decoding.
      expect(find.byType(Image), findsOneWidget);
      expect(find.byIcon(AppIcons.monitor), findsOneWidget);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  testWidgets(
    'a symbol this macOS lacks, or a channel that fails, draws the catalogue\'s',
    (tester) async {
      fakeAppKit(missing: {'macstudio'});
      await showIcon(tester, 'Mac Studio', SystemSymbols());
      expect(drawn(tester), AppIcons.monitor);

      fakeAppKit(fail: true);
      await showIcon(tester, 'MacBook Air', SystemSymbols());
      expect(drawn(tester), AppIcons.laptop);
      expect(tester.takeException(), isNull);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  testWidgets(
    'off a Mac AppKit is never asked: a laptop or a display from the catalogue',
    (tester) async {
      final asked = fakeAppKit();
      await showIcon(tester, 'MacBook Pro', SystemSymbols());
      expect(drawn(tester), AppIcons.laptop);
      await showIcon(tester, null, SystemSymbols());
      expect(drawn(tester), AppIcons.monitor);
      expect(asked, isEmpty);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.linux),
  );

  testWidgets(
    'each machine row leads with its type\'s icon, dimmed while offline, '
    'instead of ~',
    (tester) async {
      final asked = fakeAppKit();
      final now = DateTime.now().millisecondsSinceEpoch;
      final server = ConversationServer();
      server.state['agents'] = <Object>[];
      server.state['machines'] = [
        {
          'machineId': 'studio',
          'name': 'Studio',
          'contributorId': 'owner',
          'observation': {
            'receivedAt': now,
            'resources': {'deviceType': 'Mac Studio'},
          },
        },
        {
          'machineId': 'air',
          'name': 'Air',
          'contributorId': 'owner',
          'observation': {
            'receivedAt': now - const Duration(hours: 3).inMilliseconds,
            'resources': {'deviceType': 'MacBook Air'},
          },
        },
        {'machineId': 'linux', 'name': 'Box', 'contributorId': 'owner'},
      ];
      final c = server.controller();
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 300,
              height: 600,
              child: SuperTabMachines(
                controller: c,
                embedded: true,
                onAddAgent: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      SuperTabMachineIcon iconOf(String id) => tester.widget(
        find.descendant(
          of: find.byKey(ValueKey('super-machine-$id')),
          matching: find.byType(SuperTabMachineIcon),
        ),
      );
      expect(find.text('~'), findsNothing);
      expect(iconOf('studio').deviceType, 'Mac Studio');
      expect(iconOf('studio').color, DesktopChrome.foreground);
      expect(iconOf('air').deviceType, 'MacBook Air');
      expect(iconOf('air').color, DesktopChrome.muted);
      expect(iconOf('linux').deviceType, isNull);
      expect(asked.toSet(), {'macstudio', 'laptopcomputer', 'display'});
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );
}
