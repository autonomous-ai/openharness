import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../phone/tty.dart';
import '../phone/tty_controls.dart';
import 'product_measurement.dart';

/// Visible before any optional signed-out report. It never blocks setup or sign-in.
///
/// One quiet line under every signed-out screen, in the onboarding's face: the box, its words, and
/// ⓘ for what is shared. The detail is a tooltip over the line, not a second line under it, so the
/// screen above — the welcome's picture — never moves for it.
class SetupUsageChoice extends StatelessWidget {
  const SetupUsageChoice({super.key, required this.measurement});
  final ProductMeasurement measurement;

  static const title = 'Share setup and sign-in counts';
  static const detail =
      'On unless you turn it off; off also turns it off for your account when you sign in. Helps us find setup problems without sharing account details, prompts, or files.';

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: measurement,
    builder: (context, _) {
      final tty = Tty.of(context);
      final checked = measurement.signedOutSharing;
      final onTap = measurement.choiceLoaded
          ? () => unawaited(measurement.setSignedOutSharing(!checked))
          : null;
      // Material for the text's default style — outside a Scaffold, without it, Flutter marks
      // every line with its yellow "no style" underline — and the ground painted down through the
      // home indicator's inset, which this keeps itself.
      return Material(
        color: tty.ground,
        child: SafeArea(
          top: false,
          minimum: const EdgeInsets.symmetric(horizontal: 16),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Flexible(
                child: _Choice(checked: checked, onTap: onTap),
              ),
              Tooltip(
                message: detail,
                triggerMode: TooltipTriggerMode.tap,
                showDuration: const Duration(seconds: 8),
                // Over the line: under it is the edge of the screen.
                preferBelow: false,
                margin: const EdgeInsets.symmetric(horizontal: 24),
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: ttyRaised(tty),
                  border: Border.all(color: tty.dim),
                  borderRadius: BorderRadius.circular(8),
                ),
                textStyle: tty
                    .style(size: TtySize.meta, color: tty.text)
                    .copyWith(height: 1.45),
                child: SizedBox.square(
                  dimension: 44,
                  child: Icon(LucideIcons.info300, size: 15, color: tty.faint),
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}

/// The box and its words — the whole of it one tap target, at least 44pt tall. Checked, the box is
/// the terminal's green with a tick in its ink; not loaded yet, it steps back.
class _Choice extends StatelessWidget {
  const _Choice({required this.checked, required this.onTap});

  final bool checked;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      container: true,
      checked: checked,
      enabled: onTap != null,
      label: SetupUsageChoice.title,
      onTap: onTap,
      excludeSemantics: true,
      child: Opacity(
        opacity: onTap == null ? .5 : 1,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap == null
              ? null
              : () {
                  HapticFeedback.selectionClick();
                  onTap!();
                },
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 44),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 16,
                  height: 16,
                  decoration: BoxDecoration(
                    color: checked ? tty.green : null,
                    border: Border.all(
                      color: checked ? tty.green : tty.dim,
                      width: 1.5,
                    ),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: checked
                      ? Icon(
                          LucideIcons.check,
                          size: 12,
                          color: tty.onFill(tty.theme.black),
                        )
                      : null,
                ),
                const SizedBox(width: 9),
                Flexible(
                  child: Text(
                    SetupUsageChoice.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: tty.style(size: TtySize.meta, color: tty.faint),
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
