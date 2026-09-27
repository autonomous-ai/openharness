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

/// The website's download menu (autonomous.ai/harness-app), row for row.
const kDesktopPlatforms = <DesktopPlatform>[
  (
    key: 'desktop-macos-arm64-dmg',
    label: 'macOS',
    note: 'Apple Silicon',
    icon: Icons.apple,
  ),
  (key: 'desktop-macos-dmg', label: 'macOS', note: 'Intel', icon: Icons.apple),
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
/// │  Apple Silicon                       │
/// │  macOS                           ⇪  │
/// │  Intel                               │
/// │  Linux                           ⇪  │
/// │  Intel/AMD · Ubuntu, Omarchy and more│
/// │  Linux                           ⇪  │
/// │  ARM · Raspberry Pi, ARM servers     │
/// │  CLI                             ⧉  │
/// │  curl -fsSL …/install.sh | bash      │
/// └──────────────────────────────────────┘
/// or open harness.autonomous.ai/desktop there.
///
/// Then open it, and scan the code it shows.
/// Scan to connect ›
/// ```
class SetUpComputerPage extends StatefulWidget {
  const SetUpComputerPage({
    super.key,
    required this.onScan,
    required this.onBack,
    this.loadDownloads,
  });

  /// Back to the first screen's other answer, once the app is on the computer.
  final VoidCallback onScan;
  final VoidCallback onBack;

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
          child: TtyBackButton(onPressed: widget.onBack),
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
                        label: 'CLI',
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
              Text('Then open it, and scan the code it shows.', style: faint),
              const SizedBox(height: 4),
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
            ],
          ),
        ),
      ],
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
