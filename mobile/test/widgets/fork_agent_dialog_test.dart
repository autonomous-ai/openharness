import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/widgets/fork_agent_dialog.dart';

void main() {
  group('forkNameFor', () {
    test('marks the source name as a fork', () {
      expect(forkNameFor('api server'), 'api server - fork');
    });

    test('trims the source name first', () {
      expect(forkNameFor('  api server \n'), 'api server - fork');
    });

    test('an unnamed source forks as Harness', () {
      expect(forkNameFor(''), 'Harness - fork');
      expect(forkNameFor('   '), 'Harness - fork');
    });
  });
}
