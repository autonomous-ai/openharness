"""A stand-in for cdn.autonomous.ai in linux-install.sh: serves a folder over HTTPS on 127.0.0.1:443, under a
certificate a throwaway CA signed, and appends each request line and its status to requests.log beside the folder.

    sudo python3 -I https-fake-cdn.py <folder> <cert> <key>
"""

import functools
import http
import http.server
import os
import ssl
import sys


def main():
    if len(sys.argv) != 4:
        print("usage: https-fake-cdn.py <folder> <cert> <key>", file=sys.stderr)
        return 2
    folder, cert, key = (os.path.abspath(arg) for arg in sys.argv[1:])
    requests_log = os.path.join(os.path.dirname(folder), "requests.log")

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_request(self, code="-", size="-"):
            if isinstance(code, http.HTTPStatus):
                code = code.value
            with open(requests_log, "a", encoding="utf-8") as log:
                log.write(f"{self.requestline} {code}\n")

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 443), functools.partial(Handler, directory=folder))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
