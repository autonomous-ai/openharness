import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../swarm_type.dart';

/// A time centered between chat messages, shown only after a pause of more
/// than [pause] (anh Dee's mockup, 11-07, #4529): the bubbles themselves carry
/// none. Keyed `swarm-chat-time-<message id>` by the list.
class SwarmChatTime extends StatelessWidget {
  const SwarmChatTime(this.time, {super.key});

  final DateTime time;

  /// The pause after which the next message gets a time above it.
  static const pause = Duration(minutes: 5);

  /// Whether [time] comes more than [pause] after [previous], on the same
  /// day: a new day has its own line.
  static bool after(DateTime? previous, DateTime? time) =>
      previous != null &&
      time != null &&
      DateUtils.isSameDay(previous.toLocal(), time.toLocal()) &&
      time.difference(previous) > pause;

  @override
  Widget build(BuildContext context) => Padding(
    padding: grid.AppDesktop.chatTimePadding,
    child: Center(
      child: Text(
        TimeOfDay.fromDateTime(time.toLocal()).format(context),
        style: SwarmType.time(context),
      ),
    ),
  );
}
