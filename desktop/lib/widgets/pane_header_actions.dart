import 'dart:math' as math;

import 'package:flutter/widgets.dart';

/// Pane-local model selection and optional standalone terminal context.
/// The pane keeps its close target outside this group.
class PaneHeaderActions extends StatelessWidget {
  const PaneHeaderActions({
    super.key,
    this.details,
    this.trailing,
    this.modelPicker,
    this.agentPicker,
  });

  final Widget? details, trailing, modelPicker, agentPicker;

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
        if (agentPicker != null)
          ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: constraints.maxWidth.isFinite
                  ? math.min(
                      140,
                      details != null || trailing != null
                          ? constraints.maxWidth * .3
                          : math.max(
                              0,
                              constraints.maxWidth -
                                  (modelPicker != null ? 56 : 0),
                            ),
                    )
                  : 140,
            ),
            child: agentPicker!,
          ),
        if (modelPicker != null) ...[
          if (details != null || trailing != null) const SizedBox(width: 8),
          if (details != null || trailing != null)
            // Short model names leave room for the standalone pane's context.
            ConstrainedBox(
              constraints: BoxConstraints(
                maxWidth: constraints.maxWidth.isFinite
                    ? constraints.maxWidth * .4
                    : 232,
              ),
              child: modelPicker!,
            )
          else
            // The model uses the room left by the agent's natural width.
            Flexible(child: modelPicker!),
        ],
      ],
    ),
  );
}
