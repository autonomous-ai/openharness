import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../theme/app_theme.dart';

/// The pane header's transport badge: a compact topology for the path carrying terminal bytes.
///
/// The three shapes describe one hop, an intermediate hop, and a central server respectively. That
/// makes the modes distinguishable without colour while keeping the badge small enough for a four-pane
/// layout. The wire name `relay` still means the backend WebSocket; only its human-facing label is WS.
class LinkModeMark extends StatelessWidget {
  final String mode;

  const LinkModeMark({super.key, required this.mode});

  @override
  Widget build(BuildContext context) {
    final (icon, color, label) = switch (mode) {
      'p2p' => (
        LucideIcons.link2,
        AppColors.success,
        'P2P · Direct peer connection',
      ),
      'turn' => (
        LucideIcons.waypoints,
        AppColors.warning,
        'TURN · Via Cloudflare relay',
      ),
      _ => (
        LucideIcons.server,
        AppColors.mutedStrong,
        'WS · Via Harness WebSocket relay',
      ),
    };
    return Tooltip(
      message: label,
      child: Icon(icon, size: 14, color: color, semanticLabel: label),
    );
  }
}

/// Image/file transfer progress with a cancel action, kept in the pane's corner.
class TransferProgressBadge extends StatelessWidget {
  final String label;
  final double? fraction;
  final VoidCallback onCancel;
  const TransferProgressBadge({
    super.key,
    required this.label,
    required this.fraction,
    required this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final percentLabel = fraction == null
        ? ''
        : ' · ${(fraction! * 100).round()}%';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: grid.AppPalette.panelBg.withValues(alpha: 0.93),
        border: Border.all(color: AppColors.borderStrong),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '$label$percentLabel',
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: AppColors.textSoft,
                    fontFamily: AppFonts.sans,
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              InkWell(
                onTap: onCancel,
                child: Text(
                  'CANCEL',
                  style: TextStyle(
                    color: AppColors.textSoft,
                    fontFamily: AppFonts.sans,
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: LinearProgressIndicator(
              minHeight: 4,
              value: fraction,
              backgroundColor: AppColors.border,
              color: AppColors.accent,
            ),
          ),
        ],
      ),
    );
  }
}

/// The whole tile, carried under the cursor.
///
/// ⚠️ THIS IS DRAWN, NOT PHOTOGRAPHED, AND THE PHOTOGRAPH IS WHY. The obvious
/// way to carry "the whole pane" is RepaintBoundary.toImage() on press — and it
/// FROZE THE APP. That call is a GPU readback on the raster thread, and the
/// raster thread in this app is never idle: every pane holds a terminal that
/// repaints on its own, so asking it to stop and hand a surface back on every
/// pointer-down deadlocked the window. It is not a tuning problem; there is
/// nothing to tune down to.
///
/// So the ghost is built from what is already known — the pane's measured size
/// and its own header — and the body is a plain surface rather than a copy of
/// the scrollback. It reads as the tile because it is tile-SHAPED and carries
/// the tile's name, which is what the eye is following.
///
/// See-through on purpose: a full-size opaque copy sits exactly over the tile
/// being aimed at and hides the "Swap with this pane" highlight that says the
/// drop will land.
