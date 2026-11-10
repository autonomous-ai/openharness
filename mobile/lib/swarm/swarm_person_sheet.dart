import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'swarm_face.dart';
import 'swarm_reader.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';

/// Who the member [personId] of the Swarm [swarmId] is, in a sheet over the
/// page: their face, name, email and role.
Future<void> showSwarmPerson(
  BuildContext context, {
  required String swarmId,
  required String personId,
}) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  backgroundColor: AppGlass.rowFill,
  shape: AppControl.sheetShape,
  builder: (_) => SwarmPersonSheet(swarmId: swarmId, personId: personId),
);

/// What [showSwarmPerson] shows.
class SwarmPersonSheet extends StatelessWidget {
  const SwarmPersonSheet({
    super.key,
    required this.swarmId,
    required this.personId,
  });

  final String swarmId, personId;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final reader = SwarmScope.of(context)?.inbox.reader(swarmId);
    return SafeArea(
      top: false,
      child: Padding(
        key: const ValueKey('swarm-person'),
        padding: const EdgeInsets.fromLTRB(
          AppSpace.l,
          AppSpace.s,
          AppSpace.l,
          AppSpace.xl,
        ),
        child: reader == null
            ? const SizedBox.shrink()
            : ListenableBuilder(
                listenable: reader,
                builder: (context, _) => _sheet(reader),
              ),
      ),
    );
  }

  Widget _sheet(SwarmReader reader) {
    final person = reader.snapshot?.person(personId);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // The grabber: a capsule as wide as the two largest steps.
        Center(
          child: Container(
            width: AppSpace.xl + AppSpace.m,
            height: AppSpace.xs,
            margin: const EdgeInsets.only(bottom: AppSpace.l),
            decoration: ShapeDecoration(
              color: AppGlass.hair,
              shape: const StadiumBorder(),
            ),
          ),
        ),
        if (person == null)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.xs,
              AppSpace.m,
              AppSpace.xs,
              0,
            ),
            child: Text(
              'They are no longer in this Swarm.',
              style: AppType.caption(color: AppPalette.textSecondary),
            ),
          )
        else
          Row(
            children: [
              SwarmAvatar(
                id: person.id,
                name: person.shownName,
                size: 64,
                picture: person.avatar,
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      person.shownName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppType.heading(color: AppPalette.textPrimary),
                    ),
                    const SizedBox(height: 4),
                    // The handle a tag types, under a name they set.
                    if (person.name != null)
                      Text(
                        '@${person.username}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppType.caption(color: AppPalette.textSecondary),
                      ),
                    Text(
                      person.email,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppType.caption(color: AppPalette.textSecondary),
                    ),
                    Text(
                      _role(person.role),
                      style: AppType.caption(color: AppPalette.textFaint),
                    ),
                  ],
                ),
              ),
            ],
          ),
      ],
    );
  }

  static String _role(String role) => switch (role) {
    'owner' => 'Owner',
    'collaborator' => 'Collaborator',
    'viewer' => 'Viewer',
    _ => role,
  };
}
