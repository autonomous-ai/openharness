import 'desktop_updater.dart';

/// Result of a user-initiated check. A manually checked version remains
/// installable even when the user skipped its background notification earlier.
class ManualUpdateCheck {
  final DesktopUpdateCheck check;
  final bool isSkipped;

  const ManualUpdateCheck({required this.check, this.isSkipped = false});

  UpdateInfo? get update => check.update;
  DesktopUpdateCheckStatus get status => check.status;
  bool get isUpToDate => status == DesktopUpdateCheckStatus.upToDate;
}
