import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/workspace_welcome.dart';

const _closed = [(id: 'tab-1', name: 'Pilot'), (id: 'tab-2', name: 'Build')];

Future<List<String>> _mount(
  WidgetTester tester, {
  List<({String id, String name})> closed = _closed,
  bool composer = false,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1280, 800);
  addTearDown(tester.view.reset);
  final opened = <String>[];
  await tester.pumpWidget(
    MaterialApp(
      home: WorkspaceWelcome(
        onCommand: (_) {},
        closedSuperTabs: closed,
        onOpenSuperTab: opened.add,
        composerBuilder: composer
            ? (recents) => recents ?? const SizedBox()
            : null,
      ),
    ),
  );
  await tester.pumpAndSettle();
  return opened;
}

void main() {
  for (final composer in [false, true]) {
    final layout = composer ? 'composer' : 'classic';
    testWidgets('$layout welcome lists closed Super Tabs and opens one', (
      tester,
    ) async {
      final opened = await _mount(tester, composer: composer);
      expect(find.text('Closed Super Tabs'), findsOneWidget);
      expect(find.text('Pilot'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('welcome-closed-super-tab-tab-2')));
      expect(opened, ['tab-2']);
    });

    testWidgets('$layout welcome has no section when nothing is closed', (
      tester,
    ) async {
      await _mount(tester, closed: const [], composer: composer);
      expect(find.text('Closed Super Tabs'), findsNothing);
    });
  }
}
