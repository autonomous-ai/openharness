import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/open_in_browser.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/tasks/personal_task_card.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/zone_time.dart';

import 'super_tab_personal_tasks_pane_test.dart' show TasksFixture;
import 'super_tab_personal_tasks_test.dart' show task;
import 'swarm_state_test.dart' show createApp;

const _title =
    'Desktop Tasks pane: board-style cards, click opens the task with its chat in the middle; one-row agent chat header';
const _pr = 'https://github.com/autonomous-ai/openharness/pull/3464';

void main() {
  setUpAll(superTabLoadZones);

  testWidgets('a card opens its task with its header and chat in the middle', (
    t,
  ) async {
    final opened = <Uri>[];
    final before = browserOpener;
    browserOpener = (url) async {
      opened.add(url);
      return true;
    };
    addTearDown(() => browserOpener = before);
    final f = TasksFixture()
      ..rows = [
        task('aeef', 1, 20)
          ..['projectId'] = '5701'
          ..['status'] = 'working'
          ..['canApprove'] = false
          ..['title'] = _title
          ..['requester'] = {'id': '6a86', 'name': 'Ken'}
          ..['agent'] = {'id': '0540', 'name': 'Hugo'}
          ..['pullRequestUrl'] = _pr,
      ];
    addTearDown(f.controller.dispose);
    await f.controller.refresh();
    final app = createApp();
    addTearDown(app.dispose);
    t.view.physicalSize = const Size(1600, 1000);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabView(
            controller: f.controller,
            app: app,
            board: true,
            machineName: (_) => 'Computer',
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            onNewSwarm: () {},
          ),
        ),
      ),
    );
    await t.pump();
    await t.tap(
      find.descendant(
        of: find.byType(SuperTabPersonalTaskCard),
        matching: find.text(_title),
      ),
    );
    await t.pumpAndSettle();

    expect(f.controller.selectedId, 'aeef');
    expect(find.byKey(const ValueKey('super-board-tab-board')), findsNothing);
    final middle = find.byKey(const ValueKey('super-middle-chat'));
    final header = find.descendant(
      of: middle,
      matching: find.byKey(const ValueKey('super-task-header')),
    );
    expect(header, findsOneWidget);
    Finder inHeader(Finder f) => find.descendant(of: header, matching: f);
    // The full title, never cut.
    final title = t.widget<Text>(inHeader(find.text(_title)));
    expect(title.maxLines, isNull);
    expect(title.overflow, isNot(TextOverflow.ellipsis));
    // It spans the middle from its left edge, never centred in it, a short title too.
    f.rows.single
      ..['title'] = 'Short'
      ..['version'] = 2;
    await f.controller.refresh();
    await t.pump();
    expect(t.getRect(header).left, t.getRect(middle).left);
    expect(t.getRect(header).width, t.getRect(middle).width);
    expect(
      inHeader(find.text(superTabTaskStatusLabel('working'))),
      findsOneWidget,
    );
    expect(inHeader(find.byType(SuperTabTaskStatusMark)), findsOneWidget);
    final person = f.controller.snapshot!.people.single;
    expect(inHeader(find.text(person.shownName)), findsOneWidget);
    expect(inHeader(find.text('Hugo')), findsOneWidget);
    expect(
      t
          .widgetList<SuperTabAvatar>(inHeader(find.byType(SuperTabAvatar)))
          .map((a) => a.identity),
      ['person:6a86', 'agent:0540'],
    );
    await t.tap(inHeader(find.text('#3464')));
    await t.pump();
    expect(opened, [Uri.parse(_pr)]);
    // The card it was opened from stays selected.
    expect(
      t
          .widget<SuperTabPersonalTaskCard>(
            find.byType(SuperTabPersonalTaskCard),
          )
          .selected,
      isTrue,
    );
  });
}
