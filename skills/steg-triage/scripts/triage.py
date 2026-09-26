#!/usr/bin/env python3
"""Steganalysis triage: score one file for hidden data. Detection only — payloads are never decoded."""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import zlib

TOOL_TIMEOUT_SECONDS = 15
BOOTSTRAP_TIMEOUT_SECONDS = 300
NOT_APPLICABLE = "not applicable to this format"
CHUNK_LIMIT = 400
ARCHIVE_MAGIC = (b"PK\x03\x04", b"\x1f\x8b\x08", b"7z\xbc\xaf\x27\x1c", b"Rar!\x1a\x07")
PRINTABLE = re.compile(rb"[\x20-\x7e]{8,}")
BASE64ISH = re.compile(r"[A-Za-z0-9+/]{40,}={0,2}")


def looks_base64(text):
    """Base64 payload, not prose that happens to contain 40 alphanumerics in a row.

    A calendar Description full of meeting URLs matched the old loose pattern and was
    reported as a hidden blob. Real base64 mixes cases and digits throughout and has no
    spaces; prose almost always has whitespace, so that is the cheapest reliable split.
    """
    stripped = text.strip()
    if len(stripped) < 40 or " " in stripped:
        return False
    candidate = stripped[:200]
    if not re.fullmatch(r"[A-Za-z0-9+/=]+", candidate):
        return False
    digits = sum(c.isdigit() for c in candidate)
    upper = sum(c.isupper() for c in candidate)
    lower = sum(c.islower() for c in candidate)
    return digits >= len(candidate) * 0.05 and upper >= 3 and lower >= 3
ZSTEG_TEXT = re.compile(r"text:\s*(\".*\")", re.S)
ZSTEG_MIN_RUN = 24
ZSTEG_WORD = re.compile(r"[A-Za-z]{4,}")


def tool_dirs():
    """Where to look for tools beyond PATH, overridable so the no-tools case is testable."""
    override = os.environ.get("STEG_TOOL_DIRS")
    if override is not None:
        return [entry for entry in override.split(os.pathsep) if entry]
    return [
        *sorted(glob.glob(os.path.expanduser("~/.gem/ruby/*/bin"))),
        os.path.expanduser("~/.local/bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ]


def bootstrap():
    """Install the missing analysis tools once per sandbox.

    The Daytona image is bare, so a fresh sandbox reports every tool as 'not installed'
    and the verdict rests on the pure-Python fallbacks alone. That is a weaker analysis
    than the skill claims, so install rather than silently degrade. Best effort: a sandbox
    without network or root still gets the fallbacks.
    """
    wanted = [name for name in ("exiftool", "binwalk", "pngcheck", "zsteg", "steghide")
              if tool_path(name) is None]
    if not wanted:
        return []
    if os.environ.get("STEG_NO_BOOTSTRAP") == "1":
        return wanted
    installer = os.path.join(os.path.dirname(os.path.abspath(__file__)), "install_tools.sh")
    if not os.access(installer, os.X_OK):
        return wanted
    try:
        subprocess.run([installer], capture_output=True, timeout=BOOTSTRAP_TIMEOUT_SECONDS)
    except (subprocess.TimeoutExpired, OSError):
        pass
    return [name for name in wanted if tool_path(name) is None]


def tool_path(name):
    if shutil.which(name) is not None:
        return name
    for directory in tool_dirs():
        candidate = os.path.join(directory, name)
        if os.access(candidate, os.X_OK):
            return candidate
    return None


def run(args):
    binary = tool_path(args[0])
    if binary is None:
        return None
    try:
        result = subprocess.run([binary, *args[1:]], capture_output=True, timeout=TOOL_TIMEOUT_SECONDS)
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
            ihdr = blob[16:16 + 13]
            width = int.from_bytes(ihdr[0:4], "big") if len(ihdr) >= 13 else 0
            depth, color = ihdr[8], ihdr[9]
            channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color, 0)
            return {
                "data": bytes(data),
                "end": offset + 12 + length,
                "width": width,
                "channels": channels,
                "depth": depth,
            }
        offset += 12 + length
    return None


PNG_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


def png_pixels(raw, width, channels):
    """Reverse the per-scanline PNG filters so bit-plane work sees real samples."""
    if not width or channels not in PNG_CHANNELS.values():
        return b""
    stride = width * channels
    out = bytearray()
    prior = bytearray(stride)
    for start in range(0, len(raw) - stride, stride + 1):
        filter_type, line, offset = raw[start], bytearray(raw[start + 1 : start + 1 + stride]), start + 1
        for index in range(stride):
            left = line[index - channels] if index >= channels else 0
            up = prior[index]
            upper_left = prior[index - channels] if index >= channels else 0
            if filter_type == 1:
                line[index] = (line[index] + left) & 0xFF
            elif filter_type == 2:
                line[index] = (line[index] + up) & 0xFF
            elif filter_type == 3:
                line[index] = (line[index] + ((left + up) >> 1)) & 0xFF
            elif filter_type == 4:
                estimate = left + up - upper_left
                distances = (abs(estimate - left), abs(estimate - up), abs(estimate - upper_left))
                predictor = (left, up, upper_left)[distances.index(min(distances))]
                line[index] = (line[index] + predictor) & 0xFF
        out += line
        prior = line
    return bytes(out)


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


def png_text_chunks(blob):
    offset = 8
    while offset + 8 <= len(blob):
        length = int.from_bytes(blob[offset : offset + 4], "big")
        kind = blob[offset + 4 : offset + 8]
        body = blob[offset + 8 : offset + 8 + length]
        if len(body) != length:
            return
        if kind in (b"tEXt", b"zTXt", b"iTXt"):
            keyword = body.partition(b"\x00")[0].decode("latin1", "replace")
            value = body.partition(b"\x00")[2]
            if kind == b"zTXt":
                try:
                    value = zlib.decompress(value[1:])
                except zlib.error:
                    value = b""
            yield keyword, value
        if kind == b"IEND":
            return
        offset += 12 + length


def bits_to_bytes(bits, msb_first):
    out = bytearray()
    for index in range(0, len(bits) - 7, 8):
        group = bits[index : index + 8]
        value = 0
        for position, bit in enumerate(group):
            value = (value << 1) | bit if msb_first else value | (bit << position)
        out.append(value)
    return bytes(out)


def degenerate(chunk):
    """Repetitive bytes are a gradient/padding artifact, not a payload.

    A clean synthetic image unfilters into a short repeating cycle, which decodes
    to endless printable runs. Real payloads are not periodic.
    """
    for period in (1, 2, 3, 4, 6, 8):
        if len(chunk) < period * 4:
            continue
        if (chunk[:period] * (len(chunk) // period + 1))[: len(chunk)] == chunk:
            return True
    return False


def lsb_ascii_run(pixels, channels):
    """Scan each channel and the interleaved stream for a readable run in a bit plane."""
    if not pixels:
        return None
    planes = [pixels[channel::channels] for channel in range(channels)] + [pixels]
    best = (0, None)
    for label, samples in zip([f"channel {i}" for i in range(channels)] + ["interleaved"], planes):
        for bit_index, msb_first in ((0, True), (0, False), (1, True), (1, False)):
            bits = [(sample >> bit_index) & 1 for sample in samples]
            decoded = bits_to_bytes(bits, msb_first)
            where = f"{label} bit {bit_index}"
            length = int.from_bytes(decoded[:4], "big")
            if 8 <= length <= len(decoded) - 4:
                body = decoded[4 : 4 + length]
                if PRINTABLE.fullmatch(body) and not degenerate(body):
                    return f"length-prefixed ASCII payload of {length} bytes in {where}"
            for match in PRINTABLE.finditer(decoded):
                chunk = match.group(0)
                words = len(ZSTEG_WORD.findall(chunk.decode("ascii", "replace")))
                if words >= 2 and not degenerate(chunk) and len(chunk) > best[0]:
                    best = (len(chunk), f"printable run of {len(chunk)} characters in {where}")
    return best[1] if best[0] >= ZSTEG_MIN_RUN else None


def inspect(blob, kind="unknown"):
    signals = []
    if kind in ("archive", "unknown"):
        # A docx is a zip: PK headers repeat by design, and a random 0xffd9 can appear in
        # any compressed stream. Marker scanning is only meaningful in a known image format.
        return signals

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

    suspicious_keywords = re.compile(r"comment|description|creator|author|title|payload|note|profile", re.I)
    for keyword, value in png_text_chunks(blob):
        if not suspicious_keywords.search(keyword):
            continue
        text = value.decode("latin1", "replace").strip()
        if looks_base64(text) or len(text) > 80:
            signals.append(
                {
                    "source": "fallback",
                    "name": "oversized_metadata",
                    "detail": f"tEXt {keyword}: {text[:60]!r}",
                }
            )
        elif PRINTABLE.search(value[:512]) and re.search(r"payload|secret|steg|hidden|flag\{", text, re.I):
            signals.append(
                {"source": "fallback", "name": "metadata_payload", "detail": f"tEXt {keyword}: {text[:60]!r}"}
            )

    if idat:
        bad = png_chunk_errors(blob)
        if bad:
            signals.append({"source": "fallback", "name": "png_chunk_crc", "detail": f"bad CRC in {', '.join(bad)}"})
        try:
            raw = zlib.decompress(idat["data"])
        except zlib.error as error:
            signals.append({"source": "fallback", "name": "png_idat_invalid", "detail": str(error)})
        else:
            pixels = png_pixels(raw, idat["width"], idat["channels"])
            if not pixels:
                signals.append({"source": "fallback", "name": "png_unfilter_failed", "detail": "unsupported PNG variant or short IDAT"})
            else:
                found = lsb_ascii_run(pixels, idat["channels"])
                if found:
                    signals.append(
                        {"source": "fallback", "name": "lsb_ascii", "detail": f"LSB plane carries ASCII: {found[:60]!r}"}
                    )
    return signals


def from_tools(results):
    signals = []
    exiftool = results.get("exiftool")
    if exiftool:
        # exiftool always prints filesystem facts (File Name, Directory, File Size, ExifTool
        # Version). Those are it describing where the file is, not data inside it, and
        # matching "Directory" as a Description flagged every calendar invite as suspicious.
        noise = re.compile(r"^(File Name|Directory|File Size|File Modification Date|File Access|"
                           r"File Inode|ExifTool Version|File Permissions|File Type|File Inode Change)", re.I)
        # Formats with legitimate long prose fields: a calendar Description is a real event
        # description, not a hidden payload. Only flag length on formats where a field that
        # long has no innocent explanation.
        prose_ok = results.get("_kind") in ("archive", "unknown", "pdf")
        for line in exiftool.splitlines():
            name, _, value = line.partition(":")
            if noise.match(name.strip()) or not value.strip():
                continue
            if re.search(r"Comment|Description|Creator|Author|Title", name) and looks_base64(value):
                signals.append({"source": "exiftool", "name": "metadata_blob", "detail": line.strip()[:120]})
                break
            if not prose_ok and re.search(r"Comment|Description", name) and len(value.strip()) > 120:
                signals.append({"source": "exiftool", "name": "oversized_metadata", "detail": line.strip()[:120]})
                break

    binwalk = results.get("binwalk")
    embedded_re = r"Zip archive|gzip compressed|7-zip|RAR archive|embedded"
    # A .docx/.pkpass is a zip by construction, so binwalk listing its members is the format
    # working. Only treat an embedded file as a signal in a format where it should not exist.
    if binwalk and results.get("_kind") not in ("archive",) and re.search(embedded_re, binwalk, re.I):
        hit = next((line.strip() for line in binwalk.splitlines() if re.search(embedded_re, line, re.I)), "")
        signals.append({"source": "binwalk", "name": "embedded_file", "detail": hit[:120]})

    zsteg = results.get("zsteg")
    for line in (zsteg or "").splitlines():
        # zsteg prints a text: hit for almost any bitplane, including noise like "7Cs73sG4sG%rW%rg&rg"
        # from coarse 4x-downscaled planes. A real hidden message is long AND reads as words, so demand both.
        if not re.search(r"^b\d+,[a-z]+,(lsb|msb),", line):
            continue
        found = ZSTEG_TEXT.search(line)
        if not found:
            continue
        text = found.group(1).strip().strip('"')
        if len(text) >= ZSTEG_MIN_RUN and len(ZSTEG_WORD.findall(text)) >= 2:
            signals.append({"source": "zsteg", "name": "lsb_payload", "detail": line.strip()[:120]})
            break

    steghide = results.get("steghide")
    if steghide and re.search(r"embedded file|zlib compressed|encrypted", steghide, re.I):
        last = steghide.strip().splitlines()[-1] if steghide.strip() else ""
        signals.append({"source": "steghide", "name": "embedded_structure", "detail": last[:120]})

    pngcheck = results.get("pngcheck")
    if pngcheck and "ERROR" in pngcheck:
        hit = next((line.strip() for line in pngcheck.splitlines() if "ERROR" in line), "")
        signals.append({"source": "pngcheck", "name": "structural_anomaly", "detail": hit[:120]})
    return signals


def applicable(path, blob):
    """Tools are format-specific. Running pngcheck on a calendar invite just yields
    'not a PNG', which is a type mismatch, not evidence of anything.

    A .docx or .pkpass *is* a zip, so binwalk finding files inside one is the format
    working as designed, not data hidden in it. Only formats where appending or LSB
    tricks are meaningful are worth a verdict.
    """
    head = blob[:12]
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", ["exiftool", "binwalk", "zsteg", "pngcheck"]
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg", ["exiftool", "binwalk", "steghide"]
    if head.startswith(b"RIFF") and blob[8:12] == b"WAVE":
        return "wav", ["exiftool", "binwalk", "steghide"]
    if head.startswith(b"BM"):
        return "bmp", ["exiftool", "binwalk", "zsteg", "steghide"]
    if blob[:5] == b"%PDF-":
        return "pdf", ["exiftool", "binwalk"]
    if blob[:4] in (b"PK\x03\x04", b"Rar!", b"7z\xbc\xaf\x27\x1c") or blob[:2] == b"\x1f\x8b":
        return "archive", []
    return "unknown", []


def trailing_data(blob, kind):
    """Bytes after the format's real end. PDFs conventionally pad with whitespace after
    %%EOF, so that padding is not a signal."""
    if kind == "pdf":
        end = blob.rfind(b"%%EOF")
        return b"" if end < 0 else blob[end + 5:].strip()
    return blob


def triage(path):
    with open(path, "rb") as handle:
        blob = handle.read()

    kind, wanted = applicable(path, blob)
    still_missing = bootstrap()
    results = {
        "_kind": kind,
        "exiftool": run(["exiftool", path]),
        "binwalk": run(["binwalk", path]),
        "zsteg": run(["zsteg", path]) if "zsteg" in wanted else None,
        "steghide": run(["steghide", "info", "-p", "", path]) if "steghide" in wanted else None,
        "pngcheck": run(["pngcheck", "-v", path]) if "pngcheck" in wanted else None,
    }
    unique = {}
    for signal in from_tools(results) + inspect(trailing_data(blob, kind), kind):
        unique.setdefault(signal["name"], signal)
    signals = list(unique.values())
    names = set(unique)

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
        "kind": kind,
        "signals": signals,
        "tools": {
            name: (NOT_APPLICABLE if name not in wanted else "not installed" if output is None else output[:CHUNK_LIMIT])
            for name, output in results.items()
            if name != "_kind"
        },
        "summary": "; ".join(f"{signal['source']}:{signal['name']}" for signal in signals) or "nothing fired",
        "unavailable_tools": still_missing,
        "note": "detection only — payload contents were not decoded",
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: triage.py <file>", file=sys.stderr)
        sys.exit(2)
    print(json.dumps(triage(sys.argv[1]), indent=2))
