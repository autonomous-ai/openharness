import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/pull_request_icon.dart';
import '../shared/theme/status_line_style.dart';
import '../shared/theme/workspace_bar_style.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';

/// The state icon and number are one link, continuing the selected status
/// ribbon. The enclosing control supplies the full state and action.
class WorkspacePullRequestLabel extends StatelessWidget {
  const WorkspacePullRequestLabel({
    super.key,
    required this.number,
    required this.state,
    this.color = true,
    this.emphasized = false,
    this.style = StatusLineStyle.standard,
    this.segmentOffset = 0,
  });

  final int number;
  final String state;
  final bool color;
  final bool emphasized;
  final StatusLineStyle style;
  final int segmentOffset;

  static double widthOf(
    BuildContext context,
    int number, {
    StatusLineStyle style = StatusLineStyle.standard,
  }) =>
      MediaQuery.textScalerOf(context).scale(workspaceBarFontSize) +
      workspaceBarCellSizeOf(context).width * (style.segmented ? 4 : 1) +
      workspaceBarTextSizeOf(context, '#$number').width;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ValueListenableBuilder(
      valueListenable: terminalThemeStore,
      builder: (context, _, _) {
        final theme = terminalThemeFor(
          grid.AppTheme.palette.value,
          terminalThemeStore.value,
        );
        final iconSize = MediaQuery.textScalerOf(context)
            .scale(workspaceBarFontSize);
        final gap = workspaceBarCellSizeOf(context).width;
        final paint = statusLinePaintSegments(
          pullRequestStatusLineParts(
            number: number,
            state: state,
            style: style,
          ),
          theme,
          color: color,
          segmentOffset: segmentOffset,
        ).single;
        return Semantics(
          label: 'Pull request #$number: $state',
          child: ExcludeSemantics(
            child: LayoutBuilder(
              builder: (context, constraints) {
                final width = math.min(
                  widthOf(context, number, style: style),
                  constraints.maxWidth,
                );
                final ribbon = style.segmented && width >= gap * 4;
                final icon = SvgPicture.asset(
                  pullRequestIconAsset(state),
                  width: iconSize,
                  height: iconSize,
                  colorFilter: ColorFilter.mode(
                    ribbon
                        ? paint.foreground
                        : pullRequestIconColor(state, theme, color: color),
                    BlendMode.srcIn,
                  ),
                );
                Widget content(double available) => available < iconSize + gap
                    ? ClipRect(child: Center(child: icon))
                    : Row(
                        children: [
                          icon,
                          SizedBox(width: gap),
                          Expanded(
                            child: Text(
                              '#$number',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: workspaceBarTextStyle(
                                color: ribbon
                                    ? paint.foreground
                                    : theme.foreground,
                                emphasized: emphasized,
                              ),
                            ),
                          ),
                        ],
                      );
                return SizedBox(
                  width: width,
                  height: workspaceBarControlHeight(context),
                  child: ribbon
                      ? Center(
                          child: CustomPaint(
                            painter: _PullRequestRibbonPainter(
                              paint.background!,
                              gap,
                              style,
                              roundedStart: segmentOffset == 0,
                            ),
                            child: SizedBox(
                              height: workspaceBarCellSizeOf(context).height,
                              child: Padding(
                                padding: EdgeInsets.only(
                                  left: gap,
                                  right: gap * 2,
                                ),
                                child: content(width - gap * 3),
                              ),
                            ),
                          ),
                        )
                      : content(width),
                );
              },
            ),
          ),
        );
      },
    );
  }
}

/// The final segment uses the same flat join and outside cap as StatusLine.
class _PullRequestRibbonPainter extends CustomPainter {
  const _PullRequestRibbonPainter(
    this.color,
    this.cell,
    this.style, {
    required this.roundedStart,
  });
  final Color color;
  final double cell;
  final StatusLineStyle style;
  final bool roundedStart;

  @override
  void paint(Canvas canvas, Size size) {
    final end = size.width - cell, h = size.height;
    final roundStart = roundedStart && style.roundedStart;
    final path = Path()
      ..moveTo(roundStart ? cell : 0, 0)
      ..lineTo(end, 0);
    if (style.roundedSeparators || style.roundedEnd) {
      path.cubicTo(
        end + cell * .55,
        0,
        end + cell,
        h * .225,
        end + cell,
        h / 2,
      );
      path.cubicTo(end + cell, h * .775, end + cell * .55, h, end, h);
    } else {
      path
        ..lineTo(end + cell, h / 2)
        ..lineTo(end, h);
    }
    path.lineTo(roundStart ? cell : 0, h);
    if (roundStart) {
      path.cubicTo(cell * .45, h, 0, h * .775, 0, h / 2);
      path.cubicTo(0, h * .225, cell * .45, 0, cell, 0);
    }
    path.close();
    canvas.drawPath(path, Paint()..color = color);
  }

  @override
  bool shouldRepaint(_PullRequestRibbonPainter old) =>
      color != old.color ||
      cell != old.cell ||
      style != old.style ||
      roundedStart != old.roundedStart;
}
