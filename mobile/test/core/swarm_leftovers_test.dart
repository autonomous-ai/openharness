import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/swarm_leftovers.dart';
import 'package:harness_mobile/logging/app_log.dart';

/// The Keychain as a set of key names.
class _Keys implements LeftoverKeys {
  _Keys(this.held);

  final Set<String> held;
  Object? failWith;

  @override
  Future<bool> remove(String key) async {
    if (failWith case final error?) throw error;
    return held.remove(key);
  }
}

class _Log implements AppLog {
  final lines = <String>[];

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) => lines.add('$category $message${error == null ? '' : ' $error'}');
}

void main() {
  late Directory root, state, temp;
  late _Log log;
  late AppLog before;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('swarm-leftovers');
    state = await Directory('${root.path}/state').create();
    temp = await Directory('${root.path}/tmp').create();
    before = appLog;
    appLog = log = _Log();
  });

  tearDown(() async {
    appLog = before;
    await root.delete(recursive: true);
  });

  List<String> names(Directory folder) =>
      folder.listSync().map((e) => e.uri.pathSegments.lastWhere((s) => s.isNotEmpty)).toList();

  void leaveSwarmBehind() {
    for (final name in ['swarm-home.bin', 'swarm-home.bin.next', 'swarm-kept.bin']) {
      File('${state.path}/$name').writeAsStringSync('sealed');
    }
    Directory('${temp.path}/swarm-attachments/account/shared').createSync(recursive: true);
    File('${temp.path}/swarm-attachments/account/index.json').writeAsStringSync('{}');
    Directory('${temp.path}/harness-swarm-outgoing').createSync();
    File('${temp.path}/harness-swarm-outgoing/picture.png').writeAsStringSync('png');
  }

  test('the Swarm’s files, folders and keys go, and nothing beside them', () async {
    leaveSwarmBehind();
    File('${state.path}/state.json').writeAsStringSync('{}');
    File('${state.path}/swarm-home.bin.old').writeAsStringSync('not ours');
    File('${temp.path}/photo.png').writeAsStringSync('png');
    final keys = _Keys({'swarm_home_key', 'swarm_kept_key', 'setup_wifi:Home'});

    await forgetSwarmLeftovers(state: state, temporary: () async => temp, keys: keys);

    expect(names(state), unorderedEquals(['state.json', 'swarm-home.bin.old']));
    expect(names(temp), ['photo.png']);
    expect(keys.held, {'setup_wifi:Home'});
    expect(log.lines, ['swarm leftovers removed: 3 files, 2 folders, 2 keys']);
  });

  test('a second run finds nothing, removes nothing and says nothing', () async {
    leaveSwarmBehind();
    final keys = _Keys({'swarm_home_key'});
    await forgetSwarmLeftovers(state: state, temporary: () async => temp, keys: keys);
    log.lines.clear();

    await forgetSwarmLeftovers(state: state, temporary: () async => temp, keys: keys);

    expect(log.lines, isEmpty);
    expect(names(state), isEmpty);
    expect(names(temp), isEmpty);
  });

  test('a step that fails stops no other, and the log names no path', () async {
    leaveSwarmBehind();
    final secret = '${root.path}/private/tmp';
    final keys = _Keys({'swarm_home_key'})..failWith = const FormatException('keychain');

    await forgetSwarmLeftovers(
      state: state,
      temporary: () async => throw FileSystemException('cannot list', secret),
      keys: keys,
    );

    expect(names(state), isEmpty, reason: 'the files went all the same');
    expect(log.lines, [
      'swarm leftovers removed: 3 files, 0 folders, 0 keys',
      'swarm leftovers not all removed: FileSystemException, FormatException',
    ]);
    expect(log.lines.join('\n'), isNot(contains(root.path)));
  });
}
