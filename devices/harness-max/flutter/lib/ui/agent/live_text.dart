// Words that follow a clock: a turn's, a recording's, "2 min ago".
import 'dart:async';

import 'package:flutter/widgets.dart';

/// A clock as the mockup's fmt: "4:12"; an hour or more, "1:04:12".
String clockText(int secs) {
  if (secs < 0) secs = 0;
  String two(int v) => v.toString().padLeft(2, '0');
  if (secs < 3600) return '${secs ~/ 60}:${two(secs % 60)}';
  return '${secs ~/ 3600}:${two(secs ~/ 60 % 60)}:${two(secs % 60)}';
}

/// How long ago, as the mockup and the dial say it: "just now", "2 min ago", "1 h ago", "3 d ago".
String agoText(DateTime at, DateTime now) {
  final secs = now.difference(at).inSeconds;
  if (secs < 60) return 'just now';
  if (secs < 3600) return '${secs ~/ 60} min ago';
  if (secs < 86400) return '${secs ~/ 3600} h ago';
  return '${secs ~/ 86400} d ago';
}

/// Text read from a clock: it looks again a few times a second and rebuilds only when the words change.
class LiveText extends StatefulWidget {
  const LiveText(this.read, {super.key, required this.style});
  final String Function() read;
  final TextStyle style;

  @override
  State<LiveText> createState() => _LiveTextState();
}

class _LiveTextState extends State<LiveText> {
  late String _text = widget.read();
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    // A look every quarter second keeps a seconds clock close to the mockup's without asking for a frame every vsync.
    _timer = Timer.periodic(const Duration(milliseconds: 250), (_) => _look());
  }

  void _look() {
    final t = widget.read();
    if (t != _text) setState(() => _text = t);
  }

  @override
  void didUpdateWidget(LiveText old) {
    super.didUpdateWidget(old);
    _text = widget.read();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Text(_text, style: widget.style, maxLines: 1, softWrap: false);
}
