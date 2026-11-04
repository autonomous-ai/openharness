import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness/measurement/product_measurement.dart';
import 'package:harness/core/local_key_value_store.dart';

import 'support/memory_key_value_store.dart';

class _DelayedSetupStore extends MemoryKeyValueStore {
  final loaded = Completer<String?>();
  @override
  Future<String?> read(String key) => loaded.future;
}

class _UnreadableSetupStore extends MemoryKeyValueStore {
  @override
  Future<String?> read(String key) async => throw StateError('PRIVATE_CANARY');
}

void main() {
  late ProductMeasurement usage;
  late List<Map<String, dynamic>> setup, reports;
  late Map<String, dynamic> choice;
  late DateTime now;
  var fail = false;
  setUp(() {
    now = DateTime.utc(2026, 10, 14, 12);
    setup = [];
    reports = [];
    choice = {'enabled': true, 'revision': 0};
    fail = false;
    usage = ProductMeasurement(
      surface: 'desktop',
      automatic: false,
      now: () => now,
      sendSetup: (r) async {
        setup.add(jsonDecode(jsonEncode(r)));
        return {'accepted': true};
      },
    );
  });
  tearDown(() => usage.dispose());
  Future<void> account([Object id = 'PRIVATE_ACCOUNT']) async {
    usage.account(
      id,
      choice: () async => choice,
      send: (r) async {
        reports.add(jsonDecode(jsonEncode(r)));
        if (fail) throw StateError('PRIVATE_ERROR');
        return {'accepted': true};
      },
    );
    await usage.flush();
  }

  test(
    'Desktop setup sharing defaults on without claiming explicit consent',
    () async {
      final finish = usage.begin(ProductFlow.signIn);
      finish(ProductOutcome.ok);
      finish(ProductOutcome.failed);
      await usage.flush();
      expect(setup.single.keys.toSet(), {
        'schemaVersion',
        'sharing',
        'id',
        'day',
        'counters',
      });
      expect(setup.single['sharing'], 'default');
      expect(setup.single['counters'], {
        'setup_desktop_sign_in_started': 1,
        'setup_desktop_sign_in_ok': 1,
        'setup_desktop_sign_in_under_1s': 1,
      });
    },
  );
  test(
    'why a sign-in did not go through is a signed-out setup count',
    () async {
      usage.begin(ProductFlow.signIn)(ProductOutcome.failed);
      usage.signInEnded(SignInEndReason.noResult);
      await usage.flush();
      expect(setup.single['counters'], {
        'setup_desktop_sign_in_started': 1,
        'setup_desktop_sign_in_failed': 1,
        'setup_desktop_sign_in_under_1s': 1,
        'setup_desktop_sign_in_reason_no_result': 1,
      });
    },
  );
  test('a signed-in report carries no sign-in reason', () async {
    await account();
    usage.signInEnded(SignInEndReason.timeout);
    await usage.flush();
    expect(setup, isEmpty);
    expect(
      reports.expand((r) => (r['counters'] as Map? ?? {}).keys),
      isNot(contains(startsWith('setup_desktop_sign_in_reason'))),
    );
  });
  test('the phone and the browser count no sign-in reason', () async {
    for (final surface in ['phone', 'web']) {
      final other = ProductMeasurement(
        surface: surface,
        automatic: false,
        now: () => now,
        sendSetup: (r) async {
          setup.add(jsonDecode(jsonEncode(r)));
          return {'accepted': true};
        },
      );
      other.signInEnded(SignInEndReason.timeout);
      await other.flush();
      other.dispose();
    }
    expect(setup, isEmpty);
  });
  test('UTC-day counts survive before local midnight', () async {
    now = DateTime.utc(2026, 10, 19, 4);
    usage.begin(ProductFlow.signIn)(ProductOutcome.ok);
    await usage.flush();
    expect(setup.single['day'], '2026-10-19');
    expect(
      setup.single['counters'],
      containsPair('setup_desktop_sign_in_ok', 1),
    );
  });
  ProductMeasurement withStore(LocalKeyValueStore storage) =>
      ProductMeasurement(
        surface: 'desktop',
        automatic: false,
        now: () => now,
        setupStorage: storage,
        sendSetup: (r) async {
          setup.add(jsonDecode(jsonEncode(r)));
          return {'accepted': true};
        },
      );

  test(
    'a fresh persisted preference defaults on, and opt-out survives relaunch',
    () async {
      final store = MemoryKeyValueStore();
      final first = withStore(store);
      expect(first.choiceLoaded, isFalse);
      first.begin(ProductFlow.signIn)(ProductOutcome.failed);
      await first.setupChoiceReady;
      expect(first.signedOutSharing, isTrue);
      final pending = first.begin(ProductFlow.signIn);
      await first.setSignedOutSharing(false);
      pending(ProductOutcome.ok);
      await first.flush();
      first.dispose();
      expect(setup, isEmpty);
      expect(store.values, {
        ProductMeasurement.setupPreferenceKey:
            ProductMeasurement.pendingSetupOptOut,
      });
      final next = withStore(store);
      await next.setupChoiceReady;
      next.begin(ProductFlow.signIn)(ProductOutcome.ok);
      await next.flush();
      expect(setup, isEmpty);
      await next.setSignedOutSharing(true);
      next.begin(ProductFlow.signIn)(ProductOutcome.ok);
      await next.flush();
      next.dispose();
      expect(
        (setup.single['counters'] as Map)['setup_desktop_sign_in_started'],
        1,
      );
    },
  );

  test('account opt-out persists through sign-out and relaunch', () async {
    final store = MemoryKeyValueStore();
    final first = withStore(store);
    await first.setupChoiceReady;
    first.account(
      'PRIVATE_ACCOUNT',
      choice: () async => {'enabled': false, 'revision': 1},
      send: (_) async => {},
    );
    await first.flush();
    await first.setupChoiceSaved;
    first.account(null);
    expect(first.signedOutSharing, isFalse);
    first.dispose();
    final next = withStore(store);
    await next.setupChoiceReady;
    expect(next.signedOutSharing, isFalse);
    next.begin(ProductFlow.signIn)(ProductOutcome.ok);
    await next.flush();
    next.dispose();
    expect(setup, isEmpty);
    expect(store.values, {ProductMeasurement.setupPreferenceKey: 'false'});
  });

  test('a late local read cannot override an explicit opt-out', () async {
    final store = _DelayedSetupStore();
    final local = withStore(store);
    await local.setSignedOutSharing(false);
    store.loaded.complete('true');
    await local.setupChoiceReady;
    expect(local.signedOutSharing, isFalse);
    local.dispose();
  });

  test('default-on account lookup waits for the persisted opt-out', () async {
    final store = _DelayedSetupStore();
    final local = withStore(store);
    var reads = 0;
    local.account(
      'PRIVATE_ACCOUNT',
      choice: () async {
        reads++;
        return {'enabled': true, 'revision': 0};
      },
      send: (_) async => throw StateError('No account report expected'),
    );
    final flushing = local.flush();
    expect(reads, 0);
    local.savedChoice({'enabled': true, 'revision': 0});
    expect(local.sharing, isFalse);
    store.loaded.complete(ProductMeasurement.pendingSetupOptOut);
    await flushing;
    expect(local.accountOptOutPending, isTrue);
    expect(local.sharing, isFalse);
    expect(local.signedOutSharing, isFalse);
    local.dispose();
    expect(setup, isEmpty);
  });

  test(
    'local opt-out clears account observations before any re-enable',
    () async {
      await account();
      final finish = usage.begin(ProductFlow.remoteConnect);
      await usage.setSignedOutSharing(false);
      finish(ProductOutcome.ok);
      await usage.setSignedOutSharing(true);
      await usage.flush();
      expect(reports, isEmpty);
    },
  );

  test(
    'unreadable and malformed local preferences do not enable sharing',
    () async {
      for (final store in [
        _UnreadableSetupStore(),
        MemoryKeyValueStore()
          ..values[ProductMeasurement.setupPreferenceKey] = 'broken',
      ]) {
        final local = withStore(store);
        await local.setupChoiceReady;
        local.begin(ProductFlow.signIn)(ProductOutcome.ok);
        await local.flush();
        expect(local.signedOutSharing, isFalse);
        local.dispose();
      }
      expect(setup, isEmpty);
    },
  );

  test(
    'rapid preference changes persist in order without storing history',
    () async {
      final store = MemoryKeyValueStore();
      final local = withStore(store);
      await local.setupChoiceReady;
      await Future.wait([
        local.setSignedOutSharing(false),
        local.setSignedOutSharing(true),
        local.setSignedOutSharing(false),
      ]);
      local.dispose();
      expect(store.values, {
        ProductMeasurement.setupPreferenceKey:
            ProductMeasurement.pendingSetupOptOut,
      });
    },
  );
  test(
    'off and account changes discard queued counts and open observations',
    () async {
      await account();
      final finish = usage.begin(ProductFlow.remoteConnect);
      choice = {'enabled': false, 'revision': 1};
      usage.savedChoice(choice);
      finish(ProductOutcome.ok);
      await usage.flush();
      expect(reports, isEmpty);
      choice = {'enabled': true, 'revision': 2};
      await usage.flush();
      usage.begin(ProductFlow.viewerOpen)(ProductOutcome.ok);
      await account('OTHER_PRIVATE_ACCOUNT');
      expect(reports, isEmpty);
      usage.begin(ProductFlow.computerLink)(ProductOutcome.failed);
      await usage.flush();
      expect(jsonEncode(reports), isNot(contains('PRIVATE')));
      expect(
        (reports.single['counters'] as Map).keys,
        everyElement(startsWith('ui_desktop_computer_link_')),
      );
    },
  );
  test(
    'setup opt-out discards retries and re-enabling does not replay them',
    () async {
      var attempts = 0;
      final local = ProductMeasurement(
        surface: 'desktop',
        automatic: false,
        sendSetup: (_) async {
          attempts++;
          throw StateError('PRIVATE_CANARY');
        },
      );
      local.begin(ProductFlow.signIn)(ProductOutcome.failed);
      await local.flush();
      expect(attempts, 1);
      await local.setSignedOutSharing(false);
      await local.setSignedOutSharing(true);
      await local.flush();
      local.dispose();
      expect(attempts, 1);
    },
  );
  test(
    'retry is immutable, current events wait, and batching is bounded',
    () async {
      await account();
      fail = true;
      usage.begin(ProductFlow.signIn)(ProductOutcome.ok);
      await usage.flush();
      final first = jsonEncode(reports.single);
      for (final flow in ProductFlow.values) {
        usage.begin(flow)(ProductOutcome.failed);
      }
      await usage.flush();
      expect(jsonEncode(reports.last), first);
      fail = false;
      await usage.flush();
      expect(jsonEncode(reports.last), first);
      await usage.flush();
      await usage.flush();
      for (final r in reports) {
        expect((r['counters'] as Map).length, lessThanOrEqualTo(32));
        expect(utf8.encode(jsonEncode(r)).length, lessThan(4096));
      }
      expect(reports.last['id'], isNot(reports.first['id']));
    },
  );
  test(
    'stale preference response cannot undo an explicit off choice',
    () async {
      final pending = Completer<Map<String, dynamic>>();
      usage.account(
        'PRIVATE_ACCOUNT',
        choice: () => pending.future,
        send: (r) async {
          reports.add(r);
          return {'accepted': true};
        },
      );
      usage.savedChoice(choice);
      usage.begin(ProductFlow.remoteConnect)(ProductOutcome.ok);
      final flushing = usage.flush();
      usage.savedChoice({'enabled': false, 'revision': 1});
      pending.complete(choice);
      await flushing;
      expect(usage.sharing, isFalse);
      expect(reports, isEmpty);
    },
  );
  test(
    'unknown settings fail closed and account off also clears setup sharing',
    () async {
      await usage.setSignedOutSharing(true);
      usage.begin(ProductFlow.signIn)(ProductOutcome.ok);
      choice = {'enabled': false, 'revision': 1};
      await account();
      expect(setup, isEmpty);
      expect(usage.signedOutSharing, isFalse);
      usage.savedChoice({'enabled': true});
      expect(usage.sharing, isFalse);
    },
  );
  test('phone setup retains its existing off-by-default choice', () async {
    final phone = ProductMeasurement(
      surface: 'phone',
      automatic: false,
      sendSetup: (r) async {
        setup.add(r);
        return {'accepted': true};
      },
    );
    phone.begin(ProductFlow.signIn)(ProductOutcome.ok);
    await phone.flush();
    expect(setup, isEmpty);
    await phone.setSignedOutSharing(true);
    phone.begin(ProductFlow.signIn)(ProductOutcome.ok);
    await phone.flush();
    phone.dispose();
    expect(setup.single['consent'], isTrue);
    expect(setup.single.containsKey('sharing'), isFalse);
  });
  test(
    'expired RAM queues are discarded and unmatched setup remains unknown',
    () async {
      await usage.setSignedOutSharing(true);
      usage.setupFacts({ProductFlow.setupTmux: 'running'});
      usage.setupFacts({ProductFlow.setupTmux: 'ready'});
      usage.setupFacts({ProductFlow.setupTmux: 'ready'});
      await usage.flush();
      expect(
        (setup.single['counters'] as Map)['setup_desktop_setup_tmux_ok'],
        1,
      );
      usage.begin(ProductFlow.signIn);
      now = now.add(const Duration(days: 2));
      await usage.flush();
      expect(setup.length, 1);
    },
  );
  test('a missing tool keeps its setup step open and is marked once', () async {
    usage.setupFacts({ProductFlow.setupHarness: 'pending'});
    usage.setupFacts({ProductFlow.setupHarness: 'missing'});
    usage.setupFacts({ProductFlow.setupHarness: 'missing'});
    usage.setupFacts({ProductFlow.setupHarness: 'running'});
    usage.setupFacts({ProductFlow.setupHarness: 'ready'});
    await usage.flush();
    expect(setup.single['counters'], {
      'setup_desktop_setup_harness_started': 1,
      'setup_desktop_setup_harness_missing': 1,
      'setup_desktop_setup_harness_ok': 1,
      'setup_desktop_setup_harness_under_1s': 1,
    });
  });
  test('a signed-in setup step counts no missing mark', () async {
    await account();
    usage.setupFacts({ProductFlow.setupTmux: 'missing'});
    usage.setupFacts({ProductFlow.setupTmux: 'ready'});
    await usage.flush();
    expect(reports.last['counters'], {
      'ui_desktop_setup_tmux_started': 1,
      'ui_desktop_setup_tmux_ok': 1,
      'ui_desktop_setup_tmux_under_1s': 1,
    });
    expect(setup, isEmpty);
  });
  test('agent downloads are anonymous setup counts by engine name', () async {
    usage.setupDownload('codex');
    usage.setupDownload('codex', ok: true, took: const Duration(seconds: 95));
    usage.setupDownload('claude');
    usage.setupDownload('claude', ok: false, took: const Duration(minutes: 7));
    usage.setupDownload('/Users/PRIVATE/.local/bin/x', ok: true);
    await account();
    usage.setupDownload('opencode');
    await usage.flush();
    final counters = {
      for (final report in setup) ...(report['counters'] as Map),
    };
    expect(counters, {
      'setup_desktop_agent_download_codex_started': 1,
      'setup_desktop_agent_download_codex_ok': 1,
      'setup_desktop_agent_download_codex_1m_to_5m': 1,
      'setup_desktop_agent_download_claude_started': 1,
      'setup_desktop_agent_download_claude_failed': 1,
      'setup_desktop_agent_download_claude_over_5m': 1,
      'setup_desktop_agent_download_opencode_started': 1,
    });
    expect(jsonEncode(setup), isNot(contains('PRIVATE')));
  });
  test(
    'flow observations are bounded and unknown operations never upload content',
    () async {
      await account();
      for (var i = 0; i < 1000; i++) {
        usage.begin(ProductFlow.remoteConnect);
      }
      await usage.flush();
      expect(reports.single['counters'], {
        'ui_desktop_remote_connect_started': 64,
      });
    },
  );
  test(
    'web never queues signed-out setup even if a caller enables it',
    () async {
      final web = ProductMeasurement(
        surface: 'web',
        automatic: false,
        sendSetup: (r) async {
          setup.add(r);
          return {'accepted': true};
        },
      );
      await web.setSignedOutSharing(true);
      web.begin(ProductFlow.signIn)(ProductOutcome.ok);
      await web.flush();
      web.dispose();
      expect(setup, isEmpty);
    },
  );
}
