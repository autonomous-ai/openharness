import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/welcome/phone_welcome.dart';
import 'package:harness_mobile/swarm/parts.dart';

import '../phone_edge/edge_fixture.dart';
import 'swarm_fixture.dart';

/// A phone that starts signed out (its session ended while the app was not
/// running) keeps nothing of the last Swarm Home: the signed-out screen lets
/// it go, view and key, before anyone signs in again.
void main() {
  testWidgets('the signed-out screen lets the Home kept go', (tester) async {
    final home = memoryHomeCache();
    await tester.runAsync(
      () => home.write('person-me', [
        (
          id: 'a',
          name: 'Swarm a',
          view: (
            state: SuperTabParts.firstLoad(firstLoad(tabId: 'a')).state,
            partners: const <String, String>{},
          ),
        ),
      ]),
    );
    setPhone(tester, largePhone);
    final app = edgeApp(noMachines: true);

    // On the real clock: the clear the screen starts is real file work.
    await tester.runAsync(() async {
      await tester.pumpWidget(
        phoneApp(PhoneWelcome(notifier: app, swarmHome: home)),
      );
      await home.read('person-me');
    });

    expect(home.file.existsSync(), isFalse);
    expect((home.key as MemorySwarmHomeKey).value, isNull);

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 3));
    app.dispose();
    await tester.pump(const Duration(seconds: 30));
  });
}
