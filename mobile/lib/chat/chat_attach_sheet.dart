import 'package:flutter/material.dart';

import 'package:harness_mobile/phone/agent_model_rows.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/terminal/terminal_look.dart';

/// One way to attach something: its icon, its name, and a quieter line under it.
typedef ChatAttachOption = ({
  IconData icon,
  String title,
  String? detail,
  VoidCallback onTap,
});

/// Chat UI's `+`: the ways to send the agent a picture or a file, on one rounded card — the same
/// card the model sheet groups its choices on ([ModelCard]).
Future<void> showChatAttachSheet(
  BuildContext context,
  List<ChatAttachOption> options,
) => showModalBottomSheet<void>(
  // The app's sheet even over a terminal's page — see [TerminalLook.outside].
  context: TerminalLook.outside(context),
  useRootNavigator: true,
  showDragHandle: true,
  backgroundColor: AppPalette.panelBg,
  builder: (sheetContext) => SafeArea(
    child: Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: ModelCard(
        children: [
          for (final option in options)
            _AttachRow(
              option: option,
              // Close first, then open the picker: the system's own sheet must not come up under
              // this one while it is still animating out.
              onTap: () {
                Navigator.of(sheetContext).pop();
                option.onTap();
              },
            ),
        ],
      ),
    ),
  ),
);

class _AttachRow extends StatelessWidget {
  const _AttachRow({required this.option, required this.onTap});

  final ChatAttachOption option;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final detail = option.detail;
    return InkWell(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: minTouchTarget + 8),
        padding: const EdgeInsets.symmetric(
          horizontal: kModelRowInset,
          vertical: 12,
        ),
        child: Row(
          children: [
            Icon(option.icon, size: 20, color: AppPalette.textSecondary),
            const SizedBox(width: 18),
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    option.title,
                    style: TextStyle(
                      color: AppPalette.textPrimary,
                      fontSize: 16,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  if (detail != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        detail,
                        style: TextStyle(
                          color: AppPalette.textSecondary,
                          fontSize: 13.5,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
