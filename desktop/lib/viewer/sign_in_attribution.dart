/// The keys auth-service carries back onto the sign-in callback: the `utm_*` tags and
/// Autonomous's referral id `rid`.
const _attributionKeys = {
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'rid',
};

/// Where this sign-in came from, as the marketing site tagged it: the [_attributionKeys] of [callback],
/// under their URL keys, for `/api/auth/exchange` to record on the account (backend
/// lib/signInAttribution.ts). Empty when the sign-in carried none.
Map<String, String> signInAttribution(Uri callback) => {
  for (final MapEntry(:key, :value) in callback.queryParameters.entries)
    if (_attributionKeys.contains(key) && value.trim().isNotEmpty) key: value,
};
