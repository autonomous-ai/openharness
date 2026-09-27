import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import '../tty.dart';
import '../tty_controls.dart';
import 'how_it_works.dart';

/// The commands that put Harness on a computer, in order — the README's "Get started".
const kSetUpCommands = [
  'curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash',
  'harness login',
  'harness remote-password set',
  'harness start',
];

/// Where the desktop app is downloaded.
const kDesktopAppUrl = 'https://harness.autonomous.ai/desktop';

/// How to put Harness on a computer, for someone who has not — the one idea a phone app for agents
/// has to get across first: **the agents run on your computer, and the phone connects to it.**
///
/// Two ways, the app or a terminal, each with its steps to copy. Signed in, the page also watches
/// for the computer to appear (every few seconds, since nothing tells the phone), and the app moves
/// on by itself the moment it does. Signed out, it is the "New here?" page behind the welcome.
class ConnectComputerPage extends StatefulWidget {
  const ConnectComputerPage({
    super.key,
    required this.notifier,
    this.signedIn = true,
    this.onBack,
    this.onTrySample,
  });

  final AppNotifier notifier;

  /// Watch for the computer and say whose account it must be signed in to.
  final bool signedIn;

  /// Shown as `‹ Back` when set.
  final VoidCallback? onBack;

  /// Opens the sample; see `PhoneWelcome.onTrySample`.
  final Future<Object?> Function(BuildContext context)? onTrySample;

  @override
  State<ConnectComputerPage> createState() => _ConnectComputerPageState();
}

class _ConnectComputerPageState extends State<ConnectComputerPage> {
  Timer? _watch;
  String? _copied;
  Timer? _copiedTimer;

  /// Which way the steps are shown: the terminal first — who this is for lives in one — or the
  /// Mac app.
  bool _terminal = true;

  /// The steps, sent to [email] through the phone's own Mail — there is no server doing it, and a
  /// message in your own inbox is where the computer will find it.
  Future<void> _emailSteps(String? email) async {
    final body = [
      'Set up Harness on your computer:',
      '',
      'Mac app: $kDesktopAppUrl',
      '  Sign in${email == null ? '' : ' with $email'}, then Machines → this computer → Set password.',
      '',
      'Or, in a terminal:',
      for (final line in kSetUpCommands) '  $line',
      '',
      'Then open Harness on your phone — it finds the computer by itself.',
    ].join('\n');
    final uri = Uri(
      scheme: 'mailto',
      path: email ?? '',
      query: _mailQuery({
        'subject': 'Set up Harness on your computer',
        'body': body,
      }),
    );
    try {
      final opened = await launchUrl(uri);
      if (!opened && mounted) _copy('commands', body);
    } on Exception {
      if (mounted) _copy('commands', body);
    }
  }

  /// `mailto:` wants `%20`, not `+`, between words.
  static String _mailQuery(Map<String, String> fields) => fields.entries
      .map((e) => '${e.key}=${Uri.encodeComponent(e.value)}')
      .join('&');

  @override
  void initState() {
    super.initState();
    if (widget.signedIn) {
      // Nothing pushes a new machine to the phone: ask again every few seconds while this is up.
      _watch = Timer.periodic(const Duration(seconds: 5), (_) {
        if (mounted) unawaited(widget.notifier.refreshMachines());
      });
    }
  }

  @override
  void dispose() {
    _watch?.cancel();
    _copiedTimer?.cancel();
    super.dispose();
  }

  void _copy(String what, String text) {
    unawaited(Clipboard.setData(ClipboardData(text: text)));
    HapticFeedback.lightImpact();
    _copiedTimer?.cancel();
    setState(() => _copied = what);
    _copiedTimer = Timer(const Duration(seconds: 2), () {
      if (mounted) setState(() => _copied = null);
    });
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final email = widget.notifier.currentUser?.email;
    final account = email == null ? 'the same account' : email;
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (widget.onBack != null)
              Align(
                alignment: Alignment.centerLeft,
                child: TtyBackButton(onPressed: widget.onBack),
              ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(
                  Tty.origin,
                  16,
                  Tty.origin,
                  24,
                ),
                children: [
                  TtyText(
                    'Set up your computer',
                    size: 24,
                    weight: FontWeight.w600,
                  ),
                  const SizedBox(height: 12),
                  Text(
                    'Your agents run on your computer — this phone is the '
                    'remote. It takes about two minutes, once.',
                    style: tty.style(size: TtySize.row, color: tty.faint),
                  ),
                  const SizedBox(height: 24),
                  // Signed in: say so — and that the page is watching — where it is read first.
                  if (widget.signedIn) ...[
                    _Watching(account: email),
                    const SizedBox(height: 16),
                  ],
                  // Most people meet this page on the phone, away from the computer: the one thing
                  // to do from here is send the steps to where they will be read.
                  TtyPrimaryButton(
                    label: 'Email me the setup link',
                    onPressed: () => unawaited(_emailSteps(email)),
                  ),
                  const SizedBox(height: 6),
                  Center(
                    child: TtyText(
                      'Open it on your Mac or Linux computer.',
                      size: TtySize.meta,
                      color: tty.faint,
                    ),
                  ),
                  const SizedBox(height: 32),
                  TtyText(
                    'Already at your computer?',
                    size: TtySize.row,
                    weight: FontWeight.w600,
                  ),
                  const SizedBox(height: 12),
                  _Choice(
                    options: const ['Terminal', 'Mac app'],
                    selected: _terminal ? 0 : 1,
                    onSelected: (index) =>
                        setState(() => _terminal = index == 0),
                  ),
                  const SizedBox(height: 14),
                  if (!_terminal) ...[
                    _CopyLine(
                      text: 'harness.autonomous.ai/desktop',
                      copied: _copied == 'link',
                      onCopy: () => _copy('link', kDesktopAppUrl),
                    ),
                    const SizedBox(height: 10),
                    Text(
                      'Download it, sign in with $account, then open Machines '
                      '(your computers) → this Mac → Set password. That is '
                      'the phone password you type here next.',
                      style: tty.style(size: TtySize.meta, color: tty.faint),
                    ),
                  ] else ...[
                    _CommandBlock(
                      lines: kSetUpCommands,
                      copied: _copied == 'commands',
                      onCopy: () =>
                          _copy('commands', kSetUpCommands.join('\n')),
                    ),
                    const SizedBox(height: 10),
                    Text.rich(
                      TextSpan(
                        style: tty.style(size: TtySize.meta, color: tty.faint),
                        children: [
                          TextSpan(
                            text: 'harness login',
                            style: tty.style(
                              size: TtySize.meta,
                              color: tty.green,
                            ),
                          ),
                          TextSpan(
                            text: ' signs the computer in to $account. ',
                          ),
                          TextSpan(
                            text: 'remote-password',
                            style: tty.style(
                              size: TtySize.meta,
                              color: tty.green,
                            ),
                          ),
                          const TextSpan(
                            text:
                                ' sets your phone password — what this '
                                'phone unlocks it with. It never leaves your '
                                'devices.',
                          ),
                        ],
                      ),
                    ),
                  ],
                  const SizedBox(height: 32),
                  Center(
                    child: TtyTextButton(
                      label: 'How Harness works',
                      onPressed: () => unawaited(openHowItWorks(context)),
                    ),
                  ),
                  if (widget.onTrySample != null) ...[
                    const SizedBox(height: 16),
                    Center(
                      child: TtyTextButton(
                        label: widget.signedIn
                            ? 'Try the sample while you wait'
                            : 'Try the sample',
                        onPressed: () =>
                            unawaited(widget.onTrySample!(context)),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Two or three ways to do one thing, one chosen — iOS's segmented control, drawn flat.
class _Choice extends StatelessWidget {
  const _Choice({
    required this.options,
    required this.selected,
    required this.onSelected,
  });

  final List<String> options;
  final int selected;
  final ValueChanged<int> onSelected;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Container(
      height: 40,
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: ttyRaised(tty),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          for (var i = 0; i < options.length; i++)
            Expanded(
              child: Semantics(
                button: true,
                selected: i == selected,
                label: options[i],
                excludeSemantics: true,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () {
                    HapticFeedback.selectionClick();
                    onSelected(i);
                  },
                  child: Container(
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      // The chosen one lifts off the track, as iOS draws it.
                      color: i == selected
                          ? Color.alphaBlend(
                              tty.text.withValues(alpha: 0.2),
                              tty.ground,
                            )
                          : Colors.transparent,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: TtyText(
                      options[i],
                      size: TtySize.meta,
                      weight: i == selected ? FontWeight.w600 : FontWeight.w400,
                      color: i == selected ? tty.text : tty.faint,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// One line to copy — a link — with `Copy` at its end.
class _CopyLine extends StatelessWidget {
  const _CopyLine({
    required this.text,
    required this.copied,
    required this.onCopy,
  });

  final String text;
  final bool copied;
  final VoidCallback onCopy;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Container(
      decoration: BoxDecoration(
        color: ttyRaised(tty),
        borderRadius: BorderRadius.circular(6),
      ),
      padding: const EdgeInsets.only(left: 12),
      child: Row(
        children: [
          Expanded(
            child: TtyText(text, size: TtySize.meta, color: tty.text),
          ),
          TtyTextButton(
            label: copied ? 'Copied' : 'Copy',
            color: copied ? tty.green : null,
            onPressed: onCopy,
          ),
        ],
      ),
    );
  }
}

/// Commands as a terminal would show them, `$ ` in front of each, and `Copy all` under them.
class _CommandBlock extends StatelessWidget {
  const _CommandBlock({
    required this.lines,
    required this.copied,
    required this.onCopy,
  });

  final List<String> lines;
  final bool copied;
  final VoidCallback onCopy;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Container(
      decoration: BoxDecoration(
        color: ttyRaised(tty),
        borderRadius: BorderRadius.circular(6),
      ),
      padding: const EdgeInsets.fromLTRB(12, 10, 0, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final line in lines)
            Padding(
              padding: const EdgeInsets.only(bottom: 6, right: 12),
              child: Text.rich(
                TextSpan(
                  children: [
                    TextSpan(
                      text: r'$ ',
                      style: tty.style(color: tty.green, size: TtySize.meta),
                    ),
                    TextSpan(
                      text: line,
                      style: tty.style(size: TtySize.meta),
                    ),
                  ],
                ),
              ),
            ),
          Align(
            alignment: Alignment.centerRight,
            child: TtyTextButton(
              label: copied ? 'Copied' : 'Copy all',
              color: copied ? tty.green : null,
              onPressed: onCopy,
            ),
          ),
        ],
      ),
    );
  }
}

/// `Looking for your computer…` with a terminal spinner — the page is watching.
class _Watching extends StatefulWidget {
  const _Watching({this.account});

  /// Whose computer it is waiting for.
  final String? account;

  @override
  State<_Watching> createState() => _WatchingState();
}

class _WatchingState extends State<_Watching> {
  // The terminal's oldest spinner — every monospace face has these four.
  static const _frames = ['|', '/', '-', r'\'];
  int _frame = 0;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(milliseconds: 150), (_) {
      if (mounted) setState(() => _frame = (_frame + 1) % _frames.length);
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: ttyRaised(tty),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        children: [
          TtyText(_frames[_frame], color: tty.green, size: TtySize.row),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              widget.account == null
                  ? 'Waiting for your computer…'
                  : 'Signed in as ${widget.account}. Waiting for your '
                        'computer…',
              style: tty.style(size: TtySize.meta, color: tty.text),
            ),
          ),
        ],
      ),
    );
  }
}
