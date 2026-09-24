import 'package:flutter/material.dart';

import '../core/dsh_catalog.dart';
import 'store_listing.dart';

/// Original editorial illustrations, kept separate from real project output.
/// These appear only in featured stories, never in the catalog's icon rows.
const storeFeaturedArt = <String, String>{
  'Coding': 'assets/store/editorial-code.jpg',
  'Design': 'assets/store/editorial-shape.jpg',
  'Engineering': 'assets/store/editorial-circuit.jpg',
  'Media': 'assets/store/editorial-media.jpg',
  'Music': 'assets/store/editorial-music.jpg',
  'Productivity': 'assets/store/editorial-productivity.jpg',
  'Science & Data': 'assets/store/editorial-science.jpg',
  'Simulation': 'assets/store/editorial-simulation.jpg',
  'Games': 'assets/store/editorial-games.jpg',
  'Research': 'assets/store/editorial-research.jpg',
  'Local AI': 'assets/store/editorial-local-ai.jpg',
};

class StoreFeaturedArt extends StatelessWidget {
  const StoreFeaturedArt({
    super.key,
    required this.category,
    required this.entry,
  });
  final String category;
  final DshEntry entry;

  @override
  Widget build(BuildContext context) {
    final asset = storeFeaturedArt[category];
    final fallback = Center(child: StoreAppIcon(entry: entry, size: 72));
    return asset == null
        ? fallback
        : Image.asset(
            asset,
            fit: BoxFit.cover,
            semanticLabel: '$category editorial illustration',
            errorBuilder: (_, _, _) => fallback,
          );
  }
}
