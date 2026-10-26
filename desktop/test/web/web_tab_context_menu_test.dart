@TestOn('browser')
library;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/widgets/desktop_workspace_tab.dart';

/// In a browser the page's own context menu would open over a tab's menu
/// (Invite People…, Show Agent Messages…). It is off only while the pointer
/// is over a tab that has a menu, and back on when it leaves.
void main() {
  late List<String> calls;

  setUp(() {
    calls = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.contextMenu, (call) async {
          calls.add(call.method);
          return null;
        });
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.contextMenu, null);
  });

  Widget host({
    VoidCallback? onInvite,
    bool shown = true,
    WorkspaceChrome? chrome,
  }) => MaterialApp(
    theme: grid.buildAppTheme(brightness: Brightness.dark),
    home: Scaffold(
      body: WorkspaceChromeScope(
        chrome: chrome,
        child: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: 220,
            height: 40,
            child: shown
                ? DesktopWorkspaceTab(
                    id: 'app',
                    label: 'app',
                    selected: true,
                    showShortcuts: const AlwaysStoppedAnimation(false),
                    onSelect: () {},
                    onClose: () {},
                    onInvitePeople: onInvite,
                    onShowAgentMessages: onInvite == null ? null : () {},
                  )
                : null,
          ),
        ),
      ),
    ),
  );

  testWidgets('a tab with a menu turns the browser menu off while hovered', (
    tester,
  ) async {
    var invited = 0;
    await tester.pumpWidget(host(onInvite: () => invited++));
    final tab = tester.getCenter(find.byKey(const ValueKey('tab-label:app')));
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer(location: const Offset(500, 500));
    await tester.pump();
    expect(calls, isEmpty);

    await mouse.moveTo(tab);
    await tester.pump();
    expect(calls, ['disableContextMenu']);

    // The right-click opens the tab's menu, and only it.
    await tester.tap(
      find.byKey(const ValueKey('tab-label:app')),
      buttons: kSecondaryButton,
      kind: PointerDeviceKind.mouse,
    );
    await tester.pumpAndSettle();
    expect(find.text('Invite People…'), findsOneWidget);
    await tester.tap(find.text('Invite People…'));
    await tester.pumpAndSettle();
    expect(invited, 1);

    await mouse.moveTo(const Offset(500, 500));
    await tester.pump();
    expect(calls, ['disableContextMenu', 'enableContextMenu']);

    // Gone while hovered: the browser menu comes back.
    await mouse.moveTo(tab);
    await tester.pump();
    await tester.pumpWidget(host(shown: false));
    expect(calls.last, 'enableContextMenu');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a host with a menu on every tab turns it off for any tab', (
    tester,
  ) async {
    await tester.pumpWidget(
      host(
        chrome: WorkspaceChrome(
          leadingWidth: (_) => 0,
          leading: (_, _) => const SizedBox.shrink(),
          menuOnEveryTab: true,
        ),
      ),
    );
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer(location: const Offset(500, 500));
    final tab = tester.getCenter(find.byKey(const ValueKey('tab-label:app')));
    await mouse.moveTo(tab);
    await tester.pump();
    expect(calls, ['disableContextMenu']);

    await tester.tap(
      find.byKey(const ValueKey('tab-label:app')),
      buttons: kSecondaryButton,
      kind: PointerDeviceKind.mouse,
    );
    await tester.pumpAndSettle();
    expect(find.text('Close Tab'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    expect(calls.last, 'enableContextMenu');
  });

  testWidgets('a tab without a menu leaves the browser menu alone', (
    tester,
  ) async {
    await tester.pumpWidget(host());
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer(location: const Offset(500, 500));
    await mouse.moveTo(
      tester.getCenter(find.byKey(const ValueKey('tab-label:app'))),
    );
    await tester.pump();
    await mouse.moveTo(const Offset(500, 500));
    await tester.pump();
    expect(calls, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });
}
