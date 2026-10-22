import 'dart:async';

import 'product_measurement.dart';

/// The phone's dials as the desktop counts them (`desktop/lib/measurement/product_connections.dart`):
/// `connect_user` for one the person asked for ("Try again"), `connect_auto` for every other — the
/// launch's, a dropped socket coming back. Beside `remote_connect`, which still counts every dial
/// as before, so its figures carry on unbroken.
///
/// Connection keys stay in these bounded RAM maps and never reach a counter. Why a dial failed is
/// told by its outcome alone — `failed` when the phone knows (the computer is locked or offline),
/// `unknown` when it does not: the reasons' own counters (`connect_error_*`) are the desktop's
/// health vocabulary, which the backend does not take from a phone yet.
class ProductConnections {
  ProductConnections(
    this.measurement, {
    this.manualDeadline = const Duration(seconds: 12),
  }) {
    measurement.addListener(_choiceChanged);
  }

  final ProductMeasurement measurement;

  /// How long an asked-for dial may take before it counts as failed — the desktop's Connect timeout.
  final Duration manualDeadline;

  final _pending = <String, void Function(ProductOutcome)>{};
  final _manual =
      <String, ({void Function(ProductOutcome) finish, Timer deadline})>{};
  int _generation = -1;

  void _choiceChanged() {
    if (!measurement.sharing ||
        _generation != measurement.observationGeneration) {
      clear();
    }
    _generation = measurement.observationGeneration;
  }

  /// The person asked to reach [key] again. [connected]: it already is, so the ask is answered.
  /// Otherwise it ends with the first status that settles it ([status]), or fails at
  /// [manualDeadline]. A dial already under way for [key] is the person's from here.
  void manual(String key, {bool connected = false}) {
    _choiceChanged();
    if (!measurement.sharing) return;
    if (_manual.length >= 64 && !_manual.containsKey(key)) return;
    _pending.remove(key)?.call(ProductOutcome.cancelled);
    _endManual(key, ProductOutcome.cancelled);
    final finish = measurement.begin(ProductFlow.connectUser);
    if (connected) return finish(ProductOutcome.ok);
    late final Timer deadline;
    deadline = Timer(manualDeadline, () {
      if (_manual[key]?.deadline == deadline) {
        _endManual(key, ProductOutcome.failed);
      }
    });
    _manual[key] = (finish: finish, deadline: deadline);
  }

  /// [key]'s socket moved: [connecting] (a re-dial included), [connected], or neither — dropped.
  /// [failed]: the phone knows why it is not up (locked, offline).
  void status(
    String key, {
    required bool connecting,
    required bool connected,
    bool failed = false,
  }) {
    _choiceChanged();
    if (!measurement.sharing) return;
    if (_manual.containsKey(key)) {
      // Asked for: up is the answer, down is a failed ask. A socket backing off between dials is
      // still on its way, until the deadline says otherwise.
      if (connected) {
        _endManual(key, ProductOutcome.ok);
      } else if (!connecting) {
        _endManual(key, ProductOutcome.failed);
      }
      return;
    }
    if (connecting) {
      if (_pending.length >= 64 && !_pending.containsKey(key)) return;
      _pending.putIfAbsent(
        key,
        () => measurement.begin(ProductFlow.connectAuto),
      );
      return;
    }
    _pending
        .remove(key)
        ?.call(
          connected
              ? ProductOutcome.ok
              : failed
              ? ProductOutcome.failed
              : ProductOutcome.unknown,
        );
  }

  void _endManual(String key, ProductOutcome outcome) {
    final entry = _manual.remove(key);
    if (entry == null) return;
    entry.deadline.cancel();
    entry.finish(outcome);
  }

  /// The app went to the background with these dials open: each ends `cancelled`, as `remote_connect`'s do —
  /// the phone left before the socket answered, and a suspended app may never hear it. Both kinds end, and
  /// an asked-for dial's [manualDeadline] goes with it, so nothing is counted `failed` later. They leave the
  /// maps as they end: the socket's own answer finds none to end again, and a dial once the app is back is
  /// a new count.
  void cancelOpen() {
    final asked = _manual.values.toList();
    final own = _pending.values.toList();
    _manual.clear();
    _pending.clear();
    for (final entry in asked) {
      entry.deadline.cancel();
      entry.finish(ProductOutcome.cancelled);
    }
    for (final finish in own) {
      finish(ProductOutcome.cancelled);
    }
  }

  /// Drops every open observation uncounted: a sign-out, another account, a sharing change.
  void clear() {
    _pending.clear();
    for (final entry in _manual.values) {
      entry.deadline.cancel();
    }
    _manual.clear();
  }

  void dispose() {
    measurement.removeListener(_choiceChanged);
    clear();
  }
}
