import 'package:flutter/widgets.dart';

/// Pane-local model selection and optional standalone terminal context.
/// Closing, zooming, and stopping remain keyboard/menu commands.
class PaneHeaderActions extends StatelessWidget {
  const PaneHeaderActions({
    super.key,
    this.details,
    this.trailing,
    this.modelPicker,
  });

  final Widget? details, trailing, modelPicker;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) => Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (details != null || trailing != null)
          Flexible(
            child: Row(
              key: const ValueKey('pane-header-details'),
              mainAxisSize: MainAxisSize.min,
              children: [
                if (details != null) Flexible(child: details!),
                if (details != null && trailing != null)
                  const SizedBox(width: 8),
                if (trailing != null) Flexible(child: trailing!),
              ],
            ),
          ),
        if (modelPicker != null) ...[
          if (details != null || trailing != null) const SizedBox(width: 8),
          // Let a short model use only its natural width, leaving the remaining
          // space for context. Cap it when context shares a narrow header.
          ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: constraints.maxWidth.isFinite
                  ? constraints.maxWidth *
                        (details != null || trailing != null ? .4 : 1)
                  : 232,
            ),
            child: modelPicker!,
          ),
        ],
      ],
    ),
  );
}
