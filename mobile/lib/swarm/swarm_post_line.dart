import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'swarm_message_row.dart' show swarmChatText;

/// A phone control's least height (design system, Phone: 44-point targets).
const _finger = 44.0;

/// The line under the person's post on its way, as Slack shows it (Dee,
/// 10-29): "Sending…", then — its answer lost — "Not sent · Retry · Delete". A post
/// that arrived carries no line.
class SwarmPostLine extends StatelessWidget {
  const SwarmPostLine({
    super.key,
    required this.sending,
    required this.onRetry,
    required this.onDelete,
  });

  final bool sending;
  final VoidCallback onRetry;

  /// Takes it away, Not sent: it may still have arrived, and then it shows when
  /// the chat is next read.
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final color = sending ? AppPalette.textFaint : tty.yellow;
    final style = swarmChatText(14, color: color);
    return Semantics(
      liveRegion: true,
      child: Row(
        children: [
          Icon(
            sending ? LucideIcons.loaderCircle : LucideIcons.triangleAlert,
            size: 16,
            color: color,
          ),
          const SizedBox(width: AppSpace.xs),
          Text(sending ? 'Sending…' : 'Not sent', style: style),
          if (!sending) ...[
            const SizedBox(width: AppSpace.xs),
            Text('·', style: style),
            _action(
              'Retry',
              const ValueKey('swarm-resend-post'),
              tty.blue,
              onRetry,
            ),
            Text('·', style: style),
            _action(
              'Delete',
              const ValueKey('swarm-delete-post'),
              tty.blue,
              onDelete,
            ),
          ],
        ],
      ),
    );
  }

  Widget _action(String label, Key key, Color color, VoidCallback onTap) =>
      Semantics(
        button: true,
        label: label,
        excludeSemantics: true,
        child: GestureDetector(
          key: key,
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minHeight: _finger,
              minWidth: _finger,
            ),
            child: Center(
              widthFactor: 1,
              // Even on both sides, and wide enough for a finger.
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
                child: Text(label, style: swarmChatText(14, color: color)),
              ),
            ),
          ),
        ),
      );
}
