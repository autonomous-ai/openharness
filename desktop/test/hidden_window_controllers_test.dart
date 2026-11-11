/// The app-wide readers outside the app model ask nothing on a clock while the window is hidden
/// (task #2953, roadmap Phase 3 item 2), and catch up once on return when a read came due.
///
/// Each takes the window's sight as a listenable (`AppNotifier.inSight` in the app); null, as in
/// every older caller, is always in sight.
library;

import 'package:clock/clock.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/settings/experimental_features.dart';
import 'package:harness/usage/models_menu_controller.dart';
import 'package:harness/usage/usage_accounts.dart';
import 'package:harness/usage/usage_controller.dart';
import 'package:harness/web/update/web_update_watcher.dart';

import 'experimental_features_test.dart' show AccountSettings;

void main() {
  group('experimental settings', () {
    test('out of sight: no read for two safety nets; back: one, then every '
        'five minutes', () {
      fakeAsync((async) {
        final seen = ValueNotifier(true);
        final server = AccountSettings('owner');
        final store = ExperimentalFeaturesStore(seen: seen)
          ..bind('owner', transport: server);
        async.elapse(const Duration(seconds: 1));
        expect(server.reads, 1);
        seen.value = false;
        async.elapse(ExperimentalFeaturesStore.safetyNet * 2);
        expect(server.reads, 1, reason: 'nothing read while hidden');
        seen.value = true;
        async.flushMicrotasks();
        expect(server.reads, 2, reason: 'one read on return');
        async.elapse(ExperimentalFeaturesStore.safetyNet);
        expect(server.reads, 3, reason: 'then the safety net again');
        store.dispose();
      });
    });

    test(
      'a glance away shorter than the safety net reads nothing on return',
      () {
        fakeAsync((async) {
          final seen = ValueNotifier(true);
          final server = AccountSettings('owner');
          final store = ExperimentalFeaturesStore(seen: seen)
            ..bind('owner', transport: server);
          async.elapse(const Duration(seconds: 1));
          seen.value = false;
          async.elapse(const Duration(seconds: 40));
          seen.value = true;
          async.flushMicrotasks();
          expect(server.reads, 1);
          store.dispose();
        });
      },
    );
  });

  group('subscription usage (the models menu)', () {
    test('out of sight: no usage read; back: one at once, then every five '
        'minutes', () {
      fakeAsync((async) {
        final seen = ValueNotifier(true);
        var reads = 0;
        final menu = ModelsMenuController(
          usage: UsageController(
            sources: const [],
            remote: () async {
              reads++;
              return const <MachineUsage>[];
            },
            autoStart: false,
          ),
          now: clock.now,
          seen: seen,
        )..start();
        async.flushMicrotasks();
        expect(reads, 1);
        seen.value = false;
        async.elapse(const Duration(minutes: 20));
        expect(reads, 1, reason: 'nothing read while hidden');
        seen.value = true;
        async.flushMicrotasks();
        expect(reads, 2, reason: 'one read on return');
        async.elapse(const Duration(minutes: 5));
        expect(reads, 3, reason: 'then every five minutes');
        menu.dispose();
      });
    });
  });

  group('the web page\'s release check', () {
    test('a hidden tab asks the host nothing on its clock', () {
      fakeAsync((async) {
        var shown = true, reads = 0;
        final watcher = WebUpdateWatcher(
          running: '1.3.51',
          readLatest: () async {
            reads++;
            return '1.3.51';
          },
          shown: () => shown,
        )..start();
        async.elapse(const Duration(minutes: 5));
        expect(reads, 1);
        shown = false;
        async.elapse(const Duration(minutes: 30));
        expect(reads, 1, reason: 'nothing read while hidden');
        shown = true;
        async.elapse(const Duration(minutes: 5));
        expect(reads, 2);
        watcher.dispose();
      });
    });
  });
}
