import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/desk_tab_filter_bar.dart';
import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/phone/terminal_search.dart';
import 'package:harness_mobile/phone/welcome/pick_up_page.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_pager_fixture.dart';
import 'desk_fixture.dart';

/// Find's New Harness makes its harness in the tab the chips are narrowed to.
///
/// ⚠️ The regression this is here for: Find opened over `a` (a Desktop harness), narrowed to
/// Docker, New Harness tapped — and the new harness landed in Desktop. The phone counts itself in
/// the tab of the harness on screen, and the chip only narrowed the list; nothing carried it to
/// the form. The form now holds the tab ([NewAgentPage.deskTabId]) and the desk write takes it
/// (`desk_writes_test.dart`, `phone_desk_test.dart`).
void main() {
  Future<AppNotifier> openFind(WidgetTester tester) async {
    final app = await deskApp(
      PagerConn(),
      opensTerminals: false,
      tabs: [
        deskTab('t1', 'Desktop', ['a', 'b']),
        deskTab('t2', 'Docker', ['c']),
      ],
    );
    addTearDown(app.dispose);
    // What the home screen records under the harness on screen.
    app.noteDeskTab('t1');
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TerminalSearchOverlay(
            notifier: app,
            animation: const AlwaysStoppedAnimation(1),
            onClose: () {},
            showing: (machineId: 'm', agentId: 'a'),
          ),
        ),
      ),
    );
    await tester.pump();
    return app;
  }

  Future<void> pickTab(WidgetTester tester, String name) async {
    await tester.tap(
      find.descendant(
        of: find.byType(DeskTabFilterBar),
        matching: find.text(name),
      ),
    );
    await tester.pump();
  }

  Future<void> openForm(WidgetTester tester, Finder button) async {
    await tester.ensureVisible(button);
    await tester.pump();
    await tester.tap(button);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  String? formTab(WidgetTester tester) =>
      tester.widget<NewAgentPage>(find.byType(NewAgentPage)).deskTabId;

  bool formNewTab(WidgetTester tester) =>
      tester.widget<NewAgentPage>(find.byType(NewAgentPage)).newDeskTab;

  final newTab = find.byKey(const ValueKey('find-new-tab'));

  /// Takes the form down and runs its clocks out, so no timer outlives the test.
  Future<void> unmount(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 30));
  }

  testWidgets('the button at the foot makes it in the tab picked', (
    tester,
  ) async {
    await openFind(tester);
    await pickTab(tester, 'Docker');

    await openForm(tester, find.byKey(const ValueKey('find-new-harness')));

    expect(find.byType(NewAgentPage), findsOneWidget);
    expect(formTab(tester), 't2');
    await unmount(tester);
  });

  testWidgets('so does the + New Harness row', (tester) async {
    await openFind(tester);
    await pickTab(tester, 'Docker');

    await openForm(tester, find.text('+ New Harness', findRichText: true));

    expect(formTab(tester), 't2');
    await unmount(tester);
  });

  testWidgets('on All the tab the phone is in still decides', (tester) async {
    await openFind(tester);
    await pickTab(tester, 'Docker');
    await pickTab(tester, 'All');

    await openForm(tester, find.byKey(const ValueKey('find-new-harness')));

    expect(formTab(tester), isNull);
    await unmount(tester);
  });

  // Find's `+` after the last tab chip is the desktop's New Tab: the harness made opens a tab of
  // its own, whatever tab the chips are narrowed to.
  testWidgets('the + after the last tab makes it in a tab of its own', (
    tester,
  ) async {
    await openFind(tester);
    await pickTab(tester, 'Docker');

    await openForm(tester, newTab);

    expect(find.byType(NewAgentPage), findsOneWidget);
    expect(formNewTab(tester), isTrue);
    expect(formTab(tester), isNull);
    await unmount(tester);
  });

  testWidgets('the + sits after the last tab, on the chips row', (
    tester,
  ) async {
    await openFind(tester);

    expect(newTab, findsOneWidget);
    expect(
      find.descendant(of: find.byType(DeskTabFilterBar), matching: newTab),
      findsOneWidget,
    );
    final docker = find.descendant(
      of: find.byType(DeskTabFilterBar),
      matching: find.text('Docker'),
    );
    expect(
      tester.getTopLeft(newTab).dx,
      greaterThan(tester.getTopRight(docker).dx),
    );
    expect(
      tester.getCenter(newTab).dy,
      closeTo(tester.getCenter(docker).dy, 1),
    );
    expect(find.bySemanticsLabel('New Tab'), findsOneWidget);
  });

  testWidgets('the foot and the row still join the tab picked, not a new one', (
    tester,
  ) async {
    await openFind(tester);
    await pickTab(tester, 'Docker');

    await openForm(tester, find.byKey(const ValueKey('find-new-harness')));

    expect(formNewTab(tester), isFalse);
    expect(formTab(tester), 't2');
    await unmount(tester);
  });

  testWidgets('no + while no computer can take a new harness', (tester) async {
    final app = await openFind(tester);
    app.stateOf('m')!.nodeOnline = false;
    app.notifyListeners();
    await tester.pump();

    // The chips stay; only the doors to a new harness go.
    expect(find.byType(DeskTabFilterBar), findsOneWidget);
    expect(newTab, findsNothing);
    expect(find.byKey(const ValueKey('find-new-harness')), findsNothing);
  });

  // The first screen after pairing draws Find's own list, chips and `+ New Harness` included.
  testWidgets('the pick-up screen makes it in the tab picked too', (
    tester,
  ) async {
    final app = await deskApp(
      PagerConn(),
      opensTerminals: false,
      tabs: [
        deskTab('t1', 'Desktop', ['a', 'b']),
        deskTab('t2', 'Docker', ['c']),
      ],
    );
    addTearDown(app.dispose);
    app.noteDeskTab('t1');
    await tester.pumpWidget(MaterialApp(home: PickUpPage(notifier: app)));
    await tester.pump();
    await pickTab(tester, 'Docker');

    await openForm(tester, find.text('+ New Harness', findRichText: true));

    expect(formTab(tester), 't2');
    await unmount(tester);
  });
}
