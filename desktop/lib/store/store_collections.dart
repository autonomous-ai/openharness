import '../core/dsh_catalog.dart';
import 'store_catalog_history.g.dart';
import 'store_editorial.dart';
import 'store_models.dart';

typedef StoreSession = ({DshEntry entry, StoreExample example});

/// One recorded example per available harness. Catalog publications can join
/// this collection without adding an ID or artwork to the desktop release.
/// Start with a mix of disciplines; keep every remaining session discoverable.
List<StoreSession> storeRecordedSessions(Iterable<DshEntry> entries) {
  final sessions = <StoreSession>[];
  for (final entry in entries) {
    if (entry.isEngine || entry.isViewerPackage) continue;
    final example = entry.examples.where((example) {
      bool https(String? value) {
        final uri = value == null ? null : Uri.tryParse(value);
        return uri?.scheme == 'https' && uri!.host.isNotEmpty;
      }

      return https(example.image) && https(example.video);
    }).firstOrNull;
    if (example != null) sessions.add((entry: entry, example: example));
  }
  sessions.sort((a, b) {
    final order = a.entry.name.toLowerCase().compareTo(
      b.entry.name.toLowerCase(),
    );
    return order != 0 ? order : a.entry.id.compareTo(b.entry.id);
  });
  final categories = <String>{};
  final first = <StoreSession>[], remaining = <StoreSession>[];
  for (final session in sessions) {
    (categories.add(storeCategoryFor(session.entry)) ? first : remaining).add(
      session,
    );
  }
  return [...first, ...remaining];
}

/// Real publication history bundled with this app release. Membership still
/// comes from the machine's live catalog, so unavailable tools never appear.
List<DshEntry> storeRecentlyUpdated(Iterable<DshEntry> entries) {
  final known = entries
      .where(
        (entry) =>
            !entry.isEngine &&
            !entry.isViewerPackage &&
            storeCatalogHistory.containsKey(entry.id),
      )
      .toList();
  known.sort((a, b) {
    final aTime = storeCatalogHistory[a.id]!.updatedAt;
    final bTime = storeCatalogHistory[b.id]!.updatedAt;
    final order = bTime.compareTo(aTime);
    return order != 0 ? order : a.name.compareTo(b.name);
  });
  return known;
}

/// Community stars are not downloads. Require several reviews per tool and
/// omit unrated tools instead of manufacturing a popularity chart.
List<DshEntry> storeTopRated(
  Iterable<DshEntry> entries,
  StoreRating Function(DshEntry) ratingFor,
) {
  final rated = entries
      .where((entry) => !entry.isViewerPackage && ratingFor(entry).count >= 3)
      .toList();
  rated.sort((a, b) {
    final ar = ratingFor(a), br = ratingFor(b);
    final stars = br.average.compareTo(ar.average);
    if (stars != 0) return stars;
    final reviews = br.count.compareTo(ar.count);
    return reviews != 0 ? reviews : a.name.compareTo(b.name);
  });
  return rated;
}
