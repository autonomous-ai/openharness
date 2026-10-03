import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

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
/// The code is what a person reads out or compares against another screen, so it is never truncated;
/// Copy puts the exact string on the clipboard. [large] is the detail page's size, small the one in
/// the "This device" card.
class FingerprintBlock extends StatefulWidget {
  const FingerprintBlock(
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
  State<FingerprintBlock> createState() => _FingerprintBlockState();
}

class _FingerprintBlockState extends State<FingerprintBlock> {
  Timer? _timer;
  bool _copied = false;

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _copy() {
    unawaited(Clipboard.setData(ClipboardData(text: widget.fingerprint)));
    HapticFeedback.selectionClick();
    _timer?.cancel();
    setState(() => _copied = true);
    _timer = Timer(const Duration(seconds: 2), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Row(
      children: [
        Expanded(
          child: Semantics(
            label: fingerprintSpoken(widget.fingerprint),
            excludeSemantics: true,
            child: SelectableText(
              widget.fingerprint,
              style: TextStyle(
                fontFamily: AppFont.mono,
                fontFamilyFallback: AppFont.monoFallback,
                fontSize: widget.large ? 22 : 16,
                letterSpacing: 0.5,
                color: AppPalette.textPrimary,
              ),
            ),
          ),
        ),
        TextButton(
          key: widget.copyKey,
          onPressed: _copy,
          child: Text(_copied ? 'Copied' : 'Copy'),
        ),
      ],
    );
  }
}
