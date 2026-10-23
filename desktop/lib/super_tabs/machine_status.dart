import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';

/// A reading this old is late: the machine reports every 15 seconds
/// (`MACHINE_HEARTBEAT_MS`, `cli/src/superTabs/machines.ts`), so a reading past a beat and a quarter has missed one.
const kSuperTabMachineLateAfter = Duration(seconds: 20);

/// How long a machine's reading may stand before the Swarm calls it offline: two missed beats, plus a margin for the
/// Swarm to be read in turn. A machine reports at once when something changes, so a quiet one is still under this.
const kSuperTabMachineOfflineAfter = Duration(seconds: 35);

/// What the Machines list says of one machine, and draws as its dot.
enum SuperTabMachineStatus {
  /// Reported within [kSuperTabMachineLateAfter].
  live,

  /// Past that, not yet [kSuperTabMachineOfflineAfter].
  late,

  /// Silent for [kSuperTabMachineOfflineAfter] or more (or, for a computer read directly, not connected).
  offline,

  /// The Swarm cannot be read, so what a machine reports through it cannot be told from silence. Not offline.
  unknown,

  /// Back from the background: what is shown was read before, and the new reading has not arrived.
  refreshing,
}

/// The status of a machine from how old its reading is.
///
/// [age]: null when it has no reading. [unreachable]: the Swarm cannot be read and the reading comes through it.
/// [refreshing]: a new reading is awaited. [connected]: for a computer this Desktop reads itself, whether its
/// connection is up; null for one whose reports come through the Swarm. A computer that is connected is never
/// called offline for an old reading, only late: its connection says it is there.
SuperTabMachineStatus superTabMachineStatus({
  required Duration? age,
  bool unreachable = false,
  bool refreshing = false,
  bool? connected,
}) {
  if (unreachable) return SuperTabMachineStatus.unknown;
  if (refreshing) return SuperTabMachineStatus.refreshing;
  if (connected == false || age == null) return SuperTabMachineStatus.offline;
  if (age >= kSuperTabMachineOfflineAfter) {
    return connected == true
        ? SuperTabMachineStatus.late
        : SuperTabMachineStatus.offline;
  }
  return age >= kSuperTabMachineLateAfter
      ? SuperTabMachineStatus.late
      : SuperTabMachineStatus.live;
}

/// How long ago: "just now", "4s ago", "3 min ago", "2 h ago".
String superTabAgo(Duration age) {
  final seconds = age.inSeconds;
  if (seconds < 1) return 'just now';
  if (seconds < 60) return '${seconds}s ago';
  if (age.inMinutes < 60) return '${age.inMinutes} min ago';
  if (age.inHours < 24) return '${age.inHours} h ago';
  return '${age.inDays} d ago';
}

/// The same, shortest: "6s", "1m", "2h", for the heading's "Reconnecting · 1m".
String superTabAgoShort(Duration age) {
  if (age.inSeconds < 60) return '${math.max(0, age.inSeconds)}s';
  if (age.inMinutes < 60) return '${age.inMinutes}m';
  if (age.inHours < 24) return '${age.inHours}h';
  return '${age.inDays}d';
}

/// What hovering or focusing a machine's row says of its state, before its owner and hardware: nothing while
/// it is online (the dot says so), and never how old the reading is.
String? superTabMachineTip(SuperTabMachineStatus status) => switch (status) {
  SuperTabMachineStatus.refreshing => 'Refreshing…',
  SuperTabMachineStatus.unknown => "Can't reach Harness",
  SuperTabMachineStatus.offline => 'Offline',
  SuperTabMachineStatus.live || SuperTabMachineStatus.late => null,
};

/// The state in words, so that colour is never the only signal.
String superTabMachineStateLabel(SuperTabMachineStatus status) =>
    switch (status) {
      SuperTabMachineStatus.live => 'Live',
      SuperTabMachineStatus.late => 'Late',
      SuperTabMachineStatus.offline => 'Offline',
      SuperTabMachineStatus.unknown => 'Status unknown',
      SuperTabMachineStatus.refreshing => 'Refreshing',
    };

/// The tabular figures the heading's pill counts in.
const _tabular = [FontFeature.tabularFigures()];

/// The 8 px mark in a machine row's icon column: green when live (with one short ping as each new reading arrives),
/// amber when late, a hollow ring when offline, a dashed ring when unknown, a breathing grey when refreshing.
/// Motion stops when the platform asks for reduced motion.
class SuperTabMachineDot extends StatefulWidget {
  const SuperTabMachineDot({
    super.key,
    required this.status,
    this.readingAt,
    this.arrived = false,
  });

  final SuperTabMachineStatus status;

  /// When the reading was taken; a newer one than before pings a live dot.
  final DateTime? readingAt;

  /// The reading is new as this is first built: the dot pings once.
  final bool arrived;

  @override
  State<SuperTabMachineDot> createState() => _SuperTabMachineDotState();
}

class _SuperTabMachineDotState extends State<SuperTabMachineDot>
    with TickerProviderStateMixin {
  late final _ping = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1200),
  );
  late final _breath = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 1),
  );
  bool _still = false;

  @override
  void initState() {
    super.initState();
    if (widget.status == SuperTabMachineStatus.live && widget.arrived) {
      _ping.forward();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    _sync();
  }

  @override
  void didUpdateWidget(SuperTabMachineDot old) {
    super.didUpdateWidget(old);
    if (widget.status == SuperTabMachineStatus.live &&
        widget.readingAt != null &&
        widget.readingAt != old.readingAt &&
        !_still) {
      _ping.forward(from: 0);
    }
    _sync();
  }

  void _sync() {
    final breathing = widget.status == SuperTabMachineStatus.refreshing;
    if (_still) {
      _ping.stop();
      _breath.stop();
    } else if (breathing && !_breath.isAnimating) {
      _breath.repeat();
    } else if (!breathing && _breath.isAnimating) {
      _breath.stop();
    }
  }

  @override
  void dispose() {
    _ping.dispose();
    _breath.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: SizedBox.square(
      dimension: 8,
      child: AnimatedBuilder(
        animation: Listenable.merge([_ping, _breath]),
        builder: (context, _) => CustomPaint(
          painter: _DotPainter(
            status: widget.status,
            ping: _still ? 0 : _ping.value,
            breath: _still ? 0 : _breath.value,
            online: grid.AppPalette.online,
            warn: grid.AppPalette.warn,
            quiet: grid.AppPalette.offline,
          ),
        ),
      ),
    ),
  );
}

class _DotPainter extends CustomPainter {
  _DotPainter({
    required this.status,
    required this.ping,
    required this.breath,
    required this.online,
    required this.warn,
    required this.quiet,
  });

  final SuperTabMachineStatus status;
  final double ping, breath;
  final Color online, warn, quiet;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final radius = size.width / 2;
    switch (status) {
      case SuperTabMachineStatus.live:
        canvas.drawCircle(center, radius, Paint()..color = online);
        // One short ping: a ring around the dot, from 0.6x to 1.6x of its 3 px halo, fading as it goes.
        if (ping > 0 && ping < 1) {
          canvas.drawCircle(
            center,
            (radius + 3) * (.6 + ping),
            Paint()
              ..style = PaintingStyle.stroke
              ..strokeWidth = 1
              ..color = online.withValues(alpha: .8 * (1 - ping)),
          );
        }
      case SuperTabMachineStatus.late:
        canvas.drawCircle(center, radius, Paint()..color = warn);
      case SuperTabMachineStatus.offline:
        canvas.drawCircle(
          center,
          radius - .75,
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1.5
            ..color = quiet,
        );
      case SuperTabMachineStatus.unknown:
        final paint = Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.5
          ..color = quiet;
        const dashes = 6;
        final ring = Rect.fromCircle(center: center, radius: radius - .75);
        for (var i = 0; i < dashes; i++) {
          canvas.drawArc(
            ring,
            i * 2 * math.pi / dashes,
            math.pi / dashes,
            false,
            paint,
          );
        }
      case SuperTabMachineStatus.refreshing:
        // The breath: full at rest, down to 35% half way round.
        final dip = 1 - (breath < .5 ? breath : 1 - breath) * 2;
        canvas.drawCircle(
          center,
          radius,
          Paint()..color = quiet.withValues(alpha: .35 + .65 * dip),
        );
    }
  }

  @override
  bool shouldRepaint(_DotPainter old) =>
      old.status != status ||
      old.ping != ping ||
      old.breath != breath ||
      old.online != online ||
      old.warn != warn ||
      old.quiet != quiet;
}

/// The pill beside the Machines heading while the Swarm cannot be read: "Reconnecting · 1m". A live
/// Swarm shows no pill. Where the heading leaves too little room for the words (the minimum pane), it is
/// only its dot, which says the same on hover.
class SuperTabMachinesPill extends StatelessWidget {
  const SuperTabMachinesPill({super.key, required this.reconnectingFor});

  /// How long the Swarm has failed to be read.
  final Duration reconnectingFor;

  /// Below this width the words would ellipsize to almost nothing.
  static const _minWordsWidth = 56.0;

  @override
  Widget build(BuildContext context) {
    final failingFor = superTabAgoShort(reconnectingFor);
    final text = 'Reconnecting · $failingFor';
    final dot = DecoratedBox(
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: grid.AppPalette.warn,
      ),
      child: const SizedBox.square(dimension: 6),
    );
    return Semantics(
      label: 'Machines: reconnecting, for $failingFor',
      excludeSemantics: true,
      child: LayoutBuilder(
        builder: (context, constraints) => constraints.maxWidth < _minWordsWidth
            ? Tooltip(
                message: text,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: dot,
                ),
              )
            : DecoratedBox(
                decoration: ShapeDecoration(
                  shape: StadiumBorder(
                    side: BorderSide(color: DesktopChrome.rim),
                  ),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 2,
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      dot,
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          text,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: DesktopChrome.metadata().copyWith(
                            fontSize: 11,
                            fontFeatures: _tabular,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
      ),
    );
  }
}
