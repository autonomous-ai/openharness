import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:share_plus/share_plus.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import '../tty.dart';
import '../tty_controls.dart';
import 'scan_to_connect.dart' show kAddPhoneWhere;

/// Where Harness is downloaded: the website's download page, which offers each computer its own
/// file — the Mac's, Linux's, the command line's.
const kDesktopDownloadUrl = 'https://harness.autonomous.ai/desktop';

/// **Connect your computer** — the page a phone with no computer stands on: signed out (the first
/// screen, `phone_welcome.dart`), signed in to an account with none (`connect_computer.dart`), and
/// Computers ▸ Set up another computer. One button, what it takes, and the way for somebody who has
/// no Harness on the computer yet ([GetHarnessPage]).
///
/// ```
/// harness▌                         (⚙ once signed in: Settings)
///           Connect your computer
///   Drive Claude Code and Codex from your phone.
///   [status]
///          [ ⊞  Pair computer ]
///
/// HOW IT WORKS
/// [1] Open Add Phone on your computer
///     Mac: Harness menu · Linux: Ctrl+Shift+P
/// [2] Scan its code
/// [3] You’re connected
///     End-to-end encrypted.
///
///        No Harness yet? Get it ›
/// ```
///
/// Nothing else on it, signed out: the other ways to sign in are the camera's "Can’t scan?", where
/// a computer with no code or a phone with no camera finds out it needs them, and the sample is
/// Get it's, for somebody waiting on the computer (owner, 2026-10-09).
///
/// Short on purpose (owner, 2026-10-08): a line under a step only where the step cannot be done
/// without it — where Add Phone is, which account.
///
/// ⚠️ **One button, after Orca's (owner, 2026-10-08).** The first screen used to ask "Is Harness on
/// your computer?" — Yes to the camera, Not yet to a page of download rows, steps and a second scan —
/// beside Google and Apple: six ways on before anything was explained. Somebody who has Harness
/// presses Pair computer; somebody who has not follows Get it, and comes back to the same button.
class SetUpComputerPage extends StatelessWidget {
  const SetUpComputerPage({
    super.key,
    required this.onScan,
    required this.onGetIt,
    this.onBack,
    this.status,
    this.account,
    this.watching = false,
    this.topTrailing,
    this.scanStatus,
  });

  /// Pair computer: the camera, for the code the computer's Add Phone shows — it pairs this phone
  /// with it (and, signed out, signs it in).
  final VoidCallback onScan;

  /// "No Harness yet? Get it ›" — [GetHarnessPage].
  final VoidCallback onGetIt;

  /// Null draws the wordmark instead of a back button: the page is a home screen, not a pushed one.
  final VoidCallback? onBack;

  /// Under the words, over the button: what is going on — the watch for the computer once signed
  /// in, or why the phone was signed out.
  final Widget? status;

  /// The account this phone is signed in to, when it is: the computer has to sign in to the same
  /// one, and the first step says so by name.
  final String? account;

  /// Whether the page is watching the account for the computer (signed in, at home): it then
  /// shows up by itself, with no code.
  final bool watching;

  /// At the right of the top row, across from the wordmark or `‹ Back` — Settings
  /// (`PhoneSettingsButton`) once signed in.
  final Widget? topTrailing;

  /// What the last scan came to — pairing, or why it did not — right under Pair computer, the
  /// button that started it.
  final Widget? scanStatus;

  /// The steps, signed out: open Add Phone (and where it is), scan its code. Signed in: sign in on
  /// the computer with the same account — it then turns up by itself, with no code — and Add Phone,
  /// and where it is, for one that does not.
  ///
  /// ⚠️ **Where Add Phone is is said either way.** Signed in, it was left out as needed only for the
  /// scan — and that is exactly when it is needed: a computer whose account already has this phone
  /// does not open Add Phone by itself, and one slow to read the phone's key does not turn up.
  ({String title, String? note}) get _firstStep => switch (account) {
    null => (title: 'Open Add Phone on your computer', note: kAddPhoneWhere),
    _ when watching => (
      title: 'Sign in on your computer',
      note: 'With the same account.',
    ),
    // From Computers nothing above names the account.
    final account => (
      title: 'Sign in on your computer',
      note: 'With $account.',
    ),
  };

  ({String title, String? note}) get _secondStep => account == null
      ? (title: 'Scan its code', note: null)
      : (title: 'Not showing up? Scan its code', note: kAddPhoneWhere);

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final faint = tty.style(color: tty.faint, size: TtySize.meta);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // One row whatever is in it: the back button's height, so the page starts at the same place
        // with a back or the wordmark, a trailing control or none.
        SizedBox(
          height: 44,
          child: Row(
            children: [
              if (onBack case final onBack?)
                TtyBackButton(onPressed: onBack)
              else
                const Padding(
                  padding: EdgeInsets.only(left: Tty.origin),
                  child: _Wordmark(),
                ),
              const Spacer(),
              ?topTrailing,
            ],
          ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(Tty.origin, 32, Tty.origin, 28),
            children: [
              const _Hero(
                title: 'Connect your computer',
                body: 'Drive Claude Code and Codex from your phone.',
              ),
              if (status case final status?) ...[
                const SizedBox(height: 18),
                status,
              ],
              const SizedBox(height: 26),
              Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 300),
                  child: TtyPrimaryButton(
                    key: const ValueKey('set-up-scan'),
                    icon: LucideIcons.qrCode300,
                    label: 'Pair computer',
                    onPressed: onScan,
                  ),
                ),
              ),
              if (scanStatus case final scanStatus?) ...[
                const SizedBox(height: 10),
                scanStatus,
              ],
              const SizedBox(height: 40),
              Text(
                'HOW IT WORKS',
                style: faint.copyWith(
                  fontSize: 11.5,
                  letterSpacing: 1.1,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 4),
              _HowItWorksRow(
                number: 1,
                title: _firstStep.title,
                note: _firstStep.note,
              ),
              _HowItWorksRow(
                number: 2,
                title: _secondStep.title,
                note: _secondStep.note,
              ),
              const _HowItWorksRow(
                number: 3,
                title: 'You’re connected',
                note: 'End-to-end encrypted.',
                last: true,
              ),
              const SizedBox(height: 24),
              Center(
                child: _TextLink(
                  key: const ValueKey('set-up-get-it'),
                  lead: 'No Harness yet? ',
                  action: 'Get it ›',
                  onTap: onGetIt,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// **Get it** — Harness onto the computer, from the phone: the download page, sent to the computer
/// (a phone cannot install it), then back to Pair computer.
///
/// ```
/// ‹
///      Get Harness on your computer
///          For Mac and Linux.
///      [ ⇪  Send to my computer ]
///   or open harness.autonomous.ai/desktop on it
///   ─────────────────────────────────────
///        Installed? Pair computer ›
///      Try the sample while you wait
/// ```
///
/// The page sends the website, not a file: it offers each computer its own download (Mac, Linux,
/// the command line), which a phone cannot tell apart.
class GetHarnessPage extends StatelessWidget {
  const GetHarnessPage({
    super.key,
    required this.onBack,
    required this.onPair,
    this.onTrySample,
  });

  final VoidCallback onBack;

  /// "Pair computer ›": the camera, the same as the button on [SetUpComputerPage].
  final VoidCallback onPair;

  /// The offline sample — what Harness is like, for somebody waiting on the computer to install.
  final VoidCallback? onTrySample;

  /// The share sheet with the download page: AirDrop to the Mac beside you, or Messages or email to
  /// yourself, opened on the computer. Anchored to the button for iPad, where the sheet is a popover.
  Future<void> _sendLink(BuildContext button) async {
    final box = button.findRenderObject() as RenderBox?;
    final origin = box == null || !box.attached
        ? null
        : box.localToGlobal(Offset.zero) & box.size;
    try {
      await SharePlus.instance.share(
        ShareParams(
          uri: Uri.parse(kDesktopDownloadUrl),
          subject: 'Get Harness for your computer',
          sharePositionOrigin: origin,
        ),
      );
    } catch (_) {
      // No share sheet came up: the address under the button is the way on, and the button can be
      // pressed again.
    }
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final faint = tty.style(color: tty.faint, size: TtySize.meta);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: TtyBackButton(onPressed: onBack),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(Tty.origin, 32, Tty.origin, 28),
            children: [
              const _Hero(
                title: 'Get Harness on your computer',
                body: 'For Mac and Linux.',
              ),
              const SizedBox(height: 26),
              Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 300),
                  child: Builder(
                    builder: (button) => _SolidButton(
                      key: const ValueKey('get-it-send'),
                      icon: LucideIcons.share300,
                      label: 'Send to my computer',
                      onPressed: () => unawaited(_sendLink(button)),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              Text.rich(
                TextSpan(
                  children: [
                    const TextSpan(text: 'or open '),
                    TextSpan(
                      text: kDesktopDownloadUrl.replaceFirst('https://', ''),
                      style: tty.style(size: TtySize.meta),
                    ),
                    const TextSpan(text: ' on it'),
                  ],
                ),
                textAlign: TextAlign.center,
                style: faint,
              ),
              const SizedBox(height: 40),
              Container(height: 1, color: tty.dim.withValues(alpha: 0.6)),
              const SizedBox(height: 20),
              // Nothing about signing in there: the desktop app asks for it itself, and opens Add
              // Phone by itself once it is.
              Center(
                child: _TextLink(
                  key: const ValueKey('get-it-pair'),
                  lead: 'Installed? ',
                  action: 'Pair computer ›',
                  onTap: onPair,
                ),
              ),
              if (onTrySample case final onTrySample?)
                Center(
                  child: _TextLink(
                    key: const ValueKey('get-it-sample'),
                    action: 'Try the sample while you wait',
                    onTap: onTrySample,
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

/// A page's title and the sentence under it, centred.
class _Hero extends StatelessWidget {
  const _Hero({required this.title, required this.body});

  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          title,
          textAlign: TextAlign.center,
          style: tty
              .style(size: 24, weight: FontWeight.w600)
              .copyWith(height: 1.25, letterSpacing: -0.4),
        ),
        const SizedBox(height: 12),
        Text(
          body,
          textAlign: TextAlign.center,
          style: tty.style(color: tty.faint, size: 14).copyWith(height: 1.55),
        ),
      ],
    );
  }
}

/// `harness▌`: the app's name and the terminal's cursor, where a home screen has no back.
class _Wordmark extends StatelessWidget {
  const _Wordmark();

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        TtyText('harness', size: TtySize.row, weight: FontWeight.w600),
        Container(
          width: 8,
          height: 16,
          margin: const EdgeInsets.only(left: 2),
          color: tty.green,
        ),
      ],
    );
  }
}

/// One row of HOW IT WORKS: its number in a raised square, what to do, and a quieter line under it
/// when one is needed — a rule between rows.
class _HowItWorksRow extends StatelessWidget {
  const _HowItWorksRow({
    required this.number,
    required this.title,
    this.note,
    this.last = false,
  });

  final int number;
  final String title;
  final String? note;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 14),
      decoration: BoxDecoration(
        border: last
            ? null
            : Border(bottom: BorderSide(color: tty.dim.withValues(alpha: 0.6))),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 28,
            height: 28,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: ttyRaised(tty),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Text(
              '$number',
              style: tty.style(color: tty.faint, size: TtySize.meta),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Centred on the number's square while it is one line; wraps under itself after.
                ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 28),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      title,
                      style: tty.style(
                        size: TtySize.row,
                        weight: FontWeight.w600,
                      ),
                    ),
                  ),
                ),
                if (note case final note?)
                  Text(
                    note,
                    style: tty
                        .style(color: tty.faint, size: TtySize.meta)
                        .copyWith(height: 1.45),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// A small centred link: faint words, and the part that acts in the terminal's green — "No Harness
/// yet? Get it ›", "Pair computer ›". With no [lead] at all the whole link is the
/// faint words ("Try the sample while you wait").
class _TextLink extends StatelessWidget {
  const _TextLink({
    super.key,
    required this.action,
    required this.onTap,
    this.lead,
  });

  final String? lead;
  final String action;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final lead = this.lead;
    return Semantics(
      button: true,
      label: '${lead ?? ''}$action',
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () {
          HapticFeedback.selectionClick();
          onTap();
        },
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
            child: Text.rich(
              TextSpan(
                children: [
                  if (lead != null) TextSpan(text: lead),
                  TextSpan(
                    text: action,
                    style: lead == null
                        ? null
                        : tty.style(
                            color: tty.green,
                            size: TtySize.meta,
                            weight: FontWeight.w600,
                          ),
                  ),
                ],
              ),
              textAlign: TextAlign.center,
              style: tty.style(color: tty.faint, size: TtySize.meta),
            ),
          ),
        ),
      ),
    );
  }
}

/// [TtyPrimaryButton]'s shape in the terminal's ink rather than its green: a page's one action when
/// it is not the scan — Send to my computer.
class _SolidButton extends StatefulWidget {
  const _SolidButton({
    super.key,
    required this.icon,
    required this.label,
    required this.onPressed,
  });

  final IconData icon;
  final String label;
  final VoidCallback onPressed;

  @override
  State<_SolidButton> createState() => _SolidButtonState();
}

class _SolidButtonState extends State<_SolidButton> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final fill = _down
        ? Color.alphaBlend(Colors.black.withValues(alpha: 0.14), tty.text)
        : tty.text;
    return Semantics(
      button: true,
      label: widget.label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: (_) => setState(() => _down = true),
        onTapCancel: () => setState(() => _down = false),
        onTapUp: (_) => setState(() => _down = false),
        onTap: () {
          HapticFeedback.lightImpact();
          widget.onPressed();
        },
        child: Container(
          constraints: const BoxConstraints(minHeight: TtyPrimaryButton.height),
          padding: const EdgeInsets.symmetric(
            horizontal: Tty.origin,
            vertical: 10,
          ),
          decoration: BoxDecoration(
            color: fill,
            borderRadius: BorderRadius.circular(6),
          ),
          alignment: Alignment.center,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(widget.icon, size: 20, color: tty.ground),
              const SizedBox(width: 10),
              Flexible(
                child: Text(
                  widget.label,
                  maxLines: 1,
                  softWrap: false,
                  overflow: TextOverflow.ellipsis,
                  style: tty.style(
                    color: tty.ground,
                    weight: FontWeight.w600,
                    size: TtySize.title,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
