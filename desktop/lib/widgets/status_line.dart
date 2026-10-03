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
    this.middleEllipsis = false,
    this.surfaceBackground,
    this.monochromeColor,
  });
  final StatusLineParts parts;
  final bool color;
  final TextAlign textAlign;

  /// Fill behind the final arrow to join a separately clickable next segment.
  final Color? nextBackground;
  final int segmentOffset;
  final bool workspaceBar;
  final bool emphasized;
  final bool middleEllipsis;

  /// Set only when the status is displayed outside its terminal surface.
  final Color? surfaceBackground;

  /// Secondary context keeps the chosen wording, fields, and status face, but
  /// uses one ink without colored segment backgrounds. The focused workspace
  /// footer does not set this and retains its full customized appearance.
  final Color? monochromeColor;

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
        final foreground =
            monochromeColor ??
            (surfaceBackground == null
                ? theme.foreground
                : statusLineInkOnSurface(theme.foreground, surfaceBackground!));
        final style = workspaceBar
            ? workspaceBarTextStyle(color: foreground, emphasized: emphasized)
            : terminalContentStyle(color: foreground);
        final resolvedSegments = statusLinePaintSegments(
          parts,
          theme,
          color: color,
          segmentOffset: segmentOffset,
          surfaceBackground: surfaceBackground,
        );
        final segments = monochromeColor == null
            ? resolvedSegments
            : [
                for (final (index, segment) in resolvedSegments.indexed)
                  StatusLinePaintSegment(
                    '${parts.style.segmented && index > 0 ? '  ' : ''}'
                    '${segment.text}',
                    monochromeColor!,
                    null,
                    branchSymbol: segment.branchSymbol,
                  ),
              ];
        final cell = workspaceBar
            ? workspaceBarCellSizeOf(context)
            : terminalCellSizeOf(context);
        final scaler = MediaQuery.textScalerOf(context);
        double measure(String text) => workspaceBar
            ? workspaceBarTextSizeOf(context, text).width
            : _measure(text, style, scaler);
        if (!parts.style.segmented || monochromeColor != null) {
          Widget line(List<StatusLinePaintSegment> visible) => Text.rich(
            TextSpan(
              children: [
                for (final segment in visible) ...[
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
          Widget body(List<StatusLinePaintSegment> visible) => workspaceBar
              ? SizedBox(
                  width:
                      workspaceBarTextSizeOf(
                        context,
                        segments.map((s) => s.text).join(),
                      ).width +
                      segments.where((s) => s.branchSymbol).length *
                          cell.width *
                          2,
                  child: line(visible),
                )
              : line(visible);
          return middleEllipsis
              ? LayoutBuilder(
                  builder: (context, constraints) => body(
                    _shortenStatusSegments(
                      segments,
                      constraints.maxWidth,
                      cell.width,
                      measure,
                    ),
                  ),
                )
              : body(segments);
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
                    middleEllipsis
                        ? _middleEllipsis(
                            parts.text,
                            constraints.maxWidth,
                            measure,
                          )
                        : parts.text,
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
                    middleEllipsis,
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

String _middleEllipsis(
  String text,
  double width,
  double Function(String) measure,
) {
  if (measure(text) <= width + .01) return text;
  final characters = text.characters.toList();
  String cut(int keep) =>
      '${characters.take((keep + 1) ~/ 2).join()}…'
      '${characters.skip(characters.length - keep ~/ 2).join()}';
  var low = 0, high = math.max(0, characters.length - 1);
  while (low < high) {
    final mid = (low + high + 1) ~/ 2;
    if (measure(cut(mid)) <= width) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return cut(low);
}

List<StatusLinePaintSegment> _shortenStatusSegments(
  List<StatusLinePaintSegment> segments,
  double width,
  double cell,
  double Function(String) measure,
) {
  if (segments.isEmpty) return segments;
  final widths = [for (final segment in segments) measure(segment.text)];
  var longest = 0;
  for (var i = 1; i < widths.length; i++) {
    if (widths[i] > widths[longest]) longest = i;
  }
  final available = math.max(
    0.0,
    width -
        widths.fold(0.0, (a, b) => a + b) +
        widths[longest] -
        segments.where((s) => s.branchSymbol).length * cell * 2,
  );
  return [
    for (var i = 0; i < segments.length; i++)
      if (i == longest)
        StatusLinePaintSegment(
          _middleEllipsis(segments[i].text, available, measure),
          segments[i].foreground,
          segments[i].background,
          branchSymbol: segments[i].branchSymbol,
        )
      else
        segments[i],
  ];
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
    this.middleEllipsis,
  );
  final List<StatusLinePaintSegment> segments;
  final List<double> widths;
  final Size cell;
  final TextStyle style;
  final TextScaler scaler;
  final Color? nextBackground;
  final StatusLineStyle format;
  final int segmentOffset;
  final bool middleEllipsis;

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
      final textWidth = math.max(0.0, fitted[i] - symbolWidth);
      final text = middleEllipsis
          ? _middleEllipsis(
              segment.text,
              textWidth,
              (text) => math.max(
                _measure(
                  text,
                  style.copyWith(fontWeight: FontWeight.normal),
                  scaler,
                ),
                _measure(
                  text,
                  style.copyWith(fontWeight: FontWeight.bold),
                  scaler,
                ),
              ),
            )
          : segment.text;
      final painter = TextPainter(
        text: TextSpan(
          text: text,
          style: style.copyWith(color: segment.foreground),
        ),
        textDirection: TextDirection.ltr,
        textScaler: scaler,
        maxLines: 1,
        ellipsis: '…',
      )..layout(maxWidth: textWidth);
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
      segmentOffset != oldDelegate.segmentOffset ||
      middleEllipsis != oldDelegate.middleEllipsis;
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
