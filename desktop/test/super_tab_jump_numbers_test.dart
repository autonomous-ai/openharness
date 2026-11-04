import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

/// Task #2911's numbers: a jump a week back in a chat of 5,000 messages over
/// two weeks, the way #2924 read it (a page at a time until that day) and the
/// way this task reads it. Run with SUPER_TAB_JUMP_NUMBERS=1; it prints reads,
/// wall time, the slowest frame, frames and rows held for each.
final _measure = Platform.environment['SUPER_TAB_JUMP_NUMBERS'] != null;

const _messages = 5000;

void main() {
  final now = DateTime.now();
  final from = DateTime(now.year, now.month, now.day - 7);

  Future<(SuperTabController, ConversationServer, List<String>)> open(
    WidgetTester tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1280, 860));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = ConversationServer();
    final start = now.subtract(const Duration(days: 14));
    final step = const Duration(days: 14).inSeconds ~/ _messages;
    for (var i = 1; i <= _messages; i++) {
      server.append('Update $i');
      server.messages.last['createdAt'] = start
          .add(Duration(seconds: step * i))
          .toUtc()
          .toIso8601String();
    }
    server.markReadElsewhere('lead', _messages);
    final reads = <String>[];
    server.onRead = reads.add;
    final c = server.controller();
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    addTearDown(c.dispose);
    reads.clear();
    return (c, server, reads);
  }

  /// One frame, timed: build, layout and paint of the test binding.
  Future<Duration> frame(WidgetTester tester) async {
    final watch = Stopwatch()..start();
    await tester.pump();
    return watch.elapsed;
  }

  Duration slowest(List<Duration> frames) =>
      frames.fold(Duration.zero, (a, b) => a > b ? a : b);

  /// The reader scrolls after landing: ten drags of 200 px, each frame timed,
  /// as each rebuild walks every row held.
  Future<Duration> scrolling(WidgetTester tester) async {
    final list = find.byKey(const PageStorageKey('super-messages-tab-lead'));
    final frames = <Duration>[];
    for (var i = 0; i < 10; i++) {
      await tester.drag(list, Offset(0, i.isEven ? 200 : -200));
      frames.add(await frame(tester));
    }
    return slowest(frames);
  }

  Future<void> report(
    WidgetTester tester,
    String name,
    List<String> reads,
    Duration wall,
    List<Duration> frames,
    int held,
  ) async {
    final scroll = await scrolling(tester);
    // ignore: avoid_print
    print(
      '$name: reads ${reads.length}, wall ${wall.inMilliseconds} ms, '
      'frames ${frames.length}, slowest frame ${slowest(frames).inMilliseconds} ms, '
      'slowest scroll frame after ${scroll.inMilliseconds} ms, '
      'rows held $held, rss ${ProcessInfo.currentRss ~/ (1 << 20)} MB',
    );
  }

  testWidgets('a week back, a page at a time until that day (#2924)', (
    tester,
  ) async {
    final (c, _, reads) = await open(tester);
    final frames = <Duration>[];
    final watch = Stopwatch()..start();
    await tester.runAsync(() async {
      bool before(m) => m.createdAt?.isBefore(from) ?? false;
      for (var page = 0; page < 50; page++) {
        if (c.messages('lead').any(before) || !c.hasOlder('lead')) break;
        await c.loadMessages('lead', older: true);
        frames.add(await frame(tester));
      }
    });
    frames.add(await frame(tester));
    watch.stop();
    await report(
      tester,
      'page at a time',
      reads,
      watch.elapsed,
      frames,
      c.messages('lead').length,
    );
    expect(c.messages('lead').any((m) => m.createdAt!.isBefore(from)), isTrue);
  }, skip: !_measure);
}
