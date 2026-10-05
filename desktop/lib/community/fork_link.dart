/// Public links carry an identifier and a retry receipt, never a URL, path or command.
class ForkLink {
  const ForkLink(this.harnessId, this.requestId);
  final String harnessId;
  final String requestId;
  static final _id = RegExp(
    r'^(starter-[a-z0-9-]{1,80}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$',
  );
  static final _request = RegExp(
    r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',
  );
  String get key => '$harnessId/$requestId';
  String get url => 'harness://fork/$harnessId?request=$requestId';
  static ForkLink? parse(String value) {
    if (value.length > 240) return null;
    final uri = Uri.tryParse(value);
    if (uri == null ||
        uri.scheme != 'harness' ||
        uri.host != 'fork' ||
        uri.hasPort ||
        uri.userInfo.isNotEmpty ||
        uri.fragment.isNotEmpty ||
        uri.pathSegments.length != 1 ||
        uri.queryParametersAll.length != 1) {
      return null;
    }
    final requests = uri.queryParametersAll['request'];
    if (requests == null ||
        requests.length != 1 ||
        !_request.hasMatch(requests.single) ||
        !_id.hasMatch(uri.pathSegments.single)) {
      return null;
    }
    return ForkLink(uri.pathSegments.single, requests.single);
  }
}
