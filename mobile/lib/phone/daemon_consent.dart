import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/daemons/daemon_face.dart';
import 'package:harness_mobile/daemons/render.dart';
import 'package:harness_mobile/daemons/roster.dart';
import 'package:harness_mobile/daemons/zoo_client.dart';

import 'daemon_style.dart';

/// Ask whether the paired daemon may watch, full screen, over everything (the
/// sheet's way to give it). "Let it watch" sends `zoo.consent { watching:
/// true }`; "Not now" and closing send nothing, so the question stays open.
Future<void> showDaemonConsent(NavigatorState navigator, DaemonFace face) {
  final def = face.def;
  return navigator.push(
    PageRouteBuilder<void>(
      opaque: true,
      fullscreenDialog: true,
      transitionDuration: const Duration(milliseconds: 180),
      reverseTransitionDuration: const Duration(milliseconds: 180),
      transitionsBuilder: (context, animation, _, child) =>
          FadeTransition(opacity: animation, child: child),
      pageBuilder: (context, _, _) => DaemonConsentPage(
        zoo: face.zoo,
        name: face.name,
        sprite: def == null
            ? null
            : renderSprite(
                face.roster,
                def,
                face.versionIndex,
                DaemonMood.idle,
              ),
        colour: def?.colorFor(shiny: face.shiny),
        pitch: def?.darkOnly == true,
      ),
    ),
  );
}

/// The consent screen on its own page: the sheet's "Let it watch".
class DaemonConsentPage extends StatelessWidget {
  const DaemonConsentPage({
    super.key,
    required this.zoo,
    required this.name,
    this.sprite,
    this.colour,
    this.pitch = false,
  });

  final ZooClient zoo;
  final String name;
  final String? sprite;
  final Color? colour;
  final bool pitch;

  @override
  Widget build(BuildContext context) {
    void close() => unawaited(Navigator.of(context).maybePop());
    return Scaffold(
      key: const ValueKey('daemon-consent-page'),
      backgroundColor: pitch ? DaemonInk.pitch : DaemonInk.deep,
      body: SafeArea(
        child: Stack(
          children: [
            Positioned.fill(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(20, 56, 20, 24),
                child: DaemonConsent(
                  name: name,
                  sprite: sprite,
                  colour: colour,
                  onWatch: () {
                    zoo.consent(watching: true);
                    close();
                  },
                  onNotNow: close,
                ),
              ),
            ),
            Positioned(
              top: 4,
              right: 4,
              child: IconButton(
                tooltip: 'Close',
                onPressed: close,
                icon: const Icon(Icons.close, color: DaemonInk.dim),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The first-day consent screen, from `daemons/README.md` "What your daemon
/// sees": what it reads, what it writes (nothing until you allow it; lessons
/// only with your yes), and where it runs. Short on purpose: the README and
/// BRAIN.md hold the detail. The reveal shows it after a first hatch's card;
/// the sheet opens it on its own page.
class DaemonConsent extends StatelessWidget {
  const DaemonConsent({
    super.key,
    required this.name,
    required this.onWatch,
    required this.onNotNow,
    this.sprite,
    this.colour,
  });

  /// The daemon as the person knows it: its nickname, else its id.
  final String name;
  final VoidCallback onWatch, onNotNow;

  /// Its sprite, drawn over the words in [colour].
  final String? sprite;
  final Color? colour;

  static const reads = [
    'turns starting and ending, and each turn\'s recap',
    'a question an agent waits on, and the dialog it shows',
    'your next prompt and a turn\'s failures, to notice a lesson',
  ];
  static const readsNever = 'Never a terminal, sub-agents, or its own harness.';
  static const writes = [
    'a journal of its last 2,000 events, keys, tokens, passwords and emails '
        'taken out',
    'lessons, only with your yes',
  ];
  static const runs = [
    'On your computers. The journal stays there, shared only with your other '
        'computers, sealed end to end.',
    'Harness\'s servers keep ids and counts, never a question, command, '
        'recap or lesson.',
    'A model sees it only if you opt in, or talk to it.',
  ];

  @override
  Widget build(BuildContext context) => SizedBox(
    key: const ValueKey('daemon-consent'),
    width: double.infinity,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (sprite != null) ...[
          Center(
            child: ExcludeSemantics(
              child: FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(
                  sprite!,
                  softWrap: false,
                  textScaler: TextScaler.noScaling,
                  style: DaemonInk.mono(
                    size: 22,
                    height: 1,
                    weight: FontWeight.w600,
                    color: colour ?? DaemonInk.ink,
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 14),
        ],
        Semantics(
          header: true,
          child: Text(
            'What $name sees',
            style: DaemonInk.sans(
              size: 22,
              color: DaemonInk.bright,
              weight: FontWeight.w700,
              height: 1.2,
            ),
          ),
        ),
        const SizedBox(height: 6),
        Text(
          'Nothing here happens until you say yes.',
          style: DaemonInk.sans(size: 15, color: DaemonInk.dim),
        ),
        const _Heading('WHAT IT READS'),
        Text(
          'On each of your computers, only its coding agents:',
          style: DaemonInk.sans(size: 14.5),
        ),
        for (final line in reads) _Point(line),
        const SizedBox(height: 4),
        Text(readsNever, style: DaemonInk.sans(size: 14, color: DaemonInk.dim)),
        const _Heading('WHAT IT WRITES'),
        Text(
          'Nothing until you allow it. Then, on that computer:',
          style: DaemonInk.sans(size: 14.5),
        ),
        for (final line in writes) _Point(line),
        const _Heading('WHERE IT RUNS'),
        for (final line in runs) _Point(line),
        const SizedBox(height: 10),
        Text(
          'It starts at watch: it only tells you.',
          style: DaemonInk.sans(size: 14, color: DaemonInk.dim),
        ),
        const SizedBox(height: 18),
        Wrap(
          spacing: 12,
          runSpacing: 8,
          children: [
            DaemonButton(
              'Let $name watch',
              onWatch,
              key: const ValueKey('daemon-consent-watch'),
              hint: 'Lets it read your agents as above',
              filled: true,
            ),
            DaemonButton(
              'Not now',
              onNotNow,
              key: const ValueKey('daemon-consent-not-now'),
              hint: 'It watches nothing. The sheet can let it later',
            ),
          ],
        ),
      ],
    ),
  );
}

class _Heading extends StatelessWidget {
  const _Heading(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 16, bottom: 4),
    child: Semantics(
      header: true,
      child: Text(
        text,
        style: DaemonInk.mono(
          size: 12,
          color: DaemonInk.faint,
          weight: FontWeight.w600,
        ).copyWith(letterSpacing: 1.6),
      ),
    ),
  );
}

/// One thing it reads, writes or keeps: a dash, then the words.
class _Point extends StatelessWidget {
  const _Point(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 3),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ExcludeSemantics(
          child: Text(
            '- ',
            style: DaemonInk.mono(
              size: 14,
              color: DaemonInk.faint,
              height: 1.4,
            ),
          ),
        ),
        Expanded(child: Text(text, style: DaemonInk.sans(size: 14.5))),
      ],
    ),
  );
}
