import '../core/dsh_catalog.dart';
import 'store_catalog_history.g.dart';
import 'store_models.dart';

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
