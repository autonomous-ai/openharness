import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/add_phone_dialog.dart';
import 'package:harness/widgets/phone_offer_card.dart';

import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show createApp, MemoryStore;

/// This computer's record that Add Phone has had its offer.
const _done = 'phone_offer_done';

/// The daemon's device list, answered in memory: [listing], or a read that fails.
class _DevicesApi extends ApiClient {
  _DevicesApi(this.listing, {this.fails = false})
    : super(config: AppConfig.dev, session: AuthSession());

  final Map<String, dynamic>? listing;
  final bool fails;

  @override
  Future<Map<String, dynamic>?> daemonDevices() async {
    if (fails) throw StateError('The network connection was lost.');
    return listing;
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

    test('a computer that opens signed in has had its first sign-in', () async {
      final store = MemoryStore();
      final app = createApp(store: store)
        ..signedIn = true
        ..api = _DevicesApi(_listing([]));
      addTearDown(app.dispose);
      await app.offerPhoneForTest(atLaunch: true);
      expect(app.phoneOfferShowing, isFalse);
      await pumpEventQueue();
      expect(store.values[_done], '1');
      // So a later sign-in by hand offers nothing either.
      await app.offerPhoneForTest(atLaunch: false);
      expect(app.phoneOfferShowing, isFalse);
    });

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
      expect(taps, ['add', 'dismiss']);
    });
  });

  group('on the workspace', () {
    Future<(AppNotifier, MemoryStore)> offered(WidgetTester tester) async {
      final store = MemoryStore();
      final app = createApp(store: store)
        ..status = AppStatus.authenticated
        ..signedIn = false;
      await app.offerPhoneForTest(atLaunch: true);
      expect(app.phoneOfferShowing, isTrue);
      await mount(tester, app);
      return (app, store);
    }

    testWidgets(
      'the card stands in the top-right, and Add Phone opens from it',
      (tester) async {
        final (app, store) = await offered(tester);
        addTearDown(app.dispose);
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
        await tester.pump();
        expect(store.values[_done], '1');

        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(seconds: 5));
      },
    );

    testWidgets('× puts it away for good', (tester) async {
      final (app, store) = await offered(tester);
      addTearDown(app.dispose);
      await tester.tap(find.byKey(const Key('phone-offer-dismiss')));
      await tester.pump();
      expect(find.byKey(const Key('phone-offer-card')), findsNothing);
      expect(find.byType(AddPhoneDialog), findsNothing);
      await tester.pump();
      expect(store.values[_done], '1');
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 5));
    });
  });
}
