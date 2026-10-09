import 'package:flutter/foundation.dart';

import '../core/dsh_catalog.dart';
import '../core/viewer_mode.dart';
import '../settings/experimental_features.dart';

/// App workspaces are bundled with Harness, not installed from the registry.
/// Devices is always listed on the desktop app; an experimental one follows the
/// current account's confirmed experiment.
enum ExperimentalStoreHarness {
  devices(
    null,
    DshEntry(
      id: 'autonomous/devices',
      name: 'Devices',
      engine: 'codex',
      author: 'Autonomous',
      category: 'Devices',
      description:
          'Manage your Harness devices and work with an agent beside them.',
      viewer: true,
    ),
  ),
  companions(
    ExperimentalFeature.focusBarCreature,
    DshEntry(
      id: 'autonomous/pair',
      name: 'Companions',
      engine: 'opencode',
      author: 'Autonomous',
      category: 'Companions',
      description: 'Meet your companions, grow your collection, and talk with your companion.',
      viewer: true,
    ),
  );

  const ExperimentalStoreHarness(this.feature, this.entry);

  /// The account experiment that gates this workspace, or null when it ships
  /// to everyone the platform allows.
  final ExperimentalFeature? feature;
  final DshEntry entry;

  bool enabled(ExperimentalFeaturesStore features) => switch (feature) {
    null => !kIsWeb && !kViewerMode,
    final feature =>
      feature.available &&
          features.isAvailable(feature) &&
          features.enabled(feature),
  };

  static ExperimentalStoreHarness? forId(String id) =>
      values.where((harness) => harness.entry.id == id).firstOrNull;
}

/// Also filters rows from older/custom daemons: a catalog row cannot bypass
/// an account opt-in, and a generated companion name is not the product name.
Iterable<DshEntry> storeVisibleHarnesses(
  Iterable<DshEntry> entries,
  ExperimentalFeaturesStore features,
) sync* {
  yield* entries.where(
    (entry) => ExperimentalStoreHarness.forId(entry.id) == null,
  );
  for (final harness in ExperimentalStoreHarness.values) {
    if (harness.enabled(features)) yield harness.entry;
  }
}
