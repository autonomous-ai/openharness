import 'codex_profiles.dart';
import 'models.dart';
import 'permission_modes.dart';

/// Management tools are never a person's next coding setup or working project.
bool isInternalLaunchHarness(String? id) => const {
  'autonomous/harness-monitor',
  'autonomous/machine-monitor',
  'autonomous/autonomous-grid',
}.contains(id);

/// Discard generated management folders left in project history by older apps.
/// A user repository simply named "harness-monitor" remains an ordinary project.
bool isInternalLaunchFolder(String folder) => RegExp(
  r'(?:^|/)(?:harness-monitor|machine-monitor|autonomous-grid)-\d{4}-\d{2}-\d{2}(?:-|$)',
).hasMatch(folder);

/// One confirmed user launch. Model routes and account references stay paired
/// with their agent; an account path only applies on the machine that owns it.
/// Task text, files, branches and temporary worktree folders are not preferences.
class LaunchSetup {
  const LaunchSetup({
    required this.engine,
    this.harnessId,
    this.permissionMode = kDefaultPermissionMode,
    this.model,
    this.profile,
    this.profileMachineId,
  });

  final String engine;
  final String? harnessId;
  final String permissionMode;
  final GridModel? model;
  final LocalCodexProfile? profile;
  final String? profileMachineId;

  Map<String, dynamic> toJson() => {
    'engine': engine,
    if (harnessId != null) 'harness': harnessId,
    'permissionMode': permissionMode,
    if (model case final value?)
      'model': {'id': value.id, 'node': value.node, 'grid': value.grid},
    if (profile case final value?)
      'profile': {
        'path': value.path,
        'label': value.label,
        'machineId': profileMachineId,
      },
  };

  static LaunchSetup? fromJson(Object? raw) {
    if (raw is! Map || raw['engine'] is! String) return null;
    final engine = raw['engine'] as String;
    final harness = raw['harness'] is String ? raw['harness'] as String : null;
    if (engine.isEmpty ||
        engine.contains('/') ||
        engine == 'terminal' ||
        isInternalLaunchHarness(harness)) {
      return null;
    }
    final mode = raw['permissionMode'];
    final model = raw['model'];
    final profile = raw['profile'];
    return LaunchSetup(
      engine: engine,
      harnessId: harness,
      permissionMode: permissionModesOf(engine).any((item) => item.id == mode)
          ? mode as String
          : kDefaultPermissionMode,
      model:
          model is Map &&
              model['id'] is String &&
              (model['id'] as String).isNotEmpty
          ? GridModel(
              id: model['id'] as String,
              node: model['node'] is String ? model['node'] as String : '',
              grid: model['grid'] is String ? model['grid'] as String : null,
            )
          : null,
      profile:
          engine == 'codex' &&
              profile is Map &&
              profile['path'] is String &&
              profile['machineId'] is String
          ? LocalCodexProfile(
              profile['path'] as String,
              profile['label'] is String
                  ? profile['label'] as String
                  : 'Profile',
            )
          : null,
      profileMachineId: profile is Map && profile['machineId'] is String
          ? profile['machineId'] as String
          : null,
    );
  }
}
