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
        final cell = workspaceBar
            ? workspaceBarCellSizeOf(context)
            : terminalCellSizeOf(context);
        final scaler = MediaQuery.textScalerOf(context);
        if (!parts.style.segmented) {
          final text = Text.rich(
            TextSpan(
              children: [
                for (final segment in segments) ...[
                  if (segment.branchSymbol)
                    WidgetSpan(
                      alignment: PlaceholderAlignment.middle,
                      child: ExcludeSemantics(
                        child: CustomPaint(
                          size: Size(cell.width * 2, cell.height * .7),
                          painter: _BranchSymbolPainter(segment.foreground),
                        ),
                      ),
                    ),
                  TextSpan(
                    text: segment.text,
                    style: TextStyle(color: segment.foreground),
                  ),
                ],
              ],
            ),
            semanticsLabel: parts.text,
            style: style,
            maxLines: 1,
            softWrap: false,
            overflow: TextOverflow.ellipsis,
            textAlign: textAlign,
          );
          return workspaceBar
              ? SizedBox(
                  width:
                      workspaceBarTextSizeOf(
                        context,
                        segments.map((s) => s.text).join(),
                      ).width +
                      segments.where((s) => s.branchSymbol).length *
                          cell.width *
                          2,
                  child: text,
                )
              : text;
        }
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
                  (workspaceBar
                          ? workspaceBarTextSizeOf(context, segment.text).width
                          : _measure(segment.text, style, scaler)) +
                      (segment.branchSymbol ? cell.width * 2 : 0),
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
                    parts.style,
                    segmentOffset,
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
    this.format,
    this.segmentOffset,
  );
  final List<StatusLinePaintSegment> segments;
  final List<double> widths;
  final Size cell;
  final TextStyle style;
  final TextScaler scaler;
  final Color? nextBackground;
  final StatusLineStyle format;
  final int segmentOffset;

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
      canvas.drawRect(
        Rect.fromLTWH(size.width - cell.width, 0, cell.width, cell.height),
        Paint()..color = nextBackground!,
      );
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
      final roundStart = format.roundedStart && segmentOffset == 0 && i == 0;
      final roundRight =
          format.roundedSeparators ||
          (format.roundedEnd &&
              i == segments.length - 1 &&
              nextBackground == null);
      final h = cell.height;
      final c = cell.width;
      final end = x + width;
      final shape = Path()
        ..moveTo(x + (roundStart ? c : 0), 0)
        ..lineTo(end, 0);
      if (roundRight) {
        shape.cubicTo(end + c * .55, 0, end + c, h * .225, end + c, h / 2);
        shape.cubicTo(end + c, h * .775, end + c * .55, h, end, h);
      } else {
        shape
          ..lineTo(end + c, h / 2)
          ..lineTo(end, h);
      }
      shape.lineTo(x + (roundStart ? c : 0), h);
      if (roundStart) {
        shape.cubicTo(x + c * .45, h, x, h * .775, x, h / 2);
        shape.cubicTo(x, h * .225, x + c * .45, 0, x + c, 0);
      } else if (i > 0 && format.roundedSeparators) {
        shape.cubicTo(x + c * .55, h, x + c, h * .775, x + c, h / 2);
        shape.cubicTo(x + c, h * .225, x + c * .55, 0, x, 0);
      } else {
        shape.lineTo(x + (i == 0 ? 0 : c), h / 2);
      }
      shape.close();
      canvas.drawPath(shape, Paint()..color = segment.background!);
      // At tight widths, preserve the branch name before its decorative icon.
      final symbolWidth = segment.branchSymbol && fitted[i] >= cell.width * 3
          ? cell.width * 2
          : 0.0;
      if (symbolWidth > 0) {
        _paintBranchSymbol(
          canvas,
          Rect.fromLTWH(x + inset, h * .15, cell.width, h * .7),
          segment.foreground,
        );
      }
      final painter = TextPainter(
        text: TextSpan(
          text: segment.text,
          style: style.copyWith(color: segment.foreground),
        ),
        textDirection: TextDirection.ltr,
        textScaler: scaler,
        maxLines: 1,
        ellipsis: '…',
      )..layout(maxWidth: math.max(0, fitted[i] - symbolWidth));
      painter.paint(
        canvas,
        Offset(x + inset + symbolWidth, (cell.height - painter.height) / 2),
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
      nextBackground != oldDelegate.nextBackground ||
      format != oldDelegate.format ||
      segmentOffset != oldDelegate.segmentOffset;
}

class _BranchSymbolPainter extends CustomPainter {
  const _BranchSymbolPainter(this.color);
  final Color color;
  @override
  void paint(Canvas canvas, Size size) => _paintBranchSymbol(
    canvas,
    Rect.fromLTWH(0, 0, size.width / 2, size.height),
    color,
  );
  @override
  bool shouldRepaint(_BranchSymbolPainter oldDelegate) =>
      color != oldDelegate.color;
}

void _paintBranchSymbol(Canvas canvas, Rect rect, Color color) {
  final paint = Paint()
    ..color = color
    ..style = PaintingStyle.stroke
    ..strokeWidth = rect.width * .14
    ..strokeCap = StrokeCap.round;
  final left = rect.left + rect.width * .25;
  final right = rect.left + rect.width * .8;
  final top = rect.top + rect.height * .15;
  final bottom = rect.top + rect.height * .85;
  final radius = rect.width * .16;
  final path = Path()
    ..moveTo(left, top + radius)
    ..lineTo(left, bottom - radius)
    ..moveTo(right, top + radius)
    ..cubicTo(
      right,
      rect.center.dy,
      left,
      rect.center.dy,
      left,
      bottom - radius,
    );
  canvas.drawPath(path, paint);
  for (final center in [
    Offset(left, top),
    Offset(right, top),
    Offset(left, bottom),
  ]) {
    canvas.drawCircle(center, radius, paint);
  }
}
