import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/harness_file_store.dart';
import 'package:harness/core/swarm_leftovers.dart';
import 'package:harness/logging/app_log.dart';

/// What the Swarm left on a computer goes at launch (2026-11-14), and nothing
/// else does.
void main() {
  late Directory home;
  late HarnessFileStore store;

  setUp(() async {
    home = await Directory.systemTemp.createTemp('swarm-leftovers-test-');
    store = HarnessFileStore(directory: home);
  });

  tearDown(() async {
    if (await home.exists()) await home.delete(recursive: true);
  });

  String path(String name) => '${home.path}${Platform.pathSeparator}$name';

  Future<void> leaveSwarmData() async {
    // What Swarm builds wrote to the settings, beside settings that stay: the
    // ordinary tabs keep their `swarm_` names.
    for (final key in [
      'super_tab.view.acc-1.tab-1',
      'super_tab.views.acc-1',
      'super_tab.hidden.acc-1',
      'super_tab.saved_by',
      'swarm_join_seen.acc-1',
      'swarm_layout_v1',
      'swarm_recent_v1',
      'theme_mode',
    ]) {
      await store.write(key, 'value');
    }
    // Its saved chats and chat pictures beside the settings file, and another
    // folder of the app's that stays.
    await File(path('swarm-views/view.a.b')).create(recursive: true);
    await File(path('image-cache/picture.png')).create(recursive: true);
    await File(path('finder/roots.json')).create(recursive: true);
  }

  test('the Swarm\'s settings, saved chats and chat pictures go; the rest '
      'stays', () async {
    await leaveSwarmData();

    await clearSwarmLeftovers(store: store, folder: home.path);

    expect(await store.keys(), {
      'swarm_layout_v1',
      'swarm_recent_v1',
      'theme_mode',
    });
    expect(await Directory(path('swarm-views')).exists(), isFalse);
    expect(await Directory(path('image-cache')).exists(), isFalse);
    expect(await File(path('finder/roots.json')).exists(), isTrue);
  });

  test('a link in a Swarm folder is removed, never followed into the work '
      'it points at', () async {
    final work = await Directory.systemTemp.createTemp('swarm-leftovers-work-');
    addTearDown(() => work.delete(recursive: true));
    final checkout = File('${work.path}/README.md');
    await checkout.writeAsString('a person\'s work');
    await Directory(path('image-cache')).create();
    await Link(path('image-cache/project')).create(work.path);

    await clearSwarmLeftovers(store: store, folder: home.path);

    expect(await Directory(path('image-cache')).exists(), isFalse);
    expect(await checkout.readAsString(), 'a person\'s work');
  }, skip: Platform.isWindows ? 'a link needs privileges on Windows' : false);

  test('a second launch finds nothing to do', () async {
    await leaveSwarmData();
    await clearSwarmLeftovers(store: store, folder: home.path);
    final before = await store.stateFile.readAsString();

    await clearSwarmLeftovers(store: store, folder: home.path);

    expect(await store.stateFile.readAsString(), before);
  });

  test(
    'settings that cannot be read are logged, and the folders still go',
    () async {
      await leaveSwarmData();
      final log = _RecordingLog();
      final previous = appLog;
      appLog = log;
      addTearDown(() => appLog = previous);

      await clearSwarmLeftovers(store: _Unreadable(home), folder: home.path);

      expect(log.lines, [
        'warn swarm-leftovers settings not removed: disk gone',
      ]);
      expect(await Directory(path('swarm-views')).exists(), isFalse);
      expect(await Directory(path('image-cache')).exists(), isFalse);
    },
  );
}

class _Unreadable extends HarnessFileStore {
  _Unreadable(Directory directory) : super(directory: directory);

  @override
  Future<Set<String>> keys() async =>
      throw const FileSystemException('disk gone');
}

class _RecordingLog implements AppLog {
  final lines = <String>[];

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) {
    // Only what went wrong: the removals themselves log at info.
    if (level.index >= AppLogLevel.warn.index) {
      lines.add('${level.name} $category $message');
    }
  }
}
