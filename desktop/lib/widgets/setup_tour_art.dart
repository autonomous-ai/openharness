import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import 'engine_identity.dart';

/// The welcome tour's seven pictures, after the approved onboarding render
/// (`docs/research/2026-10-08-onboarding-redesign/index.html`).
///
/// Each is drawn from ordinary widgets on one fixed canvas and scaled to the
/// room its slide has ([TourArtFrame]), so its proportions hold at every
/// window size. They are pictures, not controls: static, theme-aware, and
/// read by a screen reader as one labelled image.
const tourArtSize = Size(600, 480);

/// Scales a picture drawn on [tourArtSize] into the space it is given.
///
/// Text inside is part of the drawing, so it is laid out without the
/// platform's text scaling: enlarged text would only push the picture's own
/// labels out of their cards. The slide's real text beside it does scale.
class TourArtFrame extends StatelessWidget {
  const TourArtFrame({super.key, required this.label, required this.child});

  /// What the picture shows, for a screen reader.
  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      image: true,
      label: label,
      excludeSemantics: true,
      child: FittedBox(
        fit: BoxFit.contain,
        child: MediaQuery.withNoTextScaling(
          child: SizedBox.fromSize(size: tourArtSize, child: child),
        ),
      ),
    );
  }
}

// Engine ids, drawn by [_mark].
const _claude = 'claude';
const _codex = 'codex';
const _opencode = 'opencode';
const _cursor = 'cursor';
const _pi = 'pi';

// The pictures' own few tones, all read off the design tokens so a light
// palette draws them light.
Color get _amber => grid.AppPalette.onboardingAccent;
Color get _ink => grid.AppPalette.textPrimary;
Color get _soft => grid.AppPalette.textSecondary;
Color get _faint => grid.AppPalette.textFaint;
Color get _ok => grid.AppPalette.online;
Color get _card => grid.AppPalette.cardBg;
Color get _rim => grid.AppPalette.divider;
// A pane's terminal ground: a step below the card it sits in.
Color get _paneGround => grid.AppPalette.panelBg;
List<BoxShadow> get _lift => [
  BoxShadow(
    color: Colors.black.withValues(alpha: grid.AppTheme.pick(0.10, 0.45)),
    blurRadius: 38,
    offset: const Offset(0, 19),
  ),
];

TextStyle _sans(double size, {Color? color, FontWeight? weight}) =>
    grid.AppType.body(
      color: color ?? _ink,
      fontWeight: weight,
    ).copyWith(fontSize: size, height: 1.3);

TextStyle _mono(double size, {Color? color}) => grid.AppType.monoLabel(
  color: color ?? _soft,
  fontWeight: FontWeight.w400,
).copyWith(fontSize: size, height: 1.55);

/// An agent's mark: the app's own [EngineMark] (which gives the near-white
/// vendor marks a dark tile on a light palette), and Claude's picture, as in
/// the render.
Widget _mark(String engine, double size) => engine == _claude
    ? ClipRRect(
        borderRadius: BorderRadius.circular(size * 0.22),
        child: Image.asset(
          'assets/model-icons/claude.png',
          width: size,
          height: size,
          fit: BoxFit.cover,
          // A missing asset must not take the slide with it.
          errorBuilder: (_, _, _) => SizedBox.square(dimension: size),
        ),
      )
    : EngineMark(engine: engine, size: size);

BoxDecoration _cardDecoration({double radius = 15, Color? border}) =>
    BoxDecoration(
      color: _card,
      borderRadius: BorderRadius.circular(radius),
      border: Border.all(color: border ?? _rim),
      boxShadow: _lift,
    );

/// The amber "working" dot beside a busy line.
class _Busy extends StatelessWidget {
  const _Busy();

  @override
  Widget build(BuildContext context) => Container(
    width: 8,
    height: 8,
    margin: const EdgeInsets.only(right: 5, bottom: 1),
    decoration: BoxDecoration(
      color: _amber,
      shape: BoxShape.circle,
      boxShadow: [
        BoxShadow(color: _amber.withValues(alpha: 0.6), blurRadius: 10),
      ],
    ),
  );
}

/// One line of a pane's transcript.
enum _Tone { user, ok, busy, ask, dim, plain }

class _Line {
  const _Line(this.text, [this.tone = _Tone.plain]);
  final String text;
  final _Tone tone;
}

/// A harness pane as the workspace draws one: agent and project in the
/// header, a few lines of its conversation below.
class _Pane extends StatelessWidget {
  const _Pane({
    required this.icon,
    required this.agent,
    required this.tag,
    required this.lines,
    this.size = 12,
  });

  final String icon;
  final String agent;
  final String tag;
  final List<_Line> lines;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: _paneGround,
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: _rim),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: _rim)),
            ),
            child: Row(
              children: [
                _mark(icon, 17),
                const SizedBox(width: 7),
                Expanded(
                  child: Text(
                    agent,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: _sans(12, color: _ink),
                  ),
                ),
                Text(tag, style: _mono(11, color: _faint)),
              ],
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 9, 12, 0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [for (final line in lines) _line(line)],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _line(_Line line) {
    final style = _mono(size);
    return switch (line.tone) {
      _Tone.user => Text('› ${line.text}', style: style.copyWith(color: _ink)),
      _Tone.dim => Text(line.text, style: style.copyWith(color: _faint)),
      _Tone.ok => Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text: '✓ ',
              style: style.copyWith(color: _ok),
            ),
            TextSpan(text: line.text),
          ],
        ),
        style: style,
      ),
      _Tone.ask => Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text: '? ',
              style: style.copyWith(color: _amber, fontWeight: FontWeight.w700),
            ),
            TextSpan(text: line.text),
          ],
        ),
        style: style,
      ),
      _Tone.busy => Row(
        children: [
          const _Busy(),
          Flexible(child: Text(line.text, style: style)),
        ],
      ),
      _Tone.plain => Text(line.text, style: style),
    };
  }
}

/// A key as a keycap: ⌘, P, Alt…
class TourKeycap extends StatelessWidget {
  const TourKeycap(this.label, {super.key});

  final String label;

  @override
  Widget build(BuildContext context) {
    final dark = grid.AppTheme.isDark;
    return Container(
      constraints: const BoxConstraints(minWidth: 46, minHeight: 46),
      padding: const EdgeInsets.symmetric(horizontal: 12),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: dark
              ? const [Color(0xFF2E2E2B), Color(0xFF222220)]
              : const [Color(0xFFFFFFFF), Color(0xFFECECE8)],
        ),
        border: Border.all(
          color: dark
              ? Colors.white.withValues(alpha: 0.14)
              : Colors.black.withValues(alpha: 0.12),
        ),
        boxShadow: [
          BoxShadow(
            color: dark ? const Color(0xFF111110) : const Color(0xFFCFCFCA),
            offset: const Offset(0, 4.5),
          ),
          BoxShadow(
            color: Colors.black.withValues(alpha: dark ? 0.4 : 0.08),
            blurRadius: 26,
            offset: const Offset(0, 13),
          ),
        ],
      ),
      child: Text(label, style: _sans(23, weight: FontWeight.w600)),
    );
  }
}

Widget _keys(List<String> keys) => Padding(
  padding: const EdgeInsets.only(bottom: 18),
  child: Row(
    children: [
      for (final key in keys) ...[TourKeycap(key), const SizedBox(width: 9)],
    ],
  ),
);

Widget _mini(List<String> words) => Padding(
  padding: const EdgeInsets.only(top: 13),
  child: Text(
    words.join('  ·  '),
    textAlign: TextAlign.center,
    style: _sans(13, color: _soft),
  ),
);

/// 1 · Machines: three computers around this one.
class TourMachinesArt extends StatelessWidget {
  const TourMachinesArt({super.key, required this.thisComputer});

  /// "this Mac", or "this computer" elsewhere.
  final String thisComputer;

  static const _hub = Offset(312, 245);

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Positioned.fill(
          child: CustomPaint(
            painter: _Spokes(
              from: _hub,
              to: const [Offset(110, 60), Offset(490, 100), Offset(312, 420)],
              color: _amber.withValues(alpha: 0.45),
            ),
          ),
        ),
        Positioned(
          left: _hub.dx - 96,
          top: _hub.dy - 96,
          child: _Hub(thisComputer: thisComputer),
        ),
        const Positioned(
          left: 0,
          top: 0,
          child: _MachineCard(
            icon: AppIcons.laptop,
            name: 'MacBook',
            status: '2 agents working',
            agents: [_claude, _codex],
          ),
        ),
        const Positioned(
          right: 0,
          top: 38,
          child: _MachineCard(
            icon: AppIcons.monitor,
            name: 'Studio desktop',
            status: '1 agent working',
            agents: [_opencode],
          ),
        ),
        const Positioned(
          left: 210,
          bottom: 0,
          child: _MachineCard(
            icon: AppIcons.server,
            name: 'Cloud box',
            status: '3 agents working',
            agents: [_codex, _claude, _pi],
          ),
        ),
      ],
    );
  }
}

class _Spokes extends CustomPainter {
  _Spokes({required this.from, required this.to, required this.color});

  final Offset from;
  final List<Offset> to;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 1.4
      ..style = PaintingStyle.stroke;
    for (final end in to) {
      final delta = end - from;
      final length = delta.distance;
      final step = delta / length;
      // Dashes of 5 with gaps of 5, as the render draws them.
      for (var at = 0.0; at < length; at += 10) {
        final dashEnd = (at + 5).clamp(0, length).toDouble();
        canvas.drawLine(from + step * at, from + step * dashEnd, paint);
      }
    }
  }

  @override
  bool shouldRepaint(_Spokes old) =>
      old.color != color || old.from != from || old.to != to;
}

class _Hub extends StatelessWidget {
  const _Hub({required this.thisComputer});

  final String thisComputer;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 192,
      height: 192,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: RadialGradient(
          center: const Alignment(-0.3, -0.4),
          radius: 0.7,
          colors: [
            Color.alphaBlend(_amber.withValues(alpha: 0.18), _card),
            _card,
          ],
        ),
        border: Border.all(color: _amber.withValues(alpha: 0.35)),
        boxShadow: [
          BoxShadow(color: _amber.withValues(alpha: 0.18), blurRadius: 77),
        ],
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Image.asset(
            'assets/app_icon.png',
            width: 70,
            height: 70,
            errorBuilder: (_, _, _) => const SizedBox.square(dimension: 70),
          ),
          const SizedBox(height: 6),
          Text('Harness', style: _sans(18, weight: FontWeight.w700)),
          const SizedBox(height: 2),
          Text(thisComputer, style: _sans(13, color: _soft)),
        ],
      ),
    );
  }
}

class _MachineCard extends StatelessWidget {
  const _MachineCard({
    required this.icon,
    required this.name,
    required this.status,
    required this.agents,
  });

  final IconData icon;
  final String name;
  final String status;
  final List<String> agents;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 205,
      padding: const EdgeInsets.all(17),
      decoration: _cardDecoration(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 20, color: _soft),
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: _sans(15, weight: FontWeight.w600),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(status, style: _sans(12, color: _soft)),
          const SizedBox(height: 13),
          Row(
            children: [
              for (final agent in agents) ...[
                _mark(agent, 26),
                const SizedBox(width: 6),
              ],
            ],
          ),
        ],
      ),
    );
  }
}

/// 2 · Agents: four agents at work in one grid.
class TourAgentsArt extends StatelessWidget {
  const TourAgentsArt({super.key});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    const panes = [
      _Pane(
        icon: _claude,
        agent: 'Claude Code',
        tag: 'api',
        lines: [
          _Line('add rate limits', _Tone.user),
          _Line('middleware.ts', _Tone.ok),
          _Line('running tests…', _Tone.busy),
        ],
      ),
      _Pane(
        icon: _codex,
        agent: 'Codex',
        tag: 'web',
        lines: [
          _Line('fix the login page', _Tone.user),
          _Line('3 files changed', _Tone.ok),
          _Line('done in 41 s'),
        ],
      ),
      _Pane(
        icon: _opencode,
        agent: 'OpenCode',
        tag: 'docs',
        lines: [
          _Line('write the changelog', _Tone.user),
          _Line('writing…', _Tone.busy),
        ],
      ),
      _Pane(
        icon: _cursor,
        agent: 'Cursor',
        tag: 'ios',
        lines: [
          _Line('review PR #212', _Tone.user),
          _Line('needs your answer', _Tone.ask),
        ],
      ),
    ];
    return Center(
      child: Container(
        width: 538,
        height: 384,
        padding: const EdgeInsets.all(8),
        decoration: _cardDecoration(),
        child: Column(
          children: [
            Expanded(
              child: Row(
                children: [
                  Expanded(child: panes[0]),
                  const SizedBox(width: 8),
                  Expanded(child: panes[1]),
                ],
              ),
            ),
            const SizedBox(height: 8),
            Expanded(
              child: Row(
                children: [
                  Expanded(child: panes[2]),
                  const SizedBox(width: 8),
                  Expanded(child: panes[3]),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 3 · ⌘P: one search, results from three machines and three agents.
class TourSearchArt extends StatelessWidget {
  const TourSearchArt({super.key, required this.keys});

  /// The keycaps for the search's shortcut on this platform.
  final List<String> keys;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    Widget row(
      String icon,
      String title,
      String meta,
      String machine, {
      bool on = false,
    }) => Container(
      color: on ? _amber.withValues(alpha: 0.14) : null,
      padding: const EdgeInsets.symmetric(horizontal: 17, vertical: 10),
      child: Row(
        children: [
          _mark(icon, 20),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: _sans(14)),
                const SizedBox(height: 2),
                Text(meta, style: _sans(11.5, color: _soft)),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 2),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(26),
              border: Border.all(color: _rim),
            ),
            child: Text(machine, style: _sans(11.5, color: _soft)),
          ),
        ],
      ),
    );
    return Center(
      child: SizedBox(
        width: 563,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _keys(keys),
            Container(
              clipBehavior: Clip.antiAlias,
              decoration: _cardDecoration(radius: 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 17,
                      vertical: 13,
                    ),
                    decoration: BoxDecoration(
                      border: Border(bottom: BorderSide(color: _rim)),
                    ),
                    child: Row(
                      children: [
                        Flexible(child: Text('checkout', style: _sans(17))),
                        _Caret(height: 18),
                      ],
                    ),
                  ),
                  row(
                    _codex,
                    'write e2e tests for checkout',
                    'ios-app · 3 days ago',
                    'MacBook',
                    on: true,
                  ),
                  row(
                    _claude,
                    'redesign the checkout flow',
                    'web · yesterday',
                    'Studio desktop',
                  ),
                  row(
                    _opencode,
                    'checkout copy for the pricing page',
                    'docs · last week',
                    'Cloud box',
                  ),
                  row(
                    _claude,
                    'checkout webhook retries',
                    'api-server · 2 weeks ago',
                    'Cloud box',
                  ),
                ],
              ),
            ),
            Center(
              child: _mini(const [
                'Every harness',
                'all your machines',
                'all your agents',
              ]),
            ),
          ],
        ),
      ),
    );
  }
}

class _Caret extends StatelessWidget {
  const _Caret({required this.height});

  final double height;

  @override
  Widget build(BuildContext context) => Container(
    width: 2,
    height: height,
    margin: const EdgeInsets.only(left: 2),
    color: _amber,
  );
}

/// 4 · ⌘N: the New Harness box, agent, machine and project picked by keys.
class TourNewHarnessArt extends StatelessWidget {
  const TourNewHarnessArt({super.key, required this.keys});

  /// The keycaps for New Harness on this platform.
  final List<String> keys;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    Widget chip(String label, {String? icon}) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(26),
        border: Border.all(color: _rim),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[_mark(icon, 18), const SizedBox(width: 6)],
          Text(label, style: _sans(13.5)),
          const SizedBox(width: 4),
          Icon(AppIcons.chevronDown, size: 13, color: _soft),
        ],
      ),
    );
    return Center(
      child: SizedBox(
        width: 563,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _keys(keys),
            Container(
              padding: const EdgeInsets.all(15),
              decoration: _cardDecoration(radius: 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      chip('Claude Code', icon: _claude),
                      chip('Studio desktop'),
                      chip('api-server'),
                    ],
                  ),
                  const SizedBox(height: 13),
                  Container(
                    constraints: const BoxConstraints(minHeight: 70),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 15,
                      vertical: 14,
                    ),
                    decoration: BoxDecoration(
                      color: _paneGround,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: _amber.withValues(alpha: 0.5)),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Flexible(
                          child: Text(
                            'add a health check endpoint',
                            style: _sans(16.5),
                          ),
                        ),
                        _Caret(height: 20),
                      ],
                    ),
                  ),
                  const SizedBox(height: 10),
                  Align(
                    alignment: Alignment.centerRight,
                    child: Text('⏎ start', style: _sans(13, color: _soft)),
                  ),
                ],
              ),
            ),
            Center(
              child: _mini(const ['Any agent', 'any machine', 'any project']),
            ),
          ],
        ),
      ),
    );
  }
}

/// 5 · Sessions that keep going: one conversation across a restart.
class TourSessionsArt extends StatelessWidget {
  const TourSessionsArt({super.key, required this.computer});

  /// "Mac", or "Computer" elsewhere: what restarted.
  final String computer;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    Widget pill(String label, {bool on = false}) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 4),
      decoration: BoxDecoration(
        color: _card,
        borderRadius: BorderRadius.circular(26),
        border: Border.all(color: on ? _amber.withValues(alpha: 0.5) : _rim),
      ),
      child: Text(label, style: _sans(12)),
    );
    Widget rule() => Expanded(
      child: Container(
        height: 1,
        margin: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          gradient: LinearGradient(
            colors: [
              _rim.withValues(alpha: 0),
              _rim,
              _rim.withValues(alpha: 0),
            ],
          ),
        ),
      ),
    );
    return Stack(
      children: [
        Positioned(
          left: 26,
          top: 26,
          width: 486,
          height: 333,
          child: DecoratedBox(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(10),
              boxShadow: _lift,
            ),
            child: _Pane(
              icon: _claude,
              agent: 'Claude Code',
              tag: 'api · main',
              size: 13,
              lines: [
                const _Line('Yesterday 18:02', _Tone.dim),
                const _Line('migrate the users table', _Tone.user),
                const _Line('migration 0042 written', _Tone.ok),
                _Line('─── $computer restarted ───', _Tone.dim),
                const _Line('Today 09:14 · resumed', _Tone.dim),
                const _Line('now backfill the emails', _Tone.user),
                const _Line('working…', _Tone.busy),
              ],
            ),
          ),
        ),
        Positioned(
          left: 0,
          right: 0,
          bottom: 13,
          child: Row(
            children: [
              pill('Mon 18:02'),
              rule(),
              pill('restart'),
              rule(),
              pill('Tue 09:14 · same session', on: true),
            ],
          ),
        ),
      ],
    );
  }
}

/// 6 · The Harness phone app: an agent asking from a phone.
class TourPhoneArt extends StatelessWidget {
  const TourPhoneArt({super.key});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // The bezel is hardware and stays dark; the screen follows the theme, as
    // the phone app does.
    const bezel = Color(0xFF2C2C29);
    return Center(
      child: Container(
        width: 192,
        height: 397,
        padding: const EdgeInsets.fromLTRB(11, 14, 11, 14),
        decoration: BoxDecoration(
          color: grid.AppPalette.windowBg,
          borderRadius: BorderRadius.circular(31),
          border: Border.all(color: bezel, width: 6),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(
                alpha: grid.AppTheme.pick(0.18, 0.6),
              ),
              blurRadius: 51,
              offset: const Offset(0, 26),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 64,
                height: 14,
                decoration: BoxDecoration(
                  color: bezel,
                  borderRadius: BorderRadius.circular(13),
                ),
              ),
            ),
            const SizedBox(height: 13),
            const SizedBox(
              height: 154,
              child: _Pane(
                icon: _codex,
                agent: 'Codex',
                tag: 'web',
                size: 11,
                lines: [
                  _Line('ship the pricing page', _Tone.user),
                  _Line('built', _Tone.ok),
                  _Line('deploying…', _Tone.busy),
                ],
              ),
            ),
            const SizedBox(height: 13),
            Container(
              padding: const EdgeInsets.all(11.5),
              decoration: BoxDecoration(
                color: _card,
                borderRadius: BorderRadius.circular(13),
                border: Border.all(color: _amber.withValues(alpha: 0.4)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Codex needs you',
                    style: _sans(13.5, weight: FontWeight.w700),
                  ),
                  const SizedBox(height: 5),
                  Text('Deploy to production?', style: _sans(12)),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Expanded(
                        child: _PhoneButton(
                          'Not now',
                          fill: grid.AppPalette.cardBgHover,
                          ink: _ink,
                        ),
                      ),
                      const SizedBox(width: 6),
                      Expanded(
                        child: _PhoneButton(
                          'Deploy',
                          fill: _amber,
                          ink: grid.AppTheme.pick(
                            Colors.white,
                            const Color(0xFF1A1205),
                          ),
                          bold: true,
                        ),
                      ),
                    ],
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

class _PhoneButton extends StatelessWidget {
  const _PhoneButton(
    this.label, {
    required this.fill,
    required this.ink,
    this.bold = false,
  });

  final String label;
  final Color fill;
  final Color ink;
  final bool bold;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(vertical: 6),
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: fill,
      borderRadius: BorderRadius.circular(10),
    ),
    child: Text(
      label,
      style: _sans(11.5, color: ink, weight: bold ? FontWeight.w700 : null),
    ),
  );
}

/// 7 · The Harness device, as photographed on a desk.
class TourDeviceArt extends StatelessWidget {
  const TourDeviceArt({super.key});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Center(
      child: Container(
        width: 600,
        height: 384,
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(18),
          color: _card,
          boxShadow: _lift,
        ),
        child: Image.asset(
          'assets/devices/harness-desk.webp',
          fit: BoxFit.cover,
          errorBuilder: (_, _, _) => const SizedBox.expand(),
        ),
      ),
    );
  }
}
