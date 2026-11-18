import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/harness_home.dart';
import 'package:path/path.dart' as p;

void main() {
  group('HarnessHome', () {
    test('the table is the spec\'s', () {
      expect(
        {for (final e in HarnessEntry.values) e.segment: e.root},
        {
          'auth': HarnessRootKind.data,
          'computer-id': HarnessRootKind.data,
          'cli': HarnessRootKind.data,
          'connections': HarnessRootKind.data,
          'agent-messages': HarnessRootKind.data,
          'bin': HarnessRootKind.data,
          'dsh': HarnessRootKind.data,
          'claude-profiles': HarnessRootKind.data,
          'desktop-app-v2': HarnessRootKind.data,
          'viewer-app-v2': HarnessRootKind.data,
          'tui': HarnessRootKind.data,
          'devices': HarnessRootKind.data,
          'lessons': HarnessRootKind.data,
          'grid-fleet': HarnessRootKind.data,
          'community': HarnessRootKind.data,
          'logs': HarnessRootKind.state,
          'runtime': HarnessRootKind.state,
          'hook-routes': HarnessRootKind.state,
          's': HarnessRootKind.state,
          'run': HarnessRootKind.state,
          'shell-requests': HarnessRootKind.state,
          'pty': HarnessRootKind.state,
          'uninstalling': HarnessRootKind.state,
          'flasher': HarnessRootKind.state,
        },
      );
      expect(HarnessEntry.values, hasLength(24));
    });

    test(
      'every entry is <home>/.harness/<segment>, on posix and on Windows',
      () {
        final posix = HarnessHome.of('/Users/me', join: p.posix.join);
        final windows = HarnessHome.of(r'C:\Users\me', join: p.windows.join);
        for (final e in HarnessEntry.values) {
          expect(posix.path(e), '/Users/me/.harness/${e.segment}');
          expect(windows.path(e), 'C:\\Users\\me\\.harness\\${e.segment}');
        }
      },
    );

    test('both roots are one folder', () {
      final home = HarnessHome.of('/Users/me', join: p.posix.join);
      expect(home.root(HarnessRootKind.data), '/Users/me/.harness');
      expect(home.root(HarnessRootKind.state), '/Users/me/.harness');
    });

    test('at() takes a folder a caller already holds', () {
      expect(
        HarnessHome.at(
          '/t/h',
          join: separatorJoin('/'),
        ).path(HarnessEntry.runtime),
        '/t/h/runtime',
      );
    });

    test('joins as its caller joined', () {
      expect(
        HarnessHome.of(
          '/Users/me/',
          join: separatorJoin('/'),
        ).path(HarnessEntry.cli),
        '/Users/me//.harness/cli',
      );
      expect(
        HarnessHome.of('/Users/me/', join: p.posix.join).path(HarnessEntry.cli),
        '/Users/me/.harness/cli',
      );
    });
  });
}
