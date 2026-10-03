/// An owner's viewer destination. IDs identify work; the URL grants no access. The browser
/// still needs its own sign-in and a trusted, encrypted link to the selected machine.
class ViewerLocation {
  const ViewerLocation(this.machineId, this.agentId);
  final String machineId, agentId;

  static bool isRoute(Uri uri) {
    if (uri.path != '/') return false;
    // Inspect keys without decoding values: a damaged identity must still stay on
    // the viewer error page instead of throwing or restoring the normal desk.
    for (final field in uri.query.split('&')) {
      try {
        if (Uri.decodeQueryComponent(field.split('=').first) == 'viewer') {
          return true;
        }
      } on FormatException {
        // An unrelated damaged key cannot hide a later viewer flag.
      }
    }
    return false;
  }

  static ViewerLocation? parse(Uri uri) {
    if (!isRoute(uri)) return null;
    try {
      if (uri.queryParametersAll['viewer']?.length != 1 ||
          uri.queryParameters['viewer'] != '1') {
        return null;
      }
      String? id(String key) {
        final values = uri.queryParametersAll[key];
        if (values == null || values.length != 1) return null;
        final value = values.single;
        if (value.isEmpty ||
            value.length > 160 ||
            value.runes.any((c) => c < 32 || c == 127)) {
          return null;
        }
        return value;
      }

      final machine = id('machine'), agent = id('agent');
      return machine == null || agent == null
          ? null
          : ViewerLocation(machine, agent);
    } on FormatException {
      return null;
    }
  }

  static String? returnPath(Object? value) {
    if (value is! String) return null;
    final uri = Uri.tryParse(value);
    if (uri == null ||
        uri.hasScheme ||
        uri.hasAuthority ||
        parse(uri) == null) {
      return null;
    }
    return uri.toString();
  }

  /// OAuth restores its destination before signed-in bootstrap. Until that happens, no callback
  /// tab should restore or claim a terminal from the saved workspace.
  static bool workspaceAllowed(Uri uri) =>
      !isRoute(uri) && uri.path != '/auth/callback' && uri.path != '/callback';
}
