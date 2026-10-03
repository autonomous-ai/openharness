import 'package:flutter/material.dart';

import '../phone_navigation.dart';
import '../tty.dart';
import '../tty_controls.dart';

/// Opens [HowItWorksPage].
Future<void> openHowItWorks(BuildContext context) =>
    Navigator.of(context).push(phoneRoute((_) => const HowItWorksPage()));

/// The words Harness uses and the gestures nothing on screen spells out — in one page, in
/// plain language, reachable from Settings, from Find (`help`) and from setting up a computer.
class HowItWorksPage extends StatelessWidget {
  const HowItWorksPage({super.key});

  static const _concepts = [
    (
      'Computer',
      'Where your agents actually run — a Mac or a Linux machine with Harness '
          'on it. This phone connects to it; nothing runs on the phone.',
    ),
    ('Agent', 'The AI that does the work: Claude Code, Codex, and others.'),
    (
      'Harness',
      'One running session of an agent, with its own conversation and working '
          'context. You can run several harnesses with the same agent. '
          'They keep going when you close the app.',
    ),
    (
      'Swarm',
      'A group of harnesses, shown together in the workspace. Add a harness to '
          'include it. With Swarm collaboration enabled in Experimental settings, '
          'their agents can consult peers in the same swarm.',
    ),
    (
      'Project',
      'The folder a harness works in. In a git project it can take its own '
          'branch in a new worktree, so two harnesses never trip over each other.',
    ),
    (
      'Phone password',
      'For a computer with no Harness app to show a code (a server): unlocks '
          'it from this phone, once, over an end-to-end encrypted link. It never '
          'leaves your devices. A Mac shows a code to scan instead.',
    ),
  ];

  static const _gestures = [
    ('swipe right', 'all your harnesses'),
    ('swipe left', 'start a new harness'),
    ('tap the title', 'rename, restart, paste'),
    ('hold the title', 'back to the last harness'),
    ('esc', 'stop what it is doing'),
    ('the mic', 'talk to the harness on screen'),
  ];

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: TtyBackButton(
                onPressed: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(
                  Tty.origin,
                  8,
                  Tty.origin,
                  32,
                ),
                children: [
                  TtyText(
                    'How Harness works',
                    size: 24,
                    weight: FontWeight.w600,
                  ),
                  const SizedBox(height: 20),
                  for (final (word, meaning) in _concepts) ...[
                    TtyText(
                      word,
                      size: TtySize.row,
                      weight: FontWeight.w600,
                      color: tty.green,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      meaning,
                      style: tty.style(size: TtySize.meta, color: tty.text),
                    ),
                    const SizedBox(height: 18),
                  ],
                  const SizedBox(height: 8),
                  TtyText(
                    'On the phone',
                    size: TtySize.row,
                    weight: FontWeight.w600,
                  ),
                  const SizedBox(height: 10),
                  for (final (gesture, does) in _gestures)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SizedBox(
                            width: 128,
                            child: TtyText(
                              gesture,
                              size: TtySize.meta,
                              color: tty.green,
                            ),
                          ),
                          Expanded(
                            child: Text(
                              does,
                              style: tty.style(size: TtySize.meta),
                            ),
                          ),
                        ],
                      ),
                    ),
                  const SizedBox(height: 10),
                  Text(
                    'When a harness asks you something, its answers appear as '
                    'buttons at the bottom of the screen. Tap one, or just say '
                    '"yes", "no" or the number.',
                    style: tty.style(size: TtySize.meta, color: tty.faint),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
