import 'package:flutter/material.dart';

import '../widgets/app_dialog.dart' show kSheetVeilOpacity;

/// What the profile sheet, the reaction picker, the row and the attachment
/// needed that no design-system role carries yet.
abstract final class SwarmTokensSetA {
  /// The page behind a bottom sheet: the app's sheet veil
  /// ([kSheetVeilOpacity]), as `showPhoneSheet` dims it, so a Swarm sheet and a
  /// terminal sheet stand on the same dimming.
  static final Color sheetBarrier = Colors.black.withValues(
    alpha: kSheetVeilOpacity,
  );
}
