import 'harness_home.dart';

/// The web build has no folders to look at and is never Linux.
HomeLook platformHomeLook({Map<String, String>? environment}) =>
    const HomeLook(linux: false, environment: {}, exists: _never);

bool _never(String path) => false;
