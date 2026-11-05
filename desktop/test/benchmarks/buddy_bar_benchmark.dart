// Run explicitly: flutter test test/benchmarks/buddy_bar_benchmark.dart --reporter expanded
// Headless CPU measurements of the Swarm Buddy bar's rebuild, not display latency.
//
// Task #3256 (review of #3171): the bar reads its chat's held messages for the
// Start again offer on every build. This rebuilds the bar alone over a chat
// holding [sizes] messages, all of them read back page by page, with the held
// switch refusal last (the offer shows) and with no line by the Buddy at all
// (the scan reads every held row and finds nothing), and prints the median and
// p95 of a rebuild in microseconds.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/buddies.dart';

import '../support/buddy_fixture.dart';

const sizes = [100, 2000, 10000];
const rebuilds = 300;

void main() {
  for (final size in sizes) {
    for (final refusalLast in [true, false]) {
      final label = refusalLast ? 'refusal last' : 'no Buddy line';
      testWidgets('Buddy bar rebuild, $size held, $label', (tester) async {
        final server = oneBuddySwarm();
        giveSwarmBuddy(server);
        for (var i = 0; i < size - 1; i++) {
          server.append('message $i', conversationId: 'swarm-buddy-peer');
          server.messages.last['author'] = {
            'kind': 'person',
            'id': 'peer',
            'name': 'peer@example.com',
          };
        }
        server.append(
          refusalLast
              ? "Couldn't switch your Buddy: Start your Buddy again to switch "
                    'its model. It is still on your subscription.'
              : 'the last message',
          conversationId: 'swarm-buddy-peer',
        );
        server.messages.last
          ..['author'] = refusalLast
              ? {'kind': 'agent', 'id': 'wren', 'name': 'Wren'}
              : {'kind': 'person', 'id': 'peer', 'name': 'peer@example.com'}
          ..['source'] = refusalLast ? {'kind': 'system'} : <String, dynamic>{};
        final c = server.controller(account: 'peer');
        await c.refresh();
        await c.select('swarm-buddy-peer');
        while (c.hasOlder('swarm-buddy-peer')) {
          await c.loadMessages('swarm-buddy-peer', older: true);
        }
        expect(c.messages('swarm-buddy-peer'), hasLength(size));
        final chat = c.snapshot!.conversation('swarm-buddy-peer')!;
        late StateSetter rebuild;
        await tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.light),
            home: Scaffold(
              body: StatefulBuilder(
                builder: (context, setState) {
                  rebuild = setState;
                  return SuperTabBuddyBar(controller: c, chat: chat);
                },
              ),
            ),
          ),
        );
        await tester.pump();
        final times = <int>[];
        for (var i = 0; i < rebuilds; i++) {
          rebuild(() {});
          final watch = Stopwatch()..start();
          await tester.pump();
          times.add(watch.elapsedMicroseconds);
        }
        times.sort();
        // ignore: avoid_print
        print(
          'buddy-bar size=$size $label '
          'median=${times[times.length ~/ 2]}us '
          'p95=${times[(times.length * 0.95).floor()]}us',
        );
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      });
    }
  }
}
