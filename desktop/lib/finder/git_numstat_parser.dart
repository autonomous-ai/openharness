/// Lines added and removed per path, from `git diff --numstat -z`.
///
/// A binary file is counted `-\t-`, which reads as no count at all (null)
/// rather than as zero. A rename's record is followed by its two paths, and
/// is filed under the new one — the path `git status` names it by.
Map<String, (int?, int?)> parseGitNumstat(String output) {
  final counts = <String, (int?, int?)>{};
  final records = output.split('\u0000');
  for (var i = 0; i < records.length; i++) {
    final fields = records[i].split('\t');
    if (fields.length != 3) continue;
    final added = int.tryParse(fields[0]);
    final removed = int.tryParse(fields[1]);
    var path = fields[2];
    if (path.isEmpty) {
      // Renamed: the old path, then the new one, in the next two records.
      if (i + 2 >= records.length) break;
      path = records[i + 2];
      i += 2;
    }
    counts[path] = (added, removed);
  }
  return counts;
}
