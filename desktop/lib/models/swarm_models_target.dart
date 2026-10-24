import 'package:flutter/foundation.dart';

import '../state/app_state.dart';

/// Models shared with the person on someone else's grid, and offering them to a Swarm. Hidden for now (owner,
/// 2026-10-23); the code stays, and turning this on brings it back everywhere it was.
const swarmSharedWithYouShown = false;

/// The Models picker opened for a Swarm's Local models (docs/plans/2026-10-23-swarm-local-models.md): the same
/// sections as ⌘I's Models, less Subscriptions, whose actions put a model on the Swarm's grid instead of starting a
/// harness on it. A model of this computer's runs for the Swarm; a saved API is shared with it, on this computer's key;
/// a model shared with the person is usable by agents on their machines and needs nothing done.
class SwarmModelsTarget extends ChangeNotifier {
  SwarmModelsTarget({
    required this.app,
    required this.grid,
    required this.machineId,
  });

  final AppNotifier app;

  /// The Swarm's grid.
  final String grid;

  /// This computer: the APIs are its own saved ones, and only it shares them.
  final String machineId;

  /// The APIs this computer shares with the Swarm, by `connectionId` and model.
  Set<String> shares = {};

  /// The models shared with this person that this computer offers to the Swarm, by their grid and model.
  Set<String> offers = {};

  bool offered(String sharedGrid, String model) =>
      offers.contains(shareKey(sharedGrid, model));
  String? error;
  bool _disposed = false;

  static String shareKey(String connectionId, String model) =>
      '$connectionId\u0000$model';

  bool shared(String connectionId, String model) =>
      shares.contains(shareKey(connectionId, model));

  Future<void> refresh() async {
    try {
      final answer = await app.swarmOffers(machineId, grid);
      offers = _keys(answer['offers'], 'sharedGrid');
    } catch (_) {
      // Unknown, not "none": keep what was last read.
    }
    try {
      final answer = await app.swarmApiShares(machineId, grid);
      shares = {
        for (final row
            in answer['shares'] is List ? answer['shares'] as List : const [])
          if (row is Map &&
              row['connectionId'] is String &&
              row['model'] is String)
            shareKey(row['connectionId'] as String, row['model'] as String),
      };
    } catch (_) {
      // Unknown, not "none": keep what was last read.
    }
    if (!_disposed) notifyListeners();
  }

  static Set<String> _keys(Object? rows, String first) => {
    for (final row in rows is List ? rows : const [])
      if (row is Map && row[first] is String && row['model'] is String)
        shareKey(row[first] as String, row['model'] as String),
  };

  /// Offers [model], shared with this person on [sharedGrid], to the Swarm, or stops. Returns why it could not, or null.
  Future<String?> offer(
    String sharedGrid,
    String model, {
    required bool start,
  }) async {
    error = null;
    try {
      final answer = await app.swarmOffer(
        machineId,
        grid: grid,
        sharedGrid: sharedGrid,
        model: model,
        start: start,
      );
      error = answer['error'] as String?;
    } catch (_) {
      error = 'This computer could not be reached. Try again.';
    }
    await refresh();
    return error;
  }

  /// Shares, or stops sharing, [model] of the saved API [connectionId]. Returns why it could not, or null.
  Future<String?> share(
    String connectionId,
    String model, {
    required bool start,
  }) async {
    error = null;
    try {
      final answer = await app.swarmApiShare(
        machineId,
        grid: grid,
        connectionId: connectionId,
        model: model,
        start: start,
      );
      error = answer['error'] as String?;
    } catch (_) {
      error = 'This computer could not be reached. Try again.';
    }
    await refresh();
    return error;
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
