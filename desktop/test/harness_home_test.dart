import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/harness_home.dart';
import 'package:harness/core/harness_home_look_io.dart';
import 'package:path/path.dart' as p;

/// A Linux computer where only [existing] exists.
HomeLook linux({
  Set<String> existing = const {},
  Map<String, String> environment = const {},
}) =>
    HomeLook(linux: true, environment: environment, exists: existing.contains);

/// macOS or Windows: the rule must not look, so a look throws.
final offLinux = HomeLook(
  linux: false,
  environment: const {'XDG_DATA_HOME': '/d', 'XDG_STATE_HOME': '/s'},
  exists: (path) => throw StateError('looked at $path off Linux'),
);

const data = '/h/.local/share/harness';
const state = '/h/.local/state/harness';
const legacy = '/h/.harness';

void main() {
  group('HarnessHome', () {
    test('the table is the CLI\'s', () {
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
          'memory': HarnessRootKind.data,
          'logs': HarnessRootKind.state,
          'runtime': HarnessRootKind.state,
          'hook-routes': HarnessRootKind.state,
          's': HarnessRootKind.state,
          'run': HarnessRootKind.state,
          'shell-requests': HarnessRootKind.state,
          'pty': HarnessRootKind.state,
          'uninstalling': HarnessRootKind.state,
          'flasher': HarnessRootKind.state,
          'monitor': HarnessRootKind.state,
        },
      );
      expect(HarnessEntry.values, hasLength(26));
    });

    test(
      'every entry is <home>/.harness/<segment>, on posix and on Windows',
      () {
        final posix = HarnessHome.of(
          '/Users/me',
          join: p.posix.join,
          look: offLinux,
        );
        final windows = HarnessHome.of(
          r'C:\Users\me',
          join: p.windows.join,
          look: offLinux,
        );
        for (final e in HarnessEntry.values) {
          expect(posix.path(e), '/Users/me/.harness/${e.segment}');
          expect(windows.path(e), 'C:\\Users\\me\\.harness\\${e.segment}');
        }
      },
    );

    test('both roots are one folder', () {
      final home = HarnessHome.of(
        '/Users/me',
        join: p.posix.join,
        look: offLinux,
      );
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
          look: offLinux,
        ).path(HarnessEntry.cli),
        '/Users/me//.harness/cli',
      );
      expect(
        HarnessHome.of(
          '/Users/me/',
          join: p.posix.join,
          look: offLinux,
        ).path(HarnessEntry.cli),
        '/Users/me/.harness/cli',
      );
    });
  });

  group('this computer\'s look', () {
    test('reads the environment its caller hands it', () {
      const environment = {'HOME': '/home/t', 'XDG_DATA_HOME': '/x'};
      expect(
        platformHomeLook(environment: environment).environment,
        same(environment),
      );
      expect(platformHomeLook().environment, same(Platform.environment));
    });
  });

  group('HarnessHome on Linux', () {
    HarnessHome of(HomeLook look) =>
        HarnessHome.of('/h', join: p.posix.join, look: look);

    void expectRoots(HarnessHome home, String dataRoot, String stateRoot) {
      expect(home.root(HarnessRootKind.data), dataRoot);
      expect(home.root(HarnessRootKind.state), stateRoot);
    }

    test('fresh: neither folder exists, the XDG roots', () {
      expectRoots(of(linux()), data, state);
    });

    test('legacy only: both roots are ~/.harness', () {
      expectRoots(of(linux(existing: {legacy})), legacy, legacy);
    });

    test('the data root exists: XDG, whatever is at ~/.harness', () {
      expectRoots(of(linux(existing: {data, legacy})), data, state);
      expectRoots(of(linux(existing: {data})), data, state);
    });

    test('the state root alone does not switch a legacy home', () {
      expectRoots(of(linux(existing: {state, legacy})), legacy, legacy);
    });

    test('an XDG variable that is unset, empty or relative is ignored', () {
      for (final environment in <Map<String, String>>[
        {},
        {'XDG_DATA_HOME': '', 'XDG_STATE_HOME': ''},
        {'XDG_DATA_HOME': 'share', 'XDG_STATE_HOME': 'state'},
      ]) {
        expectRoots(of(linux(environment: environment)), data, state);
      }
    });

    test('an absolute XDG variable names the root, and its existence', () {
      final environment = {'XDG_DATA_HOME': '/d', 'XDG_STATE_HOME': '/s'};
      expectRoots(
        of(linux(environment: environment)),
        '/d/harness',
        '/s/harness',
      );
      expectRoots(
        of(linux(environment: environment, existing: {data, legacy})),
        legacy,
        legacy,
      );
      expectRoots(
        of(linux(environment: environment, existing: {'/d/harness', legacy})),
        '/d/harness',
        '/s/harness',
      );
    });

    test('an XDG variable\'s trailing slashes are dropped, as the CLI drops them', () {
      expectRoots(
        HarnessHome.of(
          '/h',
          join: separatorJoin('/'),
          look: linux(environment: {'XDG_DATA_HOME': '/x/', 'XDG_STATE_HOME': '/y//'}),
        ),
        '/x/harness',
        '/y/harness',
      );
    });

    test('every entry goes to the root its label names', () {
      final home = of(linux());
      for (final e in HarnessEntry.values) {
        final root = e.root == HarnessRootKind.data ? data : state;
        expect(home.path(e), '$root/${e.segment}');
      }
    });

    test('off Linux the look is not asked', () {
      final home = HarnessHome.of('/h', join: p.posix.join, look: offLinux);
      for (final e in HarnessEntry.values) {
        expect(home.path(e), '/h/.harness/${e.segment}');
      }
      expect(
        HarnessHome.of(
          r'C:\Users\me',
          join: p.windows.join,
          look: offLinux,
        ).path(HarnessEntry.runtime),
        r'C:\Users\me\.harness\runtime',
      );
    });

    test('legacyPath ignores the rule', () {
      final home = of(linux(existing: {data}));
      expect(home.path(HarnessEntry.dsh), '$data/dsh');
      expect(home.legacyPath(HarnessEntry.dsh), '/h/.harness/dsh');
      expect(home.legacyPath(HarnessEntry.runtime), '/h/.harness/runtime');
    });

    test('at() and roots() ignore the rule', () {
      final at = HarnessHome.at('/t/h', join: p.posix.join);
      expectRoots(at, '/t/h', '/t/h');
      expect(at.path(HarnessEntry.cli), '/t/h/cli');
      expect(at.path(HarnessEntry.runtime), '/t/h/runtime');

      final roots = HarnessHome.roots(
        data: '/t/d',
        state: '/t/s',
        join: p.posix.join,
      );
      expectRoots(roots, '/t/d', '/t/s');
      expect(roots.path(HarnessEntry.cli), '/t/d/cli');
      expect(roots.path(HarnessEntry.runtime), '/t/s/runtime');
    });
  });
}
