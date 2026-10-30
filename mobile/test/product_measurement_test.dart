import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/measurement/product_measurement.dart';

import 'voice_fakes.dart' show MemoryKeyValueStore;

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
    'signed-out sharing defaults off and opt-in never replays earlier actions',
    () async {
      usage.begin(ProductFlow.signIn)(ProductOutcome.failed);
      await usage.flush();
      expect(setup, isEmpty);
      await usage.setSignedOutSharing(true);
      final finish = usage.begin(ProductFlow.signIn);
      finish(ProductOutcome.ok);
      finish(ProductOutcome.failed);
      await usage.flush();
      expect(setup.single.keys.toSet(), {
        'schemaVersion',
        'consent',
        'id',
        'day',
        'counters',
      });
      expect(setup.single['counters'], {
        'setup_desktop_sign_in_started': 1,
        'setup_desktop_sign_in_ok': 1,
        'setup_desktop_sign_in_under_1s': 1,
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
    'unknown settings fail closed and account off also clears guest consent',
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

  group('signed-out sharing kept on this phone, as on the desktop', () {
    late MemoryKeyValueStore store;
    final opened = <ProductMeasurement>[];
    setUp(() => store = MemoryKeyValueStore());
    tearDown(() {
      for (final usage in opened) {
        usage.dispose();
      }
      opened.clear();
    });

    String? kept() => store.values[ProductMeasurement.setupPreferenceKey];

    ProductMeasurement launch({LocalKeyValueStore? keeping}) {
      final usage = ProductMeasurement(
        surface: 'phone',
        automatic: false,
        now: () => now,
        setupStorage: keeping,
        sendSetup: (r) async {
          setup.add(jsonDecode(jsonEncode(r)));
          return {'accepted': true};
        },
      );
      opened.add(usage);
      return usage;
    }

    /// Signed in, the account answering [answer] to every read.
    Future<void> signIn(
      ProductMeasurement usage,
      Map<String, dynamic> Function() answer,
    ) async {
      usage.account(
        'PRIVATE_ACCOUNT',
        choice: () async => answer(),
        send: (r) async {
          reports.add(jsonDecode(jsonEncode(r)));
          return {'accepted': true};
        },
      );
      await usage.flush();
      await usage.setupChoiceSaved;
    }

    test('starts on, and says so rather than consent', () async {
      final phone = launch(keeping: store);
      expect(
        phone.choiceLoaded,
        isFalse,
        reason: 'nothing counted before it is read',
      );
      await phone.setupChoiceReady;
      expect(phone.signedOutSharing, isTrue);
      phone.begin(ProductFlow.signIn)(ProductOutcome.ok);
      await phone.flush();
      expect(setup.single['sharing'], 'default');
      expect(setup.single.containsKey('consent'), isFalse);
      expect(
        (setup.single['counters'] as Map).keys,
        everyElement(startsWith('setup_phone_sign_in_')),
      );
    });

    test(
      'turned off signed out, it is kept as an opt-out to carry to the account',
      () async {
        final first = launch(keeping: store);
        await first.setupChoiceReady;
        await first.setSignedOutSharing(false);
        expect(kept(), ProductMeasurement.pendingSetupOptOut);
        expect(first.accountOptOutPending, isTrue);

        final second = launch(keeping: store);
        await second.setupChoiceReady;
        expect(second.signedOutSharing, isFalse);
        expect(second.accountOptOutPending, isTrue);
        second.begin(ProductFlow.signIn)(ProductOutcome.ok);
        await second.flush();
        expect(setup, isEmpty);
      },
    );

    test('until the account confirms it is off, nothing is counted for the account', () async {
      final phone = launch(keeping: store);
      await phone.setupChoiceReady;
      await phone.setSignedOutSharing(false);
      // An account that still reads on (the request to turn it off has not landed).
      await signIn(phone, () => {'enabled': true, 'revision': 0});
      expect(phone.sharing, isFalse);
      expect(phone.accountOptOutPending, isTrue);
      phone.begin(ProductFlow.remoteConnect)(ProductOutcome.ok);
      await phone.flush();
      expect(reports, isEmpty);

      // The account turned off: the opt-out is settled and kept as an ordinary off.
      phone.savedChoice({'enabled': false, 'revision': 1});
      await phone.setupChoiceSaved;
      expect(phone.accountOptOutPending, isFalse);
      expect(kept(), 'false');
    });

    test(
      'the account\'s choice is the next signed-out one, on or off',
      () async {
        final phone = launch(keeping: store);
        await phone.setupChoiceReady;
        await signIn(phone, () => {'enabled': false, 'revision': 3});
        expect(kept(), 'false');
        expect(phone.signedOutSharing, isFalse);

        final next = launch(keeping: store);
        await next.setupChoiceReady;
        await signIn(next, () => {'enabled': true, 'revision': 4});
        expect(kept(), 'true');
        expect(next.signedOutSharing, isTrue);
      },
    );

    test(
      'turning sharing on in Privacy settles an opt-out still to carry',
      () async {
        final phone = launch(keeping: store);
        await phone.setupChoiceReady;
        await phone.setSignedOutSharing(false);
        await signIn(phone, () => {'enabled': true, 'revision': 0});
        expect(phone.sharing, isFalse);

        phone.savedChoice({'enabled': true, 'revision': 5}, explicit: true);
        await phone.setupChoiceSaved;
        expect(phone.accountOptOutPending, isFalse);
        expect(phone.sharing, isTrue);
        expect(kept(), 'true');
      },
    );

    test(
      'an account answer before the phone\'s own choice is read waits for it',
      () async {
        final slow = _Slow();
        final phone = launch(keeping: slow);
        phone.savedChoice({'enabled': true, 'revision': 0});
        expect(phone.choiceLoaded, isFalse);
        slow.answer.complete(ProductMeasurement.pendingSetupOptOut);
        await phone.setupChoiceReady;
        expect(phone.accountOptOutPending, isTrue);
        expect(phone.signedOutSharing, isFalse);
      },
    );

    test('a choice that cannot be read is an opt-out still to carry', () async {
      final phone = launch(keeping: _Unreadable());
      await phone.setupChoiceReady;
      expect(phone.choiceLoaded, isTrue);
      expect(phone.signedOutSharing, isFalse);
      expect(phone.accountOptOutPending, isTrue);
    });

    test(
      'a box ticked or unticked before the kept choice is read stands',
      () async {
        final phone = launch(keeping: store);
        await phone.setSignedOutSharing(false);
        await phone.setupChoiceReady;
        expect(phone.signedOutSharing, isFalse);
      },
    );

    test(
      'with nowhere to keep an opt-out — a test, the sample — it starts off',
      () {
        final phone = launch();
        expect(phone.choiceLoaded, isTrue);
        expect(phone.signedOutSharing, isFalse);
        expect(phone.accountOptOutPending, isFalse);
      },
    );

    group('the first launch of an install', () {
      Map<String, dynamic> counted(List<Map<String, dynamic>> sent) => {
        for (final report in sent) ...(report['counters'] as Map),
      };

      test('signed out it is counted once, never on a later launch', () async {
        final first = launch(keeping: store);
        await first.noteFirstOpen();
        await first.noteFirstOpen();
        await first.flush();
        expect(counted(setup), {'setup_phone_first_open': 1});
        expect(store.values[ProductMeasurement.firstOpenKey], '1');

        final second = launch(keeping: store);
        await second.noteFirstOpen();
        await second.flush();
        expect(setup, hasLength(1));
      });

      test(
        'off signed out it is never counted, nor a later launch instead',
        () async {
          final first = launch(keeping: store);
          await first.setupChoiceReady;
          await first.setSignedOutSharing(false);
          await first.noteFirstOpen();
          await first.setSignedOutSharing(true);
          await first.flush();
          expect(setup, isEmpty);

          final second = launch(keeping: store);
          await second.noteFirstOpen();
          await second.flush();
          expect(setup, isEmpty);
        },
      );

      test(
        'opened signed in, it waits for the account and counts there',
        () async {
          final phone = launch(keeping: store);
          phone.account(
            'PRIVATE_ACCOUNT',
            choice: () async => {'enabled': true, 'revision': 0},
            send: (r) async {
              reports.add(jsonDecode(jsonEncode(r)));
              return {'accepted': true};
            },
          );
          await phone.noteFirstOpen();
          expect(reports, isEmpty, reason: 'the account has not answered');
          await phone.flush();
          await phone.flush();
          expect(setup, isEmpty);
          expect(counted(reports), {'ui_phone_first_open': 1});
        },
      );

      test('an account that reads off drops it for good', () async {
        final phone = launch(keeping: store);
        await signIn(phone, () => {'enabled': false, 'revision': 1});
        await phone.noteFirstOpen();
        phone.savedChoice({'enabled': true, 'revision': 2}, explicit: true);
        await phone.flush();
        expect(reports, isEmpty);
        expect(setup, isEmpty);
      });

      test('nothing without storage, nor off the phone', () async {
        final sample = launch();
        await sample.setSignedOutSharing(true);
        await sample.noteFirstOpen();
        await sample.flush();
        final desktop = ProductMeasurement(
          surface: 'desktop',
          automatic: false,
          now: () => now,
          setupStorage: store,
          sendSetup: (r) async {
            setup.add(jsonDecode(jsonEncode(r)));
            return {'accepted': true};
          },
        );
        opened.add(desktop);
        await desktop.noteFirstOpen();
        await desktop.flush();
        expect(setup, isEmpty);
        expect(
          store.values.containsKey(ProductMeasurement.firstOpenKey),
          isFalse,
        );
      });

      test('a flag that cannot be read counts nothing', () async {
        final phone = launch(keeping: _Unreadable());
        await phone.setupChoiceReady;
        await phone.setSignedOutSharing(true);
        await phone.noteFirstOpen();
        await phone.flush();
        expect(setup, isEmpty);
      });
    });
  });

  group('the phone\'s side pages', () {
    late ProductMeasurement phone;
    setUp(() {
      phone = ProductMeasurement(
        surface: 'phone',
        automatic: false,
        now: () => now,
        sendSetup: (_) async => {'accepted': true},
      );
    });
    tearDown(() => phone.dispose());

    test(
      'each opening is counted by page and by way, for an account that shares',
      () async {
        phone.screenOpened(PhoneScreen.find, ScreenOpening.swipe);
        phone.account(
          'PRIVATE_ACCOUNT',
          choice: () async => choice,
          send: (r) async {
            reports.add(jsonDecode(jsonEncode(r)));
            return {'accepted': true};
          },
        );
        await phone.flush();
        phone.screenOpened(PhoneScreen.find, ScreenOpening.swipe);
        phone.screenOpened(PhoneScreen.find, ScreenOpening.swipe);
        phone.screenOpened(PhoneScreen.computers, ScreenOpening.button);
        await phone.flush();
        expect(reports.single['counters'], {
          'ui_phone_screen_find_swipe': 2,
          'ui_phone_screen_computers_button': 1,
        });
      },
    );

    test(
      'a desktop never counts them: the backend names them for the phone alone',
      () async {
        await account();
        usage.screenOpened(PhoneScreen.find, ScreenOpening.button);
        await usage.flush();
        expect(reports, isEmpty);
      },
    );

    test('every page and way is in the backend vocabulary', () {
      final vocabulary = File('../backend/src/types/productUsage.ts')
          .readAsStringSync();
      List<String> listed(String name) => RegExp("'(\\w+)'")
          .allMatches(
            RegExp('export const $name = \\[([^\\]]*)\\]')
                .firstMatch(vocabulary)!
                .group(1)!,
          )
          .map((match) => match.group(1)!)
          .toList();
      expect(
        listed('PRODUCT_USAGE_PHONE_SCREENS'),
        PhoneScreen.values.map((screen) => screen.name),
      );
      expect(
        listed('PRODUCT_USAGE_SCREEN_OPENINGS'),
        ScreenOpening.values.map((how) => how.name),
      );
    });
  });

  group('leaving the screen', () {
    // iOS suspends an app within seconds of leaving the screen and may end it unannounced: a count
    // still in RAM then is gone. On 2026-10-19 the signed-out screen counted 17 sign-ins and the
    // accounts 9.
    test('sends what both channels queued, now', () async {
      // Signed out: a sign-in's count waits on the setup channel.
      await usage.setSignedOutSharing(true);
      usage.begin(ProductFlow.signIn)(ProductOutcome.ok);
      await usage.sendBeforeBackground();
      expect(
        setup.single['counters'],
        containsPair('setup_desktop_sign_in_ok', 1),
      );
      // Signed in: the account's counts.
      await account();
      reports.clear();
      usage.begin(ProductFlow.remoteConnect)(ProductOutcome.ok);
      usage.begin(ProductFlow.appStart)(ProductOutcome.ok);
      await usage.sendBeforeBackground();
      expect(
        reports.expand((r) => (r['counters'] as Map).keys),
        containsAll([
          'ui_desktop_remote_connect_ok',
          'ui_desktop_app_start_ok',
        ]),
      );
    });

    test(
      'asks an account whose choice is unread, so what waits on it is counted',
      () async {
        final waited = <String>[];
        usage.addListener(() {
          if (usage.sharing && waited.isEmpty) {
            waited.add('admitted');
            usage.begin(ProductFlow.appStart)(ProductOutcome.ok);
          }
        });
        usage.account(
          'PRIVATE_ACCOUNT',
          choice: () async => choice,
          send: (r) async {
            reports.add(jsonDecode(jsonEncode(r)));
            return {'accepted': true};
          },
        );
        expect(usage.sharing, isFalse);
        await usage.sendBeforeBackground();
        expect(waited, ['admitted']);
        expect(
          reports.expand((r) => (r['counters'] as Map).keys),
          contains('ui_desktop_app_start_ok'),
        );
      },
    );

    test('sends nothing when nothing is queued', () async {
      await account();
      reports.clear();
      var reads = 0;
      usage.account(
        'PRIVATE_OTHER',
        choice: () async {
          reads++;
          return choice;
        },
        send: (r) async {
          reports.add(r);
          return {'accepted': true};
        },
      );
      await usage.flush();
      reads = 0;
      await usage.sendBeforeBackground();
      expect(reports, isEmpty);
      expect(reads, 0);
    });

    test(
      'a refused report waits for the next minute, not another try at once',
      () async {
        await account();
        fail = true;
        reports.clear();
        usage.begin(ProductFlow.remoteConnect)(ProductOutcome.ok);
        await usage.sendBeforeBackground();
        expect(reports, hasLength(1));
        fail = false;
        await usage.flush();
        expect(reports, hasLength(2));
        expect(reports.last['id'], reports.first['id']);
      },
    );

    test('a slow report stops the wait at its bound', () async {
      final answer = Completer<Map<String, dynamic>>();
      usage.account(
        'PRIVATE_ACCOUNT',
        choice: () async => choice,
        send: (r) => answer.future,
      );
      await Future<void>.delayed(Duration.zero);
      usage.begin(ProductFlow.remoteConnect)(ProductOutcome.ok);
      final watch = Stopwatch()..start();
      await usage.sendBeforeBackground(
        within: const Duration(milliseconds: 50),
      );
      expect(watch.elapsed, lessThan(const Duration(seconds: 2)));
      answer.complete({'accepted': true});
    });
  });
}

/// A kept choice that cannot be read: an opt-out must never come back on because of it.
class _Unreadable implements LocalKeyValueStore {
  @override
  Future<String?> read(String key) async => throw StateError('locked');

  @override
  Future<void> write(String key, String value) async {}

  @override
  Future<void> delete(String key) async {}
}

/// A kept choice read only when the test says so.
class _Slow implements LocalKeyValueStore {
  final answer = Completer<String?>();

  @override
  Future<String?> read(String key) => answer.future;

  @override
  Future<void> write(String key, String value) async {}

  @override
  Future<void> delete(String key) async {}
}
