import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/status_line_style.dart';
import '../shared/theme/workspace_bar_style.dart';
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';

/// Shares resolved text/color segments with the native macOS status bar.
class StatusLine extends StatelessWidget {
  const StatusLine({
    super.key,
    required this.parts,
    this.color = true,
    this.textAlign = TextAlign.right,
    this.nextBackground,
    this.segmentOffset = 0,
    this.workspaceBar = false,
    this.emphasized = false,
  });
  final StatusLineParts parts;
  final bool color;
  final TextAlign textAlign;

  /// Fill behind the final arrow to join a separately clickable next segment.
  final Color? nextBackground;
  final int segmentOffset;
  final bool workspaceBar;
  final bool emphasized;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    grid.AppTheme.watch(context);
    return ValueListenableBuilder(
      valueListenable: terminalThemeStore,
      builder: (context, _, _) {
        final theme = terminalThemeFor(
          grid.AppTheme.palette.value,
          terminalThemeStore.value,
        );
        final style = workspaceBar
            ? workspaceBarTextStyle(
                color: theme.foreground,
                emphasized: emphasized,
              )
            : terminalContentStyle(color: theme.foreground);
        final segments = statusLinePaintSegments(
          parts,
          theme,
          color: color,
          segmentOffset: segmentOffset,
        );
        if (!parts.style.segmented) {
          final text = Text.rich(
            TextSpan(
              children: [
                for (final segment in segments)
                  TextSpan(
                    text: segment.text,
                    style: TextStyle(color: segment.foreground),
                  ),
              ],
            ),
            style: style,
            maxLines: 1,
            softWrap: false,
            overflow: TextOverflow.ellipsis,
            textAlign: textAlign,
          );
          return workspaceBar
              ? SizedBox(
                  width: workspaceBarTextSizeOf(
                    context,
                    segments.map((s) => s.text).join(),
                  ).width,
                  child: text,
                )
              : text;
        }
        final cell = workspaceBar
            ? workspaceBarCellSizeOf(context)
            : terminalCellSizeOf(context);
        final scaler = MediaQuery.textScalerOf(context);
        return Semantics(
          label: parts.text,
          child: LayoutBuilder(
            builder: (context, constraints) {
              // Below one text cell per segment, show ordinary text rather than
              // spending all available room on arrows and padding.
              if (constraints.maxWidth < segments.length * cell.width * 4) {
                return ExcludeSemantics(
                  child: Text(
                    parts.text,
                    style: style,
                    maxLines: 1,
                    softWrap: false,
                    overflow: TextOverflow.ellipsis,
                    textAlign: textAlign,
                  ),
                );
              }
              final widths = [
                for (final segment in segments)
                  workspaceBar
                      ? workspaceBarTextSizeOf(context, segment.text).width
                      : _measure(segment.text, style, scaler),
              ];
              final natural =
                  widths.fold(0.0, (a, b) => a + b) +
                  segments.length * cell.width * 3;
              return Align(
                widthFactor: 1,
                alignment: textAlign == TextAlign.left
                    ? Alignment.centerLeft
                    : Alignment.centerRight,
                child: CustomPaint(
                  size: Size(
                    math.min(natural, constraints.maxWidth),
                    cell.height,
                  ),
                  painter: _StatusSegmentsPainter(
                    segments,
                    widths,
                    cell,
                    style,
                    scaler,
                    nextBackground,
                  ),
                ),
              );
            },
          ),
        );
      },
    );
  }
}

double _measure(String text, TextStyle style, TextScaler scaler) {
  final painter = TextPainter(
    text: TextSpan(text: text, style: style),
    textDirection: TextDirection.ltr,
    textScaler: scaler,
    maxLines: 1,
  )..layout();
  final width = painter.width;
  painter.dispose();
  return width;
}

/// Short values retain their width; the longest values share the remaining
/// space. Native AppKit uses the same cap when a segmented status is shortened.
List<double> fitStatusLineWidths(List<double> widths, double available) {
  if (widths.fold(0.0, (a, b) => a + b) <= available) return widths;
  var low = 0.0;
  var high = widths.fold(0.0, math.max);
  for (var i = 0; i < 24; i++) {
    final cap = (low + high) / 2;
    if (widths.fold(0.0, (sum, width) => sum + math.min(width, cap)) >
        available) {
      high = cap;
    } else {
      low = cap;
    }
  }
  return [for (final width in widths) math.min(width, low)];
}

class _StatusSegmentsPainter extends CustomPainter {
  const _StatusSegmentsPainter(
    this.segments,
    this.widths,
    this.cell,
    this.style,
    this.scaler,
    this.nextBackground,
  );
  final List<StatusLinePaintSegment> segments;
  final List<double> widths;
  final Size cell;
  final TextStyle style;
  final TextScaler scaler;
  final Color? nextBackground;

  @override
  void paint(Canvas canvas, Size size) {
    final fitted = fitStatusLineWidths(
      widths,
      math.max(0, size.width - segments.length * cell.width * 3),
    );
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    // Fill through the next click target's join, including subpixel rounding.
    if (nextBackground != null) {
      canvas.drawRect(Offset.zero & size, Paint()..color = nextBackground!);
    }
    var x = 0.0;
    for (var i = 0; i < segments.length; i++) {
      final segment = segments[i];
      final inset = cell.width * (i == 0 ? 1 : 2);
      final width = fitted[i] + inset + cell.width;
      if (i == segments.length - 1 && nextBackground != null) {
        canvas.drawRect(
          Rect.fromLTWH(x + width, 0, cell.width, cell.height),
          Paint()..color = nextBackground!,
        );
      }
      final shape = Path()
        ..moveTo(x, 0)
        ..lineTo(x + width, 0)
        ..lineTo(x + width + cell.width, cell.height / 2)
        ..lineTo(x + width, cell.height)
        ..lineTo(x, cell.height)
        ..lineTo(x + (i == 0 ? 0 : cell.width), cell.height / 2)
        ..close();
      canvas.drawPath(shape, Paint()..color = segment.background!);
      final painter = TextPainter(
        text: TextSpan(
          text: segment.text,
          style: style.copyWith(color: segment.foreground),
        ),
        textDirection: TextDirection.ltr,
        textScaler: scaler,
        maxLines: 1,
        ellipsis: '…',
      )..layout(maxWidth: fitted[i]);
      painter.paint(
        canvas,
        Offset(x + inset, (cell.height - painter.height) / 2),
      );
      painter.dispose();
      x += width;
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_StatusSegmentsPainter oldDelegate) =>
      segments != oldDelegate.segments ||
      widths != oldDelegate.widths ||
      cell != oldDelegate.cell ||
      style != oldDelegate.style ||
      scaler != oldDelegate.scaler ||
      nextBackground != oldDelegate.nextBackground;
}
