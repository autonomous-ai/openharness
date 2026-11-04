import 'model.dart';

/// How the Swarm shows a person: their name, else their username.
String projectPersonName(SuperTabPerson p) => p.name ?? p.username;

/// The Add people picker's two lists (Diego, 2026-11-04): the Swarm's people who can be added to [project], by name,
/// and those already in it, the owner first. [query] narrows both, as a case-insensitive substring of name,
/// username or email.
({List<SuperTabPerson> addable, List<SuperTabPerson> inProject})
projectPeopleLists(
  List<SuperTabPerson> people,
  SuperTabProject project,
  String query,
) {
  final q = query.trim().toLowerCase();
  bool matches(SuperTabPerson p) =>
      q.isEmpty ||
      [
        p.name ?? '',
        p.username,
        p.email,
      ].any((s) => s.toLowerCase().contains(q));
  bool isIn(SuperTabPerson p) =>
      p.id == project.ownerId || project.memberIds.contains(p.id);
  final shown = people.where(matches).toList();
  return (
    addable: shown.where((p) => !isIn(p)).toList()
      ..sort(
        (a, b) =>
            projectPersonName(a)
                .toLowerCase()
                .compareTo(projectPersonName(b).toLowerCase()),
      ),
    inProject: [
      ...shown.where((p) => p.id == project.ownerId),
      ...shown.where((p) => p.id != project.ownerId && isIn(p)),
    ],
  );
}
