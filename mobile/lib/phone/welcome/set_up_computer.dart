import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:share_plus/share_plus.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import '../tty.dart';
import '../tty_controls.dart';
import 'how_it_works_video.dart';

/// Where the desktop app is downloaded, for someone typing it on the computer — and every row's
/// link when the release manifest cannot be read.
const kDesktopDownloadUrl = 'https://harness.autonomous.ai/desktop';

/// The desktop release manifest: the one the website's download menu and the desktop app's own
/// updater read, so each row below sends the current build of its file.
const kDesktopManifestUrl =
    'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/metadata.json';

/// The `harness` command alone, for a computer with no desktop — the website menu's CLI row.
const kCliInstall =
    'curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash';

/// One row of the website's download menu: its manifest key, what it says, and its icon.
typedef DesktopPlatform = ({
  String key,
  String label,
  String note,
  IconData icon,
});

/// The website's download menu (autonomous.ai/harness-app), row for row — with a word more on
/// the two Macs, for somebody who never had to know which theirs is: Apple Silicon is every
/// M-series Mac.
const kDesktopPlatforms = <DesktopPlatform>[
  (
    key: 'desktop-macos-arm64-dmg',
    label: 'macOS',
    note: 'Apple Silicon · M1 or later',
    icon: Icons.apple,
  ),
  (
    key: 'desktop-macos-dmg',
    label: 'macOS',
    note: 'Intel · older Macs',
    icon: Icons.apple,
  ),
  (
    key: 'desktop-linux-x64',
    label: 'Linux',
    note: 'Intel/AMD · Ubuntu, Omarchy and more',
    icon: LucideIcons.monitor300,
  ),
  (
    key: 'desktop-linux-arm64',
    label: 'Linux',
    note: 'ARM · Raspberry Pi, ARM servers',
    icon: LucideIcons.monitor300,
  ),
];

/// Manifest key → the file's URL. Empty when the manifest cannot be read.
typedef DesktopDownloadsLoader = Future<Map<String, String>> Function();

Future<Map<String, String>> loadDesktopDownloads({Dio? dio}) async {
  try {
    final res =
        await (dio ??
                Dio(
                  BaseOptions(
                    connectTimeout: const Duration(seconds: 10),
                    receiveTimeout: const Duration(seconds: 10),
                  ),
                ))
            .get<Object?>(kDesktopManifestUrl);
    final raw = res.data;
    final data = raw is String ? jsonDecode(raw) : raw;
    if (data is! Map) return const {};
    return {
      for (final MapEntry(:key, :value) in data.entries)
        if (key is String && value is Map && value['url'] is String)
          key: value['url'] as String,
    };
  } catch (_) {
    return const {};
  }
}

/// **Not yet — set it up**: getting Harness onto the computer, from the phone — the website's
/// download menu, where a row SENDS its file (AirDrop to the Mac beside you, or Messages or email
/// to yourself) because a phone cannot install it.
///
/// ```
/// ‹
/// Get Harness for
/// your computer
///
/// Send it to your computer:
/// ┌──────────────────────────────────────┐
/// │  macOS                           ⇪  │
/// │  Apple Silicon · M1 or later         │
/// │  macOS                           ⇪  │
/// │  Intel · older Macs                  │
/// │  Linux                           ⇪  │
/// │  Intel/AMD · Ubuntu, Omarchy and more│
/// │  Linux                           ⇪  │
/// │  ARM · Raspberry Pi, ARM servers     │
/// │  Command line                    ⧉  │
/// │  curl -fsSL …/install.sh | bash      │
/// └──────────────────────────────────────┘
/// or open harness.autonomous.ai/desktop there.
///
/// Then, on your computer:
/// 1  Install Harness, and open it.
/// 2  Sign in with Google or Apple.
/// 3  Open Add Phone… and scan its code. On a Mac, it’s in the Harness menu.
/// Scan to connect ›
/// ```
class SetUpComputerPage extends StatefulWidget {
  const SetUpComputerPage({
    super.key,
    required this.onScan,
    this.onBack,
    this.onTrySample,
    this.status,
    this.trailing = const [],
    this.loadDownloads,
    this.account,
    this.topTrailing,
  });

  /// At the right of the top row, across from `‹ Back` — on the home screen, where there is no back,
  /// the way to Settings (`PhoneSettingsButton`).
  final Widget? topTrailing;

  /// The account this phone is signed in to, when it is: the computer has to sign in to the same
  /// one, and the steps say so by name. Null for a phone not signed in yet — its scan signs it in
  /// to whichever account the computer chose.
  final String? account;

  /// Back to the first screen's other answer, once the app is on the computer — or, signed in,
  /// the scan that pairs this phone with the computer just set up.
  final VoidCallback onScan;

  /// Null draws no back button: the page is a home screen, not a pushed one.
  final VoidCallback? onBack;

  /// Opens the offline sample before the user sets up a computer.
  final VoidCallback? onTrySample;

  /// A line under the title about what is going on — signed in, the watch for the computer.
  final Widget? status;

  /// Rows after everything else — signed in, the sample to try while waiting.
  final List<Widget> trailing;

  /// Stands in for the manifest in tests. Null reads [kDesktopManifestUrl].
  final DesktopDownloadsLoader? loadDownloads;

  @override
  State<SetUpComputerPage> createState() => _SetUpComputerPageState();
}

class _SetUpComputerPageState extends State<SetUpComputerPage> {
  bool _copied = false;
  Timer? _copiedTimer;

  /// Read as the page opens, so a tap shares at once; a tap before it lands waits for it.
  late final Future<Map<String, String>> _downloads =
      (widget.loadDownloads ?? loadDesktopDownloads)();

  @override
  void dispose() {
    _copiedTimer?.cancel();
    super.dispose();
  }

  /// The share sheet with [platform]'s file: AirDrop straight to the computer beside you, or
  /// Messages or email to yourself. Anchored to the row for iPad, where the sheet is a popover.
  Future<void> _send(BuildContext row, DesktopPlatform platform) async {
    final box = row.findRenderObject() as RenderBox?;
    final origin = box == null
        ? null
        : box.localToGlobal(Offset.zero) & box.size;
    final url = (await _downloads)[platform.key] ?? kDesktopDownloadUrl;
    await SharePlus.instance.share(
      ShareParams(
        uri: Uri.parse(url),
        subject: 'Harness for ${platform.label} (${platform.note})',
        sharePositionOrigin: origin,
      ),
    );
  }

  void _copy() {
    unawaited(Clipboard.setData(const ClipboardData(text: kCliInstall)));
    HapticFeedback.selectionClick();
    _copiedTimer?.cancel();
    setState(() => _copied = true);
    _copiedTimer = Timer(const Duration(seconds: 2), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  /// What to do on the computer once the file is there. Signed in, the account is named: a
  /// computer signed in to another one never shows up here, and nothing else on the page says so.
  List<String> get _steps => [
    'Install Harness, and open it.',
    switch (widget.account) {
      final account? =>
        'Sign in with Google or Apple, as $account — the account on this '
            'phone.',
      null => 'Sign in with Google or Apple.',
    },
    'Open Add Phone… and scan its code. On a Mac, it’s in the Harness menu.',
  ];

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final faint = tty.style(color: tty.faint, size: TtySize.meta);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // One row whatever is in it: the back button's height, so the page starts at the same place
        // with a back, a trailing control, both, or neither.
        SizedBox(
          height: 44,
          child: Row(
            children: [
              if (widget.onBack case final onBack?)
                TtyBackButton(onPressed: onBack),
              const Spacer(),
              ?widget.topTrailing,
            ],
          ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(Tty.origin, 8, Tty.origin, 24),
            children: [
              Text(
                'Get Harness for\nyour computer',
                style: tty
                    .style(size: TtySize.display, weight: FontWeight.w600)
                    .copyWith(height: 34 / 28, letterSpacing: -0.6),
              ),
              if (widget.onTrySample case final onTrySample?) ...[
                const SizedBox(height: 16),
                TtyTap(
                  onTap: onTrySample,
                  semanticsLabel:
                      'Try the sample. No account or computer needed.',
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        TtyText('Try the sample ›', size: TtySize.title),
                        const SizedBox(height: 4),
                        Text('No account or computer needed.', style: faint),
                      ],
                    ),
                  ),
                ),
              ],
              if (widget.status case final status?) ...[
                const SizedBox(height: 18),
                status,
              ],
              const SizedBox(height: 28),
              Text('Send it to your computer:', style: faint),
              const SizedBox(height: 8),
              DecoratedBox(
                decoration: BoxDecoration(
                  color: ttyRaised(tty),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Column(
                    children: [
                      for (final platform in kDesktopPlatforms)
                        Builder(
                          builder: (row) => _DownloadRow(
                            icon: platform.icon,
                            label: platform.label,
                            note: platform.note,
                            action: LucideIcons.share300,
                            actionLabel: 'Send',
                            onTap: () => unawaited(_send(row, platform)),
                          ),
                        ),
                      _DownloadRow(
                        icon: LucideIcons.squareTerminal300,
                        // Not "CLI": the one row a newcomer would have to look up.
                        label: 'Command line',
                        note: _copied
                            ? 'copied'
                            : 'curl -fsSL …/install.sh | bash',
                        noteColor: _copied ? tty.green : null,
                        action: LucideIcons.copy300,
                        actionLabel: 'Copy',
                        onTap: _copy,
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 10),
              Text.rich(
                TextSpan(
                  children: [
                    const TextSpan(text: 'or open '),
                    TextSpan(
                      text: kDesktopDownloadUrl.replaceFirst('https://', ''),
                      style: tty.style(size: TtySize.meta),
                    ),
                    const TextSpan(text: ' there.'),
                  ],
                ),
                style: faint,
              ),
              const SizedBox(height: 28),
              // ⚠️ **Sign in, and with which buttons.** The desktop app opens signed out, and shows no
              // code until it is signed in — "Then open it, and scan the code it shows" sent people to
              // an Add Phone that only said "Sign in to add your phone.". Google or Apple by name: its
              // third way, "Scan with your phone", needs a phone that is already signed in.
              //
              // Three numbered steps in the page's own ink, not one faint sentence: they are what the
              // person does next, and folded into a line under the download menu they read as a
              // footnote to it.
              Text('Then, on your computer:', style: faint),
              const SizedBox(height: 10),
              for (final (index, step) in _steps.indexed)
                _SetUpStep(number: index + 1, text: step),
              const SizedBox(height: 2),
              Align(
                alignment: Alignment.centerLeft,
                child: Transform.translate(
                  // The button's own inset, so its words sit on the gutter.
                  offset: const Offset(-12, 0),
                  child: TtyTextButton(
                    label: 'Scan to connect ›',
                    onPressed: widget.onScan,
                  ),
                ),
              ),
              const SizedBox(height: 32),
              // Not at the computer: what it is like, in 30 seconds.
              Align(
                alignment: Alignment.centerLeft,
                child: Transform.translate(
                  offset: const Offset(-12, 0),
                  child: TtyTextButton(
                    label: 'See how it works ▶',
                    color: tty.faint,
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const HowItWorksVideoPage(),
                      ),
                    ),
                  ),
                ),
              ),
              ...widget.trailing,
            ],
          ),
        ),
      ],
    );
  }
}

/// One numbered step: the number in the terminal's green in a column of its own, the words beside
/// it wrapping under themselves rather than under the number.
class _SetUpStep extends StatelessWidget {
  const _SetUpStep({required this.number, required this.text});

  final int number;
  final String text;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final style = tty.style(size: TtySize.row);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // One digit in a monospace face: every number is the same width, so the steps' words
          // line up without a column of fixed width that a larger text size would outgrow.
          Text(
            '$number',
            style: style.copyWith(
              color: tty.green,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(child: Text(text, style: style)),
        ],
      ),
    );
  }
}

/// One row of the menu: its icon, what it is and for which computer, and what a tap does.
class _DownloadRow extends StatelessWidget {
  const _DownloadRow({
    required this.icon,
    required this.label,
    required this.note,
    required this.action,
    required this.actionLabel,
    required this.onTap,
    this.noteColor,
  });

  final IconData icon;
  final String label;
  final String note;
  final Color? noteColor;
  final IconData action;
  final String actionLabel;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: '$actionLabel $label, $note',
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 14, 10),
          child: Row(
            children: [
              Icon(icon, size: 22, color: tty.faint),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      label,
                      style: tty.style(
                        size: TtySize.row,
                        weight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      note,
                      style: tty.style(
                        color: noteColor ?? tty.faint,
                        size: TtySize.meta,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Icon(action, size: 18, color: tty.faint),
            ],
          ),
        ),
      ),
    );
  }
}
