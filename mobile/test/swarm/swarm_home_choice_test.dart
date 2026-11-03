import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_home_root.dart';

import '../voice_fakes.dart';

/// What the root of the phone's stack shows: Swarm Home while Swarm is on,
/// until the person goes to Harness; the terminal while it is off.
void main() {
  ExperimentalFeaturesStore features({bool on = true}) =>
      ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {if (on) PhoneExperiment.swarm};

  test('Swarm on: Swarm Home, until Harness is asked for', () {
    final choice = SwarmHomeChoice(features());
    addTearDown(choice.dispose);
    expect(choice.swarm, isTrue);
    expect(choice.harnessOverSwarm, isFalse);

    var told = 0;
    choice.addListener(() => told++);
    choice.showHarness();
    expect(choice.swarm, isFalse);
    expect(choice.harnessOverSwarm, isTrue);
    choice.showHarness();
    expect(told, 1, reason: 'asked twice, changed once');

    choice.showSwarm();
    expect(choice.swarm, isTrue);
    expect(told, 2);
  });

  test('Swarm off: the terminal, whatever was asked for', () {
    final choice = SwarmHomeChoice(features(on: false));
    addTearDown(choice.dispose);
    expect(choice.swarm, isFalse);
    expect(choice.harnessOverSwarm, isFalse);

    choice.showSwarm();
    expect(choice.swarm, isFalse);
  });

  test('turned off, the terminal; turned on again, Swarm Home', () {
    final store = features();
    final choice = SwarmHomeChoice(store);
    addTearDown(choice.dispose);
    choice.showHarness();
    var told = 0;
    choice.addListener(() => told++);

    store.value = const {};
    expect(choice.swarm, isFalse);
    expect(choice.harnessOverSwarm, isFalse);
    store.value = {PhoneExperiment.swarm};
    expect(choice.swarm, isTrue, reason: 'Swarm Home is Home again');
    expect(told, 2);
  });

  test('stops listening to the switch once disposed', () {
    final store = features();
    SwarmHomeChoice(store).dispose();
    // ignore: invalid_use_of_protected_member
    expect(store.hasListeners, isFalse);
  });
}
