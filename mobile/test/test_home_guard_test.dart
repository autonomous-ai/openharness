import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/harness_file_store.dart';

/// `test/flutter_test_config.dart` holds for every test: nothing a test builds
/// with defaults can reach the developer's own `~/.harness`.
void main() {
  test('the shared store and every default path live in a throwaway home', () {
    final realHome = Platform.environment['HOME'];
    final temp = Directory.systemTemp.resolveSymbolicLinksSync();

    for (final path in [
      HarnessFileStore.shared.directory.path,
      HarnessFileStore.defaultDirectoryPath(name: 'logs'),
    ]) {
      final resolved = Directory(path).absolute.path;
      expect(resolved, isNot(startsWith('$realHome/.harness')));
      expect(
        resolved.startsWith(Directory.systemTemp.path) ||
            resolved.startsWith(temp),
        isTrue,
        reason: '$resolved is not under the system temp directory',
      );
    }
  });

  test('a test that names its own environment still gets its own home', () {
    expect(
      HarnessFileStore.defaultDirectoryPath(
        environment: const {'HOME': '/home/someone'},
        name: 'logs',
      ),
      '/home/someone/.harness/logs',
    );
  });
}
