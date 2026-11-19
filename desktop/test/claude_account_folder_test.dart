import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/harness_home.dart';
import 'package:harness/state/app_state.dart';

void main() {
  const data = '/home/me/.local/share/harness';

  final linux = HomeLook(
    linux: true,
    environment: const {},
    exists: (path) => path == data,
  );

  test(
    "a new Claude account's folder is under the data root's claude-profiles",
    () {
      expect(
        newClaudeAccountFolder('/home/me', const {}, look: linux),
        '$data/claude-profiles/1',
      );
      expect(
        newClaudeAccountFolder('/home/me', {
          '$data/claude-profiles/1',
          '$data/claude-profiles/2',
        }, look: linux),
        '$data/claude-profiles/3',
      );
    },
  );

  test("on macOS a new Claude account's folder is under ~/.harness", () {
    expect(
      newClaudeAccountFolder(
        '/Users/me',
        const {},
        look: HomeLook(
          linux: false,
          environment: const {},
          exists: (path) => throw StateError('looked at $path off Linux'),
        ),
      ),
      '/Users/me/.harness/claude-profiles/1',
    );
  });
}
