import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import '../state/workspace_chrome.dart';

/// The smallest target a finger can hit, both ways (audit finding S1).
const double kFingerTarget = 44;

/// [child] grown to at least [kFingerTarget] each way when [enabled] (a
/// phone), its content centered; otherwise [child] as it is.
Widget fingerTarget(Widget child, {required bool enabled}) => enabled
    ? ConstrainedBox(
        constraints: const BoxConstraints(
          minWidth: kFingerTarget,
          minHeight: kFingerTarget,
        ),
        child: child,
      )
    : child;

/// A row [height] tall, or tall enough for a finger when [enabled].
double fingerHeight(double height, {required bool enabled}) =>
    enabled ? math.max(height, kFingerTarget) : height;

/// Whether the workspace around [context] is laid out for a phone: narrower
/// than its host's [WorkspaceChrome.compactBelow]. Never on Desktop, which
/// sets none.
bool workspaceIsCompact(BuildContext context) =>
    MediaQuery.sizeOf(context).width < WorkspaceChrome.of(context).compactBelow;
