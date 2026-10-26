import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/measurement/product_measurement.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/widgets/add_phone_dialog.dart';
import 'package:harness/widgets/phone_offer_card.dart';
import 'package:harness/viewer/viewer_services.dart';
import 'package:harness/viewer/viewer_key_store.dart';

import 'support/add_phone_measurement.dart';
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp, MemoryStore;

/// This computer's record that Add Phone has had its offer.
const _done = 'phone_offer_done';

/// This computer's record that the card has been on its screen, or Add Phone opened here.
const _seen = 'phone_offer_seen';

/// This computer's record that the card was put away or Add Phone opened: no card after time away.
const _stopped = 'phone_offer_stopped';

/// How many cards this computer has shown, every kind together.
const _shows = 'phone_offer_shows';

/// The daemon's device list, answered in memory: [listing], or a read that fails.
class _DevicesApi extends ApiClient {
  _DevicesApi(this.listing, {this.fails = false})
    : super(config: AppConfig.dev, session: AuthSession());

  Map<String, dynamic>? listing;
  bool fails;
  void Function()? onRead;
  Future<Map<String, dynamic>?>? profile;
  int profileReads = 0;

  @override
  Future<Map<String, dynamic>?> me() async {
    profileReads++;
    return profile == null ? null : await profile;
  }

  /// How many times the list was read.
  int reads = 0;

  @override
  Future<Map<String, dynamic>?> daemonDevices() async {
    reads++;
    onRead?.call();
    if (fails) throw StateError('The network connection was lost.');
    return listing;
  }
}

class _OnReadStore extends MemoryStore {
  void Function(String)? onRead;
  @override
  Future<String?> read(String key) async {
    onRead?.call(key);
    return super.read(key);
  }
}

Map<String, Object?> _device(String kind, {bool self = false}) => {
  'pub': 'pub-$kind${self ? '-self' : ''}',
  'label': kind,
  'kind': kind,
  'addedAt': 1,
  'fingerprint': 'fp',
  'self': self,
};

/// This computer alone on the account, plus [others].
Map<String, dynamic> _listing(List<Map<String, Object?>> others) => {
  'members': [_device('machine', self: true), ...others],
};

/// "Your agents in your pocket.": Add Phone offered once per computer, as a card beside the work —
/// at a guest's first launch, or after the first sign-in by hand on an account with no phone.
void main() {
  group('the offer', () {
    test(
      'a guest is offered it at the first launch, and only that once',
      () async {
        final store = MemoryStore();
        final app = createApp(store: store)..signedIn = false;
        addTearDown(app.dispose);
        await app.offerPhoneForTest(atLaunch: true);
        expect(app.phoneOfferShowing, isTrue);

        // Put away: gone, and remembered on this computer.
        app.dropPhoneOffer();
        expect(app.phoneOfferShowing, isFalse);
        await pumpEventQueue();
        expect(store.values[_done], '1');

        // The next launch, as a guest again: nothing.
        final next = createApp(store: store)..signedIn = false;
        addTearDown(next.dispose);
        await next.offerPhoneForTest(atLaunch: true);
        expect(next.phoneOfferShowing, isFalse);
        await next.offerPhoneForTest(atLaunch: false);
        expect(next.phoneOfferShowing, isFalse);
      },
    );

    test(
      'a signed-in returning account sees the card once it is on screen',
      () async {
        final store = MemoryStore();
        AppNotifier launch(String id) => createApp(store: store)
          ..signedIn = true
          ..currentUser = CurrentUserProfile(
            id: id,
            email: 'person@example.test',
          )
          ..api = _DevicesApi(_listing([]));
        final app = launch('account-a');
        addTearDown(app.dispose);
        await app.offerPhoneForTest(atLaunch: true);
        expect(app.phoneOfferShowing, isTrue);
        expect(store.values['phone_offer_returning.account-a'], isNull);
      expect(store.values[_done], isNull);
        app.phoneOfferShown();
        app.phoneOfferShown();
        await pumpEventQueue();
        expect(store.values['phone_offer_returning.account-a'], '1');
      expect(store.values[_done], '1');
        expect(store.values[_seen], '1');
        expect(store.values[_shows], '1');
        final next = launch('account-a');
        addTearDown(next.dispose);
        await next.offerPhoneForTest(atLaunch: true);
        expect(next.phoneOfferShowing, isFalse);
        await next.offerPhoneAfterWorkForTest();
        expect(next.phoneOfferShowing, isFalse);
        final other = launch('account-b');
        addTearDown(other.dispose);
        await other.offerPhoneForTest(atLaunch: true);
        expect(other.phoneOfferShowing, isTrue);
      },
    );

    test(
      'returning launch retries an unreadable list on the next launch',
      () async {
        for (final api in [_DevicesApi(null), _DevicesApi(null, fails: true)]) {
          final store = MemoryStore();
          AppNotifier launch() => createApp(store: store)
            ..signedIn = true
            ..currentUser = const CurrentUserProfile(
              id: 'a',
              email: 'a@example.test',
            )
            ..api = api;
          final first = launch();
          addTearDown(first.dispose);
          await first.offerPhoneForTest(atLaunch: true);
          expect(first.phoneOfferShowing, isFalse);
          expect(store.values['phone_offer_returning.a'], isNull);
          api.fails = false;
          api.listing = _listing([]);
          final next = launch();
          addTearDown(next.dispose);
          await next.offerPhoneForTest(atLaunch: true);
          expect(next.phoneOfferShowing, isTrue);
          expect(api.reads, 2);
        }
      },
    );

    test(
      'returning launch respects a phone, prior x and every Add Phone opening',
      () async {
        for (final kind in ['phone', 'browser']) {
          final app = createApp(store: MemoryStore())
            ..signedIn = true
            ..currentUser = const CurrentUserProfile(
              id: 'a',
              email: 'a@example.test',
            )
            ..api = _DevicesApi(_listing([_device(kind)]));
          addTearDown(app.dispose);
          await app.offerPhoneForTest(atLaunch: true);
          expect(app.phoneOfferShowing, isFalse);
        }
        for (final opening in [null, ...AddPhoneOpening.values]) {
          final store = MemoryStore();
          final first = createApp(store: store);
          addTearDown(first.dispose);
          if (opening == null) {
            first.dismissPhoneOffer();
          } else {
            first.addPhoneOpened(opening);
          }
          final api = _DevicesApi(_listing([]));
          final next = createApp(store: store)
            ..signedIn = true
            ..currentUser = const CurrentUserProfile(
              id: 'a',
              email: 'a@example.test',
            )
            ..api = api;
          addTearDown(next.dispose);
          await next.offerPhoneForTest(atLaunch: true);
          expect(next.phoneOfferShowing, isFalse);
          expect(api.reads, 0);
        }
      },
    );

    test('with nowhere to remember it, nothing is offered', () async {
      // No state file — a test, a fixture — would mean an offer at every launch.
      final app = createApp()..signedIn = false;
      addTearDown(app.dispose);
      await app.offerPhoneForTest(atLaunch: true);
      expect(app.phoneOfferShowing, isFalse);
    });

    test(
      'the first sign-in by hand offers it on an account with no phone',
      () async {
        for (final (name, api) in [
          ('this computer only', _DevicesApi(_listing([]))),
          ('another computer', _DevicesApi(_listing([_device('machine')]))),
          // Unreadable costs one × to put away; a newcomer left without the code costs more.
          ('a list that cannot be read', _DevicesApi(null, fails: true)),
          ('no list at all', _DevicesApi(null)),
        ]) {
          final store = MemoryStore();
          final app = createApp(store: store)
            ..signedIn = true
            ..api = api;
          await app.offerPhoneForTest(atLaunch: false);
          expect(app.phoneOfferShowing, isTrue, reason: name);
          expect(store.values[_done], isNull, reason: name);
          app.dispose();
        }
      },
    );

    test('an account with a phone or a browser on it is not offered it, '
        'ever again here', () async {
      for (final kind in ['phone', 'browser']) {
        final store = MemoryStore();
        final app = createApp(store: store)
          ..signedIn = true
          ..api = _DevicesApi(_listing([_device(kind)]));
        await app.offerPhoneForTest(atLaunch: false);
        expect(app.phoneOfferShowing, isFalse, reason: kind);
        await pumpEventQueue();
        expect(store.values[_done], '1', reason: kind);
        app.dispose();
      }
    });

    test('a sign-in that is no longer signed in offers nothing', () async {
      final store = MemoryStore();
      final app = createApp(store: store)
        ..signedIn = false
        ..api = _DevicesApi(_listing([]));
      addTearDown(app.dispose);
      await app.offerPhoneForTest(atLaunch: false);
      expect(app.phoneOfferShowing, isFalse);
    });
  });

  test('a returning launch waits for the asynchronous account profile', () async {
    final profile = Completer<Map<String, dynamic>?>();
    final api = _DevicesApi(_listing([]))..profile = profile.future;
    final store = MemoryStore();
    final app = createApp(store: store)
      ..status = AppStatus.authenticated
      ..signedIn = true
      ..api = api;
    addTearDown(app.dispose);
    final offer = app.offerPhoneForTest(atLaunch: true);
    await pumpEventQueue();
    expect(api.profileReads, 1);
    expect(api.reads, 0);
    expect(app.phoneOfferShowing, isFalse);
    profile.complete({'user': {'id': 'loaded-account', 'email': 'a@example.test'}});
    await offer;
    expect(app.phoneOfferShowing, isTrue);
    expect(api.profileReads, 1);
    expect(api.reads, 1);
    expect(store.values['phone_offer_returning.loaded-account'], isNull);
    app.phoneOfferShown();
    await pumpEventQueue();
    expect(store.values['phone_offer_returning.loaded-account'], '1');
  });

  test('signing out while the returning profile loads leaves no record', () async {
    final profile = Completer<Map<String, dynamic>?>();
    final api = _DevicesApi(_listing([]))..profile = profile.future;
    final store = MemoryStore();
    final usage = AddPhoneRecorder();
    final app = createApp(store: store, productMeasurement: usage)
      ..status = AppStatus.authenticated
      ..signedIn = true
      ..api = api;
    addTearDown(app.dispose);
    final offer = app.offerPhoneForTest(atLaunch: true);
    await pumpEventQueue();
    expect(api.profileReads, 1);
    app.signedIn = false;
    profile.complete({'user': {'id': 'loaded-account', 'email': 'a@example.test'}});
    await offer;
    expect(app.phoneOfferShowing, isFalse);
    expect(api.reads, 0);
    expect(store.values, isEmpty);
    expect(usage.skipped, ['not_signed_in']);
  });

  test('a returning launch without a stable account identity offers nothing', () async {
    for (final id in [null, '']) {
      final usage = AddPhoneRecorder();
      final app = createApp(store: MemoryStore(), productMeasurement: usage)
        ..signedIn = true
        ..currentUser = CurrentUserProfile(id: id, email: 'a@example.test')
          ..api = _DevicesApi(_listing([]));
      addTearDown(app.dispose);
      await app.offerPhoneForTest(atLaunch: true);
      expect(app.phoneOfferShowing, isFalse);
      expect(usage.skipped, ['not_signed_in']);
    }
  });

  test('a guest launch cannot show after the account lands during its state read', () async {
    final usage = AddPhoneRecorder();
    final store = _OnReadStore();
    final app = createApp(store: store, productMeasurement: usage)..signedIn = false;
    addTearDown(app.dispose);
    store.onRead = (key) { if (key == _done) { app.signedIn = true; } };
    await app.offerPhoneForTest(atLaunch: true);
    expect(app.phoneOfferShowing, isFalse);
    expect(usage.skipped, ['account_changed']);
  });

  test('each offer refusal counts one fixed skip reason without another device read', () async {
    final usage = AddPhoneRecorder();
    final store = MemoryStore()..values[_stopped] = '1';
    final api = _DevicesApi(_listing([]));
    final app = createApp(store: store, productMeasurement: usage)
      ..status = AppStatus.authenticated
      ..signedIn = true
      ..currentUser = const CurrentUserProfile(id: 'a', email: 'a@example.test')
      ..api = api;
    addTearDown(app.dispose);
    await app.offerPhoneForTest(atLaunch: true);
    expect(usage.skipped, ['stopped']);
    expect(api.reads, 0);
    store.values.remove(_stopped);
    await app.offerPhoneForTest(atLaunch: true);
    app.phoneOfferShown();
    expect(usage.started, ['phoneOfferReturning']);
    await app.offerPhoneForTest(atLaunch: true);
    expect(usage.skipped.last, 'card_showing');
  });

  test(
    'skip reasons distinguish seen, stop, no list, cached phone and read limit',
    () async {
      for (final (values, api, expected) in [
        ({_seen: '1'}, _DevicesApi(_listing([])), 'already_shown'),
        ({_stopped: '1'}, _DevicesApi(_listing([])), 'stopped'),
        (<String, String>{}, _DevicesApi(null), 'no_device_list'),
        (
          <String, String>{},
          _DevicesApi(_listing([_device('phone')])),
          'has_phone',
        ),
      ]) {
        final usage = AddPhoneRecorder();
        final store = MemoryStore()..values.addAll(values);
        final app = createApp(store: store, productMeasurement: usage)
          ..status = AppStatus.authenticated
          ..signedIn = true
          ..api = api;
        addTearDown(app.dispose);
        await app.offerPhoneAfterWorkForTest();
        expect(usage.skipped, [expected]);
        expect(app.phoneOfferShowing, isFalse);
        if (expected == 'no_device_list') {
          for (var i = 0; i < 5; i++) {
            await app.offerPhoneAfterWorkForTest();
          }
          expect(api.reads, 3);
          expect(usage.skipped, [
            'no_device_list',
            'read_limit',
          ]);
        }
        if (expected == 'has_phone') {
          await app.offerPhoneAfterWorkForTest();
          expect(usage.skipped, ['has_phone']);
          expect(api.reads, 1);
        }
      }
    },
  );

  test('50 finished own turns count already_shown once for this run', () async {
    final store = MemoryStore()..values[_seen] = '1';
    final usage = AddPhoneRecorder();
    final api = _DevicesApi(_listing([]));
    final app = createApp(store: store, productMeasurement: usage)
      ..status = AppStatus.authenticated
      ..signedIn = true
      ..api = api;
    addTearDown(app.dispose);
    app.adoptSessionForTest(terminal('a0', []));
    for (var i = 0; i < 50; i++) {
      await app.handleMachineEventForTest('m', {
        'type': 'turn_ended',
        'agentId': 'a0',
      });
      await pumpEventQueue();
    }
    expect(usage.skipped, ['already_shown']);
    expect(api.reads, 0);
  });

  test('an account invalidation permits each path/reason again without retaining old revisions', () async {
    final store = MemoryStore()..values[_seen] = '1';
    final usage = AddPhoneRecorder();
    final app =
        AppNotifier(
            config: AppConfig.dev,
            configStore: null,
            authSession: AuthSession(storage: MemoryStore()),
            paneLayoutStore: PaneLayoutStore(storage: store),
            productMeasurement: usage,
            localManualFixture: const LocalManualFixture(
              apiBaseUrl: 'http://127.0.0.1:9',
              apiKey: 'fixture',
              machineId: 'fixture',
              machineName: 'Fixture',
            ),
          )
          ..status = AppStatus.authenticated
          ..signedIn = true
          ..currentUser = const CurrentUserProfile(
            id: 'a',
            email: 'a@example.test',
          );
    addTearDown(app.dispose);
    final generation = app.accountGeneration;
    for (var i = 0; i < 50; i++) {
      await app.offerPhoneAfterWorkForTest();
    }
    expect(usage.skipped, ['already_shown']);
    app.expireSessionForTest('Account changed');
    expect(app.accountGeneration, greaterThan(generation));
    app
      ..status = AppStatus.authenticated
      ..signedIn = true
      ..currentUser = const CurrentUserProfile(
        id: 'b',
        email: 'b@example.test',
      );
    for (var i = 0; i < 50; i++) {
      await app.offerPhoneAfterWorkForTest();
    }
    expect(usage.skipped, ['already_shown', 'already_shown']);
  });

  test(
    'the same reason counts separately for launch, sign-in and work paths',
    () async {
      final store = MemoryStore()..values[_stopped] = '1';
      final usage = AddPhoneRecorder();
      final app = createApp(store: store, productMeasurement: usage)
        ..status = AppStatus.authenticated
        ..signedIn = true;
      addTearDown(app.dispose);
      app.dismissPhoneOffer();
      for (var i = 0; i < 50; i++) {
        await app.offerPhoneForTest(atLaunch: true);
        await app.offerPhoneForTest(atLaunch: false);
        await app.offerPhoneAfterWorkForTest();
      }
      expect(usage.skipped, ['stopped', 'stopped', 'stopped']);
    },
  );

  test(
    'a completed sign-in offer counts already_shown once without a device read',
    () async {
      final store = MemoryStore()..values[_done] = '1';
      final usage = AddPhoneRecorder();
      final api = _DevicesApi(_listing([]));
      final app = createApp(store: store, productMeasurement: usage)
        ..status = AppStatus.authenticated
        ..signedIn = true
        ..api = api;
      addTearDown(app.dispose);
      for (var i = 0; i < 50; i++) {
        await app.offerPhoneForTest(atLaunch: false);
      }
      expect(usage.skipped, ['already_shown']);
      expect(api.reads, 0);
    },
  );

  test(
    'a window closed before its launch decision cannot show a card',
    () async {
      final api = _DevicesApi(_listing([]));
      final app = createApp(store: MemoryStore())..api = api;
      app.dispose();
      await app.offerPhoneForTest(atLaunch: true);
      expect(app.phoneOfferShowing, isFalse);
      expect(api.reads, 0);
    },
  );

  for (final path in ['work', 'sign_in', 'launch']) {
    test(
      'a window closed during the $path device read cannot show a card',
      () async {
        final api = _DevicesApi(_listing([]));
        final app = createApp(store: MemoryStore())
          ..status = AppStatus.authenticated
          ..signedIn = true
          ..currentUser = const CurrentUserProfile(
            id: 'a',
            email: 'a@example.test',
          )
          ..api = api;
        var closed = false;
        addTearDown(() {
          if (!closed) {
            app.dispose();
          }
        });
        api.onRead = () {
          closed = true;
          app.dispose();
        };
        if (path == 'work') {
          await app.offerPhoneAfterWorkForTest();
        } else {
          await app.offerPhoneForTest(atLaunch: path == 'launch');
        }
        expect(app.phoneOfferShowing, isFalse);
        expect(api.reads, 1);
      },
    );
  }

  test('returning launch reports already shown and the sign-in path respects a prior stop', () async {
    final usage = AddPhoneRecorder();
    final store = MemoryStore()..values['phone_offer_returning.a'] = '1';
    final api = _DevicesApi(_listing([]));
    final app = createApp(store: store, productMeasurement: usage)
      ..signedIn = true
      ..currentUser = const CurrentUserProfile(id: 'a', email: 'a@example.test')
      ..api = api;
    addTearDown(app.dispose);
    await app.offerPhoneForTest(atLaunch: true);
    expect(usage.skipped, ['already_shown']);
    store.values[_stopped] = '1';
    await app.offerPhoneForTest(atLaunch: false);
    expect(usage.skipped, ['already_shown', 'stopped']);
    expect(api.reads, 0);
  });

  test('a viewer never offers cards or reads devices', () async {
    final store = MemoryStore();
    final session = AuthSession(storage: store);
    final usage = AddPhoneRecorder();
    final api = _DevicesApi(_listing([]));
    final app =
        AppNotifier(
            config: AppConfig.dev,
            authSession: session,
            viewer: ViewerServices(
              config: AppConfig.dev,
              session: session,
              keys: ViewerKeyStore(storage: store),
            ),
            productMeasurement: usage,
          )
          ..signedIn = true
          ..status = AppStatus.authenticated
          ..api = api;
    addTearDown(app.dispose);
    await app.offerPhoneForTest(atLaunch: true);
    await app.offerPhoneForTest(atLaunch: false);
    await app.offerPhoneAfterWorkForTest();
    expect(app.phoneOfferShowing, isFalse);
    expect(api.reads, 0);
    expect(usage.skipped, ['viewer', 'viewer', 'viewer']);
  });

  test('signing out during each device read cannot show a card', () async {
    for (final path in ['returning', 'sign_in', 'work']) {
      final usage = AddPhoneRecorder();
      final api = _DevicesApi(_listing([]));
      final app = createApp(store: MemoryStore(), productMeasurement: usage)
        ..status = AppStatus.authenticated
        ..signedIn = true
        ..currentUser = const CurrentUserProfile(
          id: 'a',
          email: 'a@example.test',
        )
        ..api = api;
      addTearDown(app.dispose);
      api.onRead = () => app.signedIn = false;
      if (path == 'work') {
        await app.offerPhoneAfterWorkForTest();
      } else {
        await app.offerPhoneForTest(atLaunch: path == 'returning');
      }
      expect(app.phoneOfferShowing, isFalse, reason: path);
      expect(usage.skipped, ['not_signed_in'], reason: path);
    }
  });

  test('Add Phone opened while a card path reads devices stops the pending card', () async {
    for (final path in ['returning', 'sign_in', 'work']) {
      final usage = AddPhoneRecorder();
      final api = _DevicesApi(_listing([]));
      final app = createApp(store: MemoryStore(), productMeasurement: usage)
        ..status = AppStatus.authenticated
        ..signedIn = true
        ..currentUser = const CurrentUserProfile(id: 'a', email: 'a@example.test')
        ..api = api;
      addTearDown(app.dispose);
      api.onRead = () => app.addPhoneOpened(AddPhoneOpening.menu);
      if (path == 'work') { await app.offerPhoneAfterWorkForTest(); }
      else { await app.offerPhoneForTest(atLaunch: path == 'returning'); }
      expect(app.phoneOfferShowing, isFalse, reason: path);
      expect(usage.skipped, ['stopped'], reason: path);
    }
  });

  test('changing accounts before a returning card is shown writes no offer record', () async {
    final store = MemoryStore();
    final usage = AddPhoneRecorder();
    final app = createApp(store: store, productMeasurement: usage)
      ..signedIn = true
      ..currentUser = const CurrentUserProfile(id: 'a', email: 'a@example.test')
      ..api = _DevicesApi(_listing([]));
    addTearDown(app.dispose);
    await app.offerPhoneForTest(atLaunch: true);
    app.currentUser = const CurrentUserProfile(id: 'b', email: 'b@example.test');
    app.phoneOfferShown();
    await pumpEventQueue();
    expect(store.values[_done], isNull);
    expect(store.values[_seen], isNull);
    expect(store.values['phone_offer_returning.a'], isNull);
    expect(store.values['phone_offer_returning.b'], isNull);
    expect(usage.started, isEmpty);
  });

  test(
    'another account arriving during a returning read cannot inherit its offer',
    () async {
      final usage = AddPhoneRecorder();
      final store = MemoryStore();
      final api = _DevicesApi(_listing([]));
      final app = createApp(store: store, productMeasurement: usage)
        ..signedIn = true
        ..currentUser = const CurrentUserProfile(
          id: 'a',
          email: 'a@example.test',
        )
        ..api = api;
      addTearDown(app.dispose);
      api.onRead = () => app.currentUser = const CurrentUserProfile(
        id: 'b',
        email: 'b@example.test',
      );
      await app.offerPhoneForTest(atLaunch: true);
      expect(app.phoneOfferShowing, isFalse);
      expect(usage.skipped, ['account_changed']);
      expect(store.values['phone_offer_returning.a'], isNull);
      expect(store.values['phone_offer_returning.b'], isNull);
    },
  );

  group('after work, on a computer that never showed it', () {
    /// A computer that opened signed in — marked offered at launch, the card never on its screen —
    /// on an account answering [api], measured by [usage].
    Future<(AppNotifier, MemoryStore)> returning(
      _DevicesApi api, {
      MemoryStore? store,
      AddPhoneRecorder? usage,
    }) async {
      final kept = store ?? MemoryStore();
      final app = createApp(store: kept, productMeasurement: usage)
        ..status = AppStatus.authenticated
        ..signedIn = true
        ..api = api;
      addTearDown(app.dispose);
      // The historical signed-in launch marked done without ever showing a card.
      kept.values[_done] = '1';
      expect(app.phoneOfferShowing, isFalse);
      return (app, kept);
    }

    /// One of the person's own harnesses here finishing a turn.
    Future<void> turnEnds(AppNotifier app, {bool failed = false}) async {
      app.adoptSessionForTest(terminal('a0', []));
      await app.handleMachineEventForTest('m', {
        'type': 'turn_ended',
        'agentId': 'a0',
        if (failed) 'error': 'ENGINE_FAILED',
      });
      await pumpEventQueue();
    }

    test('shows the card once a turn of its own finishes', () async {
      final (app, store) = await returning(_DevicesApi(_listing([])));
      await turnEnds(app);
      expect(app.phoneOfferShowing, isTrue);
      expect(store.values[_seen], isNull, reason: 'seen once on screen');
      app.phoneOfferShown();
      await pumpEventQueue();
      expect(store.values[_seen], '1');
    });

    test('is counted as its own flow, apart from the first offer', () async {
      final usage = AddPhoneRecorder();
      final (app, _) = await returning(_DevicesApi(_listing([])), usage: usage);
      await turnEnds(app);
      app.phoneOfferShown();
      app.addPhoneOpened(AddPhoneOpening.offer);
      expect(usage.started, ['phoneOfferAfterWork']);
      expect(usage.ended, ['phoneOfferAfterWork:ok']);
    });

    test(
      'once per computer: not after it was put away, nor on a later run',
      () async {
        final api = _DevicesApi(_listing([]));
        final (app, store) = await returning(api);
        await turnEnds(app);
        app.phoneOfferShown();
        app.dismissPhoneOffer();
        await turnEnds(app);
        expect(app.phoneOfferShowing, isFalse);

        final (next, _) = await returning(api, store: store);
        await turnEnds(next);
        expect(next.phoneOfferShowing, isFalse);
      },
    );

    test('not on a computer that showed the first card', () async {
      final store = MemoryStore();
      final first = createApp(store: store)..signedIn = false;
      addTearDown(first.dispose);
      await first.offerPhoneForTest(atLaunch: true);
      first.phoneOfferShown();
      await pumpEventQueue();
      expect(store.values[_seen], '1');

      final (app, _) = await returning(_DevicesApi(_listing([])), store: store);
      await turnEnds(app);
      expect(app.phoneOfferShowing, isFalse);
    });

    test('not on a computer where Add Phone was opened by hand', () async {
      final (app, store) = await returning(_DevicesApi(_listing([])));
      app.addPhoneOpened(AddPhoneOpening.menu);
      await pumpEventQueue();
      expect(store.values[_seen], '1');
      await turnEnds(app);
      expect(app.phoneOfferShowing, isFalse);
    });

    test(
      'an account with a phone or a browser is not offered it, ever again here',
      () async {
        for (final kind in ['phone', 'browser']) {
          final (app, store) = await returning(
            _DevicesApi(_listing([_device(kind)])),
          );
          await turnEnds(app);
          expect(app.phoneOfferShowing, isFalse, reason: kind);
          expect(store.values[_seen], '1', reason: kind);
        }
      },
    );

    test('a list it cannot read offers nothing yet, and is asked again at the next turn', () async {
      final api = _DevicesApi(_listing([]), fails: true);
      final (app, store) = await returning(api);
      await turnEnds(app);
      expect(app.phoneOfferShowing, isFalse);
      expect(store.values[_seen], isNull);
      api.fails = false;
      await turnEnds(app);
      expect(app.phoneOfferShowing, isTrue);

      // No list at all (an older daemon): the same, asked again at the next turn.
      final none = _DevicesApi(null);
      final (other, _) = await returning(none);
      await turnEnds(other);
      expect(other.phoneOfferShowing, isFalse);
      none.listing = _listing([]);
      await turnEnds(other);
      expect(other.phoneOfferShowing, isTrue);
      expect(none.reads, 2);
    });

    test(
      'a list that never comes is asked for three times a run at most',
      () async {
        // An older CLI with no device list: not a read at every finished turn for the whole run.
        for (final api in [
          _DevicesApi(null),
          _DevicesApi(_listing([]), fails: true),
        ]) {
          final (app, _) = await returning(api);
          for (var i = 0; i < 6; i++) {
            await turnEnds(app);
          }
          expect(api.reads, 3);
          expect(app.phoneOfferShowing, isFalse);
        }
      },
    );

    test(
      'a failed turn offers nothing, and a run reads the list once',
      () async {
        final api = _DevicesApi(_listing([_device('phone')]));
        final (app, _) = await returning(api);
        await turnEnds(app, failed: true);
        expect(api.reads, 0);
        await turnEnds(app);
        await turnEnds(app);
        await turnEnds(app);
        expect(api.reads, 1);
        expect(app.phoneOfferShowing, isFalse);
      },
    );

    test('with nowhere to remember it, nothing is offered', () async {
      final api = _DevicesApi(_listing([]));
      final app = createApp()
        ..status = AppStatus.authenticated
        ..signedIn = true
        ..api = api;
      addTearDown(app.dispose);
      await turnEnds(app);
      expect(app.phoneOfferShowing, isFalse);
      expect(api.reads, 0);
    });

    test('not while signed out', () async {
      final api = _DevicesApi(_listing([]));
      final app = createApp(store: MemoryStore())
        ..status = AppStatus.authenticated
        ..signedIn = false
        ..api = api;
      addTearDown(app.dispose);
      await app.offerPhoneAfterWorkForTest();
      expect(app.phoneOfferShowing, isFalse);
      expect(api.reads, 0);
    });
  });

  group('after time away', () {
    late DateTime now;
    late AppLifecycleState? state;

    /// A signed-in computer whose window is in front, on an account answering [api].
    Future<(AppNotifier, MemoryStore)> working(
      _DevicesApi api, {
      MemoryStore? store,
      AddPhoneRecorder? usage,
      bool disposeAtTearDown = true,
    }) async {
      now = DateTime.utc(2026, 10, 20, 9);
      state = AppLifecycleState.resumed;
      final kept = store ?? MemoryStore();
      final app = createApp(store: kept, productMeasurement: usage)
        ..status = AppStatus.authenticated
        ..signedIn = true
        ..api = api
        ..phoneOfferClock = (() => now)
        ..lifecycle = (() => state);
      if (disposeAtTearDown) addTearDown(app.dispose);
      return (app, kept);
    }

    /// The window leaves the front.
    void leave(AppNotifier app) {
      state = AppLifecycleState.inactive;
      app.appLifecycleChanged(AppLifecycleState.inactive);
    }

    /// The window is back in front, [after] it left.
    Future<void> back(AppNotifier app, Duration after) async {
      now = now.add(after);
      state = AppLifecycleState.resumed;
      app.appLifecycleChanged(AppLifecycleState.resumed);
      await pumpEventQueue();
    }

    /// Harness `a0` ("Agent 0") finished a turn, with its notification.
    Future<void> finishes(AppNotifier app, {String id = 'n1'}) =>
        app.handleMachineEventForTest('m', {
          'type': 'turn_summary',
          'agentId': 'a0',
          'payload': {
            'agentId': 'a0',
            'notification': {'id': id, 'kind': 'done'},
          },
        });

    /// Harness `a1` ("Agent 1") asks the person a question.
    Future<void> asks(AppNotifier app) => app.handleMachineEventForTest('m', {
      'type': 'commander_question',
      'agentId': 'a1',
      'payload': {
        'requestId': 'q1',
        'questions': [
          {
            'key': 'Which?',
            'q': 'Which?',
            'options': ['A', 'B'],
          },
        ],
      },
    });

    test(
      'a harness that finished while the person was away 5 min or more',
      () async {
        final usage = AddPhoneRecorder();
        final (app, store) = await working(
          _DevicesApi(_listing([])),
          usage: usage,
        );
        leave(app);
        now = now.add(const Duration(minutes: 2));
        await finishes(app);
        await back(app, const Duration(minutes: 23));
        expect(app.phoneOfferShowing, isTrue);
        expect(app.phoneOfferAway, (
          agent: 'Agent 0',
          waited: false,
          minutes: 23,
        ));
        app.phoneOfferShown();
        await pumpEventQueue();
        expect(usage.started, ['phoneOfferAwayFinished']);
        expect(store.values[_shows], '1');
      },
    );

    test(
      'a harness that waited on the person outranks one that finished',
      () async {
        final usage = AddPhoneRecorder();
        final (app, _) = await working(_DevicesApi(_listing([])), usage: usage);
        leave(app);
        await finishes(app);
        now = now.add(const Duration(minutes: 4));
        await asks(app);
        await back(app, const Duration(minutes: 18));
        expect(app.phoneOfferAway, (
          agent: 'Agent 1',
          waited: true,
          minutes: 18,
        ));
        app.phoneOfferShown();
        app.addPhoneOpened(AddPhoneOpening.offer);
        expect(usage.started, ['phoneOfferAwayWaited']);
        expect(usage.ended, ['phoneOfferAwayWaited:ok']);
      },
    );

    test('not after a shorter time away, nor with nothing missed', () async {
      final (app, _) = await working(_DevicesApi(_listing([])));
      leave(app);
      await finishes(app);
      await back(app, const Duration(minutes: 4, seconds: 59));
      expect(app.phoneOfferShowing, isFalse);

      leave(app);
      await back(app, const Duration(minutes: 30));
      expect(app.phoneOfferShowing, isFalse);
    });

    test('news from before the window left is not news from away', () async {
      final (app, _) = await working(_DevicesApi(_listing([])));
      // In front: a finish says nothing to the system and keeps nothing.
      await finishes(app);
      leave(app);
      await back(app, const Duration(minutes: 30));
      expect(app.phoneOfferShowing, isFalse);

      // Heard while the platform already said "not in front" but the window had not yet reported
      // leaving: that belongs to no time away, so leaving afterwards starts clean.
      state = AppLifecycleState.hidden;
      await finishes(app, id: 'n2');
      leave(app);
      await back(app, const Duration(minutes: 30));
      expect(app.phoneOfferShowing, isFalse);
    });

    test('its × stops it on this computer, for good', () async {
      final store = MemoryStore();
      final (app, _) = await working(_DevicesApi(_listing([])), store: store);
      leave(app);
      await finishes(app);
      await back(app, const Duration(minutes: 10));
      app.phoneOfferShown();
      app.dismissPhoneOffer();
      await pumpEventQueue();
      expect(store.values[_stopped], '1');

      final (next, _) = await working(_DevicesApi(_listing([])), store: store);
      leave(next);
      await finishes(next, id: 'n2');
      await back(next, const Duration(minutes: 10));
      expect(next.phoneOfferShowing, isFalse);
    });

    test('Add Phone opened any way stops it too', () async {
      final store = MemoryStore();
      final (app, _) = await working(_DevicesApi(_listing([])), store: store);
      app.addPhoneOpened(AddPhoneOpening.titlebar);
      await pumpEventQueue();
      expect(store.values[_stopped], '1');
      leave(app);
      await finishes(app);
      await back(app, const Duration(minutes: 10));
      expect(app.phoneOfferShowing, isFalse);
    });

    test(
      'left unanswered, it comes back on a later run, three cards at most',
      () async {
        final store = MemoryStore();
        for (var run = 1; run <= 4; run++) {
          final (app, _) = await working(
            _DevicesApi(_listing([])),
            store: store,
          );
          leave(app);
          await finishes(app, id: 'n$run');
          await back(app, const Duration(minutes: 10));
          expect(app.phoneOfferShowing, run <= 3, reason: 'run $run');
          if (app.phoneOfferShowing) app.phoneOfferShown();
          await pumpEventQueue();
        }
        expect(store.values[_shows], '3');
      },
    );

    test('the other cards count toward the three', () async {
      final store = MemoryStore()..values[_shows] = '3';
      final (app, _) = await working(_DevicesApi(_listing([])), store: store);
      leave(app);
      await finishes(app);
      await back(app, const Duration(minutes: 10));
      expect(app.phoneOfferShowing, isFalse);
    });

    test(
      'not on an account with a phone or a browser, nor with no list',
      () async {
        for (final api in [
          _DevicesApi(_listing([_device('phone')])),
          _DevicesApi(_listing([_device('browser')])),
          _DevicesApi(null),
          _DevicesApi(_listing([]), fails: true),
        ]) {
          final (app, _) = await working(api);
          leave(app);
          await finishes(app);
          await back(app, const Duration(minutes: 10));
          expect(app.phoneOfferShowing, isFalse);
          expect(api.reads, 1);
        }
      },
    );

    test(
      'an account found to have a phone is not read again in this run',
      () async {
        Future<void> awayAndBack(AppNotifier app, int times) async {
          for (var i = 0; i < times; i++) {
            leave(app);
            await finishes(app, id: 'n$i');
            await back(app, const Duration(minutes: 10));
          }
        }

        // Each read reaches the backend through the daemon: once a run is enough to know.
        final phone = _DevicesApi(_listing([_device('phone')]));
        final (app, _) = await working(phone);
        await awayAndBack(app, 3);
        expect(app.phoneOfferShowing, isFalse);
        expect(phone.reads, 1);

        // Found by the card after work first: the same.
        final known = _DevicesApi(_listing([_device('browser')]));
        final (worked, _) = await working(known);
        await worked.offerPhoneAfterWorkForTest();
        expect(known.reads, 1);
        await awayAndBack(worked, 2);
        expect(worked.phoneOfferShowing, isFalse);
        expect(known.reads, 1);

        // No list is no answer: asked again at the next return.
        final unread = _DevicesApi(null);
        final (other, _) = await working(unread);
        await awayAndBack(other, 2);
        expect(unread.reads, 2);
      },
    );

    test('not for a shared computer\'s harness, nor while signed out, nor with nowhere to remember', () async {
      final (shared, _) = await working(_DevicesApi(_listing([])));
      const sharedMachine = Machine(
        machineId: 'm',
        authMode: MachineAuthMode.remote,
        name: 'Test host',
        isShared: true,
      );
      shared.machines = [sharedMachine];
      shared.machineStates['m'] = MachineState(sharedMachine)
        ..agents = shared.machineStates['m']!.agents;
      leave(shared);
      await finishes(shared);
      await back(shared, const Duration(minutes: 10));
      expect(shared.phoneOfferShowing, isFalse);

      final (out, _) = await working(_DevicesApi(_listing([])));
      out.signedIn = false;
      leave(out);
      await finishes(out);
      await back(out, const Duration(minutes: 10));
      expect(out.phoneOfferShowing, isFalse);

      final api = _DevicesApi(_listing([]));
      final nowhere = createApp()
        ..status = AppStatus.authenticated
        ..signedIn = true
        ..api = api
        ..phoneOfferClock = (() => now)
        ..lifecycle = (() => state);
      addTearDown(nowhere.dispose);
      leave(nowhere);
      await finishes(nowhere);
      await back(nowhere, const Duration(minutes: 10));
      expect(nowhere.phoneOfferShowing, isFalse);
      expect(api.reads, 0);
    });

    test(
      'a returning card uses one away-cap slot and suppresses the work card',
      () async {
        final usage = AddPhoneRecorder();
        final (app, store) = await working(
          _DevicesApi(_listing([])),
          usage: usage,
        );
        app.currentUser = const CurrentUserProfile(
          id: 'a',
          email: 'a@example.test',
        );
        await app.offerPhoneForTest(atLaunch: true);
        app.phoneOfferShown();
        await pumpEventQueue();
        expect(store.values[_shows], '1');
        app.dropPhoneOffer();
        await app.offerPhoneAfterWorkForTest();
        expect(app.phoneOfferShowing, isFalse);
        for (var i = 0; i < 3; i++) {
          leave(app);
          await finishes(app, id: 'return-$i');
          await back(app, const Duration(minutes: 10));
          expect(app.phoneOfferShowing, i < 2);
          if (i < 2) {
            app.phoneOfferShown();
            await pumpEventQueue();
            app.dropPhoneOffer();
          }
        }
        expect(store.values[_shows], '3');
        expect(usage.skipped.last, 'cap_reached');
      },
    );

    test('signing out during the away read records one skip', () async {
      final usage = AddPhoneRecorder();
      final api = _DevicesApi(_listing([]));
      final (app, _) = await working(api, usage: usage);
      api.onRead = () => app.signedIn = false;
      leave(app);
      await finishes(app);
      await back(app, const Duration(minutes: 10));
      expect(app.phoneOfferShowing, isFalse);
      expect(usage.skipped, ['not_signed_in']);
    });

    test('an account whose workspace is not ready skips the away card', () async {
      final usage = AddPhoneRecorder();
      final (app, _) = await working(_DevicesApi(_listing([])), usage: usage);
      leave(app);
      await finishes(app);
      app.status = AppStatus.unauthenticated;
      await back(app, const Duration(minutes: 10));
      expect(app.phoneOfferShowing, isFalse);
      expect(usage.skipped, ['not_signed_in']);
    });

    for (final reason in [
      'stopped',
      'cap_reached',
      'no_device_list',
      'has_phone',
      'card_showing',
    ]) {
      test('50 returns after time away count $reason once', () async {
        final usage = AddPhoneRecorder();
        final store = MemoryStore();
        if (reason == 'stopped') {
          store.values[_stopped] = '1';
        }
        if (reason == 'cap_reached') {
          store.values[_shows] = '3';
        }
        final api = _DevicesApi(
          reason == 'no_device_list'
              ? null
              : _listing(reason == 'has_phone' ? [_device('phone')] : []),
        );
        final (app, _) = await working(api, store: store, usage: usage);
        if (reason == 'card_showing') {
          await app.offerPhoneAfterWorkForTest();
        }
        for (var i = 0; i < 50; i++) {
          leave(app);
          await finishes(app, id: 'dedup-$i');
          await back(app, const Duration(minutes: 10));
        }
        expect(usage.skipped, [reason]);
      });
    }

    test(
      'a window closed during the away device read cannot show a card',
      () async {
        final api = _DevicesApi(_listing([]));
        final (app, _) = await working(api, disposeAtTearDown: false);
        var closed = false;
        addTearDown(() {
          if (!closed) {
            app.dispose();
          }
        });
        api.onRead = () {
          closed = true;
          app.dispose();
        };
        leave(app);
        await finishes(app);
        await back(app, const Duration(minutes: 10));
        expect(app.phoneOfferShowing, isFalse);
        expect(api.reads, 1);
      },
    );

    test('a card already up is left as it is', () async {
      final (app, _) = await working(_DevicesApi(_listing([])));
      await app.offerPhoneAfterWorkForTest();
      expect(app.phoneOfferShowing, isTrue);
      leave(app);
      await finishes(app);
      await back(app, const Duration(minutes: 10));
      expect(app.phoneOfferAway, isNull);
    });
  });

  group('its measure', () {
    /// A guest's first launch, with the card offered, measured by [usage].
    Future<AppNotifier> offered(AddPhoneRecorder usage) async {
      final app = createApp(store: MemoryStore(), productMeasurement: usage)
        ..signedIn = false;
      addTearDown(app.dispose);
      await app.offerPhoneForTest(atLaunch: true);
      expect(app.phoneOfferShowing, isTrue);
      return app;
    }

    List<String> card(AddPhoneRecorder usage) =>
        usage.started.where((flow) => flow == 'phoneOffer').toList();

    test(
      'begins once it is on screen, once however often it is built',
      () async {
        final usage = AddPhoneRecorder();
        final app = await offered(usage);
        expect(card(usage), isEmpty);
        app.phoneOfferShown();
        app.phoneOfferShown();
        expect(card(usage), ['phoneOffer']);
        expect(usage.ended, isEmpty);
      },
    );

    test('nothing begins with no card offered', () async {
      final usage = AddPhoneRecorder();
      final app = createApp(store: MemoryStore(), productMeasurement: usage);
      addTearDown(app.dispose);
      app.phoneOfferShown();
      expect(card(usage), isEmpty);
    });

    test('its Add Phone is ok, its × cancelled, once each', () async {
      final add = AddPhoneRecorder();
      final app = await offered(add);
      app.phoneOfferShown();
      app.addPhoneOpened(AddPhoneOpening.offer);
      expect(add.ended, ['phoneOffer:ok']);
      expect(add.openings, [AddPhoneOpening.offer]);
      expect(app.phoneOfferShowing, isFalse);
      // The dialog closing drops the spent offer again: nothing more.
      app.dropPhoneOffer();
      expect(add.ended, ['phoneOffer:ok']);

      final dismiss = AddPhoneRecorder();
      final other = await offered(dismiss);
      other.phoneOfferShown();
      other.dismissPhoneOffer();
      other.dismissPhoneOffer();
      expect(dismiss.ended, ['phoneOffer:cancelled']);
      expect(dismiss.openings, isEmpty);
      expect(other.phoneOfferShowing, isFalse);
    });

    test(
      'Add Phone opened another way while it shows is unknown for it',
      () async {
        final usage = AddPhoneRecorder();
        final app = await offered(usage);
        app.phoneOfferShown();
        app.addPhoneOpened(AddPhoneOpening.menu);
        expect(usage.ended, ['phoneOffer:unknown']);
        expect(usage.openings, [AddPhoneOpening.menu]);
        expect(app.phoneOfferShowing, isFalse);
        // Later openings count their way in, with no card left to end.
        app.addPhoneOpened(AddPhoneOpening.account);
        expect(usage.ended, ['phoneOffer:unknown']);
        expect(usage.openings, [AddPhoneOpening.menu, AddPhoneOpening.account]);
      },
    );

    test('a card a sign-in takes away is unknown', () async {
      final usage = AddPhoneRecorder();
      final app = await offered(usage);
      app.phoneOfferShown();
      app.signingIn = true;
      app.cancelLogin();
      expect(usage.ended, ['phoneOffer:unknown']);
      expect(app.phoneOfferShowing, isFalse);
    });

    test('a card never on screen ends nothing', () async {
      final usage = AddPhoneRecorder();
      final app = await offered(usage);
      app.dismissPhoneOffer();
      expect(usage.ended, isEmpty);
    });
  });

  group('the card', () {
    Future<({List<String> taps})> card(WidgetTester tester) async {
      final taps = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: Align(
              alignment: Alignment.topRight,
              child: PhoneOfferCard(
                onAdd: () => taps.add('add'),
                onDismiss: () => taps.add('dismiss'),
                onShown: () => taps.add('shown'),
              ),
            ),
          ),
        ),
      );
      return (taps: taps);
    }

    testWidgets('says what the Welcome Tour said, and does what it says', (
      tester,
    ) async {
      final (:taps) = await card(tester);
      expect(find.text('Your agents in your pocket.'), findsOneWidget);
      expect(
        find.text('When an agent needs you, answer from anywhere.'),
        findsOneWidget,
      );
      // Named as the phone names it: "Open Add Phone on your computer".
      expect(find.widgetWithText(FilledButton, 'Add Phone'), findsOneWidget);
      await tester.tap(find.byKey(const Key('phone-offer-add')));
      await tester.tap(find.byKey(const Key('phone-offer-dismiss')));
      // On screen once its first frame is drawn, before any tap.
      expect(taps, ['shown', 'add', 'dismiss']);
    });
  });

  group('the card after time away', () {
    testWidgets(
      'says what the harness did, then what a phone would have done',
      (tester) async {
        for (final (away, title, detail) in [
          (
            (agent: 'Codex', waited: true, minutes: 18),
            'Codex waited 18\u00A0min for you.',
            'Answer from your phone next time.',
          ),
          (
            (agent: 'Codex', waited: false, minutes: 25),
            'Codex finished 25\u00A0min ago.',
            'Know the moment it’s done, on your phone.',
          ),
        ]) {
          await tester.pumpWidget(
            MaterialApp(
              theme: grid.buildAppTheme(brightness: Brightness.dark),
              home: Scaffold(
                body: Align(
                  alignment: Alignment.topRight,
                  child: PhoneOfferCard(
                    onAdd: () {},
                    onDismiss: () {},
                    away: away,
                  ),
                ),
              ),
            ),
          );
          expect(find.text(title), findsOneWidget);
          expect(find.text(detail), findsOneWidget);
          expect(
            find.widgetWithText(FilledButton, 'Add Phone'),
            findsOneWidget,
          );
          expect(find.text('Your agents in your pocket.'), findsNothing);
        }
      },
    );

    testWidgets('a long harness name keeps the card its size', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: Align(
              alignment: Alignment.topRight,
              child: PhoneOfferCard(
                onAdd: () {},
                onDismiss: () {},
                away: (
                  agent:
                      'Fix the login flow across every payment provider '
                      'and the account settings page too',
                  waited: true,
                  minutes: 7,
                ),
              ),
            ),
          ),
        ),
      );
      expect(tester.takeException(), isNull);
      final title = tester.widget<Text>(
        find.byKey(const Key('phone-offer-title')),
      );
      expect(title.maxLines, 2);
      expect(
        tester.getSize(find.byKey(const Key('phone-offer-card'))).width,
        288,
      );
    });

    testWidgets('the minutes never wrap apart from "min"', (tester) async {
      // Every name length puts the line break somewhere else in the title.
      for (var length = 1; length <= 40; length++) {
        for (final waited in [true, false]) {
          await tester.pumpWidget(
            MaterialApp(
              theme: grid.buildAppTheme(brightness: Brightness.dark),
              home: Scaffold(
                body: Align(
                  alignment: Alignment.topRight,
                  child: PhoneOfferCard(
                    onAdd: () {},
                    onDismiss: () {},
                    away: (
                      agent: 'Refactor auth flow and more'
                          .padRight(length, 'x')
                          .substring(0, length),
                      waited: waited,
                      minutes: 21,
                    ),
                  ),
                ),
              ),
            ),
          );
          final title = tester.renderObject<RenderParagraph>(
            find.descendant(
              of: find.byKey(const Key('phone-offer-title')),
              matching: find.byType(RichText),
            ),
          );
          final text = title.text.toPlainText();
          final digits = text.indexOf('21');
          final unit = text.indexOf('min', digits);
          // The title's own text, laid out at the title's own width.
          final painter = TextPainter(
            text: title.text,
            textDirection: title.textDirection,
            textScaler: title.textScaler,
          )..layout(maxWidth: title.size.width);
          addTearDown(painter.dispose);
          TextRange line(int offset) =>
              painter.getLineBoundary(TextPosition(offset: offset));
          expect(
            line(unit + 2),
            line(digits),
            reason: '"$text" wraps between the minutes and "min"',
          );
        }
      }
    });
  });

  group('on the workspace', () {
    Future<(AppNotifier, MemoryStore)> offered(
      WidgetTester tester, {
      ProductMeasurement? usage,
    }) async {
      final store = MemoryStore();
      final app = createApp(store: store, productMeasurement: usage)
        ..status = AppStatus.authenticated
        ..signedIn = false;
      await app.offerPhoneForTest(atLaunch: true);
      expect(app.phoneOfferShowing, isTrue);
      await mount(tester, app);
      return (app, store);
    }

    testWidgets(
      'the returning card waits for first arrival before recording its account',
      (tester) async {
        final usage = AddPhoneRecorder();
        final store = MemoryStore()..values['first_arrival_v1'] = 'new';
        final app = createApp(store: store, productMeasurement: usage)
          ..status = AppStatus.authenticated
          ..signedIn = true
          ..currentUser = const CurrentUserProfile(
            id: 'a',
            email: 'a@example.test',
          )
          ..api = _DevicesApi(_listing([]));
        addTearDown(app.dispose);
        await app.firstArrival.restore();
        await app.offerPhoneForTest(atLaunch: true);
        await mount(tester, app);
        expect(app.phoneOfferShowing, isTrue);
        expect(find.byType(PhoneOfferCard), findsNothing);
        expect(find.byType(AddPhoneDialog), findsNothing);
        expect(store.values['phone_offer_returning.a'], isNull);
        expect(usage.started, isEmpty);
        app.firstArrival.dismiss();
        app.notifyListeners();
        await tester.pump();
        await tester.pump();
        expect(find.byType(PhoneOfferCard), findsOneWidget);
        expect(find.byType(AddPhoneDialog), findsNothing);
        expect(store.values['phone_offer_returning.a'], '1');
        expect(usage.started, ['phoneOfferReturning']);
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets(
      'the card stands in the top-right, and Add Phone opens from it',
      (tester) async {
        final usage = AddPhoneRecorder();
        final (app, store) = await offered(tester, usage: usage);
        addTearDown(app.dispose);
        expect(usage.started.where((f) => f == 'phoneOffer'), ['phoneOffer']);
        final card = find.byKey(const Key('phone-offer-card'));
        expect(card, findsOneWidget);
        // Beside the work, in the agents' banners' corner — not over the middle of the window.
        final box = tester.getRect(card);
        expect(box.right, greaterThan(1280 - 40));
        expect(box.top, lessThan(200));

        await tester.tap(find.byKey(const Key('phone-offer-add')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
        expect(find.byType(AddPhoneDialog), findsOneWidget);
        expect(find.byKey(const Key('phone-offer-card')), findsNothing);
        expect(usage.ended, ['phoneOffer:ok']);
        expect(usage.openings, [AddPhoneOpening.offer]);
        await tester.pump();
        expect(store.values[_done], '1');

        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(seconds: 5));
      },
    );

    testWidgets('it leaves the top-right pane\'s header clear', (tester) async {
      final store = MemoryStore();
      final app = createApp(store: store)
        ..status = AppStatus.authenticated
        ..signedIn = false;
      addTearDown(app.dispose);
      app.adoptSessionForTest(terminal('a0', []));
      app.adoptSessionForTest(terminal('a1', []));
      await app.offerPhoneForTest(atLaunch: true);
      await mount(tester, app);
      final card = find.byKey(const Key('phone-offer-card'));
      final box = tester.getRect(card);
      final titles = find.byKey(const ValueKey('terminal-pane-title'));
      final right = tester
          .widgetList(titles)
          .map((title) => tester.getRect(find.byWidget(title)))
          .reduce((a, b) => a.left > b.left ? a : b);
      // The pane's header row — its name, its model, its × — is not under the card anywhere the
      // card spans, so the waiting pane can still be closed or switched.
      final cardObject = tester.renderObject(card);
      for (final y in [right.top, right.center.dy, right.bottom + 8]) {
        for (final x in [box.left + 8, box.center.dx, box.right - 8]) {
          final hits = tester.hitTestOnBinding(Offset(x, y)).path;
          expect(
            hits.any((entry) => identical(entry.target, cardObject)),
            isFalse,
            reason: 'the card covers the pane header at ($x, $y)',
          );
        }
      }
      expect(box.top, greaterThan(right.bottom));
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 5));
    });

    testWidgets('× puts it away for good', (tester) async {
      final usage = AddPhoneRecorder();
      final (app, store) = await offered(tester, usage: usage);
      addTearDown(app.dispose);
      await tester.tap(find.byKey(const Key('phone-offer-dismiss')));
      await tester.pump();
      expect(find.byKey(const Key('phone-offer-card')), findsNothing);
      expect(find.byType(AddPhoneDialog), findsNothing);
      expect(usage.ended, ['phoneOffer:cancelled']);
      expect(usage.openings, isEmpty);
      await tester.pump();
      expect(store.values[_done], '1');
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 5));
    });
  });
}
