import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/section_heading.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/humans_fixture.dart';

/// Every section of the left sidebar collapses the same way (Dee, 2026-10-30:
/// "needs to fully collapse/uncollapse (like machines and projects!!!)"): its
/// heading's chevron hides everything below it down to the next heading, and
/// shows it all again. Walks whatever headings the sidebar has, so a section
/// added later without a chevron fails here.
void main() {
  testWidgets(
    'every sidebar heading collapses all of its rows and expands them again',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1300, 1600));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = modelsSwarm();
      final controller = server.controller(
        account: 'peer',
        initial: {'tabId': 'tab', 'accountId': 'peer', 'selectedId': 'lead'},
      );
      await controller.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: SuperTabView(
              controller: controller,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final sidebar = find.byType(ProjectSidebar);
      final headings = find.descendant(
        of: sidebar,
        matching: find.byType(SuperTabSectionHeading),
      );

      /// The headings top to bottom, with where each one's section ends.
      List<({String title, double top, double bottom})> sections() {
        final found = [
          for (final element in headings.evaluate())
            (
              title: (element.widget as SuperTabSectionHeading).title,
              top: tester.getTopLeft(find.byWidget(element.widget)).dy,
              bottom: tester.getBottomLeft(find.byWidget(element.widget)).dy,
            ),
        ]..sort((a, b) => a.top.compareTo(b.top));
        return found;
      }

      /// Every text drawn between [title]'s heading and the next one.
      List<String> body(String title) {
        final all = sections();
        final i = all.indexWhere((s) => s.title == title);
        final end = i + 1 < all.length
            ? all[i + 1].top
            : tester.getBottomLeft(sidebar).dy;
        return [
          for (final element
              in find
                  .descendant(of: sidebar, matching: find.byType(RichText))
                  .evaluate())
            if (tester.getTopLeft(find.byWidget(element.widget)).dy case final y
                when y >= all[i].bottom && y < end)
              (element.widget as RichText).text.toPlainText(),
        ];
      }

      final titles = [for (final s in sections()) s.title];
      // Not a vacuous walk: the sections people asked about are all here.
      expect(
        titles,
        containsAllInOrder(['Projects', 'Buddies', 'Machines', 'Models']),
      );
      for (final title in titles) {
        final heading = find.descendant(
          of: sidebar,
          matching: find.byWidgetPredicate(
            (w) => w is SuperTabSectionHeading && w.title == title,
          ),
        );
        expect(
          tester.widget<SuperTabSectionHeading>(heading).onToggleCollapsed,
          isNotNull,
          reason: '$title chevron',
        );
        final shown = body(title);
        expect(shown, isNotEmpty, reason: '$title has rows');
        final label = find.descendant(of: heading, matching: find.text(title));
        await tester.tap(label);
        await tester.pumpAndSettle();
        expect(body(title), isEmpty, reason: '$title collapsed');
        await tester.tap(label);
        await tester.pumpAndSettle();
        expect(body(title), shown, reason: '$title expanded');
      }

      await tester.pumpWidget(const SizedBox());
      await controller.flush();
      controller.dispose();
    },
  );

  testWidgets('remembers a collapsed Buddies after a restart', (tester) async {
    final server = modelsSwarm();
    final controller = server.controller(
      account: 'peer',
      initial: {'tabId': 'tab', 'accountId': 'peer', 'selectedId': 'lead'},
    );
    await controller.refresh();
    controller.toggleBuddiesGroup();
    await controller.flush();
    controller.dispose();
    expect(server.saved!['buddiesGroupOpen'], isFalse);
    final reopened = server.controller(account: 'peer', initial: server.saved);
    await reopened.refresh();
    expect(reopened.buddiesGroupOpen, isFalse);
    await reopened.flush();
    reopened.dispose();
  });
}
