import 'package:flutter/widgets.dart';

import 'swarm_activity_page.dart';
import 'swarm_inbox.dart';

/// Opens Activity, which replaced Needs you (Tony's prototype C3), over
/// [context]'s page: [focus] — a need's key — open in full under its filter;
/// only Swarm [swarmId]'s rows when Home shows that Swarm alone.
void openSwarmNeeds(BuildContext context, {String? focus, String? swarmId}) =>
    openSwarmActivity(context, focus: focus, swarmId: swarmId);

/// The needs Home shows: every Swarm's, or [swarmId]'s alone.
List<SwarmNeed> swarmNeedsOf(SwarmInbox inbox, String? swarmId) => [
  for (final need in inbox.needs)
    if (swarmId == null || need.swarmId == swarmId) need,
];
