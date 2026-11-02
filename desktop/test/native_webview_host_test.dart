import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/runtime_platform.dart';
import 'package:harness/widgets/agent_picker.dart';
import 'package:harness/widgets/native_webview_host.dart';
import 'package:harness/widgets/pane_menu.dart';
import 'package:harness/widgets/transient_menus.dart';

import 'support/agent_picker.dart';

void main() {
  testWidgets('nested overlays release visibility only after the last close', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(home: NativeWebViewHost(child: Text('Native surface'))),
    );
    final first = registerTransientMenu(() {});
    final second = registerTransientMenu(() {});
    await tester.pump();
    if (RuntimePlatform.isLinux) {
      expect(find.text('Native surface'), findsNothing);
    }
    first();
    first();
    await tester.pump();
    expect(transientMenusVisible.value, isTrue);
    if (RuntimePlatform.isLinux) {
      expect(find.text('Native surface'), findsNothing);
    }
    second();
    await tester.pump();
    expect(transientMenusVisible.value, isFalse);
    expect(find.text('Native surface'), findsOneWidget);
  });

  testWidgets('agent picker hides native views and releases them on disposal', (
    tester,
  ) async {
    final pickerVisible = ValueNotifier<bool>(true);
    addTearDown(pickerVisible.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Column(
            children: [
              ValueListenableBuilder<bool>(
                valueListenable: pickerVisible,
                builder: (_, visible, _) => visible
                    ? AgentPicker(
                        value: 'test',
                        choices: [
                          AgentChoice(
                            id: 'test',
                            label: 'Test agent',
                            mark: (size) => SizedBox.square(dimension: size),
                          ),
                        ],
                        onChanged: (_) {},
                      )
                    : const SizedBox.shrink(),
              ),
              const Expanded(
                child: NativeWebViewHost(child: Text('Native surface')),
              ),
            ],
          ),
        ),
      ),
    );
    await openAgentSearch(tester);
    expect(transientMenusVisible.value, isTrue);
    if (RuntimePlatform.isLinux) {
      expect(find.text('Native surface'), findsNothing);
    }
    dismissTransientMenus();
    await tester.pumpAndSettle();
    expect(transientMenusVisible.value, isFalse);
    expect(find.text('Native surface'), findsOneWidget);
    await openAgentSearch(tester);
    pickerVisible.value = false;
    await tester.pump();
    await tester.pump();
    expect(transientMenusVisible.value, isFalse);
    expect(find.text('Native surface'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('removing the overlay owner releases pane menu visibility', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: Text('Owner'))),
    );
    showPaneMenu<void>(
      context: tester.element(find.text('Owner')),
      position: const RelativeRect.fromLTRB(20, 20, 20, 0),
      children: (close) => [
        paneMenuItem(onTap: () => close(null), child: const Text('Menu')),
      ],
    );
    await tester.pumpAndSettle();
    expect(transientMenusVisible.value, isTrue);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    expect(transientMenusVisible.value, isFalse);
    expect(tester.takeException(), isNull);
  });
}
