import 'package:flutter/material.dart';

import '../shared/theme/workspace_bar_style.dart';
import '../state/machine_resource_monitor.dart';

/// Reduce complete metric groups at tight widths; never cut a percentage in half.
class WorkspaceMachineResources extends StatelessWidget {
  const WorkspaceMachineResources({super.key, required this.monitor});
  final MachineResourceMonitor monitor;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: monitor,
    builder: (context, _) => LayoutBuilder(
      builder: (context, constraints) {
        final cell = workspaceBarCellSizeOf(context).width;
        var label = monitor.metricsLabel(ram: false, gpu: false);
        for (final candidate in [
          monitor.metricsLabel(),
          monitor.metricsLabel(gpu: false),
        ]) {
          if (workspaceBarTextSizeOf(context, candidate, grouped: true).width +
                  cell * 2 <=
              constraints.maxWidth) {
            label = candidate;
            break;
          }
        }
        return Tooltip(
          message: monitor.detail,
          excludeFromSemantics: true,
          waitDuration: const Duration(milliseconds: 500),
          child: Semantics(
            label: monitor.detail,
            excludeSemantics: true,
            child: Padding(
              padding: EdgeInsets.symmetric(horizontal: cell),
              child: SizedBox(
                height: workspaceBarControlHeight(context),
                child: Center(
                  widthFactor: 1,
                  child: Text.rich(
                    workspaceBarGroupTextSpan(label, cellWidth: cell),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: workspaceBarTextStyle(),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    ),
  );
}
