import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'swarm_message_link.dart';

/// Opens a message's long-press sheet, with a light tap of the phone: Copy
/// link to message with its [link], which copies it and says so, and on the
/// reader's own message Edit message and Delete message: each closes the
/// sheet, then calls [onEdit] or [onDelete]. Reactions are gone (anh Dee,
/// 2026-11-09).
Future<void> showSwarmMessageActions(
  BuildContext context, {
  required SwarmMessageLink link,
  VoidCallback? onEdit,
  VoidCallback? onDelete,
}) async {
  HapticFeedback.lightImpact();
  await showModalBottomSheet<void>(
    context: context,
    backgroundColor: AppGlass.rowFill,
    shape: AppControl.sheetShape,
    builder: (context) =>
        _Actions(link: link, onEdit: onEdit, onDelete: onDelete),
  );
}

class _Actions extends StatelessWidget {
  const _Actions({required this.link, this.onEdit, this.onDelete});

  final SwarmMessageLink link;
  final VoidCallback? onEdit, onDelete;

  /// The sheet closed, then [act]: what it opens goes over the chat.
  void _then(BuildContext context, VoidCallback act) {
    Navigator.of(context).pop();
    act();
  }

  /// Desktop's Copy link to message: the link on the clipboard, the sheet
  /// closed, and "Link copied".
  Future<void> _copy(BuildContext context, SwarmMessageLink link) async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    Navigator.of(context).pop();
    await Clipboard.setData(ClipboardData(text: link.url));
    messenger?.showSnackBar(
      const SnackBar(content: Text('Link copied'), duration: Durations.long4),
    );
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpace.l,
          AppSpace.s,
          AppSpace.l,
          AppSpace.l,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // The grabber: a capsule as wide as the two largest steps.
            Container(
              width: AppSpace.xl + AppSpace.m,
              height: AppSpace.xs,
              margin: const EdgeInsets.only(bottom: AppSpace.m),
              decoration: ShapeDecoration(
                color: AppGlass.hair,
                shape: const StadiumBorder(),
              ),
            ),
            _Action(
              key: const ValueKey('swarm-copy-link'),
              icon: LucideIcons.link300,
              label: 'Copy link to message',
              onTap: () => _copy(context, link),
            ),
            if (onEdit case final edit?)
              _Action(
                key: const ValueKey('swarm-edit-message'),
                icon: LucideIcons.pencil300,
                label: 'Edit message',
                onTap: () => _then(context, edit),
              ),
            if (onDelete case final delete?)
              _Action(
                key: const ValueKey('swarm-delete-message'),
                icon: LucideIcons.trash2300,
                label: 'Delete message',
                // Destructive: the red tuned as ink on a surface.
                color: AppColors.danger,
                onTap: () => _then(context, delete),
              ),
          ],
        ),
      ),
    );
  }
}

/// One of the sheet's rows: its icon and words, a finger's height, the whole
/// width to tap.
class _Action extends StatelessWidget {
  const _Action({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
    this.color,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  /// Its ink; the primary text's when null.
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final ink = color ?? AppPalette.textPrimary;
    return SizedBox(
      width: double.infinity,
      child: Semantics(
        button: true,
        child: InkWell(
          borderRadius: BorderRadius.circular(AppControl.radius),
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: minTouchTarget),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpace.m,
                AppSpace.s,
                AppSpace.m,
                AppSpace.s,
              ),
              child: Row(
                children: [
                  Icon(icon, size: 20, color: ink),
                  const SizedBox(width: AppSpace.m),
                  Expanded(
                    child: Text(label, style: AppType.body(color: ink)),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
