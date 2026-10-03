import 'package:flutter/widgets.dart';

/// Narrower than this a browser is laid out for a phone: a tab switcher for
/// the tab row, one harness at a time for the grid. Covers a phone in either
/// orientation, or a slim window beside another.
const double kWebCompactBelow = 720;

/// Whether this browser window gets the phone layout.
bool isWebCompact(BuildContext context) =>
    MediaQuery.sizeOf(context).width < kWebCompactBelow;
