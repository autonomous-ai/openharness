import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/app_icons.dart';
import '../theme/app_theme.dart' as grid;

/// A device's key code spelled for a screen reader: `Key code E 2 F B, 0 D F 5, 5 F D 8, E 6 C 7` —
/// letter by letter, so it is not read as a word.
String fingerprintSpoken(String fingerprint) =>
    'Key code ${fingerprint.split('·').map((group) => group.split('').join(' ')).join(', ')}';

/// How to check a key code, shown under it in a device's detail. [computer] adds the CLI route, which
/// only a computer has.
String fingerprintHowToCompare({required bool computer}) => computer
    ? 'This device’s own key code. Open Your devices on that computer — the code under “This device” '
          'must match — or run harness status on it.'
    : 'This device’s own key code. Open Your devices on that device — the code under “This device” must match.';

/// A key code (`E2FB·0DF5·5FD8·E6C7`) set in mono, selectable, with a Copy button.
///
/// The code is what a person reads out or compares against another screen, so it is never truncated or
/// restyled into something that is hard to select; the Copy button puts the exact string on the
/// clipboard. [large] is the detail's size, small the one inside the "This device" card.
class FingerprintText extends StatefulWidget {
  const FingerprintText(
    this.fingerprint, {
    super.key,
    this.large = true,
    this.copyKey,
  });

  final String fingerprint;
  final bool large;

  /// Key of the Copy button, for tests.
  final Key? copyKey;

  @override
  State<FingerprintText> createState() => _FingerprintTextState();
}

class _FingerprintTextState extends State<FingerprintText> {
  Timer? _timer;
  String? _message;
  int _attempt = 0;

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  // Same flow as the Copy buttons in the machines panel: a later tap supersedes an earlier one still
  // waiting on the clipboard, and the answer clears itself after a few seconds.
  Future<void> _copy() async {
    final attempt = ++_attempt;
    try {
      await Clipboard.setData(ClipboardData(text: widget.fingerprint));
      if (!mounted || attempt != _attempt) return;
      setState(() => _message = 'Copied');
    } catch (_) {
      if (!mounted || attempt != _attempt) return;
      setState(() => _message = 'Couldn’t copy. Try again');
    }
    _timer?.cancel();
    _timer = Timer(const Duration(seconds: 3), () {
      if (mounted) setState(() => _message = null);
    });
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final message = _message;
    return Wrap(
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 12,
      runSpacing: 4,
      children: [
        Semantics(
          label: fingerprintSpoken(widget.fingerprint),
          excludeSemantics: true,
          child: SelectableText(
            widget.fingerprint,
            style: grid.AppType.mono(color: grid.AppPalette.textPrimary)
                .copyWith(fontSize: widget.large ? 20 : 15, letterSpacing: 0.5),
          ),
        ),
        TextButton.icon(
          key: widget.copyKey,
          onPressed: _copy,
          icon: Icon(
            message == 'Copied' ? AppIcons.check : AppIcons.copy,
            size: 16,
          ),
          label: Text(message ?? 'Copy'),
        ),
      ],
    );
  }
}
