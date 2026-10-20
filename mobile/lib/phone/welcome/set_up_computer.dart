import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../tty.dart';
import '../tty_controls.dart';
import 'onboarding_copy.dart';
import 'scan_to_connect.dart' show kAddPhoneWhere;
import 'your_computer.dart' show GoAddressButton;

/// The steps on a computer, as a timeline ([StepsTimeline]): under "On your computer, go to"'s link
/// (`your_computer.dart`) — [goToSteps] — and under the camera opened from Computers —
/// [computerSteps], which bring up Add Phone's QR code.
///
/// ⚠️ This file used to be **Connect your computer**, the page a phone with no computer stood on
/// (signed out, signed in with none, and Computers ▸ Set up another computer). The onboarding
/// replaced it (`docs/research/2026-10-11-phone-onboarding`): signed out, the welcome signs in
/// (`phone_welcome.dart`); with no computer, "On your computer, go to" (`your_computer.dart`). Only
/// the steps are left, for that screen and the camera.

/// One step: what to do, and a quieter line under it when one is needed — its lines split on `\n`.
typedef ComputerStep = ({String title, String? note});

/// The first step on the computer, for the camera: ②'s headline and, under it, ②'s address — as
/// words in the step, not ②'s green button ([ComputerSteps] hands it to [StepsTimeline.link]) —
/// then installing Harness, in the words ② says them in (owner, 2026-10-15). The address is the
/// download for whatever computer opens it, and a tap sends it there.
///
/// ⚠️ **"On your computer" is said once on a screen** (owner, 2026-10-12: three times on one screen
/// read as noise) — by the title over ②'s steps ("On your computer, go to"), and under the camera
/// by this first step: the camera has no title of its own, and a step on its own, on a phone
/// already in Harness, read as being about this phone.
const ComputerStep _getHarness = (
  title: OnboardingCopy.goToHeadline,
  note: OnboardingCopy.installStep,
);

/// The steps under "On your computer, go to"'s link: get Harness from it, and sign in — with
/// [account], the phone's, when there is one to name. Signed in with this account, the computer
/// joins it and the screen moves on by itself: no Add Phone, no code to scan (owner, 2026-10-12).
/// The sign-in step is the camera's, word for word.
List<ComputerStep> goToSteps(String? account) => [
  (title: OnboardingCopy.installStep, note: null),
  _signIn(account),
];

/// The steps under the camera that reads Add Phone's code — the welcome's Scan QR from computer,
/// and Computers' "Or scan the QR code on your computer" — where the page it came from says none
/// of them ([ScanToConnectPage.steps]): get Harness on the computer, sign in, then Add Phone and
/// where it is.
///
/// ⚠️ **One set for the camera (owner, 2026-10-12).** It used to be two: signed out "Click Add
/// Phone ③ Scan the QR code", signed in "Sign in on your computer ③ Not showing up? Click Add
/// Phone" — steps that changed under one button, and on the camera "Not showing up?" was asked of
/// somebody already scanning. Both halves hold either way: Add Phone asks a computer that is not
/// signed in to sign in before it shows a code, and a computer that turns up by itself is paired
/// just as well by its code. The scan is the camera itself, so it is not a step of its own.
/// Three steps (owner, 2026-10-14): somebody who has never had Harness on the computer starts from
/// the download, and signing in is back between it and Add Phone — ②'s sign-in, word for word,
/// with [account] when there is one to name.
List<ComputerStep> computerSteps(String? account) => [
  _getHarness,
  _signIn(account),
  (title: 'Click "Add Phone"', note: kAddPhoneWhere),
];

/// Signing in on the computer — with [account], the phone's, when there is one to name. Null signed
/// out, where a scan signs the phone in to whichever account the computer has.
ComputerStep _signIn(String? account) =>
    (title: 'Sign in', note: account == null ? null : 'Use $account');

/// Over the camera's steps: what they are for — how the code comes up on the computer, so they
/// are not read as more to do on the phone. The camera above them is what says to scan.
const _howToGetCode = 'How to get the QR code';

/// The steps on the computer under the camera ([computerSteps]) as a [StepsTimeline], under a
/// quiet line that says what they are for — with ②'s address, as words, under the first.
class ComputerSteps extends StatelessWidget {
  const ComputerSteps({super.key, required this.account});

  /// This phone's account, named in the sign-in step.
  final String? account;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          header: true,
          child: Text(
            _howToGetCode,
            style: tty.style(color: tty.faint, size: TtySize.meta),
          ),
        ),
        const SizedBox(height: 12),
        StepsTimeline(
          steps: computerSteps(account),
          link: const GoAddressButton(inline: true),
        ),
      ],
    );
  }
}

/// Steps as a timeline — each number in a ring, a thread down to the next:
///
/// ```
/// (1)  Download and install Harness
///  │
/// (2)  Sign in
///      Use ada@gmail.com
///      Not you? Sign out             [under], at home
/// ```
///
/// ⚠️ **A line each, ending in "…" rather than wrapping** — a title, and each line of a note — so
/// [heightOf] is exact: "On your computer, go to" holds that much room under its link, and the
/// picture under the steps stays put.
class StepsTimeline extends StatelessWidget {
  const StepsTimeline({super.key, required this.steps, this.under, this.link});

  final List<ComputerStep> steps;

  /// Under the first step's title, over its note, with no room of its own round it — it brings
  /// its own: under the camera, ②'s address as words ([ComputerSteps]). Not counted by [heightOf] —
  /// only ②'s own steps, which have none, are measured.
  final Widget? link;

  /// Under the last step's note, as one more line of it: at home, "Not you? Sign out" under the
  /// account the sign-in names (`your_computer.dart`'s NotYouSignOut). Set in [noteStyle], and
  /// counted by [heightOf] as one line of it.
  final Widget? under;

  /// A note's face: the meta size, faint, its lines a little apart.
  static TextStyle noteStyle(Tty tty) => tty
      .style(color: tty.faint, size: TtySize.meta)
      .copyWith(height: _HowItWorksRow._noteHeight);

  /// How tall [steps] stand at [scaler]'s text size: each title at least a ring tall, each note's
  /// lines and the room round them, the gap under every step but the last — and with [under], one
  /// more line under the last note.
  static double heightOf(
    List<ComputerStep> steps,
    TextScaler scaler, {
    bool under = false,
  }) {
    final title = math.max(
      _HowItWorksRow._ring,
      scaler.scale(TtySize.row) * 1.2,
    );
    final line = scaler.scale(TtySize.meta) * _HowItWorksRow._noteHeight;
    var height = 0.0;
    for (final (i, step) in steps.indexed) {
      height += title;
      if (step.note case final note?) {
        height +=
            '\n'.allMatches(note).length * line +
            line +
            _HowItWorksRow.noteInsets.vertical;
      }
      if (i < steps.length - 1) height += _HowItWorksRow._gap;
    }
    if (under) height += line;
    return height;
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    mainAxisSize: MainAxisSize.min,
    children: [
      for (final (i, step) in steps.indexed)
        _HowItWorksRow(
          number: i + 1,
          title: step.title,
          note: step.note,
          link: i == 0 ? link : null,
          under: i == steps.length - 1 ? under : null,
          last: i == steps.length - 1,
        ),
    ],
  );
}

/// One step: its number in a ring, a thread down to the next one's, what to do, and under it a
/// quieter line when one is needed — between them the first step's [StepsTimeline.link], and
/// [under] the note, the last step's [StepsTimeline.under].
class _HowItWorksRow extends StatelessWidget {
  const _HowItWorksRow({
    required this.number,
    required this.title,
    this.note,
    this.link,
    this.under,
    this.last = false,
  });

  final int number;
  final String title;
  final String? note;
  final Widget? link;
  final Widget? under;
  final bool last;

  static const double _ring = 24;

  /// Under every step but the last: the thread's room down to the next ring.
  ///
  /// ⚠️ With [_threadInset] above and below it, a step with no note under it — "Download and
  /// install Harness" — still leaves a thread long enough to read as one: at 16 and 6 it was four
  /// points, and the two rings read as two dots, not a timeline.
  static const double _gap = 20;

  /// The thread's distance from the ring above it and the ring below.
  static const double _threadInset = 4;

  static const double _noteHeight = 1.45;

  static const EdgeInsets noteInsets = EdgeInsets.only(top: 2, bottom: 6);

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final line = tty.dim.withValues(alpha: 0.6);
    // As tall as its words and the space under them, so the thread runs through that space to the
    // next ring.
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: _ring,
            child: Column(
              children: [
                Container(
                  width: _ring,
                  height: _ring,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(color: line),
                  ),
                  child: Text(
                    '$number',
                    style: tty.style(color: tty.faint, size: TtySize.meta),
                  ),
                ),
                if (!last)
                  Expanded(
                    child: Container(
                      width: 1,
                      margin: const EdgeInsets.symmetric(
                        vertical: _threadInset,
                      ),
                      color: line,
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Padding(
              padding: EdgeInsets.only(bottom: last ? 0 : _gap),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Centred on the ring while it is one line; wraps under itself after.
                  ConstrainedBox(
                    constraints: const BoxConstraints(minHeight: _ring),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        title,
                        maxLines: 1,
                        softWrap: false,
                        overflow: TextOverflow.ellipsis,
                        style: tty.style(
                          size: TtySize.row,
                          weight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                  ?link,
                  // A line each, ending in "…" rather than wrapping: a long account wrapping onto
                  // another would stand the steps taller than [StepsTimeline.heightOf] says.
                  if (note case final note?)
                    Padding(
                      padding: noteInsets,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          for (final part in note.split('\n'))
                            Text(
                              part,
                              maxLines: 1,
                              softWrap: false,
                              overflow: TextOverflow.ellipsis,
                              style: StepsTimeline.noteStyle(tty),
                            ),
                          ?under,
                        ],
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
