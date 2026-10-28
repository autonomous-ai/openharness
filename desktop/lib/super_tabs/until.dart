import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/widgets.dart';

/// Builds [builder] again at [until], when something it shows runs out (a
/// status that clears itself), even when nothing else changes on the page.
class SuperTabUntil extends StatefulWidget {
  const SuperTabUntil({super.key, required this.until, required this.builder});
  final DateTime? until;
  final WidgetBuilder builder;

  @override
  State<SuperTabUntil> createState() => _SuperTabUntilState();
}

class _SuperTabUntilState extends State<SuperTabUntil> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _schedule();
  }

  @override
  void didUpdateWidget(SuperTabUntil old) {
    super.didUpdateWidget(old);
    if (old.until != widget.until) _schedule();
  }

  void _schedule() {
    _timer?.cancel();
    final until = widget.until;
    if (until == null) return;
    final left = until.difference(clock.now());
    if (left.isNegative) return;
    _timer = Timer(left + const Duration(milliseconds: 1), () {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder(context);
}
