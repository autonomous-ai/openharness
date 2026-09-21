import 'package:flutter/material.dart';

import '../core/dsh_catalog.dart';
import 'store_listing.dart';

/// Original editorial illustrations, kept separate from real project output.
/// These appear only in featured stories, never in the catalog's icon rows.
const storeFeaturedArt = <String, String>{
  'Coding': 'assets/store/editorial-code.png',
  'Design': 'assets/store/editorial-shape.png',
  'Engineering': 'assets/store/editorial-circuit.png',
  'Media': 'assets/store/editorial-media.png',
  'Music': 'assets/store/editorial-music.png',
  'Productivity': 'assets/store/editorial-productivity.png',
  'Science & Data': 'assets/store/editorial-science.png',
  'Simulation': 'assets/store/editorial-simulation.png',
  'Games': 'assets/store/editorial-games.png',
  'Research': 'assets/store/editorial-research.png',
  'Local AI': 'assets/store/editorial-local-ai.png',
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
