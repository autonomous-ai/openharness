// The Super Tab's header on a phone (the web below compactBelow): Chat, the
// people and machines and the ⋮ menu stay in the bar, a finger's size each,
// and the menu names what the bar drew as bare icons — the group's terminals
// and its pull requests — while the header says which of them is open. A
// wider window keeps the icons.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/widgets/app_icon_button.dart';
import 'package:harness/super_tabs/roster.dart';

import 'support/super_tab_phone.dart';

final _options = find.byKey(const ValueKey('super-group-options'));
final _people = find.byTooltip('Members and machines');
final _openView = find.byKey(const ValueKey('super-open-view'));

void main() {
  testWidgets('a phone keeps Chat and the menu in the bar, a finger each', (
    tester,
  ) async {
    final (_, controller) = await mountPhoneSuperTab(
      tester,
      const Size(390, 844),
    );
    expect(find.byKey(const ValueKey('super-terminals')), findsNothing);
    expect(find.byKey(const ValueKey('super-pull-requests')), findsNothing);
    for (final control in [
      find.byTooltip('Conversations'),
      find.byKey(const ValueKey('super-chat')),
      find.byKey(const ValueKey('super-leaderboard')),
      _people,
      _options,
    ]) {
      expect(control, findsOneWidget);
      final size = tester.getSize(control);
      expect(size.width, greaterThanOrEqualTo(44));
      expect(size.height, greaterThanOrEqualTo(44));
    }
    expect(tester.takeException(), isNull);
    await unmountPhoneSuperTab(tester, controller);
  });

  testWidgets('the phone menu names terminals and pull requests', (
    tester,
  ) async {
    var terminals = 0;
    final (_, controller) = await mountPhoneSuperTab(
      tester,
      const Size(390, 844),
      onOpenGroupTerminals: () => terminals++,
    );
    Future<void> choose(String label) async {
      await tester.tap(_options);
      await tester.pumpAndSettle();
      final row = find.widgetWithText(MenuItemButton, label);
      expect(tester.getSize(row).height, greaterThanOrEqualTo(44));
      await tester.tap(row);
      await tester.pumpAndSettle();
    }

    await choose('Group terminals (1)');
    expect(terminals, 1);

    await choose('Pull requests');
    // Chat is no longer the view: the pull requests are.
    expect(
      tester
          .widget<AppIconButton>(find.byKey(const ValueKey('super-chat')))
          .selected,
      isFalse,
    );
    expect(tester.takeException(), isNull);
    await unmountPhoneSuperTab(tester, controller);
  });

  testWidgets('a wide window keeps the icons in the header', (tester) async {
    final (_, controller) = await mountPhoneSuperTab(
      tester,
      const Size(1280, 800),
    );
    expect(find.byKey(const ValueKey('super-terminals')), findsOneWidget);
    expect(find.byKey(const ValueKey('super-pull-requests')), findsOneWidget);
    await tester.tap(_options);
    await tester.pumpAndSettle();
    expect(find.text('Pull requests'), findsNothing);
    expect(find.text('Members and machines'), findsNothing);
    await unmountPhoneSuperTab(tester, controller);
  });

  testWidgets('a phone opens the people and machines in one tap', (
    tester,
  ) async {
    final (_, controller) = await mountPhoneSuperTab(
      tester,
      const Size(390, 844),
    );
    await tester.tap(_people);
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabRoster), findsOneWidget);
    final row = find.byKey(const ValueKey('super-person-owner'));
    expect(tester.getSize(row).height, greaterThanOrEqualTo(44));
    final invite = tester.getSize(find.byTooltip('Invite people'));
    expect(invite.width, greaterThanOrEqualTo(44));
    expect(invite.height, greaterThanOrEqualTo(44));
    await tester.tapAt(const Offset(40, 400));
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabRoster), findsNothing);
    await unmountPhoneSuperTab(tester, controller);
  });

  testWidgets('a phone header says which view is open', (tester) async {
    final (_, chat) = await mountPhoneSuperTab(tester, const Size(390, 844));
    expect(_openView, findsNothing, reason: 'the chat is the default view');
    await tester.tap(_options);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(MenuItemButton, 'Pull requests'));
    await tester.pumpAndSettle();
    expect(tester.widget<Text>(_openView).data, 'Pull requests');
    await unmountPhoneSuperTab(tester, chat);

    final (_, terminals) = await mountPhoneSuperTab(
      tester,
      const Size(390, 844),
      terminalsVisible: true,
    );
    expect(tester.widget<Text>(_openView).data, 'Group terminals');
    await unmountPhoneSuperTab(tester, terminals);
  });
}
