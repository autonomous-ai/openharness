import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/desktop_workspace_tab.dart';

import 'support/agent_messages_api.dart';
import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show createApp;

/// A tab has nothing of Agent Messages (docs/design/2026-10-10-agent-messages.md):
/// at rest and hovered it shows only its name, its status and ×. The 💬 that
/// sat beside × was easy to hit by mistake and turned the tab off, failing a
/// message that was waiting (owner, 2026-10-12); whether agents may message is
/// the account's now (Settings ▸ Experimental). Traffic between its agents
/// shows nothing either.
typedef _Spec = ({String id, bool working});

Widget _host(
  List<_Spec> tabs, {
  Brightness brightness = Brightness.dark,
  void Function(String id)? onClose,
}) => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: grid.buildAppTheme(brightness: brightness),
  themeAnimationDuration: Duration.zero,
  home: Scaffold(
    body: Align(
      alignment: Alignment.topLeft,
      child: SizedBox(
        height: 40,
        child: Row(
          children: [
            for (final (index, tab) in tabs.indexed)
              SizedBox(
                width: 240,
                child: DesktopWorkspaceTab(
                  key: ValueKey('tab:${tab.id}'),
                  id: tab.id,
                  label: tab.id,
                  selected: index == 0,
                  showShortcuts: const AlwaysStoppedAnimation(false),
                  shortcutHint: '⌘${index + 1}',
                  onSelect: () {},
                  onClose: () => onClose?.call(tab.id),
                  activityLabel: tab.working ? 'Working' : null,
                  activity: tab.working
                      ? SizedBox(
                          key: ValueKey('status:${tab.id}'),
                          width: 16,
                          child: const Text('⠋'),
                        )
                      : null,
                ),
              ),
          ],
        ),
      ),
    ),
  ),
);

Finder _tab(String id) => find.byKey(ValueKey('tab:$id'));
Finder _close(String id) => find.byKey(ValueKey('tab-close:$id'));
Finder _label(String id) => find.byKey(ValueKey('tab-label:$id'));
Finder _status(String id) => find.byKey(ValueKey('status:$id'));

/// Every glyph the tab draws.
List<IconData?> _icons(WidgetTester tester, String id) => [
  for (final icon in tester.widgetList<Icon>(
    find.descendant(of: _tab(id), matching: find.byType(Icon)),
  ))
    icon.icon,
];

Future<TestGesture> _hover(WidgetTester tester, Finder target) async {
  final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
  await mouse.addPointer(location: tester.getCenter(target));
  addTearDown(mouse.removePointer);
  await tester.pump();
  return mouse;
}

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('at rest a name and status; hovered, × and nothing else '
        '(${brightness.name})', (tester) async {
      final closed = <String>[];
      await tester.pumpWidget(
        _host(
          [(id: 'app', working: true)],
          brightness: brightness,
          onClose: closed.add,
        ),
      );
      expect(_close('app').hitTestable(), findsNothing);
      expect(_status('app'), findsOneWidget);
      final title = tester.getRect(_label('app'));
      await _hover(tester, _label('app'));
      expect(_close('app').hitTestable(), findsOneWidget);
      expect(_icons(tester, 'app'), [
        AppIcons.close,
      ], reason: 'the only control a tab draws is ×');
      expect(
        find.byKey(const ValueKey('tab-agent-messages:app')),
        findsNothing,
      );
      expect(_status('app'), findsOneWidget, reason: 'hover keeps the status');
      expect(find.text('⌘1'), findsNothing, reason: 'Command is not held');
      expect(
        tester.getRect(_label('app')),
        title,
        reason: 'a name with room never moves',
      );
      final close = tester.getRect(_close('app'));
      expect(close.size, const Size.square(DesktopWorkspaceTab.closeWidth));
      expect(
        tester.getRect(_tab('app')).right - close.right,
        grid.AppDesktop.tabCloseInset,
        reason: '× keeps its inset inside the curved body',
      );
      // As the pane's ×: one gap above, below and to the body's right side.
      final tab = tester.getRect(_tab('app'));
      final above = close.top - (tab.top + grid.AppDesktop.tabTopInset);
      expect(tab.bottom - close.bottom, above);
      expect(tab.right - grid.AppDesktop.tabShoulder - close.right, above);
      // Full ink at rest, as the pane's × (AppIcons.closeInk).
      final ink = tester
          .widget<IconButton>(_close('app'))
          .style!
          .foregroundColor!
          .resolve(<WidgetState>{})!;
      expect(ink.a, 1);
      await tester.tap(_close('app'));
      await tester.pump();
      expect(closed, ['app']);
    });
  }

  testWidgets('hovered, a long name moves left only as far as × needs', (
    tester,
  ) async {
    const id = 'a-name-long-enough-to-reach-the-close-mark';
    await tester.pumpWidget(_host([(id: id, working: true)]));
    await _hover(tester, _label(id));
    final status = tester.getRect(_status(id));
    final close = tester.getRect(_close(id));
    expect(status.right, lessThanOrEqualTo(close.left + .01));
    expect(
      close.left - status.right,
      lessThan(1),
      reason: 'no room is kept for a control that is gone',
    );
  });

  testWidgets('the tab offers Close tab and no Agent Messages action', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(_host([(id: 'app', working: false)]));
    await _hover(tester, _label('app'));
    expect(find.semantics.byLabel('Agent Messages').evaluate(), isEmpty);
    final tab = tester.getSemantics(find.bySemanticsLabel(RegExp(r'^app$')));
    final actions = [
      for (final id in tab.getSemanticsData().customSemanticsActionIds!)
        CustomSemanticsAction.getAction(id)!.label,
    ];
    expect(actions, ['Close tab']);
    semantics.dispose();
  });

  testWidgets('a desk tab with Agent Messages shows none of it, hovered or '
      'not', (tester) async {
    final app = createApp();
    addTearDown(app.dispose);
    await joinAgentMessagesDesk(app);
    await mount(tester, app);
    final tab = app.activeSwarmId;
    expect(
      app.agentMessagesOffered(tab),
      isTrue,
      reason: 'the tab has a log to show',
    );
    expect(find.byKey(ValueKey('tab-agent-messages:$tab')), findsNothing);
    await _hover(tester, _label(tab));
    expect(_close(tab).hitTestable(), findsOneWidget);
    expect(find.byKey(ValueKey('tab-agent-messages:$tab')), findsNothing);
    expect(find.byIcon(Icons.forum), findsNothing);
    expect(find.byIcon(Icons.forum_outlined), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a message moving in a tab changes nothing on it', (
    tester,
  ) async {
    final app = createApp();
    addTearDown(app.dispose);
    await joinAgentMessagesDesk(app);
    final tab = app.activeSwarmId;
    await mount(tester, app);
    List<String?> tooltips() => [
      for (final tooltip in tester.widgetList<Tooltip>(
        find.ancestor(of: _label(tab), matching: find.byType(Tooltip)),
      ))
        tooltip.message,
    ];
    final label = tester.getRect(_label(tab));
    final hints = tooltips();
    app.agentMessages.handleEvent({
      'tabId': tab,
      'messageId': 'm0000001',
      'at': 1,
      'from': {'machineId': 'studio', 'agentId': 'lead'},
      'to': [
        {'machineId': 'laptop', 'agentId': 'api', 'state': 'queued'},
      ],
    });
    await tester.pump();
    expect(app.agentMessages.trafficFor(tab), 1);
    expect(
      tester.getRect(_label(tab)),
      label,
      reason: 'no status slot opens beside the name',
    );
    expect(tooltips(), hints);
    expect(find.byIcon(Icons.forum), findsNothing);
    // Let the pane marks lapse before the test ends.
    await tester.pump(app.agentMessages.markLife);
    await tester.pumpWidget(const SizedBox());
  });
}
