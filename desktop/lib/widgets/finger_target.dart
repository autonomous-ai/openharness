import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import '../shared/theme/app_icons.dart';
import '../state/workspace_chrome.dart';

/// The smallest target a finger can hit, both ways (audit finding S1).
const double kFingerTarget = 44;

/// What the phone's top bar draws in each of its icon squares: one size, the
/// avatar's circle too (Huy, 2026-11-02).
const double kPhoneBarIcon = 20;

/// How far the phone's top bar keeps what it draws from the screen's edges.
const double kPhoneBarGutter = 16;

/// A row under the phone's top bar with its own finger-wide icons at each end,
/// so that they line up with it: the first icon starts at [kPhoneBarGutter], where
/// the bar's text does, and the last is centred under the bar's last icon.
const EdgeInsets kPhoneBarRowPadding = EdgeInsets.fromLTRB(
  kPhoneBarGutter - (kFingerTarget - AppIcons.inlineSize) / 2,
  6,
  kPhoneBarGutter + (kPhoneBarIcon - kFingerTarget) / 2,
  6,
);

/// One icon of the phone's top bar: exactly a finger's square, whatever the
/// terminal font's cell, so the icons sit side by side at an even spacing.
Widget phoneBarCell(Widget child) =>
    SizedBox.square(dimension: kFingerTarget, child: child);

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
