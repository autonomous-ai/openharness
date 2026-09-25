import 'package:flutter/material.dart';

import '../shared/theme/status_line_style.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../shared/theme/workspace_bar_style.dart';
import 'status_line.dart';
import 'workspace_bar_control.dart';

typedef StatusLineLink = ({String label, VoidCallback? onPressed});

/// Fields retain individual click targets even when a long branch is shortened.
class WorkspaceStatusLine extends StatelessWidget {
  const WorkspaceStatusLine({
    super.key,
    required this.parts,
    required this.links,
    required this.color,
    this.nextBackground,
  });
  final StatusLineParts parts;
  final Map<StatusLineField, StatusLineLink> links;
  final bool color;
  final Color? nextBackground;

  @override
  Widget build(BuildContext context) {
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    final cell = workspaceBarCellSizeOf(context);
    final height = workspaceBarControlHeight(context);
    final components = parts.components;
    final widths = [
      for (final component in components)
        component.parts.segments.fold(
              0.0,
              (width, segment) =>
                  width + workspaceBarTextSizeOf(context, segment.text).width,
            ) +
            (parts.style.segmented
                ? component.parts.segments.length * cell.width * 3
                : 0),
    ];
    return LayoutBuilder(
      builder: (context, constraints) {
        final fitted = fitStatusLineWidths(widths, constraints.maxWidth);
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var i = 0; i < components.length; i++)
              (() {
                final component = components[i];
                final link = links[component.field];
                Widget body(BuildContext context, bool emphasized) => SizedBox(
                  width: fitted[i],
                  height: height,
                  child: Center(
                    child: StatusLine(
                      parts: component.parts,
                      color: color,
                      workspaceBar: true,
                      emphasized: emphasized,
                      textAlign: TextAlign.left,
                      segmentOffset: component.offset,
                      nextBackground: i == components.length - 1
                          ? nextBackground
                          : statusLinePaintSegments(
                              components[i + 1].parts,
                              theme,
                              color: color,
                              segmentOffset: components[i + 1].offset,
                            ).firstOrNull?.background,
                    ),
                  ),
                );
                return link == null
                    ? body(context, false)
                    : WorkspaceBarControl(
                        key: ValueKey(
                          'workspace-context-${component.field!.name}',
                        ),
                        label: link.label,
                        tooltip: link.label,
                        onPressed: link.onPressed,
                        builder: body,
                      );
              })(),
          ],
        );
      },
    );
  }
}
