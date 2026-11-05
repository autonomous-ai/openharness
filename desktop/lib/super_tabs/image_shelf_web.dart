import 'image_cache.dart';

/// A browser keeps its chat pictures in memory, so less of them.
const kDefaultShelfBytes = 64 * 1024 * 1024;

/// A browser has no Harness home: memory, gone with the page.
SuperTabImageShelf defaultImageShelf({Map<String, String>? environment}) =>
    MemoryImageShelf();
