@TestOn('browser')
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import '../support/add_phone_measurement.dart';
import '../swarm_state_test.dart' show createApp, MemoryStore;

void main() {
  test('the web never offers a launch, sign-in or after-work phone card', () async {
    final usage = AddPhoneRecorder();
    final store = MemoryStore();
    final app = createApp(store: store, productMeasurement: usage)
      ..status = AppStatus.authenticated
      ..signedIn = true
      ..currentUser = const CurrentUserProfile(id: 'a', email: 'a@example.test');
    addTearDown(app.dispose);
    await app.offerPhoneForTest(atLaunch: true);
    await app.offerPhoneForTest(atLaunch: false);
    await app.offerPhoneAfterWorkForTest();
    expect(app.phoneOfferShowing, isFalse);
    expect(store.values['phone_offer_returning.a'], isNull);
    expect(usage.skipped, ['viewer', 'viewer', 'viewer']);
  });
}
