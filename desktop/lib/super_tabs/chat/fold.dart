import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../widgets/desktop_chrome.dart';
import '../swarm_type.dart';
import 'chat_link.dart';

/// A long message folded after about [lines] lines, with More to read it all
/// (anh Dee's mockup, 11-07, #4529): no walls of text in the chat.
class SwarmFold extends StatefulWidget {
  const SwarmFold({super.key, this.lines = 6, required this.child});

  final int lines;
  final Widget child;

  @override
  State<SwarmFold> createState() => _SwarmFoldState();
}

class _SwarmFoldState extends State<SwarmFold> {
  var _open = false, _overflows = false;

  /// A cut message fades out over its last line or so, so no line shows cut
  /// in half above More (Mac test of #4529).
  Widget _faded(Widget clip) => !_overflows
      ? clip
      : ShaderMask(
          key: const ValueKey('swarm-fold-fade'),
          blendMode: BlendMode.dstIn,
          // Only the mask's alpha counts: opaque ink, then none.
          shaderCallback: (bounds) => LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [
              DesktopChrome.foreground,
              DesktopChrome.foreground,
              Colors.transparent,
            ],
            stops: const [0, .7, 1],
          ).createShader(bounds),
          child: clip,
        );

  void _measured(bool overflows) {
    if (overflows == _overflows || !mounted) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) setState(() => _overflows = overflows);
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_open) return widget.child;
    final line = SwarmType.body(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _faded(
          _FoldClip(
            height: line.fontSize! * line.height! * widget.lines,
            onMeasured: _measured,
            child: widget.child,
          ),
        ),
        if (_overflows)
          Padding(
            padding: const EdgeInsets.only(top: grid.AppDesktop.bubbleNoteGap),
            child: SwarmChatLink(
              label: 'More',
              onPressed: () => setState(() => _open = true),
            ),
          ),
      ],
    );
  }
}

/// Lays [child] out at its full height and shows at most [height] of it,
/// saying whether anything was cut.
class _FoldClip extends SingleChildRenderObjectWidget {
  const _FoldClip({
    required this.height,
    required this.onMeasured,
    required super.child,
  });

  final double height;
  final ValueChanged<bool> onMeasured;

  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderFoldClip(height, onMeasured);

  @override
  void updateRenderObject(BuildContext context, _RenderFoldClip render) =>
      render
        ..height = height
        ..onMeasured = onMeasured;
}

class _RenderFoldClip extends RenderProxyBox {
  _RenderFoldClip(this._height, this.onMeasured);

  double _height;
  set height(double value) {
    if (value == _height) return;
    _height = value;
    markNeedsLayout();
  }

  ValueChanged<bool> onMeasured;

  @override
  void performLayout() {
    final child = this.child!;
    child.layout(
      constraints.copyWith(maxHeight: double.infinity),
      parentUsesSize: true,
    );
    final full = child.size.height;
    size = constraints.constrain(
      Size(child.size.width, full > _height ? _height : full),
    );
    onMeasured(full > _height);
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    if (child!.size.height <= size.height) return super.paint(context, offset);
    layer = context.pushClipRect(
      needsCompositing,
      offset,
      Offset.zero & size,
      super.paint,
      oldLayer: layer as ClipRectLayer?,
    );
  }

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) =>
      size.contains(position) &&
      super.hitTestChildren(result, position: position);
}
