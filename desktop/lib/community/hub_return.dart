/// Only Hub pages can request a return from the existing web sign-in.
String? hubReturnPath(String? raw) {
  if (raw == null || raw.length > 1000 || raw.contains('\\')) return null;
  final uri = Uri.tryParse(raw);
  if (uri == null ||
      uri.hasScheme ||
      uri.hasAuthority ||
      uri.hasFragment ||
      !(uri.path == '/hub' || uri.path.startsWith('/hub/')) ||
      uri.path.split('/').any((part) => part == '..' || part == '.')) {
    return null;
  }
  return uri.toString();
}
