import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/buddy_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_CHAT_EDGE_SHOTS'];

/// Huy, 11-03: in a Buddy chat, messages scrolled up to the line under the
/// header (the Buddy's engine, machine and who reads the chat) with no edge
/// between them, so a message read as cut off under that line. The list now
/// stops at a drawn edge, as it does under the header.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  for (final brightness in Brightness.values) {
    testWidgets('the chat list stops at a drawn edge under the Buddy line while '
        'scrolling (${brightness.name})', (tester) async {
      final picture = GlobalKey();
      final server = oneBuddySwarm();
      giveSwarmBuddy(server);
      for (var i = 1; i <= 40; i++) {
        server.append(
          'Line $i of a long Buddy chat, long enough to wrap onto a second '
          'line in the pane so rows are tall.',
          conversationId: 'swarm-buddy-peer',
        );
      }
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final c = server.controller(account: 'peer');
      await c.refresh();
      await c.select('swarm-buddy-peer');
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) =>
              RepaintBoundary(key: picture, child: child),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Kens-MacBook',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('reads all your projects'), findsOneWidget);

      // Read back part way, so a message straddles the top of the list.
      final list = find.byKey(
        PageStorageKey('super-messages-${c.tabId}-swarm-buddy-peer'),
      );
      final scroll = tester.widget<CustomScrollView>(list).controller!;
      scroll.jumpTo(scroll.position.maxScrollExtent / 2 + 30);
      await tester.pumpAndSettle();

      final bar = tester.getRect(find.byKey(const ValueKey('super-buddy-bar')));
      final top = tester.getRect(list).top;
      // The list starts below the line and clips what scrolls past its top.
      expect(top, greaterThanOrEqualTo(bar.bottom));
      expect(tester.widget<CustomScrollView>(list).clipBehavior, Clip.hardEdge);

      // Written before the check, so the PR shows the chat before the fix too.
      if (shots != null) {
        await tester.runAsync(() async {
          final boundary =
              picture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 1.5);
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(shots!).create(recursive: true);
          await File('$shots/chat-edge-${brightness.name}.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
      }
      // And there is an edge to see, as under the header.
      await expectRimAbove(tester, picture, top, bar);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    });
  }

  // Review of #2788: the same cause in an earlier Buddy chat, where the PM's
  // open decisions sit straight above the list with no Buddy line.
  testWidgets('the list stops at a drawn edge under the decisions of an '
      'earlier Buddy chat', (tester) async {
    final picture = GlobalKey();
    final server = oneBuddySwarm();
    giveSwarmBuddy(server);
    // The reader's Buddy chat in a project, from before one Buddy per Swarm.
    (server.state['conversations'] as List).add({
      ...conversationFixture('buddy-peer-lead', "peer's Buddy"),
      'projectId': 'lead',
      'kind': 'buddy',
      'buddyOwnerId': 'peer',
    });
    server.ask(['Ship how?']);
    for (var i = 1; i <= 40; i++) {
      server.append(
        'Line $i of an earlier Buddy chat, long enough to wrap onto a second '
        'line in the pane so rows are tall.',
        conversationId: 'buddy-peer-lead',
      );
    }
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = server.controller(account: 'peer');
    await c.refresh();
    await c.select('buddy-peer-lead');
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        builder: (context, child) =>
            RepaintBoundary(key: picture, child: child),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Kens-MacBook',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(c.isEarlierBuddyChat(c.selected), isTrue);
    final panel = find.byKey(const ValueKey('super-pm-decisions'));
    expect(panel, findsOneWidget);

    final list = find.byKey(
      PageStorageKey('super-messages-${c.tabId}-buddy-peer-lead'),
    );
    final scroll = tester.widget<CustomScrollView>(list).controller!;
    scroll.jumpTo(scroll.position.maxScrollExtent / 2 + 30);
    await tester.pumpAndSettle();
    final decisions = tester.getRect(panel);
    final top = tester.getRect(list).top;
    expect(top, greaterThanOrEqualTo(decisions.bottom));
    await expectRimAbove(tester, picture, top, decisions);

    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  });
}

/// The row just above the list ([top]) is the chrome's rim drawn over the
/// pane, across [span].
Future<void> expectRimAbove(
  WidgetTester tester,
  GlobalKey picture,
  double top,
  Rect span,
) async {
  final rim = DesktopChrome.rim;
  final rows = await tester.runAsync(() async {
    final boundary =
        picture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage();
    final bytes = (await image.toByteData())!;
    final edge = (top - 1).floor(), pane = (top - 4).floor();
    final pairs = [
      for (var x = span.left.ceil() + 8; x < span.right.floor() - 8; x += 4)
        (
          Color(_argb(bytes, image.width, x, edge)),
          Color(_argb(bytes, image.width, x, pane)),
        ),
    ];
    image.dispose();
    return pairs;
  });
  final onRim = rows!
      .where((pair) => _near(pair.$1, Color.alphaBlend(rim, pair.$2)))
      .length;
  expect(
    onRim,
    greaterThan(rows.length * 0.9),
    reason: 'the row above the list should be the rim over the pane',
  );
}

int _argb(ByteData rgba, int width, int x, int y) {
  final at = (y * width + x) * 4;
  final r = rgba.getUint8(at),
      g = rgba.getUint8(at + 1),
      b = rgba.getUint8(at + 2),
      a = rgba.getUint8(at + 3);
  return (a << 24) | (r << 16) | (g << 8) | b;
}

/// Within a small tolerance, as a rasterizer rounds.
bool _near(Color drawn, Color expected) {
  int d(double a, double b) => ((a - b) * 255).abs().round();
  return d(drawn.r, expected.r) <= 3 &&
      d(drawn.g, expected.g) <= 3 &&
      d(drawn.b, expected.b) <= 3;
}
