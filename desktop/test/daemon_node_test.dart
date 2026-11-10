import 'package:flutter_test/flutter_test.dart';
import 'package:harness/ws/daemon_node.dart';

void main() {
  test('reads the status node, and nothing from a daemon too old to send it', () {
    expect(DaemonNode.fromStatus(null), isNull);
    expect(DaemonNode.fromStatus({'version': 5}), isNull);
    expect(
      DaemonNode.fromStatus({'version': 'v24.22.2', 'migration': 'bogus'})!.line,
      'Node v24.22.2',
    );
    expect(
      DaemonNode.fromStatus({
        'version': 'v22.23.2',
        'migration': 'rolled-back',
      })!.line,
      'Node v22.23.2 · stays on 22: Node 24 did not come up; back on 22',
    );
  });
}
