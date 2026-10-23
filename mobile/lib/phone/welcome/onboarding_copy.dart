/// Every word of the phone's onboarding, in one place — the "Every word" table of
/// `docs/research/2026-10-11-phone-onboarding` (agreed with the owner, 2026-10-12).
///
/// ```
/// ① Welcome        Manage all your agents on all your computers from your phone.
///                  [Continue with Google] [Continue with Apple]
///                  under them, as words: Continue with email · QR code
///                  QR code → the camera: How to get the QR code, its steps
/// ② Your computer  On your computer, go to   [autonomous.ai/go ⇪]
///                  under the picture: Looking for your computer▌
///                  under the link: (1) Download and install Harness  (2) Sign in, Use you@…
///                  under the account: Not you? Sign out
///   The Mac joins  MacBook Pro is ready.
/// ③ The session    by the mic, once: Send it, or say anything.
/// ```
///
/// ⚠️ **One source, because the screens share one story.** The same step is named the same way on
/// every screen it appears on — the welcome, Computers ▸ Add computer, the desktop's `/go` page — and
/// a word changed here is changed everywhere the phone says it. The desktop's own words (its pane
/// title's hover line, "✓ Added by …" at the end of its tour) are the desktop's; keep them in step
/// with these.
///
/// ⚠️ **Nothing else on these screens** (owner, 2026-10-12): no sample link, no tips, no notification
/// prompt, no page dots, and never the word "network". ② says what to do on the computer — which
/// account to sign in with, and where Add Phone is (owner, 2026-10-12, after trying it):
/// until the phone adds the computer itself, the computer signs in on its own, and that is where
/// people stood stuck.
/// Exception approved by the owner, Tony, 2026-10-22: one suggestion with a Send button above the
/// mic in the first session, once — Desktop's pre-typed starter when the pane has one, otherwise the
/// first of the New Harness first-task ideas. It goes after Send or a spoken message; no cycling and
/// no other additions were approved.
/// Owner, 2026-10-23: that session (OpenCode, Claude Code, Codex) opens with the keyboard up over the
/// task typed into the prompt — Claude Code's and Codex's typed by the phone — and its mic pretends:
/// no microphone and no permission prompt, a second tap sends the prompt as it stands.
abstract final class OnboardingCopy {
  /// ① The welcome's headline: everything lit, the promise.
  static const welcome =
      'Manage all your agents on all your computers from your phone.';

  /// ① Under the accounts, in their quiet line after Continue with email (owner, 2026-10-14): the
  /// camera, for the code a signed-in computer's Add Phone shows, which signs this phone in to that
  /// computer's account with nothing to type. The line says [qrCode]; a screen reader hears
  /// [scanQrCode].
  static const qrCode = 'QR code';
  static const scanQrCode = 'Scan QR from computer';

  /// ① Under the accounts, first in their quiet line (owner, 2026-10-14): an emailed code — the
  /// desktop login's words for it.
  static const continueWithEmail = 'Continue with email';

  /// ① Under the picture, when the camera read a computer's own sign-in code (its "Scan with your
  /// phone"): this phone needs an account before it can approve one.
  static const signInFirst = 'Sign in first, then approve your computer.';

  /// ② The headline over the address — and, under the camera, the first step's title, over the
  /// same address (`set_up_computer.dart`'s [computerSteps]).
  static const goToHeadline = 'On your computer, go to';

  /// ② The address, as written on the button that sends it: short enough to type off the phone.
  static const goAddress = 'autonomous.ai/go';

  /// ② The address the button sends — the download for whatever computer opens it. The main site
  /// sends `/go` on to Harness's download page (`harness.autonomous.ai/desktop`), which picks the
  /// file for the computer that opens it.
  static const goUrl = 'https://autonomous.ai/go';

  /// ② Under the picture, while the laptop breathes.
  static const looking = 'Looking for your computer';

  /// ② The first step under the link: getting Harness from it — the link is the download, and the
  /// step says so (owner, 2026-10-19) (`set_up_computer.dart`'s [goToSteps]; the second is signing
  /// in with this account). Under the camera, the note under the first step's address.
  static const installStep = 'Download and install Harness';

  /// ② Right under the account the steps name, at home: the question, and the way out after it.
  static const notYou = 'Not you?';
  static const signOut = 'Sign out';

  /// The moment the computer joins — its own name, as the account knows it.
  static String ready(String computer) => '$computer is ready.';

  /// Under "… is ready.", past the moment, while the computer has no session yet — its own tour
  /// starts one. Not the spec's: its computer always had one by then.
  static const waitingForSession = 'Waiting for its first session';

  /// What the phone says by the mic the first time it opens a session — one line, once.
  static const micSendIt = 'Send it, or say anything.';
  static const micPickUp = 'Pick up where you left off.';
  static const micSayWhat = 'Say what to build, or send this:';
  static const micTalk = 'Talk to it.';
}
