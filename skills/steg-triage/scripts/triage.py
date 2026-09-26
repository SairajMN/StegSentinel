#!/usr/bin/env python3
"""Steganalysis triage: score one file for hidden data. Detection only — payloads are never decoded."""
import json
import os
import re
import shutil
import subprocess
import sys
import zlib

TOOL_TIMEOUT_SECONDS = 15
CHUNK_LIMIT = 400
ARCHIVE_MAGIC = (b"PK\x03\x04", b"\x1f\x8b\x08", b"7z\xbc\xaf\x27\x1c", b"Rar!\x1a\x07")
PRINTABLE = re.compile(rb"[\x20-\x7e]{8,}")
BASE64ISH = re.compile(r"[A-Za-z0-9+/]{40,}={0,2}")


def run(args):
    if shutil.which(args[0]) is None:
        return None
    try:
        result = subprocess.run(args, capture_output=True, timeout=TOOL_TIMEOUT_SECONDS)
    except (subprocess.TimeoutExpired, OSError) as error:
        return f"ERROR: {error}"
    return (result.stdout + result.stderr).decode("utf-8", "replace")


def png_idat(blob):
    if not blob.startswith(b"\x89PNG\r\n\x1a\n"):
        return None
    offset, data = 8, bytearray()
    while offset + 8 <= len(blob):
        length = int.from_bytes(blob[offset : offset + 4], "big")
        kind = blob[offset + 4 : offset + 8]
        body = blob[offset + 8 : offset + 8 + length]
        if len(body) != length:
            return None
        if kind == b"IDAT":
            data += body
        if kind == b"IEND":
            return {"data": bytes(data), "end": offset + 12 + length}
        offset += 12 + length
    return None


def png_chunk_errors(blob):
    offset, bad = 8, []
    while offset + 8 <= len(blob):
        length = int.from_bytes(blob[offset : offset + 4], "big")
        kind = blob[offset + 4 : offset + 8]
        body = blob[offset + 8 : offset + 8 + length]
        if len(body) != length:
            bad.append(kind.decode("ascii", "replace"))
            break
        stored = int.from_bytes(blob[offset + 8 + length : offset + 12 + length], "big")
        if zlib.crc32(kind + body) & 0xFFFFFFFF != stored:
            bad.append(kind.decode("ascii", "replace"))
        offset += 12 + length
        if kind == b"IEND":
            break
    return bad
    return bad


def lsb_ascii_run(raw):
    bits = [byte & 1 for byte in raw]
    chars = bytearray(
        sum(bits[i + j] << (7 - j) for j in range(8)) for i in range(0, len(bits) - 7, 8)
    )
    match = PRINTABLE.search(bytes(chars))
    return match.group(0).decode("ascii") if match else None


def inspect(blob):
    signals = []
    idat = png_idat(blob)
    jpeg_end = blob.rfind(b"\xff\xd9") + 2 if blob.rfind(b"\xff\xd9") >= 0 else None
    trailer_start = idat["end"] if idat else jpeg_end

    if trailer_start is not None and len(blob) > trailer_start:
        signals.append(
            {
                "source": "fallback",
                "name": "trailing_data",
                "detail": f"{len(blob) - trailer_start} bytes after image end",
            }
        )

    for magic in ARCHIVE_MAGIC:
        if blob.find(magic, 16) >= 0:
            signals.append(
                {"source": "fallback", "name": "embedded_signature", "detail": f"{magic[:4]!r} found inside the file"}
            )
            break

    if idat:
        bad = png_chunk_errors(blob)
        if bad:
            signals.append({"source": "fallback", "name": "png_chunk_crc", "detail": f"bad CRC in {', '.join(bad)}"})
        try:
            raw = zlib.decompress(idat["data"])
        except zlib.error as error:
            signals.append({"source": "fallback", "name": "png_idat_invalid", "detail": str(error)})
        else:
            found = lsb_ascii_run(raw)
            if found:
                signals.append(
                    {"source": "fallback", "name": "lsb_ascii", "detail": f"LSB plane carries ASCII: {found[:60]!r}"}
                )
    return signals


def from_tools(results):
    signals = []
    exiftool = results.get("exiftool")
    if exiftool:
        for line in exiftool.splitlines():
            value = line.partition(":")[2].strip()
            if re.search(r"Comment|Description|Creator|Author|Title", line) and BASE64ISH.search(value):
                signals.append({"source": "exiftool", "name": "metadata_blob", "detail": line.strip()[:120]})
                break
            if re.search(r"Comment|Description", line) and len(value) > 120:
                signals.append({"source": "exiftool", "name": "oversized_metadata", "detail": line.strip()[:120]})
                break

    binwalk = results.get("binwalk")
    embedded_re = r"Zip archive|gzip compressed|7-zip|RAR archive|embedded"
    if binwalk and re.search(embedded_re, binwalk, re.I):
        hit = next((line.strip() for line in binwalk.splitlines() if re.search(embedded_re, line, re.I)), "")
        signals.append({"source": "binwalk", "name": "embedded_file", "detail": hit[:120]})

    zsteg = results.get("zsteg")
    if zsteg and re.search(r"b\d+,[a-z]+,(lsb|msb).*(text|file|signature|zlib)", zsteg, re.I):
        hit = next((line.strip() for line in zsteg.splitlines() if re.search(r"text|file|signature|zlib", line, re.I)), "")
        signals.append({"source": "zsteg", "name": "lsb_payload", "detail": hit[:120]})

    steghide = results.get("steghide")
    if steghide and re.search(r"embedded file|zlib compressed|encrypted", steghide, re.I):
        last = steghide.strip().splitlines()[-1] if steghide.strip() else ""
        signals.append({"source": "steghide", "name": "embedded_structure", "detail": last[:120]})

    pngcheck = results.get("pngcheck")
    if pngcheck and "ERROR" in pngcheck:
        hit = next((line.strip() for line in pngcheck.splitlines() if "ERROR" in line), "")
        signals.append({"source": "pngcheck", "name": "structural_anomaly", "detail": hit[:120]})
    return signals


def triage(path):
    with open(path, "rb") as handle:
        blob = handle.read()

    results = {
        "exiftool": run(["exiftool", path]),
        "binwalk": run(["binwalk", path]),
        "zsteg": run(["zsteg", path]),
        "steghide": run(["steghide", "info", "-p", "", path]),
        "pngcheck": run(["pngcheck", "-v", path]),
    }
    signals = from_tools(results) + inspect(blob)
    names = {signal["name"] for signal in signals}

    if names & {"embedded_file", "embedded_signature"} or len(names) >= 2:
        verdict = "likely_steganographic"
    elif names:
        verdict = "suspicious"
    else:
        verdict = "clean"

    return {
        "file": os.path.basename(path),
        "size": len(blob),
        "verdict": verdict,
        "signals": signals,
        "tools": {
            name: ("not installed" if output is None else output[:CHUNK_LIMIT])
            for name, output in results.items()
        },
        "summary": "; ".join(f"{signal['source']}:{signal['name']}" for signal in signals) or "nothing fired",
        "note": "detection only — payload contents were not decoded",
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: triage.py <file>", file=sys.stderr)
        sys.exit(2)
    print(json.dumps(triage(sys.argv[1]), indent=2))
