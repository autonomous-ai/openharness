// The toast at the bar's foot (the mockup's `.toast`): a pill in the card's colour with a green dot and one line,
// rising 20 px into place as it fades in over 0.3 s and sinking as it fades out. A tap on it opens Attention for the
// agent it names.
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';
import '../tokens.dart';

class ToastOverlay extends StatefulWidget {
  const ToastOverlay({super.key, required this.model});
  final BarModel model;

  @override
  State<ToastOverlay> createState() => _ToastOverlayState();
}

class _ToastOverlayState extends State<ToastOverlay> with SingleTickerProviderStateMixin {
  // CSS `transition: .3s` eases both ways; going out runs the same curve from the other end.
  late final AnimationController _shown = AnimationController(vsync: this, duration: const Duration(milliseconds: 300));
  late final Animation<double> _eased =
      CurvedAnimation(parent: _shown, curve: Curves.ease, reverseCurve: Curves.ease.flipped);

  /// The line on the pill: kept while it sinks away after the model drops the toast.
  String _text = '';

  @override
  void initState() {
    super.initState();
    widget.model.addListener(_changed);
    _sync();
  }

  @override
  void didUpdateWidget(ToastOverlay old) {
    super.didUpdateWidget(old);
    if (old.model != widget.model) {
      old.model.removeListener(_changed);
      widget.model.addListener(_changed);
      _sync();
    }
  }

  @override
  void dispose() {
    widget.model.removeListener(_changed);
    _shown.dispose();
    super.dispose();
  }

  void _sync() {
    final toast = widget.model.toast;
    if (toast != null) {
      _text = toast.text;
      _shown.forward();
    } else {
      _shown.reverse();
    }
  }

  void _changed() {
    final was = _text;
    _sync();
    if (_text != was) setState(() {});
  }

  @override
  Widget build(BuildContext context) => Stack(children: [
        Positioned(
          left: 0,
          right: 0,
          // 22 px off the foot, as the mockup; the finger's target reaches 12 px past the pill all round.
          bottom: 22 - _reach,
          child: Center(
            child: AnimatedBuilder(
              animation: _eased,
              builder: (context, child) => IgnorePointer(
                ignoring: widget.model.toast == null || _eased.value == 0,
                child: Transform.translate(
                  offset: Offset(0, 20 * (1 - _eased.value)),
                  child: Opacity(opacity: _eased.value, child: child),
                ),
              ),
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: widget.model.tapToast,
                child: Padding(padding: const EdgeInsets.all(_reach), child: _Pill(_text)),
              ),
            ),
          ),
        ),
      ]);
}

const double _reach = 12;

class _Pill extends StatelessWidget {
  const _Pill(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Container(
        constraints: const BoxConstraints(maxWidth: 1200),
        // 12 x 22 inside the 1 px ring, which Flutter counts as padding and CSS's inset shadow does not.
        padding: const EdgeInsets.symmetric(horizontal: 21, vertical: 11),
        decoration: BoxDecoration(
          color: Ink.card,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: Ink.rim),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          // The mockup lifts its dot 2 px off the baseline: half a pixel under the line's middle.
          Transform.translate(
            offset: const Offset(0, 0.5),
            child: Container(
                width: 8, height: 8, decoration: const BoxDecoration(color: Ink.done, shape: BoxShape.circle)),
          ),
          const SizedBox(width: 10),
          Flexible(
            child: Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: Face.s(18, color: Ink.fg)),
          ),
        ]),
      );
}
