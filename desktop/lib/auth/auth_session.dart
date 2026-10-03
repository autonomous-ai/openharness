import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';

/// Persists SSO access + refresh tokens through the platform's state store.
class AuthSession {
  final LocalKeyValueStore _storage;
  static const _access = 'auth_access_token';
  static const _refresh = 'auth_refresh_token';
  static const _env = 'auth_autonomous_env';
  static const _expiresAt = 'auth_access_token_expires_at';
  static const _ssoClientId = 'auth_sso_client_id';

  AuthSession({LocalKeyValueStore? storage})
    : _storage = storage ?? HarnessFileStore.shared;

  /// Store a newly authenticated session. A missing refresh token clears any
  /// stale token left by a previous account/environment.
  Future<void> saveLogin({
    required String token,
    String? refreshToken,
    String autonomousEnv = 'prod',
    int? expiresIn,
    String? ssoClientId,
  }) async {
    await _storage.write(_access, token);
    if (refreshToken != null && refreshToken.isNotEmpty) {
      await _storage.write(_refresh, refreshToken);
    } else {
      await _storage.delete(_refresh);
    }
    await _storage.write(_env, autonomousEnv);
    // Belongs to this sign-in alone: one that names no client must not inherit the last one's.
    if (ssoClientId != null && ssoClientId.isNotEmpty) {
      await _storage.write(_ssoClientId, ssoClientId);
    } else {
      await _storage.delete(_ssoClientId);
    }
    await _saveExpiry(expiresIn);
  }

  /// Store a refreshed access token. Identity providers do not always rotate
  /// the refresh token, so retain the current one when it is omitted.
  Future<void> saveRefresh({
    required String token,
    String? refreshToken,
    required String autonomousEnv,
    int? expiresIn,
  }) async {
    await _storage.write(_access, token);
    if (refreshToken != null && refreshToken.isNotEmpty) {
      await _storage.write(_refresh, refreshToken);
    }
    await _storage.write(_env, autonomousEnv);
    await _saveExpiry(expiresIn);
  }

  Future<String?> accessToken() => _storage.read(_access);
  Future<String?> refreshToken() => _storage.read(_refresh);
  Future<String> autonomousEnv() async => (await _storage.read(_env)) ?? 'prod';

  /// The auth-service client this session was issued to, which a refresh names again. Null is
  /// the backend's configured one: every session saved before the clients were split.
  Future<String?> ssoClientId() => _storage.read(_ssoClientId);
  Future<DateTime?> accessTokenExpiresAt() async {
    final raw = await _storage.read(_expiresAt);
    final milliseconds = int.tryParse(raw ?? '');
    return milliseconds == null
        ? null
        : DateTime.fromMillisecondsSinceEpoch(milliseconds, isUtc: true);
  }

  Future<void> _saveExpiry(int? expiresIn) async {
    if (expiresIn == null || expiresIn <= 0) {
      await _storage.delete(_expiresAt);
      return;
    }
    final expiresAt = DateTime.now().toUtc().add(Duration(seconds: expiresIn));
    await _storage.write(
      _expiresAt,
      expiresAt.millisecondsSinceEpoch.toString(),
    );
  }

  Future<void> clear() async {
    await _storage.delete(_access);
    await _storage.delete(_refresh);
    await _storage.delete(_env);
    await _storage.delete(_expiresAt);
    await _storage.delete(_ssoClientId);
  }
}
