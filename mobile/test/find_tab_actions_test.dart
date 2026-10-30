import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/desk_tab_filter_bar.dart';
import 'package:harness_mobile/phone/phone_search_results.dart';
import 'package:harness_mobile/phone/terminal_search.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/phone_desk.dart';

import 'agent_pager_fixture.dart';
import 'desk_fixture.dart';

/// A desk that answers its first read and then takes no write — the backend refusing every op,
/// which leaves the phone showing the tabs but no longer writing to them.
class _RefusingDeskApi extends DeskApi {
  _RefusingDeskApi({super.tabs});

  @override
  Future<Map<String, dynamic>?> deskOps(List<Map<String, dynamic>> ops) async {
    written.addAll(ops);
    return null;
  }
}

/// Holding a tab's chip in Find: the desktop's tab menu, Rename Tab… and Close Tab.
void main() {
  Future<AppNotifier> openFind(WidgetTester tester, {AppNotifier? app}) async {
    final shown =
        app ??
        await deskApp(
          PagerConn(),
          opensTerminals: false,
          tabs: [
            deskTab('t1', 'Desktop', ['a', 'b']),
            deskTab('t2', 'Docker', ['c']),
          ],
        );
    addTearDown(shown.dispose);
    shown.noteDeskTab('t1');
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TerminalSearchOverlay(
            notifier: shown,
            animation: const AlwaysStoppedAnimation(1),
            onClose: () {},
            showing: (machineId: 'm', agentId: 'a'),
          ),
        ),
      ),
    );
    await tester.pump();
    return shown;
  }

  Finder chip(String name) => find.descendant(
    of: find.byType(DeskTabFilterBar),
    matching: find.text(name),
  );

  /// A sheet or dialog sliding in or out, run to its end.
  Future<void> settle(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  Future<void> hold(WidgetTester tester, String name) async {
    await tester.longPress(chip(name));
    await settle(tester);
  }

  String? pickedTab(WidgetTester tester) => tester
      .state<PhoneSearchResultsState>(find.byType(PhoneSearchResults))
      .deskTabId;

  /// Takes Find down and runs its clocks out, so no timer outlives the test.
  Future<void> unmount(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 30));
  }

  testWidgets('holding a tab chip offers Rename Tab… and Close Tab', (
    tester,
  ) async {
    await openFind(tester);

    await hold(tester, 'Docker');

    expect(find.text('Rename Tab…'), findsOneWidget);
    expect(find.text('Close Tab'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('holding All offers nothing: it is no tab', (tester) async {
    await openFind(tester);

    await hold(tester, 'All');

    expect(find.text('Rename Tab…'), findsNothing);
    expect(find.text('Close Tab'), findsNothing);
    await unmount(tester);
  });

  testWidgets(
    'Close Tab takes the tab off the desk at once, and the list back to All',
    (tester) async {
      final app = await openFind(tester);
      await tester.tap(chip('Docker'));
      await tester.pump();
      expect(pickedTab(tester), 't2');

      await hold(tester, 'Docker');
      await tester.tap(find.text('Close Tab'));
      await settle(tester);

      // No question first: the desk took it, and the chip is gone.
      expect(find.text('Close Tab'), findsNothing);
      expect(deskApiOf(app).written, [
        {'op': 'tab.close', 'id': 't2'},
      ]);
      expect([for (final tab in app.deskTabs) tab.id], ['t1']);
      expect(chip('Docker'), findsNothing);
      expect(chip('Desktop'), findsOneWidget);
      expect(pickedTab(tester), isNull);
      // Its harness is stopped by nothing: still on the machine, still under All.
      expect(app.stateOf('m')!.agents.map((agent) => agent.id), contains('c'));
      await unmount(tester);
    },
  );

  testWidgets('Rename Tab… opens on the name the chip shows, and saves it', (
    tester,
  ) async {
    final app = await openFind(tester);

    await hold(tester, 'Docker');
    await tester.tap(find.text('Rename Tab…'));
    await settle(tester);

    expect(find.text('Rename Tab'), findsOneWidget);
    final field = find.byType(TextField).last;
    expect(tester.widget<TextField>(field).controller!.text, 'Docker');

    await tester.enterText(field, '  Deep work ');
    await tester.pump();
    await tester.tap(find.text('Save'));
    await settle(tester);

    expect(find.text('Rename Tab'), findsNothing);
    expect(deskApiOf(app).written, [
      {
        'op': 'tab.rename',
        'id': 't2',
        'name': 'Deep work',
        'nameIsCustom': true,
      },
    ]);
    expect(chip('Deep work'), findsOneWidget);
    expect(chip('Docker'), findsNothing);
    await unmount(tester);
  });

  testWidgets('Save waits for a name that is there and new', (tester) async {
    final app = await openFind(tester);

    await hold(tester, 'Docker');
    await tester.tap(find.text('Rename Tab…'));
    await settle(tester);

    FilledButton save() => tester.widget<FilledButton>(
      find.ancestor(of: find.text('Save'), matching: find.byType(FilledButton)),
    );
    expect(save().onPressed, isNull);
    await tester.enterText(find.byType(TextField).last, '   ');
    await tester.pump();
    expect(save().onPressed, isNull);

    // Longer than the desk takes: the field stops at its limit.
    await tester.enterText(
      find.byType(TextField).last,
      'x' * (PhoneDesk.nameMaxLength + 5),
    );
    await tester.pump();
    expect(
      tester.widget<TextField>(find.byType(TextField).last).controller!.text,
      hasLength(PhoneDesk.nameMaxLength),
    );

    await tester.tap(find.text('Cancel'));
    await settle(tester);
    expect(deskApiOf(app).written, isEmpty);
    await unmount(tester);
  });

  testWidgets(
    'a tab closed while its rename is open says so, and keeps it open',
    (tester) async {
      final app = await openFind(tester);

      await hold(tester, 'Docker');
      await tester.tap(find.text('Rename Tab…'));
      await settle(tester);
      // Gone from under the dialog — another computer's close, as this phone hears it.
      app.closeDeskTab('t2');
      await tester.pump();

      await tester.enterText(find.byType(TextField).last, 'Deep work');
      await tester.pump();
      await tester.tap(find.text('Save'));
      await settle(tester);

      expect(find.text('Rename Tab'), findsOneWidget);
      expect(find.text('This tab has been closed.'), findsOneWidget);
      expect(
        deskApiOf(app).written.where((op) => op['op'] == 'tab.rename'),
        isEmpty,
      );
      await unmount(tester);
    },
  );

  testWidgets('no menu while the desk takes no writes', (tester) async {
    final app = pagerApp(PagerConn());
    app.api = _RefusingDeskApi(
      tabs: [
        deskTab('t1', 'Desktop', ['a', 'b']),
        deskTab('t2', 'Docker', ['c']),
      ],
    );
    app.stateOf('m')!.terminalCapabilityAvailable = false;
    await syncDesk(app);
    // A write refused: the phone stops writing to the desk, and still shows its tabs.
    app.closeDeskTab('t1');
    await tester.pump();
    expect(app.deskWritable, isFalse);
    await openFind(tester, app: app);
    expect(chip('Docker'), findsOneWidget);

    await hold(tester, 'Docker');

    expect(find.text('Rename Tab…'), findsNothing);
    expect(find.text('Close Tab'), findsNothing);
    await unmount(tester);
  });
}
