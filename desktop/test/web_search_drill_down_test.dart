// The search overlay on a phone (the web below compactBelow) is two pages, as
// an iPhone app's list and its detail: the results alone, then one row's
// preview behind a Back. Owner, 2026-10-27, on '@' Machines at 390 px: "split
// it into slides instead of stacking two blocks". A wide window, and Desktop,
// keep the list and the preview side by side or stacked as before.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/swarm_search.dart';
import 'package:harness/web/shell/web_chrome.dart';
import 'package:harness/widgets/desktop_search_panel.dart';
import 'package:harness/widgets/machine_picker_extras.dart';
import 'package:harness/widgets/machine_picker_form.dart';
import 'package:harness/widgets/swarm_switcher.dart';

import '../tool/web_ux_seed.dart';
import 'support/real_fonts.dart';
import 'support/web_ux_app.dart';

const _phone = Size(390, 844);
const _input = ValueKey('swarm-search-input');
const _back = ValueKey('search-details-back');
const _title = ValueKey('search-details-title');
const _actions = ValueKey('swarm-search-resource-actions');
const _list = ValueKey('swarm-search-result-list');

Future<WebUxApp> _openSearch(
  WidgetTester tester,
  Size size, {
  bool web = true,
  bool reduceMotion = false,
  int extraMachines = 0,
}) async {
  final app = withPanes(signedIn(), 2);
  for (var i = 0; i < extraMachines; i++) {
    app.addMachine('x$i', 'Spare machine $i');
  }
  addTearDown(app.dispose);
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: reduceMotion),
        child: child!,
      ),
      home: SwarmScreen(
        notifier: app,
        nativeTabs: false,
        chrome: web ? webWorkspaceChrome(app) : null,
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 200));
  await tester.tap(find.byKey(const ValueKey('swarm-search-button')));
  await tester.pump(const Duration(milliseconds: 300));
  return app;
}

Future<void> _close(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump(const Duration(seconds: 1));
}

SwarmSearchController _search(WidgetTester tester) => tester
    .widget<SwarmSearchResults>(
      find.byType(SwarmSearchResults, skipOffstage: false),
    )
    .search;

Future<void> _type(WidgetTester tester, String text) async {
  await tester.enterText(find.byKey(_input), text);
  await tester.pump(const Duration(milliseconds: 300));
}

String _rowId(WidgetTester tester, String title) =>
    _search(tester).rows.firstWhere((row) => row.title == title).id;

/// Taps the row titled [title] and lets any slide finish.
Future<void> _tapRow(WidgetTester tester, String title) async {
  await tester.tap(find.byKey(ValueKey(_rowId(tester, title))));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

bool _onDetails(WidgetTester tester) =>
    find.byKey(_back).hitTestable().evaluate().isNotEmpty;

bool _onList(WidgetTester tester) =>
    find.byKey(_list).hitTestable().evaluate().isNotEmpty;

void main() {
  setUpAll(loadRealFonts);

  testWidgets('a phone lists machines alone, with no preview under them', (
    tester,
  ) async {
    await _openSearch(tester, _phone);
    await _type(tester, '@');
    expect(_search(tester).selected, isNotNull);
    expect(_onList(tester), isTrue);
    // The preview is built, so its commands still run, but not on this page.
    expect(find.text('Rename').hitTestable(), findsNothing);
    expect(find.byKey(_back), findsNothing);
    // The list reaches down to the footer's actions, not to half the sheet.
    final list = tester.getRect(find.byKey(_list));
    final footer = tester.getRect(find.byType(MachinePickerFooter));
    expect(footer.top - list.bottom, lessThan(16));
    await _close(tester);
  });

  testWidgets('a phone hides the Preview toggle; 720 px keeps it', (
    tester,
  ) async {
    await _openSearch(tester, _phone);
    expect(find.byKey(const ValueKey('search-toggle-preview')), findsNothing);
    for (final key in ['search-clear-query', 'search-close']) {
      if (key == 'search-clear-query') await _type(tester, '@');
      final size = tester.getSize(find.byKey(ValueKey(key)));
      expect(size, const Size(44, 44), reason: key);
    }
    await _close(tester);

    await _openSearch(tester, const Size(720, 900));
    expect(find.byKey(const ValueKey('search-toggle-preview')), findsOneWidget);
    await _close(tester);
  });

  testWidgets('a machine drills in to its details, and Back returns', (
    tester,
  ) async {
    await _openSearch(tester, _phone);
    await _type(tester, '@');
    final machine = _rowId(tester, 'Studio Mac');
    await _tapRow(tester, 'Studio Mac');
    expect(_onDetails(tester), isTrue);
    expect(_onList(tester), isFalse);
    expect(tester.widget<Text>(find.byKey(_title)).data, 'Studio Mac');
    expect(find.text('Rename').hitTestable(), findsOneWidget);
    // A finger's Back, at the top left of the page.
    final back = tester.getRect(find.byKey(_back));
    expect(back.width, greaterThanOrEqualTo(44));
    expect(back.height, greaterThanOrEqualTo(44));
    final panel = tester.getRect(
      find.byKey(const ValueKey('swarm-search-results')),
    );
    expect(back.left - panel.left, lessThan(24));

    await tester.tap(find.byKey(_back));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(_onList(tester), isTrue);
    expect(_onDetails(tester), isFalse);
    expect(_search(tester).selected?.id, machine);
    await _close(tester);
  });

  testWidgets('Back leaves the keyboard down; keys still reach the search', (
    tester,
  ) async {
    await _openSearch(tester, _phone);
    await _type(tester, '@');
    await _tapRow(tester, 'Studio Mac');
    await tester.tap(find.byKey(_back));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    // A tap back to the list is not a request to type: on a phone a focused
    // field raises the keyboard over the list just returned to.
    final focused = FocusManager.instance.primaryFocus?.context;
    expect(
      focused?.findAncestorStateOfType<EditableTextState>(),
      isNull,
      reason: '$focused',
    );
    expect(
      focused?.findAncestorWidgetOfExactType<SwarmSearchResults>(),
      isNull,
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(SwarmSearchResults), findsNothing);
    await _close(tester);
  });

  testWidgets('Back keeps the list where it was scrolled', (tester) async {
    await _openSearch(tester, _phone, extraMachines: 24);
    await _type(tester, '@');
    ScrollPosition position() => tester
        .state<ScrollableState>(
          find.descendant(
            of: find.byKey(_list),
            matching: find.byType(Scrollable),
          ),
        )
        .position;
    await tester.drag(find.byKey(_list), const Offset(0, -500));
    await tester.pump(const Duration(milliseconds: 400));
    final scrolled = position().pixels;
    expect(scrolled, greaterThan(100));
    await _tapRow(tester, 'Spare machine 12');
    expect(_onDetails(tester), isTrue);
    final chosen = _search(tester).selected!.id;
    await tester.tap(find.byKey(_back));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(_onList(tester), isTrue);
    expect(_search(tester).selected?.id, chosen);
    expect(position().pixels, closeTo(scrolled, 1));
    await _close(tester);
  });

  testWidgets('Escape returns to the list and keeps the search open', (
    tester,
  ) async {
    await _openSearch(tester, _phone);
    await _type(tester, '@');
    final machine = _rowId(tester, 'Studio Mac');
    await _tapRow(tester, 'Studio Mac');
    expect(_onDetails(tester), isTrue);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byType(SwarmSearchResults), findsOneWidget);
    expect(_onList(tester), isTrue);
    expect(_search(tester).selected?.id, machine);
    await _close(tester);
  });

  testWidgets('Escape in a details page\'s form closes the form first', (
    tester,
  ) async {
    await _openSearch(tester, _phone);
    await _type(tester, '@');
    await _tapRow(tester, 'Studio Mac');
    await tester.tap(find.text('Rename'));
    await tester.pump(const Duration(milliseconds: 300));
    final field = find.descendant(
      of: find.byType(MachinePickerForm),
      matching: find.byType(EditableText),
    );
    expect(field, findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(MachinePickerForm), findsNothing);
    expect(_onDetails(tester), isTrue);
    expect(find.byType(SwarmSearchResults, skipOffstage: false), findsOne);
    await _close(tester);
  });

  testWidgets('a right swipe from the edge returns to the list', (
    tester,
  ) async {
    await _openSearch(tester, _phone);
    await _type(tester, '@');
    await _tapRow(tester, 'Studio Mac');
    expect(_onDetails(tester), isTrue);
    final panel = tester.getRect(
      find.byKey(const ValueKey('swarm-search-results')),
    );
    final page = tester.getRect(find.byKey(_actions));
    await tester.dragFrom(
      Offset(panel.left + 6, page.top - 40),
      const Offset(220, 0),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(_onList(tester), isTrue);
    await _close(tester);
  });

  testWidgets('Return on a selected machine drills in on a phone', (
    tester,
  ) async {
    await _openSearch(tester, _phone);
    await _type(tester, '@');
    final index = _search(tester).rows
        .indexWhere((row) => row.title == 'Studio Mac');
    _search(tester).move(index - _search(tester).cursor);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(_onDetails(tester), isTrue);
    await _close(tester);
  });

  testWidgets('typing on the details page returns to the list', (tester) async {
    await _openSearch(tester, _phone);
    await _type(tester, '@');
    await _tapRow(tester, 'Studio Mac');
    expect(_onDetails(tester), isTrue);
    await _type(tester, '@ stu');
    expect(_onList(tester), isTrue);
    expect(_onDetails(tester), isFalse);
    // A scope chip changes the query too.
    await _tapRow(tester, 'Studio Mac');
    expect(_onDetails(tester), isTrue);
    await tester.tap(find.byKey(const ValueKey('search-category-Harnesses')));
    await tester.pump(const Duration(milliseconds: 400));
    expect(_onDetails(tester), isFalse);
    await _close(tester);
  });

  testWidgets('a harness still opens at once; its chevron drills in', (
    tester,
  ) async {
    final app = await _openSearch(tester, _phone);
    final id = _rowId(tester, 'Docs pass');
    final chevron = tester.getSize(
      find.byKey(
        ValueKey('swarm-row-details:${_rowId(tester, 'Release notes')}'),
      ),
    );
    expect(chevron.width, greaterThanOrEqualTo(44));
    expect(chevron.height, greaterThanOrEqualTo(44));
    await tester.tap(find.byKey(ValueKey('swarm-row-details:$id')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(_onDetails(tester), isTrue);
    expect(_search(tester).selected?.id, id);
    expect(tester.widget<Text>(find.byKey(_title)).data, 'Docs pass');
    await tester.tap(find.byKey(_back));
    await tester.pump(const Duration(milliseconds: 400));

    await _tapRow(tester, 'Docs pass');
    expect(find.byType(SwarmSearchResults), findsNothing);
    expect(app.activeSwarm.panes.any((pane) => pane.agentId == 'a3'), isTrue);
    await _close(tester);
  });

  testWidgets('Reduce Motion shows the details page without a slide', (
    tester,
  ) async {
    Future<double> backLeftAfterOneFrame({required bool reduceMotion}) async {
      await _openSearch(tester, _phone, reduceMotion: reduceMotion);
      await _type(tester, '@');
      await tester.tap(find.byKey(ValueKey(_rowId(tester, 'Studio Mac'))));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 60));
      final left = tester.getRect(find.byKey(_back)).left;
      await tester.pump(const Duration(milliseconds: 400));
      final settled = tester.getRect(find.byKey(_back)).left;
      await _close(tester);
      return left - settled;
    }

    expect(await backLeftAfterOneFrame(reduceMotion: false), greaterThan(20));
    expect(await backLeftAfterOneFrame(reduceMotion: true), 0);
  });

  testWidgets('widening the window shows the list and preview together', (
    tester,
  ) async {
    await _openSearch(tester, _phone);
    await _type(tester, '@');
    final machine = _rowId(tester, 'Studio Mac');
    await _tapRow(tester, 'Studio Mac');
    expect(_onDetails(tester), isTrue);
    tester.view.physicalSize = const Size(1280, 800);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byKey(_back), findsNothing);
    expect(_onList(tester), isTrue);
    expect(find.text('Rename').hitTestable(), findsOneWidget);
    expect(_search(tester).selected?.id, machine);
    expect(find.byKey(_input), findsOneWidget);
    await _close(tester);
  });

  testWidgets('every row whose tap only selects it drills in on a phone', (
    tester,
  ) async {
    await _openSearch(tester, _phone);
    await _type(tester, '@');
    final titles = [
      for (final row in _search(tester).rows)
        if (row.isMachine || row.isAccountDevice || row.isCreate) row.title,
    ];
    expect(titles, containsAll(['Studio Mac', 'Add machine']));
    for (final title in titles) {
      await _tapRow(tester, title);
      expect(_onDetails(tester), isTrue, reason: title);
      expect(tester.widget<Text>(find.byKey(_title)).data, title);
      await tester.tap(find.byKey(_back));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
    }
    await _close(tester);
  });

  test('Add machine drills in wherever its tap only selects it', () {
    // A picker that is not the main Open Harness one (a pane's split) still
    // only selects Add machine when it is tapped in the '@' scope: a phone
    // must show its page, or the tap does nothing visible.
    final app = withPanes(signedIn(), 1);
    addTearDown(app.dispose);
    final search = SwarmSearchController(
      app,
      const [],
      adding: true,
      offersCreate: true,
    );
    addTearDown(search.dispose);
    search.setQuery('@');
    final add = search.rows.firstWhere((row) => row.isCreate);
    expect(search.setupLayout, isFalse);
    expect(swarmSearchRowSelectsOnly(search, add), isTrue);
  });

  testWidgets('a preview hidden on a wide window is shown on a phone', (
    tester,
  ) async {
    await _openSearch(tester, const Size(1280, 800));
    await tester.tap(find.byKey(const ValueKey('search-toggle-preview')));
    await tester.pump(const Duration(milliseconds: 300));
    expect(_search(tester).previewVisible, isFalse);
    tester.view.physicalSize = _phone;
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    // Harness rows keep their way to their details…
    final id = _rowId(tester, 'Docs pass');
    expect(find.byKey(ValueKey('swarm-row-details:$id')), findsOneWidget);
    // …and a machine's page is never blank.
    await _type(tester, '@');
    await _tapRow(tester, 'Studio Mac');
    expect(_onDetails(tester), isTrue);
    expect(find.text('Rename').hitTestable(), findsOneWidget);
    await _close(tester);
  });

  testWidgets('a row picked by its number drills in like a tap', (
    tester,
  ) async {
    await _openSearch(tester, _phone);
    await _type(tester, '@');
    final index = _search(tester).rows
        .indexWhere((row) => row.title == 'Studio Mac');
    final digit = [
      LogicalKeyboardKey.digit1,
      LogicalKeyboardKey.digit2,
      LogicalKeyboardKey.digit3,
    ][index];
    await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
    await tester.sendKeyEvent(digit);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(_onDetails(tester), isTrue);
    expect(tester.widget<Text>(find.byKey(_title)).data, 'Studio Mac');
    await _close(tester);
  });

  testWidgets('a chevron names the row it opens', (tester) async {
    final semantics = tester.ensureSemantics();
    await _openSearch(tester, _phone);
    final id = _rowId(tester, 'Docs pass');
    expect(
      tester.getSemantics(find.byKey(ValueKey('swarm-row-details:$id'))),
      isSemantics(tooltip: 'Details for Docs pass'),
    );
    await _close(tester);
    semantics.dispose();
  });

  testWidgets('every control on both pages takes a finger', (tester) async {
    await _openSearch(tester, _phone);
    await _type(tester, '@');
    await _tapRow(tester, 'Studio Mac');
    final buttons = find.byWidgetPredicate(
      (widget) => widget is ButtonStyleButton || widget is IconButton,
    );
    for (final element in buttons.hitTestable().evaluate()) {
      final box = element.renderObject! as RenderBox;
      expect(box.size.width, greaterThanOrEqualTo(44), reason: '$element');
      expect(box.size.height, greaterThanOrEqualTo(44), reason: '$element');
    }
    await _close(tester);
  });

  testWidgets('a wide window\'s search reads to a screen reader as before', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    await _openSearch(tester, const Size(1280, 800));
    // The pager's own focus is for keys only: wrapping the panel must not
    // make the dialog around it a focusable node of its own.
    expect(
      tester.getSemantics(find.byType(DesktopSearchPanel)),
      isNot(isSemantics(isFocusable: true)),
    );
    await _close(tester);
    semantics.dispose();
  });

  for (final (name, size, web) in [
    ('720 px', const Size(720, 900), true),
    ('a wide window', const Size(1280, 800), true),
    ('Desktop at a phone\'s width', _phone, false),
  ]) {
    testWidgets('$name keeps the list and preview together, and its keys', (
      tester,
    ) async {
      await _openSearch(tester, size, web: web);
      await _type(tester, '@');
      // Both on screen at once, with no page to go to.
      expect(_onList(tester), isTrue);
      expect(find.text('Rename').hitTestable(), findsOneWidget);
      await _tapRow(tester, 'Studio Mac');
      expect(find.byKey(_back), findsNothing);
      expect(_onList(tester), isTrue);
      // Return on a machine moves to its actions; Escape steps back to the
      // field, then closes the search — as before.
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(SwarmSearchResults), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(SwarmSearchResults), findsOneWidget);
      expect(_onList(tester), isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump(const Duration(milliseconds: 100));
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byType(SwarmSearchResults), findsNothing);
      await _close(tester);
    });
  }
}
