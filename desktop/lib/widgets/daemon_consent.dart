import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart';
import 'desktop_chrome.dart';

/// Where the first-day consent is.
enum DaemonConsentStep {
  /// What it reads, writes and where it runs: "Let tim watch" or "Not now".
  watch,

  /// A second, separate step, only after a yes: "Let tim suggest answers?"
  suggest,
}

/// What the daemon sees, as the first-day screen says it (`daemons/README.md`,
/// "What your daemon sees"), one short row each.
List<(String, String)> daemonConsentRows(String name) => [
  (
    'reads',
    "when your agents' turns start and end, the question one waits on "
        '(the whole dialog), each turn\'s short recap, and your next prompt '
        'after a turn, to notice a lesson. never a plain terminal, a '
        'sub-agent, or your files.',
  ),
  (
    'writes',
    'nothing to your projects until you allow it: a journal on each '
        'computer, with keys, tokens and passwords taken out. a lesson only '
        'with your yes.',
  ),
  (
    'runs',
    'in harnessd, on each of your computers. the journal stays there; the '
        'Harness backend never reads it. a model sees it only if you turn one '
        'on, or talk to $name.',
  ),
  ('does', 'at watch, where it starts, nothing but tell you.'),
];

/// The first-day consent (`zoo.consent`): after the first hatch, and in the
/// panel until it is answered. "Let `name` watch" sends `watching: true` and
/// the dial stays at `watch`; "Not now" sends `watching: false`, and nothing
/// is watched. Only after a yes, and as its own step, it offers `suggest`.
class DaemonConsent extends StatefulWidget {
  const DaemonConsent({
    super.key,
    required this.name,
    required this.step,
    required this.onWatch,
    required this.onNotNow,
    required this.onSuggest,
    required this.onKeepWatch,
    this.autofocus = true,
  });
  final String name;
  final DaemonConsentStep step;
  final VoidCallback onWatch, onNotNow, onSuggest, onKeepWatch;
  final bool autofocus;

  @override
  State<DaemonConsent> createState() => _DaemonConsentState();
}

class _DaemonConsentState extends State<DaemonConsent> {
  final _yes = FocusNode(debugLabel: 'Daemon consent yes');

  @override
  void initState() {
    super.initState();
    if (widget.autofocus) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _yes.requestFocus();
      });
    }
  }

  @override
  void didUpdateWidget(DaemonConsent old) {
    super.didUpdateWidget(old);
    if (old.step != widget.step && widget.autofocus) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _yes.requestFocus();
      });
    }
  }

  @override
  void dispose() {
    _yes.dispose();
    super.dispose();
  }

  Widget _button(
    String key,
    String label,
    VoidCallback onPressed, {
    FocusNode? focusNode,
  }) => DesktopPill(
    key: ValueKey(key),
    label: label,
    focusNode: focusNode,
    onPressed: onPressed,
  );

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final name = widget.name;
    if (widget.step == DaemonConsentStep.suggest) {
      return Column(
        key: const ValueKey('daemon-consent-suggest'),
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Let $name suggest answers?', style: DesktopChrome.heading()),
          const SizedBox(height: 12),
          Text(
            'At suggest, $name proposes answers to prompts it can read with '
            'certainty (reads, tests, builds, in-project edits), and every '
            'one waits for your key. It never approves a push, rm -rf, sudo, '
            'deploy, publish, drop or merge.',
            style: DesktopChrome.text(size: 13),
          ),
          const SizedBox(height: 12),
          Text(
            'Change it any time in the daemon’s Settings tab.',
            style: DesktopChrome.metadata(),
          ),
          const SizedBox(height: 20),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _button(
                'daemon-consent-suggest-yes',
                'Let $name suggest',
                widget.onSuggest,
                focusNode: _yes,
              ),
              _button(
                'daemon-consent-keep-watch',
                'Keep it at watch',
                widget.onKeepWatch,
              ),
            ],
          ),
        ],
      );
    }
    return Column(
      key: const ValueKey('daemon-consent'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('What $name sees', style: DesktopChrome.heading()),
        const SizedBox(height: 16),
        for (final (what, words) in daemonConsentRows(name))
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${what[0].toUpperCase()}${what.substring(1)}',
                  style: DesktopChrome.control(medium: true),
                ),
                const SizedBox(height: 4),
                Text(words, style: DesktopChrome.text(size: 13)),
              ],
            ),
          ),
        Text(
          'Nothing is watched until you say yes.',
          style: DesktopChrome.metadata(),
        ),
        const SizedBox(height: 20),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            _button(
              'daemon-consent-watch',
              'Let $name watch',
              widget.onWatch,
              focusNode: _yes,
            ),
            _button('daemon-consent-not-now', 'Not now', widget.onNotNow),
          ],
        ),
      ],
    );
  }
}
