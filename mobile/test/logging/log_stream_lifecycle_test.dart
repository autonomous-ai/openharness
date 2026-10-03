import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/logging/app_log.dart';
import 'package:harness_mobile/logging/log_stream.dart';

void main() {
  test(
    'clearing a log notifies once and preserves its live read-only view',
    () async {
      final stream = LogStream();
      final entries = stream.entries;
      var updates = 0;
      stream.addListener(() => updates++);
      stream.add(AppLogLevel.info, 'app', 'one');
      stream.clear();
      stream.clear();
      await Future<void>.delayed(Duration.zero);
      expect(entries, isEmpty);
      expect(updates, 1);
      expect(() => entries.clear(), throwsUnsupportedError);
      stream.dispose();
    },
  );

  test('disposing after a log burst cancels its queued notification', () async {
    final stream = LogStream();
    stream.add(AppLogLevel.info, 'app', 'closing');
    stream.dispose();
    await Future<void>.delayed(Duration.zero);
  });
}
