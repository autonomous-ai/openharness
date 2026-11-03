/// The release a web build was built as, compiled in by
/// `scripts/build-web-release.sh` (`--dart-define=HARNESS_BUILD_VERSION`).
/// Empty for a build that was not: `flutter run`, and Desktop.
const kBuiltWebVersion = String.fromEnvironment('HARNESS_BUILD_VERSION');

/// [built] as a version, or null when none was compiled in.
String? builtWebVersion([String built = kBuiltWebVersion]) =>
    built.trim().isEmpty ? null : built.trim();

/// The release this page is, for the account menu: the one compiled into it,
/// else what it read from its host at start-up ([declared]). Never the host's
/// answer alone where a build can say its own: a page an old cache keeps
/// starts later and would read the host's newer release as its own, and so
/// never say it is out of date (review of #2622).
String? webPageVersion({String built = kBuiltWebVersion, String? declared}) =>
    builtWebVersion(built) ?? declared;

/// The same, for the watch for a newer release: a build with none compiled in
/// takes what [readHost] says, since there is no better answer.
Future<String?> webRunningVersion({
  String built = kBuiltWebVersion,
  required Future<String?> Function() readHost,
}) async => builtWebVersion(built) ?? await readHost();
