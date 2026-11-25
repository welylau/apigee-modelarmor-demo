"""Best-effort PDF text extraction, Python stdlib only.

Used by the demo server for the *native* path: Apigee's SanitizeUserPrompt policy only screens
text, so the client (this server) has to pull the text out of an uploaded PDF first. The callout
path sends the raw PDF to Model Armor instead, which parses the document itself.

Handles what most generated PDFs use: FlateDecode streams, object streams (PDF 1.5+), literal and
hex strings, Tj / TJ / ' / " operators and ToUnicode CMaps (CID fonts from Word, Chrome, etc.).
It does NOT do OCR, decrypt, or understand every font encoding; failures return less text, which
the UI reports. Invisible text (white, tiny, off-page) is extracted like any other text, on purpose:
that is exactly what an LLM would read.
"""
import re
import zlib

_OBJ_RE = re.compile(rb"(\d+)\s+(\d+)\s+obj\b(.*?)\bendobj", re.S)
_REF_RE = re.compile(rb"(\d+)\s+\d+\s+R")
_WS = b" \t\r\n\f\x00"
_DELIM = b"()<>[]{}/%"
_MAX_STREAM_OUT = 20 * 1024 * 1024  # decompression-bomb guard per stream
_MAX_DOC_INFLATED = 40 * 1024 * 1024  # ... and for all streams of one document together
_MAX_CMAP_ENTRIES = 200_000           # ToUnicode entries across all fonts (bfrange expansion guard)


class PdfError(Exception):
    pass


class _Budget:
    """Per-document resource counters. Exceeding one stops extraction with a PdfError."""

    def __init__(self):
        self.inflated = 0
        self.cmap_entries = 0

    def add_inflated(self, n):
        self.inflated += n
        if self.inflated > _MAX_DOC_INFLATED:
            raise PdfError(f"the PDF expands to more than {_MAX_DOC_INFLATED // (1024 * 1024)} MB of streams")

    def add_cmap(self, n=1):
        self.cmap_entries += n
        if self.cmap_entries > _MAX_CMAP_ENTRIES:
            raise PdfError("the PDF's font maps are too large")


def _inflate(raw, budget=None):
    d = zlib.decompressobj()
    try:
        out = d.decompress(raw, _MAX_STREAM_OUT)
    except zlib.error:
        return None
    if budget is not None:
        budget.add_inflated(len(out))
    return out


def _split_stream(body):
    """(dict_bytes, stream_bytes|None) for one object body."""
    i = body.find(b"stream")
    if i < 0 or b"endstream" not in body[i:]:
        return body, None
    head = body[:i]
    j = i + 6
    if body[j:j + 2] == b"\r\n":
        j += 2
    elif body[j:j + 1] in (b"\n", b"\r"):
        j += 1
    end = body.rfind(b"endstream")
    raw = body[j:end].rstrip(b"\r\n")
    m = re.search(rb"/Length\s+(\d+)(?!\s+\d+\s+R)", head)
    if m and int(m.group(1)) <= len(body) - j:
        raw = body[j:j + int(m.group(1))]
    return head, raw


def _decode_stream(head, raw, budget=None):
    if raw is None:
        return None
    if b"/Filter" not in head:
        return raw
    filters = re.findall(rb"/(FlateDecode|Fl|DCTDecode|JPXDecode|ASCIIHexDecode|ASCII85Decode|LZWDecode|CCITTFaxDecode|JBIG2Decode|RunLengthDecode)\b", head)
    if filters and all(f in (b"FlateDecode", b"Fl") for f in filters):
        return _inflate(raw, budget)
    return None  # images or filters we don't need for text


def _load_objects(data, budget=None):
    objs = {}  # num -> (dict_bytes, decoded_stream|None)
    for m in _OBJ_RE.finditer(data):
        head, raw = _split_stream(m.group(3))
        objs[int(m.group(1))] = (head, _decode_stream(head, raw, budget))
    # Object streams: objects packed inside a compressed stream (no nested streams allowed).
    for head, stream in list(objs.values()):
        if stream is None or b"/ObjStm" not in head:
            continue
        n = re.search(rb"/N\s+(\d+)", head)
        first = re.search(rb"/First\s+(\d+)", head)
        if not (n and first):
            continue
        nums = stream[:int(first.group(1))].split()
        pairs = [(int(nums[k]), int(nums[k + 1])) for k in range(0, min(len(nums) - 1, 2 * int(n.group(1))), 2)]
        base = int(first.group(1))
        for idx, (num, off) in enumerate(pairs):
            end = base + pairs[idx + 1][1] if idx + 1 < len(pairs) else len(stream)
            objs.setdefault(num, (stream[base + off:end], None))
    return objs


def _hex_bytes(h):
    h = re.sub(rb"[^0-9A-Fa-f]", b"", h)
    if len(h) % 2:
        h += b"0"
    return bytes.fromhex(h.decode("ascii"))


def _utf16(b):
    try:
        return b.decode("utf-16-be")
    except UnicodeDecodeError:
        return ""


def _parse_cmap(stream, budget=None):
    """ToUnicode CMap -> ({code_bytes: str}, code_lengths)."""
    budget = budget or _Budget()
    cmap, lengths = {}, set()
    for block in re.findall(rb"beginbfchar(.*?)endbfchar", stream, re.S):
        for src, dst in re.findall(rb"<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]*)>", block):
            budget.add_cmap()
            k = _hex_bytes(src)
            cmap[k] = _utf16(_hex_bytes(dst))
            lengths.add(len(k))
    for block in re.findall(rb"beginbfrange(.*?)endbfrange", stream, re.S):
        for lo, hi, dst in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f\s]*>|\[[^\]]*\])", block):
            lo_b, hi_b = _hex_bytes(lo), _hex_bytes(hi)
            width = len(lo_b)
            a, z = int.from_bytes(lo_b, "big"), int.from_bytes(hi_b, "big")
            if z < a or z - a > 65535:
                continue
            budget.add_cmap(z - a + 1)
            lengths.add(width)
            if dst.startswith(b"["):
                for off, item in enumerate(re.findall(rb"<([0-9A-Fa-f\s]*)>", dst)):
                    cmap[(a + off).to_bytes(width, "big")] = _utf16(_hex_bytes(item))
            else:
                base = _hex_bytes(dst[1:-1])
                start = int.from_bytes(base, "big") if base else 0
                dst_width = max(2, len(base))
                if start + (z - a) >= 1 << (8 * dst_width):
                    continue  # malformed range: destination would overflow its width
                for off in range(z - a + 1):
                    cmap[(a + off).to_bytes(width, "big")] = _utf16((start + off).to_bytes(dst_width, "big"))
    return cmap, sorted(lengths, reverse=True) or [1]


def _font_maps(objs, budget=None):
    """Font resource name (e.g. b'F1') -> (cmap, lengths) | codec name. Name collisions across pages: last wins."""
    fonts = {}
    for num, (head, _s) in objs.items():
        if b"/Font" not in head:
            continue
        m = re.search(rb"/ToUnicode\s+(\d+)\s+\d+\s+R", head)
        target = objs.get(int(m.group(1))) if m else None
        if target and target[1]:
            fonts[num] = _parse_cmap(target[1], budget)
            continue
        enc = head
        em = re.search(rb"/Encoding\s+(\d+)\s+\d+\s+R", head)
        if em and int(em.group(1)) in objs:
            enc = objs[int(em.group(1))][0]
        if b"/MacRomanEncoding" in enc:
            fonts[num] = "mac_roman"
    names = {}
    for head, _s in objs.values():
        for fm in re.finditer(rb"/Font\s*(<<(.*?)>>|(\d+)\s+\d+\s+R)", head, re.S):
            inner = fm.group(2)
            if inner is None:
                ref = objs.get(int(fm.group(3)))
                inner = ref[0] if ref else b""
            for name, ref in re.findall(rb"/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R", inner):
                if int(ref) in fonts:
                    names[name] = fonts[int(ref)]
    return names


def _decode_str(b, fmap):
    if isinstance(fmap, str):
        return b.decode(fmap, errors="replace")
    if fmap:
        cmap, lengths = fmap
        out, i = [], 0
        while i < len(b):
            for ln in lengths:
                chunk = b[i:i + ln]
                if chunk in cmap:
                    out.append(cmap[chunk])
                    i += ln
                    break
            else:
                i += lengths[-1]
        return "".join(out)
    if b[:2] == b"\xfe\xff":
        return _utf16(b[2:])
    return b.decode("cp1252", errors="replace")


def _read_literal(s, i):
    """s[i] == '(' -> (bytes, next_index)."""
    out, depth, i = bytearray(), 1, i + 1
    esc = {ord("n"): 10, ord("r"): 13, ord("t"): 9, ord("b"): 8, ord("f"): 12}
    while i < len(s):
        c = s[i]
        if c == 0x5C:  # backslash
            i += 1
            if i >= len(s):
                break
            c = s[i]
            if c in esc:
                out.append(esc[c])
            elif 0x30 <= c <= 0x37:
                j = i
                while j < len(s) and j < i + 3 and 0x30 <= s[j] <= 0x37:
                    j += 1
                out.append(int(s[i:j], 8) & 0xFF)
                i = j
                continue
            elif c in (10, 13):
                if c == 13 and s[i + 1:i + 2] == b"\n":
                    i += 1
            else:
                out.append(c)
        elif c == 0x28:
            depth += 1
            out.append(c)
        elif c == 0x29:
            depth -= 1
            if depth == 0:
                return bytes(out), i + 1
            out.append(c)
        else:
            out.append(c)
        i += 1
    return bytes(out), i


def _tokens(s):
    """Yield ('str', bytes) | ('arr_start',) | ('arr_end',) | ('name', bytes) | ('num', float) | ('op', bytes)."""
    i, n = 0, len(s)
    while i < n:
        c = s[i:i + 1]
        if c in (b" ", b"\t", b"\r", b"\n", b"\f", b"\x00"):
            i += 1
        elif c == b"%":
            while i < n and s[i:i + 1] not in (b"\r", b"\n"):
                i += 1
        elif c == b"(":
            val, i = _read_literal(s, i)
            yield ("str", val)
        elif c == b"<" and s[i + 1:i + 2] == b"<":
            yield ("op", b"<<")
            i += 2
        elif c == b">" and s[i + 1:i + 2] == b">":
            yield ("op", b">>")
            i += 2
        elif c == b"<":
            j = s.find(b">", i)
            j = n if j < 0 else j
            yield ("str", _hex_bytes(s[i + 1:j]))
            i = j + 1
        elif c == b"[":
            yield ("arr_start",)
            i += 1
        elif c == b"]":
            yield ("arr_end",)
            i += 1
        elif c == b"/":
            j = i + 1
            while j < n and s[j:j + 1] not in _WS and s[j:j + 1] not in _DELIM:
                j += 1
            yield ("name", s[i + 1:j])
            i = j
        else:
            j = i
            while j < n and s[j:j + 1] not in _WS and s[j:j + 1] not in _DELIM:
                j += 1
            if j == i:
                i += 1
                continue
            word = s[i:j]
            try:
                yield ("num", float(word))
            except ValueError:
                yield ("op", word)
            i = j


def _content_text(stream, fonts):
    out, operands, arr, font = [], [], None, None
    for tok in _tokens(stream):
        kind = tok[0]
        if kind == "arr_start":
            arr = []
        elif kind == "arr_end":
            operands.append(("arr", arr or []))
            arr = None
        elif arr is not None:
            arr.append(tok)
        elif kind != "op":
            operands.append(tok)
        else:
            op = tok[1]
            if op == b"Tf":
                names = [o[1] for o in operands if o[0] == "name"]
                font = fonts.get(names[-1]) if names else None
            elif op in (b"Tj", b"'", b'"'):
                if op != b"Tj":
                    out.append("\n")
                strs = [o[1] for o in operands if o[0] == "str"]
                if strs:
                    out.append(_decode_str(strs[-1], font))
            elif op == b"TJ":
                arrs = [o[1] for o in operands if o[0] == "arr"]
                for item in (arrs[-1] if arrs else []):
                    if item[0] == "str":
                        out.append(_decode_str(item[1], font))
                    elif item[0] == "num" and item[1] < -200:
                        out.append(" ")
            elif op in (b"Td", b"TD"):
                nums = [o[1] for o in operands if o[0] == "num"]
                out.append("\n" if len(nums) >= 2 and abs(nums[-1]) > 0.01 else " ")
            elif op in (b"T*", b"Tm", b"ET"):
                out.append("\n")
            operands = []
    return "".join(out)


def extract_text(data, max_chars=200_000):
    """Return the visible-or-not text of a PDF (best effort). Raises PdfError if it can't be read."""
    if b"%PDF-" not in data[:1024]:
        raise PdfError("not a PDF file")
    if re.search(rb"/Encrypt\s", data):
        raise PdfError("encrypted PDFs are not supported")
    budget = _Budget()
    objs = _load_objects(data, budget)
    if not objs:
        raise PdfError("no PDF objects found")
    fonts = _font_maps(objs, budget)

    # Page content streams in page-object order, then any other text-bearing streams (form XObjects).
    order, seen = [], set()
    for num in sorted(objs):
        head = objs[num][0]
        if re.search(rb"/Type\s*/Page(?!s)\b", head):
            cm = re.search(rb"/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)", head)
            if cm:
                for ref in _REF_RE.findall(cm.group(1)):
                    order.append(int(ref))
    for num in sorted(objs):
        stream = objs[num][1]
        if stream and b"BT" in stream and b"begincmap" not in stream and num not in order:
            if re.search(rb"/Subtype\s*/Form", objs[num][0]):
                order.append(num)

    chunks = []
    total = 0
    for num in order:
        if num in seen or num not in objs or not objs[num][1]:
            continue
        seen.add(num)
        text = _content_text(objs[num][1], fonts)
        chunks.append(text)
        total += len(text)
        if total > max_chars:
            break
    lines = [re.sub(r"[ \t\u00a0]+", " ", ln).strip() for ln in "\n".join(chunks).splitlines()]
    text = "\n".join(ln for ln in lines if ln)
    return "".join(ch for ch in text if ch == "\n" or ch.isprintable())[:max_chars]


if __name__ == "__main__":
    import sys
    with open(sys.argv[1], "rb") as f:
        print(extract_text(f.read()))
