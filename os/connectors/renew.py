"""Renewing tokens before they expire, once across every agent and the bridge."""
import connection_store as store
import gateway
import oauth


def refresh(vault, code, force=False):
    """The connection's token, renewed if it is due (or forced). A revoked grant
    marks the connection for reconnecting instead of failing every request."""
    with store.locked(vault.root):
        token = vault.token(code)
        if not token:
            raise store.StoreError("Not connected. Open harness connections to connect an account.")
        # Another process may have renewed it while this one waited for the lock.
        if not (force and store.refreshable(token)) and not store.needs_refresh(token):
            return token
        try:
            renewed = gateway.refresh(code, token) if token.get("source") == "gateway" else oauth.refresh(vault, token)
        except store.StoreError as error:
            if str(error) != "invalid_grant":
                raise
            token["needs_reconnect"] = True
            vault.put(code, token)
            raise store.StoreError("This account needs to be connected again in Connections.")
        for key in ("label", "account_name"):
            if token.get(key) and not renewed.get(key):
                renewed[key] = token[key]
        vault.put(code, renewed)
        return vault.token(code)


def refresh_due(vault):
    """Renew every connection that is due; {code: error} for the ones that failed."""
    failed = {}
    for code, token in vault.tokens().items():
        if store.needs_refresh(token):
            try:
                refresh(vault, code)
            except store.StoreError as error:
                failed[code] = str(error)
    return failed
