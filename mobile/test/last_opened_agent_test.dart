import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/harness_file_store.dart';
import 'package:harness_mobile/core/last_opened_agent.dart';

/// The record survives the app: written through the state file a phone really uses, read back by a
/// fresh process.
void main() {
  late Directory dir;
  setUp(() => dir = Directory.systemTemp.createTempSync('last-agent-'));
  tearDown(() => dir.deleteSync(recursive: true));

  /// What a relaunch has: a new store and a new record over the same file.
  LastOpenedAgent launch() => LastOpenedAgent(HarnessFileStore(directory: dir));

  /// [LastOpenedAgent.remember] does not wait for its write; a relaunch comes
  /// long after it has landed.
  Future<void> settle() =>
      Future<void>.delayed(const Duration(milliseconds: 200));

  test('the last agent remembered is the one the next launch reads', () async {
    final first = launch();
    first.remember((machineId: 'm', agentId: 'a'));
    first.remember((machineId: 'm', agentId: 'c'));
    await settle();

    expect(await launch().read(), (machineId: 'm', agentId: 'c'));
  });

  test(
    'a prefetched read serves the launch, then reads the disk again',
    () async {
      launch().remember((machineId: 'm', agentId: 'a'));
      await settle();

      final second = launch()..prefetch();
      expect(await second.read(), (machineId: 'm', agentId: 'a'));
      second.remember((machineId: 'm', agentId: 'b'));
      await settle();
      // Not the prefetch again: that read belonged to the launch.
      expect(await second.read(), (machineId: 'm', agentId: 'b'));
    },
  );
}
