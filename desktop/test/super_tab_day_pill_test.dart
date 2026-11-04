import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/widgets/laid_out_list.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_DAY_PILL_SHOTS'];

const _updates = [
  'Reading the offline queue before the reconnect.',
  'The reconnect keeps every queued edit in order.',
  'Two devices editing at once settle on the newest edit.',
  'Pushed the branch; the checks are running.',
];

// Noon UTC: two different local days in every time zone the tests run in.
const _monday = '2026-11-02T12:00:00Z', _tuesday = '2026-11-03T12:00:00Z';
const _peer = {'kind': 'person', 'id': 'peer', 'name': 'peer@example.com'};
const _lead = {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'};

const _chatPill = ValueKey('super-day-pill');
const _threadPill = ValueKey('super-thread-day-pill');

/// Two days of chat, and a thread whose root and first replies are from the
/// first day: Huy 11-03, the day stays at the top while scrolling, as Slack's.
ConversationServer _twoDays() {
  final server = ConversationServer()..threads = true;
  (server.state['people'] as List).add({
    'id': 'peer',
    'email': 'peer@example.com',
    'role': 'collaborator',
  });
  server.append('Should we do thread replies?');
  server.messages.last['createdAt'] = _monday;
  for (var i = 1; i <= 24; i++) {
    server.append('${_updates[i % _updates.length]} ($i)');
    server.messages.last
      ..['thread'] = 'message-1'
      ..['replyTo'] = 'message-1'
      ..['author'] = _peer
      ..['createdAt'] = i <= 12 ? _monday : _tuesday;
  }
  for (var i = 1; i <= 60; i++) {
    server.append('${_updates[i % _updates.length]} ($i)');
    server.messages.last
      ..['author'] = _lead
      ..['createdAt'] = i <= 30 ? _monday : _tuesday;
  }
  return server;
}

Widget _app(SuperTabController c, {Brightness? brightness, Key? picture}) =>
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness ?? Brightness.light),
      builder: (context, child) => RepaintBoundary(key: picture, child: child),
      home: Scaffold(
        body: SuperTabView(
          controller: c,
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          machineName: (_) => 'Mac Studio',
        ),
      ),
    );

String _day(WidgetTester tester, String iso) =>
    MaterialLocalizations.of(tester.element(find.byType(SuperTabView)))
        .formatMediumDate(DateTime.parse(iso).toLocal());

/// What the pill under [key] says, or null when it is not shown.
String? _pill(WidgetTester tester, Key key) {
  final pill = find.byKey(key);
  if (pill.evaluate().isEmpty) return null;
  final text = find.descendant(of: pill, matching: find.byType(Text));
  return tester.widget<Text>(text.first).data;
}

/// The chat's message list.
final _chatList = find.byWidgetPredicate(
  (w) =>
      w is CustomScrollView &&
      w.key is PageStorageKey &&
      '${(w.key as PageStorageKey).value}'.startsWith('super-messages-'),
);

ScrollController _chatScroll(WidgetTester tester) =>
    tester.widget<CustomScrollView>(_chatList).controller!;

ScrollController _threadScroll(WidgetTester tester) => tester
    .widget<ListView>(
      find.descendant(
        of: find.byKey(const ValueKey('super-thread-panel')),
        matching: find.byType(LaidOutListView),
      ),
    )
    .controller!;

Future<void> _scrollTo(
  WidgetTester tester,
  ScrollController scroll,
  double pixels,
) async {
  scroll.jumpTo(pixels);
  await tester.pump();
  await tester.pump();
}

double _topOf(WidgetTester tester, String text) =>
    tester.getTopLeft(find.text(text, findRichText: true).first).dy;

String _textOf(Widget widget) => switch (widget) {
  Text(:final data?) => data,
  RichText(:final text) => text.toPlainText(),
  _ => '',
};

/// Some message row's text in view, below the top [margin] of the screen.
String _rowInView(WidgetTester tester, {double margin = 200}) {
  final rows = find.textContaining(RegExp(r'\(\d+\)$'), findRichText: true);
  for (final element in rows.evaluate()) {
    final text = _textOf(element.widget);
    final box = element.renderObject;
    if (box is! RenderBox || !box.attached || text.isEmpty) continue;
    final top = box.localToGlobal(Offset.zero).dy;
    if (top > margin &&
        top < 600 &&
        find.text(text, findRichText: true).evaluate().length == 1) {
      return text;
    }
  }
  throw StateError('no message row in view');
}

/// The chat's day lines saying [day] that are painted: neither hidden nor
/// faded out under the pill.
Iterable<Rect> _dayLines(WidgetTester tester, String day) sync* {
  for (final element
      in find.descendant(of: _chatList, matching: find.text(day)).evaluate()) {
    var painted = true;
    element.visitAncestorElements((ancestor) {
      final widget = ancestor.widget;
      if (widget is Visibility && !widget.visible ||
          widget is Opacity && widget.opacity == 0) {
        painted = false;
      }
      return painted && widget is! CustomScrollView;
    });
    final box = element.renderObject;
    if (!painted || box is! RenderBox || !box.attached) continue;
    yield box.localToGlobal(Offset.zero) & box.size;
  }
}

/// At this place in the chat, one label at most says each day where the
/// pill is: no day line under the pill, none repeating the pill's day.
void _oneLabel(WidgetTester tester, List<String> days, String where) {
  final pill = find.byKey(_chatPill);
  if (pill.evaluate().isEmpty) return;
  final shown = _pill(tester, _chatPill);
  final rect = tester.getRect(pill);
  for (final day in days) {
    for (final line in _dayLines(tester, day)) {
      expect(
        line.overlaps(rect),
        isFalse,
        reason:
            '$where: the "$day" day line at $line is under the pill at $rect',
      );
      expect(
        day,
        isNot(shown),
        reason: '$where: the pill and a day line at $line both say "$day"',
      );
    }
  }
}

/// The chat scrolled so that Tuesday's day line sits [offset] pixels from
/// the list's top.
Future<void> _tuesdayLineAt(
  WidgetTester tester,
  ScrollController scroll,
  String tuesday,
  double offset,
) async {
  final listTop = tester.getTopLeft(_chatList).dy;
  for (var i = 0; i < 4; i++) {
    final line = _dayLines(tester, tuesday).firstOrNull;
    if (line == null) break;
    await _scrollTo(
      tester,
      scroll,
      scroll.position.pixels + line.top - listTop - offset,
    );
  }
}

Future<void> _open(
  WidgetTester tester,
  SuperTabController c, {
  Brightness? brightness,
  Key? picture,
}) async {
  await c.refresh();
  if (brightness != null) {
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
  }
  await tester.binding.setSurfaceSize(const Size(1400, 800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(_app(c, brightness: brightness, picture: picture));
  await tester.pumpAndSettle();
}

/// Scrolls [scroll] toward its start in 40-pixel steps until the pill under
/// [key] says [day]; how far it went.
Future<double> _scrollBackTo(
  WidgetTester tester,
  ScrollController scroll,
  Key key,
  String day,
) async {
  final start = scroll.position.pixels;
  while (_pill(tester, key) != day &&
      scroll.position.pixels - 40 > scroll.position.minScrollExtent) {
    await _scrollTo(tester, scroll, scroll.position.pixels - 40);
  }
  return start - scroll.position.pixels;
}

/// Writes what [picture] shows to [name].png in [shots], when it is set.
Future<void> _shoot(WidgetTester tester, GlobalKey picture, String name) async {
  if (shots == null) return;
  await tester.runAsync(() async {
    final boundary =
        picture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 1.5);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(shots!).create(recursive: true);
    await File('$shots/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  testWidgets("the chat keeps the top message's day in a pill while "
      'scrolling', (tester) async {
    final c = _twoDays().controller();
    addTearDown(c.dispose);
    await _open(tester, c);

    // At the newest message, Tuesday's rows fill the view.
    final tuesday = _day(tester, _tuesday), monday = _day(tester, _monday);
    expect(_pill(tester, _chatPill), tuesday);

    // Back into Monday: the pill follows the message at the top.
    final scroll = _chatScroll(tester);
    expect(await _scrollBackTo(tester, scroll, _chatPill, monday), isPositive);
    expect(_pill(tester, _chatPill), monday);

    // The pill floats over the list: a row moves exactly as far as the
    // list scrolls, and nothing is inserted above it.
    final row = _rowInView(tester), before = _topOf(tester, row);
    await _scrollTo(tester, scroll, scroll.position.pixels - 40);
    expect(_topOf(tester, row) - before, moreOrLessEquals(40, epsilon: .5));

    // And back down to Tuesday, it says Tuesday again.
    while (_pill(tester, _chatPill) != tuesday &&
        scroll.position.extentAfter > 0) {
      await _scrollTo(tester, scroll, scroll.position.pixels + 40);
    }
    expect(_pill(tester, _chatPill), tuesday);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
  });

  testWidgets("the thread keeps the top reply's day in a pill while "
      'scrolling, and none at its start', (tester) async {
    final c = _twoDays().controller();
    addTearDown(c.dispose);
    await _open(tester, c);
    c.openThread('message-1');
    await tester.pumpAndSettle();

    final tuesday = _day(tester, _tuesday), monday = _day(tester, _monday);
    expect(_pill(tester, _threadPill), tuesday);

    final scroll = _threadScroll(tester);
    expect(
      await _scrollBackTo(tester, scroll, _threadPill, monday),
      isPositive,
    );
    expect(_pill(tester, _threadPill), monday);

    // At the root, nothing is hidden above: no pill. Scrolling on shows it
    // over the list, which does not move for it.
    await _scrollTo(tester, scroll, scroll.position.minScrollExtent);
    expect(_pill(tester, _threadPill), isNull);
    const root = 'Should we do thread replies?';
    final threadRoot = find.descendant(
      of: find.byKey(const ValueKey('super-thread-panel')),
      matching: find.text(root),
    );
    final before = tester.getTopLeft(threadRoot).dy;
    await _scrollTo(tester, scroll, scroll.position.minScrollExtent + 30);
    expect(_pill(tester, _threadPill), monday);
    expect(
      tester.getTopLeft(threadRoot).dy - before,
      moreOrLessEquals(-30, epsilon: .5),
    );
    await tester.pumpWidget(const SizedBox());
    await c.flush();
  });

  testWidgets('the pill gives the top to "Finding the original message…" '
      'and comes back after', (tester) async {
    // 250 notes from one day; the last replies to one pages back.
    final server = ConversationServer();
    for (var i = 1; i <= 250; i++) {
      server.append('Note $i');
    }
    server.messages.last['replyTo'] = 'message-10';
    final c = server.controller();
    addTearDown(c.dispose);
    await _open(tester, c);
    final day = _day(tester, '2026-10-18T00:00:00Z');
    expect(_pill(tester, _chatPill), day);

    server.holdReads = Completer<void>();
    await tester.tap(
      find.descendant(
        of: find.byKey(const ValueKey('super-message-message-250')),
        matching: find.byType(SuperTabReplyPreview),
      ),
    );
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const ValueKey('super-reply-finding')), findsOneWidget);
    expect(_pill(tester, _chatPill), isNull);

    server.holdReads!.complete();
    server.holdReads = null;
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('super-reply-finding')), findsNothing);
    expect(_pill(tester, _chatPill), day);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
  });

  testWidgets('scrolling across a day line never shows two day labels '
      'where the pill is', (tester) async {
    final c = _twoDays().controller();
    addTearDown(c.dispose);
    await _open(tester, c);
    final tuesday = _day(tester, _tuesday), monday = _day(tester, _monday);
    final days = [monday, tuesday];
    final scroll = _chatScroll(tester);

    // Monday at the top, Tuesday's day line a little below the pill.
    await _scrollBackTo(tester, scroll, _chatPill, monday);
    await _tuesdayLineAt(tester, scroll, tuesday, 80);
    expect(_pill(tester, _chatPill), monday);
    final start = scroll.position.pixels;

    // Down past it two pixels at a time: the line meets the pill and the
    // pill takes its place, then back up.
    for (var moved = 0.0; moved <= 140; moved += 2) {
      await _scrollTo(tester, scroll, start + moved);
      _oneLabel(tester, days, 'down $moved');
    }
    expect(_pill(tester, _chatPill), tuesday);
    for (var moved = 140.0; moved >= 0; moved -= 2) {
      await _scrollTo(tester, scroll, start + moved);
      _oneLabel(tester, days, 'up $moved');
    }
    expect(_pill(tester, _chatPill), monday);
    // Below the pill, Tuesday's line says its day again.
    expect(_dayLines(tester, tuesday), isNotEmpty);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
  });

  testWidgets("the day line's place keeps its size while the pill takes it", (
    tester,
  ) async {
    final c = _twoDays().controller();
    addTearDown(c.dispose);
    await _open(tester, c);
    final tuesday = _day(tester, _tuesday), monday = _day(tester, _monday);
    final scroll = _chatScroll(tester);
    await _scrollBackTo(tester, scroll, _chatPill, monday);
    await _tuesdayLineAt(tester, scroll, tuesday, 80);
    final row = _rowInView(tester, margin: 300), before = _topOf(tester, row);
    await _scrollTo(tester, scroll, scroll.position.pixels + 70);
    expect(_pill(tester, _chatPill), tuesday);
    expect(_topOf(tester, row) - before, moreOrLessEquals(-70, epsilon: .5));
    await tester.pumpWidget(const SizedBox());
    await c.flush();
  });

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      final picture = GlobalKey();
      final c = _twoDays().controller();
      addTearDown(c.dispose);
      await _open(tester, c, brightness: brightness, picture: picture);
      c.openThread('message-1');
      await tester.pumpAndSettle();
      final monday = _day(tester, _monday);
      // The chat back until Monday's last message is in its upper part, the
      // thread at Tuesday's replies: the same place on main, with no pill.
      final scroll = _chatScroll(tester);
      const lastMonday =
          'Two devices editing at once settle on the newest edit. (30)';
      final row = find.text(lastMonday, findRichText: true);
      // Rows above the view are built too: scroll until it is well inside.
      while ((row.evaluate().isEmpty ||
              tester.getTopLeft(row.first).dy < 250) &&
          scroll.position.pixels - 40 > scroll.position.minScrollExtent) {
        await _scrollTo(tester, scroll, scroll.position.pixels - 40);
      }
      await tester.pumpAndSettle();

      // Written before the checks, so main's run writes the "before" image.
      await _shoot(tester, picture, 'day-pill-${brightness.name}');
      expect(_pill(tester, _chatPill), monday);
      expect(_pill(tester, _threadPill), _day(tester, _tuesday));

      // Tuesday's day line right where the pill is (Huy 11-04): one label,
      // on a fill nothing reads through.
      final tuesday = _day(tester, _tuesday);
      await _tuesdayLineAt(tester, scroll, tuesday, 10);
      await tester.pumpAndSettle();
      await _shoot(tester, picture, 'day-pill-over-line-${brightness.name}');
      _oneLabel(tester, [monday, tuesday], brightness.name);
      for (final key in [_chatPill, _threadPill]) {
        final fill = tester
            .widget<DecoratedBox>(
              find
                  .descendant(
                    of: find.byKey(key),
                    matching: find.byType(DecoratedBox),
                  )
                  .first,
            )
            .decoration;
        expect((fill as ShapeDecoration).color!.a, 1.0);
      }
      await tester.pumpWidget(const SizedBox());
      await c.flush();
    });
  }
}
