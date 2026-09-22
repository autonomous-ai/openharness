#!/usr/bin/env python3
"""Screenshot the CoreS3 over its cable: what is on the glass, as a PNG.

    scripts/cores3-snap.py /dev/cu.usbmodem* out.png [--send '{"t":"..."}' ...]

Sends {"t":"debug.snap"} in a cable frame and collects the SNAP frames the firmware answers with
(ui/display_cores3.c): each is a 4-byte little-endian offset then native RGB565 pixels, 320x240 in
all. Nothing else may hold the port — the Harness daemon included. Extra --send messages go out first,
so a screen can be reached before it is captured (e.g. a fake `question` frame).
"""
import argparse
import json
import struct
import sys
import time
import zlib

import serial

W, H = 320, 240
MAGIC = b"\xA5\x48"
T_JSON, T_LOG, T_SNAP = 0x01, 0x04, 0x05


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def frame(ftype: int, payload: bytes) -> bytes:
    body = bytes([1, ftype]) + struct.pack("<H", len(payload)) + payload
    return MAGIC + body + struct.pack("<H", crc16(body))


def frames(buf: bytearray):
    """Yield (type, payload) for every whole frame at the front of buf, consuming it."""
    while True:
        i = buf.find(MAGIC)
        if i < 0:
            del buf[:-1]
            return
        del buf[:i]
        if len(buf) < 8:
            return
        ftype, n = buf[3], struct.unpack("<H", buf[4:6])[0]
        if len(buf) < 8 + n:
            return
        body, crc = bytes(buf[2:6 + n]), struct.unpack("<H", buf[6 + n:8 + n])[0]
        if crc16(body) != crc:
            del buf[:2]
            continue
        del buf[:8 + n]
        yield ftype, body[4:]


def png(path: str, rgb565: bytes) -> None:
    rows = bytearray()
    for y in range(H):
        rows.append(0)
        for x in range(W):
            v = rgb565[(y * W + x) * 2] | rgb565[(y * W + x) * 2 + 1] << 8
            rows += bytes(((v >> 11) * 255 // 31, ((v >> 5) & 63) * 255 // 63, (v & 31) * 255 // 31))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("port")
    ap.add_argument("out")
    ap.add_argument("--send", action="append", default=[], help="JSON message to send before the snapshot")
    ap.add_argument("--wait", type=float, default=0.6, help="seconds between the sends and the snapshot")
    ap.add_argument("--timeout", type=float, default=8)
    a = ap.parse_args()

    s = serial.Serial()
    s.port, s.baudrate, s.timeout = a.port, 115200, 0.1
    s.dtr = s.rts = False          # toggling either on the S3's USB-JTAG can reset the chip
    s.open()
    # Opening the port resets the S3 on some hosts (USB-JTAG), whatever DTR/RTS say. If it is booting, wait
    # for the cable to come up before speaking — anything sent earlier lands before the link listens.
    boot, seen = time.time(), bytearray()
    while time.time() - boot < 8:
        seen += s.read(65536)
        if b"cable client started" in seen:
            time.sleep(1.5)          # the first screen settles
            break
        if time.time() - boot > 1.2 and b"ESP-ROM" not in seen and b"I (" not in seen:
            break                    # no boot under way: the device was already up
    for m in a.send:
        s.write(frame(T_JSON, json.dumps(json.loads(m)).encode()))
    if a.send:
        time.sleep(a.wait)
    s.reset_input_buffer()
    s.write(frame(T_JSON, b'{"t":"debug.snap"}'))

    img = bytearray(W * H * 2)
    got = 0
    buf = bytearray()
    deadline = time.time() + a.timeout
    while time.time() < deadline and got < len(img):
        buf += s.read(65536)
        for ftype, payload in frames(buf):
            if ftype == T_SNAP and len(payload) > 4:
                off = struct.unpack("<I", payload[:4])[0]
                data = payload[4:]
                img[off:off + len(data)] = data
                got += len(data)
            elif ftype == T_LOG and "--logs" in sys.argv:
                print(payload.decode(errors="replace").rstrip())
    s.close()
    if got < len(img) * 0.9:
        print(f"incomplete: {got}/{len(img)} bytes", file=sys.stderr)
        return 1
    if got < len(img):
        print(f"note: {len(img) - got} bytes missing (drawn black)", file=sys.stderr)
    png(a.out, bytes(img))
    print(a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
