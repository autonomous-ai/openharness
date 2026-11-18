// "Mic closed · tap to talk" when nothing was heard: the mockup says it in its toast's pill at the glass's foot, which
// rises in (.3s), stays 2.2 s and fades. The page draws it unless the model's own toast already says it.
import 'dart:async';

import 'package:flutter/widgets.dart';

import '../tokens.dart';

const String kMicClosed = 'Mic closed · tap to talk';

class MicClosedNote extends StatefulWidget {
  const MicClosedNote({super.key});

  @override
  State<MicClosedNote> createState() => _MicClosedNoteState();
}

class _MicClosedNoteState extends State<MicClosedNote> with SingleTickerProviderStateMixin {
  // .toast: transition .3s (ease) on opacity and a 20 px rise
  late final AnimationController _show =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 300))..forward();
  late final Animation<double> _in = CurvedAnimation(parent: _show, curve: Curves.ease, reverseCurve: Curves.ease.flipped);
  Timer? _hide;

  @override
  void initState() {
    super.initState();
    _hide = Timer(const Duration(milliseconds: 2200), () => _show.reverse());
  }

  @override
  void dispose() {
    _hide?.cancel();
    _show.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => IgnorePointer(
        child: AnimatedBuilder(
          animation: _in,
          builder: (context, child) => Opacity(
            opacity: _in.value,
            child: Transform.translate(offset: Offset(0, 20 * (1 - _in.value)), child: child),
          ),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 12),
            decoration: BoxDecoration(
              color: Ink.card,
              border: Border.all(color: Ink.rim),
              borderRadius: BorderRadius.circular(999),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Container(
                width: 8,
                height: 8,
                margin: const EdgeInsets.only(right: 10),
                decoration: const BoxDecoration(color: Ink.done, shape: BoxShape.circle),
              ),
              Text(kMicClosed, style: Face.s(18)),
            ]),
          ),
        ),
      );
}
