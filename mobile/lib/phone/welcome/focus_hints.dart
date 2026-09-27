import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/core/harness_file_store.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';

import '../tty.dart';
import '../tty_controls.dart';

/// Whether Focus's first-time hints have been seen — once per install.
class FocusHintsSeen {
  FocusHintsSeen({LocalKeyValueStore? storage})
    : _storage = storage ?? HarnessFileStore.shared;

  static const _key = 'phone_focus_hints_v1';
  final LocalKeyValueStore _storage;

  /// Shared by every Focus page, so a second page opened before the first read lands does not
  /// show the hints twice.
  static final shared = FocusHintsSeen();

  bool? _seen;

  Future<bool> seen() async {
    if (_seen case final seen?) return seen;
    // Under `flutter test` the shared store is the real one in the home directory: never read or
    // write it there. A test that wants the hints hands [FocusHints] a store of its own.
    if (identical(this, shared) &&
        Platform.environment.containsKey('FLUTTER_TEST')) {
      return _seen = true;
    }
    try {
      _seen = await _storage.read(_key) == 'yes';
    } on Exception {
      _seen = true; // No memory: never nag.
    }
    return _seen!;
  }

  /// Show them again, on the next Focus — Settings ▸ Show the tips again.
  Future<void> forget() async {
    _seen = false;
    try {
      await _storage.delete(_key);
    } on Exception {
      // Back for this run at least.
    }
  }

  Future<void> markSeen() async {
    _seen = true;
    try {
      await _storage.write(_key, 'yes');
    } on Exception {
      // Seen for this run at least.
    }
  }
}

/// Focus's first-time hints: the three things a phone can do here that nothing on screen says —
/// swipe right for your harnesses, swipe left for a new one, the mic to talk. Laid over the
/// terminal once, in the terminal's own type; any touch puts them away for good.
///
/// ```
///  tap the title       ─ rename, restart, paste…
///
///  → swipe right                swipe left ←
///    all your harnesses       start a new one
///
///                 talk to it
///                    ( mic )
/// ```
class FocusHints extends StatefulWidget {
  const FocusHints({
    super.key,
    required this.micBottom,
    this.store,
    this.onDone,
  });

  /// Called once, as the hints go — the moment to ask for what the next step needs (the
  /// notification permission: a harness asking you something is what a notice is for).
  final VoidCallback? onDone;

  /// Where the mic's centre sits, measured up from the bottom of this box.
  final double micBottom;

  final FocusHintsSeen? store;

  @override
  State<FocusHints> createState() => _FocusHintsState();
}

class _FocusHintsState extends State<FocusHints> {
  bool _show = false;

  FocusHintsSeen get _store => widget.store ?? FocusHintsSeen.shared;

  @override
  void initState() {
    super.initState();
    unawaited(
      _store.seen().then((seen) {
        if (!mounted || seen) return;
        setState(() => _show = true);
      }),
    );
  }

  void _dismiss() {
    if (!_show) return;
    HapticFeedback.selectionClick();
    setState(() => _show = false);
    unawaited(_store.markSeen());
    widget.onDone?.call();
  }

  @override
  Widget build(BuildContext context) {
    if (!_show) return const SizedBox.shrink();
    final tty = Tty.of(context);
    Widget hint(String big, String small, {TextAlign align = TextAlign.left}) =>
        Column(
          crossAxisAlignment: align == TextAlign.right
              ? CrossAxisAlignment.end
              : align == TextAlign.center
              ? CrossAxisAlignment.center
              : CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            TtyText(
              big,
              size: TtySize.title,
              weight: FontWeight.w600,
              color: tty.green,
            ),
            const SizedBox(height: 2),
            TtyText(small, size: TtySize.meta, color: tty.text),
          ],
        );
    // ⚠️ **The touch goes THROUGH.** A hint that swallowed the swipe it teaches ("swipe right")
    // made the first swipe do nothing. The listener only notices the finger going down — the hints
    // go — and the terminal under it gets the same touch and does what was taught.
    return Listener(
      behavior: HitTestBehavior.translucent,
      onPointerDown: (_) => _dismiss(),
      child: IgnorePointer(
        child: Semantics(
          label:
              'Tips: swipe right for all your harnesses, swipe left to start '
              'one, tap the title for its menu, the mic to talk.',
          child: Material(
            color: tty.ground.withValues(alpha: 0.95),
            child: Stack(
              children: [
                // Under the title, never on it: the title is three rows tall.
                Positioned(
                  left: 16,
                  top: 4 * tty.row + 14,
                  child: hint('↑ tap the title', 'rename, restart, paste…'),
                ),
                Positioned(
                  left: 16,
                  right: 16,
                  top: 0,
                  bottom: 0,
                  child: Row(
                    children: [
                      Expanded(
                        child: hint('→ swipe right', 'all your harnesses'),
                      ),
                      Expanded(
                        child: Align(
                          alignment: Alignment.centerRight,
                          child: hint(
                            'swipe left ←',
                            'start a new one',
                            align: TextAlign.right,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: widget.micBottom + 44,
                  child: Center(
                    child: hint(
                      'talk to it ↓',
                      'tap the mic, speak, tap again to send',
                      align: TextAlign.center,
                    ),
                  ),
                ),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 12,
                  child: Center(
                    child: TtyText(
                      'touch anywhere to start',
                      size: TtySize.meta,
                      color: tty.faint,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
