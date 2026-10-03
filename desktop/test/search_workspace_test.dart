import 'support/open_harness.dart';

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/swarm_switcher.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'keymap_runtime_test.dart' show mount;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  for (final native in [false, true]) {
    testWidgets(
      'toolbar tooltips follow live shortcut remaps and unbinding (native=$native)',
      (tester) async {
        debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
        addTearDown(() => debugDefaultTargetPlatformOverride = null);
        const channel = MethodChannel('harness/swarm_tabs');
        final calls = <MethodCall>[];
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          (call) async {
            calls.add(call);
            return null;
          },
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            channel,
            null,
          ),
        );
        final map = MemoryKeymap();
        final app = createApp();
        final input = <TerminalBinaryFrame>[];
        final pane = app.adoptSessionForTest(terminal('a0', input));
        await mount(tester, app, map, native: native);
        final session = pane.session;
        final focus = FocusManager.instance.primaryFocus;
        final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
        await mouse.addPointer(location: Offset.zero);
        var firstHover = true;

        Future<void> checkHints(String search, String store) async {
          if (native) {
            final payload =
                calls.lastWhere((call) => call.method == 'update').arguments
                    as Map;
            expect(payload['searchTooltip'], search);
            expect(payload['storeTooltip'], store);
          } else {
            for (final (key, text) in [
              ('swarm-search-button', search),
              ('swarm-store-button', store),
            ]) {
              await mouse.moveTo(Offset.zero);
              await tester.pump(const Duration(milliseconds: 300));
              await mouse.moveTo(tester.getCenter(find.byKey(ValueKey(key))));
              await tester.pump(const Duration(milliseconds: 499));
              // The first hint waits half a second; adjacent hints may use
              // Flutter's immediate follow-on behavior while exploring controls.
              if (firstHover) expect(find.text(text), findsNothing);
              firstHover = false;
              await tester.pump(const Duration(milliseconds: 1));
              await tester.pump(const Duration(milliseconds: 200));
              expect(find.text(text), findsOneWidget);
            }
          }
          expect(pane.session, same(session));
          expect(FocusManager.instance.primaryFocus, same(focus));
          expect(input, isEmpty);
        }

        await checkHints('Open Harness · ⌘P', 'Explore Harness Store · ⌘S');
        map.apply('''{"bindings":[
          {"keys":"cmd+p","command":null},
          {"keys":"cmd+s","command":null},
          {"keys":"cmd+k","command":"harnesses.list"},
          {"keys":"cmd+shift+s","command":"app.store"}
        ]}''');
        await tester.pump();
        await checkHints('Open Harness · ⌘K', 'Explore Harness Store · ⇧⌘S');
        map.apply('''{"bindings":[
          {"keys":"cmd+p","command":null},
          {"keys":"cmd+s","command":null}
        ]}''');
        await tester.pump();
        await checkHints('Open Harness', 'Explore Harness Store');
        await mouse.removePointer();
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
        debugDefaultTargetPlatformOverride = null;
      },
    );

    testWidgets(
      'command and Add pickers keep editing ownership with session previews (native=$native)',
      (tester) async {
        debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
        addTearDown(() => debugDefaultTargetPlatformOverride = null);
        const channel = MethodChannel('harness/swarm_tabs');
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          (_) async => null,
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            channel,
            null,
          ),
        );
        final map = MemoryKeymap();
        final app = createApp();
        app.machineStates['m']!.nodeOnline = true;
        final input = <TerminalBinaryFrame>[];
        app.adoptSessionForTest(
          terminal('a0', input)..terminal.write('Private terminal output'),
        );
        await mount(tester, app, map, native: native);
        final field = find.byKey(const ValueKey('swarm-search-input'));
        await key(tester, LogicalKeyboardKey.keyP, cmd: true, shift: true);
        final controller = tester.widget<TextField>(field).controller!;
        final focus = tester.widget<TextField>(field).focusNode!;
        final search = tester
            .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
            .search;
        final first = search.selected!.id;
        await key(tester, LogicalKeyboardKey.arrowUp);
        expect(search.selected!.id, isNot(first));
        await key(tester, LogicalKeyboardKey.arrowDown);
        expect(search.selected!.id, first);
        await tester.enterText(field, '> new');
        await key(tester, LogicalKeyboardKey.keyA, cmd: true);
        expect(controller.selection.textInside(controller.text), '> new');
        await key(tester, LogicalKeyboardKey.backspace);
        expect(controller.text, isEmpty);
        expect(
          tester
              .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
              .search
              .rows
              .every((row) => row.isCreate || row.agentId != null),
          isTrue,
        );
        expect(focus.hasFocus, isTrue);
        expect(
          find.byKey(const ValueKey('swarm-search-preview')),
          findsNothing,
        );
        expect(
          find.byKey(const ValueKey('search-category-Harnesses')),
          findsOneWidget,
        );
        await key(tester, LogicalKeyboardKey.escape);
        expect(field, findsNothing);
        await openHarnessPicker(tester);
        await tester.enterText(field, 'Agent 0');
        await tester.pump();
        expect(
          find.byKey(const ValueKey('swarm-search-preview')),
          findsOneWidget,
        );
        expect(find.textContaining('Private terminal output'), findsNothing);
        final results = tester.getRect(
          find.byKey(const ValueKey('swarm-search-result-list')),
        );
        final picker = tester.getRect(
          find.byKey(const ValueKey('swarm-search-results')),
        );
        expect(results.width, lessThan(picker.width));
        expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
        expect(input, isEmpty);
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
        debugDefaultTargetPlatformOverride = null;
      },
    );
  }
}
