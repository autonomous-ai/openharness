/// Share URLs keep the pinned owner identity in the fragment, outside server/access logs.
class SharedAgentLocation {
  const SharedAgentLocation(this.id, this.ownerKey, this.environment);
  final String id;
  final String? ownerKey;
  final String environment;

  static SharedAgentLocation? parse(Uri uri) {
    final match = RegExp(
      r'^/s/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/?$',
    ).firstMatch(uri.path);
    if (match == null) return null;
    String? key;
    try {
      key = Uri.splitQueryString(uri.fragment)['key'];
    } on FormatException {
      /* An incomplete link has no trusted identity. */
    }
    final env = uri.queryParameters['env'] ?? 'prod';
    return SharedAgentLocation(match[1]!, key, env);
  }

  /// Only a local share path can be restored after OAuth. Never accept an external redirect.
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
}
