import 'package:clock/clock.dart';

/// Tells a second click on the same row from a first, without delaying the
/// first: a single click opens a preview at once, and a second within
/// [window] keeps it — Orca's preview tabs, at click speed. Timed by
/// [clock], so a widget test's fake time decides it, not the runner's speed.
class FinderClickTracker {
  FinderClickTracker({this.window = const Duration(milliseconds: 400)});

  final Duration window;
  String? _last;
  DateTime? _at;

  /// Whether this click on [id] is the second of a double click.
  bool isDouble(String id, {DateTime? now}) {
    final time = now ?? clock.now();
    final second =
        _last == id && _at != null && time.difference(_at!) <= window;
    _last = second ? null : id;
    _at = second ? null : time;
    return second;
  }
}
