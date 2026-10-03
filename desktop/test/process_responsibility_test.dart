import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/process_responsibility.dart';

/// pid → responsible pid, and pid → executable for the processes that are alive.
class FakeProbe implements ResponsibilityProbe {
  FakeProbe(this.owners, this.paths);

  final Map<int, int> owners;
  final Map<int, String> paths;

  @override
  int? responsiblePid(int pid) => owners[pid];

  @override
  String? executablePath(int pid) => paths[pid];
}

const app = 100;
const daemon = 200;
const harness = '/Applications/Harness.app/Contents/MacOS/Harness';
const node = '/Users/me/.harness/runtime/node/bin/node';

DaemonOwnerVerdict judge(Map<int, int> owners, Map<int, String> paths) =>
    judgeDaemonOwner(
      daemonPid: daemon,
      ownPid: app,
      probe: FakeProbe(owners, paths),
    );

void main() {
  group('judgeDaemonOwner', () {
    test('keeps a daemon this app launched', () {
      final verdict = judge({app: app, daemon: app}, {app: harness});
      expect(verdict.restart, isFalse);
      expect(verdict.reason, 'owned by this app');
    });

    // Measured both ways: a daemon started from a tmux shell AND one whose app has quit are
    // reported as their own owner — and only the first is refused the LAN.
    test('asks for a LAN test when the daemon is named its own owner', () {
      final verdict = judge(
        {app: app, daemon: daemon},
        {app: harness, daemon: node},
      );
      expect(verdict.action, DaemonOwnerAction.testLan);
      expect(verdict.reason, contains(node));
    });

    test('restarts a daemon a terminal is responsible for', () {
      const terminal = 300;
      final verdict = judge(
        {app: app, daemon: terminal},
        {
          app: harness,
          terminal: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
        },
      );
      expect(verdict.restart, isTrue);
      expect(verdict.reason, contains('Terminal'));
    });

    test('keeps a daemon an earlier launch of this app started, while it still runs', () {
      const earlier = 150;
      final verdict = judge(
        {app: app, daemon: earlier},
        {app: harness, earlier: harness},
      );
      expect(verdict.restart, isFalse);
    });

    test(
      'keeps a daemon whose owner has exited — the app quit and reopened',
      () {
        final verdict = judge({app: app, daemon: 150}, {app: harness});
        expect(verdict.restart, isFalse);
        expect(verdict.reason, contains('exited'));
      },
    );

    test('keeps the daemon when either side cannot be asked', () {
      expect(judge({daemon: daemon}, const {}).restart, isFalse);
      expect(judge({app: app}, const {}).restart, isFalse);
    });

    test('shares a dev launch with the terminal both run under', () {
      const shell = 400;
      final verdict = judge({app: shell, daemon: shell}, const {});
      expect(verdict.restart, isFalse);
    });
  });

  group('DaemonOwnerGuard', () {
    late Map<int, int> owners;
    late List<String> lines;
    late int restarts;

    late List<String> lanTests;

    DaemonOwnerGuard guard({
      Future<int?> Function()? restart,
      bool Function()? paused,
      bool? lanBlocked = true,
    }) => DaemonOwnerGuard(
      probe: FakeProbe(owners, {app: harness, daemon: node}),
      ownPid: app,
      restart:
          restart ??
          () async {
            restarts++;
            owners[201] = app;
            return 201;
          },
      lanBlocked: () async {
        lanTests.add('lan');
        return lanBlocked;
      },
      log: lines.add,
      paused: paused,
    );

    setUp(() {
      owners = {app: app, daemon: daemon};
      lines = [];
      restarts = 0;
      lanTests = [];
    });

    test(
      'keeps a self-owned daemon that still reaches the LAN — its app has quit',
      () async {
        final g = guard(lanBlocked: false);
        expect(await g.check(daemon), isFalse);
        expect(restarts, 0);
        expect(lines.single, contains('reaches the local network'));
      },
    );

    test('keeps a self-owned daemon when the LAN test cannot answer', () async {
      final g = guard(lanBlocked: null);
      expect(await g.check(daemon), isFalse);
      expect(restarts, 0);
      expect(lines.single, contains('could not test'));
    });

    test(
      'restarts a daemon another running app owns, without a LAN test',
      () async {
        owners[daemon] = 300;
        final g = DaemonOwnerGuard(
          probe: FakeProbe(owners, {
            app: harness,
            300: '/Applications/iTerm.app/Contents/MacOS/iTerm2',
          }),
          ownPid: app,
          restart: () async {
            restarts++;
            owners[201] = app;
            return 201;
          },
          lanBlocked: () async => fail('an app owner needs no LAN test'),
          log: lines.add,
        );
        expect(await g.check(daemon), isTrue);
        expect(restarts, 1);
        expect(lines.first, contains('iTerm'));
      },
    );

    test('restarts a self-owned daemon refused the LAN, once, and judges the new one', () async {
      final g = guard();
      expect(await g.check(daemon), isTrue);
      expect(restarts, 1);
      expect(lanTests, ['lan']);
      expect(lines.first, startsWith('restarting daemon pid 200'));
      expect(lines.last, 'daemon pid 201: owned by this app');
      // Both pids are judged: neither the old one nor the new one is looked at again.
      expect(await g.check(daemon), isFalse);
      expect(await g.check(201), isFalse);
      expect(restarts, 1);
    });

    test('checks a pid once, however often it is asked', () async {
      owners[daemon] = app;
      final g = guard();
      await g.check(daemon);
      await g.check(daemon);
      expect(lines, ['daemon pid 200 kept: owned by this app']);
    });

    test('concurrent checks share one restart', () async {
      final gate = Completer<int?>();
      final g = guard(
        restart: () {
          restarts++;
          return gate.future;
        },
      );
      final first = g.check(daemon);
      final second = g.check(daemon);
      gate.complete(null);
      expect(await first, isTrue);
      expect(await second, isTrue);
      expect(restarts, 1);
    });

    test(
      'gives up for the session when a restart does not change the owner',
      () async {
        final g = guard(
          restart: () async {
            restarts++;
            owners[201] = 201;
            return 201;
          },
        );
        expect(await g.check(daemon), isTrue);
        expect(lines.last, contains('not retrying this session'));
        owners[202] = 202;
        expect(await g.check(202), isFalse);
        expect(restarts, 1);
      },
    );

    test('touches nothing while the daemon is paused for a flash', () async {
      var flashing = true;
      final g = guard(paused: () => flashing);
      expect(await g.check(daemon), isFalse);
      expect(restarts, 0);
      flashing = false;
      expect(await g.check(daemon), isTrue);
      expect(restarts, 1);
    });
  });

  test('MacResponsibilityProbe answers for this very process', () {
    final probe = MacResponsibilityProbe();
    expect(probe.responsiblePid(pid), isNotNull);
    expect(probe.executablePath(pid), isNotEmpty);
    expect(probe.executablePath(-1), isNull);
  }, skip: !Platform.isMacOS);
}
