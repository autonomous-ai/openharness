import 'package:flutter/material.dart';

import '../shared/theme/workspace_bar_style.dart';
import '../state/harness_monitor.dart';
import 'workspace_bar_control.dart';

/// Every resource opens the same monitor. Hide whole groups at narrow widths.
class WorkspaceHarnessResources extends StatelessWidget {
  const WorkspaceHarnessResources({
    super.key,
    required this.monitor,
    this.onPressed,
    this.trailingPadding,
  });
  final HarnessMonitor monitor;
  final VoidCallback? onPressed;
  final double? trailingPadding;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: monitor,
    builder: (context, _) => LayoutBuilder(
      builder: (context, constraints) {
        final summary = monitor.summary;
        final cell = workspaceBarCellSizeOf(context).width;
        final padding = EdgeInsets.only(
          left: cell,
          right: trailingPadding ?? cell,
        );
        var label = summary.metricsLabel(
          ram: false,
          gpu: false,
          storage: false,
        );
        for (final candidate in [
          summary.metricsLabel(),
          summary.metricsLabel(storage: false),
          summary.metricsLabel(gpu: false, storage: false),
        ]) {
          if (workspaceBarTextSizeOf(context, candidate, grouped: true).width +
                  padding.horizontal <=
              constraints.maxWidth) {
            label = candidate;
            break;
          }
        }
        return WorkspaceBarControl(
          label: summary.resourceDetail,
          tooltip: summary.resourceDetail,
          onPressed: onPressed,
          builder: (context, emphasized) => Padding(
            padding: padding,
            child: SizedBox(
              height: workspaceBarControlHeight(context),
              child: Center(
                widthFactor: 1,
                child: Text.rich(
                  workspaceBarGroupTextSpan(label, cellWidth: cell),
                  maxLines: 1,
                  overflow: TextOverflow.clip,
                  style: workspaceBarTextStyle(emphasized: emphasized),
                ),
              ),
            ),
          ),
        );
      },
    ),
  );
}
