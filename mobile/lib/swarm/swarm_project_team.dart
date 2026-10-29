import 'model.dart';

/// The people of [project] in [snapshot]: everyone in the Swarm, or, for a
/// private project, only its owner and members — the people who read it.
List<SuperTabPerson> swarmProjectPeople(
  SuperTabSnapshot snapshot,
  SuperTabProject project,
) => [
  for (final person in snapshot.people)
    if (!project.isPrivate ||
        person.id == project.ownerId ||
        project.memberIds.contains(person.id))
      person,
];

/// "3 humans · 5 agents", the people and agents of a project in words; the
/// agents left out when there are none, as the team's line then says so.
String swarmProjectHeads({required int humans, required int agents}) => [
  humans == 1 ? '1 human' : '$humans humans',
  if (agents > 0) agents == 1 ? '1 agent' : '$agents agents',
].join(' · ');
