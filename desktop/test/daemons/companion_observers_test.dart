import 'package:flutter_test/flutter_test.dart';
import 'package:harness/daemons/companion_life.dart';
import 'package:harness/daemons/companion_observers.dart';

void main() {
  test('tool history and prose never create bugs; a matching successful retry brings relief', () {
    final events = <CompanionEvent>[];
    final tools = CompanionTools((e, _) => events.add(e));
    tools.observe('a', 'tool_end', {'id': 'old', 'isError': true});
    tools.observe('a', 'tool_start', {'id': '1', 'tool': 'Bash'});
    tools.observe('a', 'tool_end', {
      'id': '1',
      'isError': false,
      'output': 'bug error failure',
    });
    expect(events, isEmpty);
    tools.observe('a', 'tool_start', {'id': '2', 'tool': 'Bash'});
    tools.observe('a', 'tool_end', {'id': '2', 'isError': true});
    tools.observe('a', 'tool_end', {'id': '2', 'isError': true});
    tools.observe('a', 'tool_start', {'id': '3', 'tool': 'Read'});
    tools.observe('a', 'tool_end', {'id': '3', 'isError': false});
    tools.observe('a', 'tool_start', {'id': '4', 'tool': 'Bash'});
    tools.observe('a', 'tool_end', {'id': '4', 'isError': false});
    expect(events, [CompanionEvent.bug, CompanionEvent.recovered]);
    tools.reset();
    tools.observe('a', 'tool_end', {'id': '5', 'isError': true});
    expect(events, hasLength(2));
  });
  testWidgets(
    'background PR transitions celebrate once, with a new-account baseline',
    (tester) async {
      var state = 'Open';
      final merged = <int>[];
      final reads = <String>[];
      final observer = CompanionPullRequests(
        sources: () => [
          (key: 'repo/a', machine: 'm', agent: 'a'),
          (key: 'repo/b', machine: 'm', agent: 'b'),
        ],
        read: (m, a) async {
          reads.add(a);
          return {
            'status': 'found',
            'number': a == 'a' ? 1 : 2,
            'state': a == 'a' ? 'Merged' : state,
            'url': 'https://github.com/fixture/test/pull/${a == 'a' ? 1 : 2}',
          };
        },
        merged: (pr) => merged.add(pr.number),
      );
      addTearDown(observer.dispose);
      observer.bind(enabled: true, scope: 'first');
      await tester.pump();
      expect(reads, ['a', 'b']);
      expect(merged, isEmpty);
      state = 'Merged';
      await observer.poll();
      expect(merged, [2]);
      await observer.poll();
      expect(merged, [2]);
      observer.bind(enabled: true, scope: 'second');
      await tester.pump();
      expect(merged, [2]);
      observer.bind(enabled: false, scope: 'second');
    },
  );
}
