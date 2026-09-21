"""Authenticate every native-server route, including administrative endpoints."""
import hmac
import os


class LocalOnlyMiddleware:
    def __init__(self, app):
        self.app = app
        self.key = os.environ["VLLM_API_KEY"]

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            return await self.app(scope, receive, send)
        if scope["type"] != "http":
            return await send({"type": "websocket.close", "code": 1008})
        headers = {k.lower(): v.decode("latin1") for k, v in scope.get("headers", [])}
        port = os.environ["HARNESS_VLLM_PORT"]
        host = headers.get(b"host", "")
        origin = headers.get(b"origin")
        allowed = host in {f"127.0.0.1:{port}", f"localhost:{port}"}
        allowed = allowed and (not origin or origin == f"http://{host}")
        allowed = allowed and headers.get(b"sec-fetch-site") != "cross-site"
        allowed = allowed and hmac.compare_digest(headers.get(b"authorization", ""), "Bearer " + self.key)
        if not allowed:
            await send({"type": "http.response.start", "status": 403, "headers": [(b"content-type", b"application/json")]})
            return await send({"type": "http.response.body", "body": b'{"error":"Private workspace server"}'})
        return await self.app(scope, receive, send)
