import '../shared/theme/app_icons.dart';

/// Agent actions use + to create and ↗ to open. Search fields keep their lens.
/// The native menu/titlebar match these with `plus` and `arrow.up.right`.
abstract final class AgentActionIcons {
  static const create = AppIcons.plus;
  static const open = AppIcons.arrowUpRight;
}
