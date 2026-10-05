#!/usr/bin/env python3
"""Local page and input observer for a disposable browser-session VM only."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path

ROOT = Path('/tmp/harness-browser-probe')
PAGE = '''<!doctype html><meta charset="utf-8"><title>Harness browser check</title>
<style>html,body{background:rgb(230,245,236);color:black;margin:0}body{padding:24px}
label{display:block;margin-bottom:8px}input{font-size:24px;width:70%}</style>
<h1>Harness browser check</h1><label for="input">Keyboard</label>
<input id="input" autofocus autocomplete="off">
<script>
const input = document.querySelector('input');
let previous = '';
function report() {
  const data = JSON.stringify({
    path:location.pathname, input:input.value, focused:document.hasFocus(),
    inputFocused:document.activeElement === input,
    innerWidth, innerHeight, outerWidth, outerHeight,
    screenWidth:screen.width, screenHeight:screen.height
  });
  if (data !== previous) {
    previous = data;
    fetch('/observe', {method:'POST', body:data});
  }
}
for (const name of ['load','resize','focus','blur']) addEventListener(name, report);
input.addEventListener('input', report);
// Wayland bounds and HTML autofocus can settle after load without another
// resize event. Report state transitions instead of equating load with readiness.
setInterval(report, 100);
</script>'''


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        data = PAGE.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        size = int(self.headers.get('Content-Length', '0'))
        if self.path != '/observe' or not 0 < size < 4096:
            self.send_error(400)
            return
        data = json.loads(self.rfile.read(size))
        with (ROOT / 'events.jsonl').open('a') as output:
            output.write(json.dumps(data) + '\n')
        (ROOT / 'state.json.tmp').write_text(json.dumps(data))
        (ROOT / 'state.json.tmp').replace(ROOT / 'state.json')
        self.send_response(204)
        self.end_headers()


if __name__ == '__main__':
    ROOT.mkdir(exist_ok=True)
    HTTPServer(('127.0.0.1', 18782), Handler).serve_forever()
