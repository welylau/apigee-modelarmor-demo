#!/usr/bin/env python3
"""
StaticGuardrails build script (single source of truth for regex rules).

Generates, from the RULES catalog below:
  1. sharedflowbundle/policies/RE-SG-*.xml      (RegularExpressionProtection, Java regex, inbound BLOCK rules)
  2. sharedflowbundle/resources/jsc/sg-rules.js  (same rules as JS RegExp, used for rule-ID attribution,
                                                  FLAG rules and outbound EventFlow scanning)
  3. env/sg.properties (from src/sg.properties.src, non-ASCII -> \\uXXXX). This is uploaded as an
     ENVIRONMENT-scoped property set named "sg" (see deploy.sh): property sets bundled inside a
     SharedFlow are NOT readable via propertyset.sg.* (verified on Apigee X), and env scope lets the
     lexicon be updated without redeploying the SharedFlow.
  4. Copies sg-common.js + sg-rules.js into guardrail-proxy/apiproxy/resources/jsc/ (EventFlow cannot
     call a SharedFlow, so the outbound scanner needs its own copy).

Usage:  python3 StaticGuardrails/build.py
Only uses the Python standard library.
"""

import json
import os
import re
import shutil
from xml.sax.saxutils import escape as xml_escape

HERE = os.path.dirname(os.path.abspath(__file__))
BUNDLE = os.path.join(HERE, "sharedflowbundle")
PROXY_JSC = os.path.join(HERE, "..", "guardrail-proxy", "apiproxy", "resources", "jsc")

# ---------------------------------------------------------------------------
# Rule catalog
#   src : "norm" = lower-cased, zero-width stripped, full-width folded text (sg.prompt_norm)
#         "raw"  = original text, case-sensitive (sg.prompt_raw)
#   sev_in / sev_out : "BLOCK" | "FLAG" | None (rule not applied in that direction)
# Patterns MUST be valid in both Java and JavaScript regex dialects:
#   no lookbehind, no possessive quantifiers, no named groups, bounded quantifiers only.
# ---------------------------------------------------------------------------
RULES = [
    # --- Prompt injection / jailbreak -------------------------------------
    dict(id="SG-PI-001", cat="prompt_injection", src="norm", sev_in="BLOCK", sev_out=None,
         desc="Instruction override (ignore previous instructions)",
         re=r"\b(ignore|disregard|forget|override)\b.{0,20}\b(previous|prior|above|earlier|system)\s+(instructions?|rules|prompts?|directives)"),
    dict(id="SG-PI-002", cat="prompt_injection", src="norm", sev_in="BLOCK", sev_out=None,
         desc="DAN / developer-mode persona",
         re=r"\byou\s+are\s+(now\s+)?dan\b|\bdo\s+anything\s+now\b|\b(developer|god|unfiltered)\s+mode\b"),
    dict(id="SG-PI-003", cat="prompt_injection", src="norm", sev_in="BLOCK", sev_out=None,
         desc="System prompt extraction",
         re=r"\b(reveal|print|show|output|repeat|leak|display)\b.{0,30}\b(system|hidden|initial|original)\s+(prompt|instructions?|message)"),
    dict(id="SG-PI-004", cat="prompt_injection", src="norm", sev_in="BLOCK", sev_out=None,
         desc="Chat-template delimiter / role token injection",
         re=r"<\|im_(start|end)\|>|\[/?inst\]|<</?sys>>|</?system>|(^|\s)#{2,}\s*(system|assistant)\s*:"),
    dict(id="SG-PI-005", cat="prompt_injection", src="norm", sev_in="FLAG", sev_out=None,
         desc="Roleplay restriction bypass",
         re=r"\bpretend\b.{0,20}\b(no|without)\s+(rules|restrictions|filters|limits)\b|\bjailbreak"),
    dict(id="SG-PI-006", cat="prompt_injection", src="norm", sev_in="BLOCK", sev_out=None,
         desc="Instruction override in ZH / JA / VI / TH (needs native-speaker validation)",
         re=r"忽略(掉)?(之前|以上|前面|先前|上面)?的?(所有|全部|一切)?的?(指令|说明|规则|提示|指示)|(以前|前|上記)の(すべての)?指示を無視|bỏ qua.{0,15}hướng dẫn (trước|trên)|(ไม่ต้องสนใจ|ละเว้น)คำสั่ง(ก่อนหน้า|ทั้งหมด)"),

    # --- Code / SQL injection payloads ------------------------------------
    dict(id="SG-SQL-001", cat="code_injection", src="norm", sev_in="BLOCK", sev_out="FLAG",
         desc="UNION-based SQL injection",
         re=r"\bunion\b\s+(all\s+)?\bselect\b"),
    dict(id="SG-SQL-002", cat="code_injection", src="norm", sev_in="BLOCK", sev_out="FLAG",
         desc="SQL tautology (' OR 1=1 / 'a'='a)",
         re=r"'\s*(or|and)\s+('?)(\w+)\2\s*=\s*('?)\3\4"),
    dict(id="SG-SQL-003", cat="code_injection", src="norm", sev_in="BLOCK", sev_out="FLAG",
         desc="Stacked destructive SQL statement",
         re=r";\s*(drop|truncate|alter)\s+(table|database|schema)\b|;\s*delete\s+from\b|;\s*shutdown\b"),
    dict(id="SG-SQL-004", cat="code_injection", src="norm", sev_in="BLOCK", sev_out="FLAG",
         desc="Time-based / command-exec SQL injection",
         re=r"\bxp_cmdshell\b|\bwaitfor\s+delay\b|\b(and|or|select)\s+sleep\s*\(\s*\d+\s*\)|\bbenchmark\s*\(\s*\d+"),
    dict(id="SG-XSS-001", cat="code_injection", src="norm", sev_in="BLOCK", sev_out="BLOCK",
         desc="Cross-site scripting payload",
         re=r"<\s*script\b|javascript:[^\s]|\bon(error|load|mouseover|focus|click)\s*=\s*['\"a-z]"),
    dict(id="SG-CMD-001", cat="code_injection", src="norm", sev_in="BLOCK", sev_out="BLOCK",
         desc="Shell command chaining / reverse shell",
         re=r"(;|&&|\|\|?)\s*(rm\s+-rf\s+[/~*]|nc\s+-e\b|ncat\s|bash\s+-i\b|powershell(\.exe)?\s+-e(nc)?\b|mkfifo\s)"),
    dict(id="SG-CMD-002", cat="code_injection", src="norm", sev_in="FLAG", sev_out=None,
         desc="Pipe-to-shell download (curl | sh)",
         re=r"\b(curl|wget)\b[^|]{0,100}\|\s*(sudo\s+)?(ba)?sh\b"),
    dict(id="SG-PATH-001", cat="code_injection", src="norm", sev_in="BLOCK", sev_out=None,
         desc="Path traversal",
         re=r"(\.\.[/\\]){3,}|/etc/(passwd|shadow)\b|c:\\windows\\system32"),
    dict(id="SG-TPL-001", cat="code_injection", src="norm", sev_in="BLOCK", sev_out="BLOCK",
         desc="Log4Shell / server-side template injection",
         re=r"\$\{jndi:|\{\{[^}]{0,50}(__class__|__globals__|__subclasses__|config\.)[^}]{0,50}\}\}"),

    # --- Secrets / credentials (case-sensitive, raw text) ------------------
    dict(id="SG-SEC-001", cat="secret_leak", src="raw", sev_in="BLOCK", sev_out="BLOCK",
         desc="Private key block",
         re=r"-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----"),
    dict(id="SG-SEC-002", cat="secret_leak", src="raw", sev_in="BLOCK", sev_out="BLOCK",
         desc="AWS access key ID",
         re=r"\b(AKIA|ASIA)[0-9A-Z]{16}\b"),
    dict(id="SG-SEC-003", cat="secret_leak", src="raw", sev_in="BLOCK", sev_out="BLOCK",
         desc="Google API key",
         re=r"\bAIza[0-9A-Za-z_\-]{35}"),
    dict(id="SG-SEC-004", cat="secret_leak", src="raw", sev_in="BLOCK", sev_out="BLOCK",
         desc="GitHub / Slack token",
         re=r"\bgh[pousr]_[A-Za-z0-9]{36}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}"),
    dict(id="SG-SEC-005", cat="secret_leak", src="raw", sev_in="FLAG", sev_out="FLAG",
         desc="JSON Web Token",
         re=r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    dict(id="SG-SEC-006", cat="secret_leak", src="raw", sev_in="BLOCK", sev_out="BLOCK",
         desc="GCP service account key JSON",
         re=r"\"type\"\s*:\s*\"service_account\"|\"private_key_id\"\s*:\s*\"[0-9a-f]{20,}\""),

    # --- Harsh language T1 (threats / death wishes / incitement) ------------
    dict(id="SG-LEX-T1-RE", cat="harsh_language", src="norm", sev_in="BLOCK", sev_out="BLOCK",
         desc="Violent threat / death wish / incitement (EN)",
         re=r"\bi\s*('ll|will|am going to|'m going to|m gonna|'m gonna|gonna)\s+(kill|murder|shoot|stab|hurt)\s+(you|u)\b|\b(go\s+(kill|hang)\s+yourself|kys|jump\s+off\s+a\s+bridge|you\s+should\s+die|go\s+die)\b|\b(exterminate|gas|ethnically\s+cleanse)\s+all\s+(the\s+)?[a-z]+"),

    dict(id="SG-LEX-T2-MASK", cat="harsh_language", src="norm", sev_in="BLOCK", sev_out="BLOCK",
         desc="Symbol-masked profanity (f*ck, sh!t, b*tch, a**hole)",
         re=r"\bf[*#@_.]{1,3}(c?k|u?ck)(ing|1ng|in|er|ed|s)?\b|\bf[u*#@][*#@]k|\bsh[*#!1][*#]?t\b|\bb[*#!1][*#]?tch|\bc[*#][*#]?nt\b|\ba[*#$]{2}hole"),

    # --- Structural ----------------------------------------------------------
    dict(id="SG-STR-003", cat="structural_abuse", src="norm", sev_in="BLOCK", sev_out=None,
         desc="Single character repeated 50+ times (padding / context stuffing)",
         re=r"(.)\1{49,}"),
    dict(id="SG-STR-005", cat="structural_abuse", src="raw", sev_in="FLAG", sev_out=None,
         desc="Large base64 blob (possible instruction smuggling)",
         re=r"[A-Za-z0-9+/]{200,}={0,2}"),
]

# RegularExpressionProtection policies = inbound BLOCK regex rules grouped by category.
RE_POLICIES = [
    ("RE-SG-PromptInjection", "prompt_injection", "Static Guardrail - Prompt Injection Signatures"),
    ("RE-SG-CodeInjection", "code_injection", "Static Guardrail - Code/SQL Injection Signatures"),
    ("RE-SG-Secrets", "secret_leak", "Static Guardrail - Secrets and Credentials"),
]

VAR_BY_SRC = {"norm": "sg.prompt_norm", "raw": "sg.prompt_raw"}


def js_ascii(s: str) -> str:
    """Escape every non-ASCII char as \\uXXXX so jsc files are pure ASCII."""
    return "".join(c if ord(c) < 128 else "\\u%04x" % ord(c) for c in s)


def props_ascii(s: str) -> str:
    return js_ascii(s)


def validate_rules() -> None:
    seen = set()
    for r in RULES:
        assert r["id"] not in seen, "duplicate rule id " + r["id"]
        seen.add(r["id"])
        re.compile(r["re"])  # Python dialect sanity check (close to Java/JS for our subset)
        assert "(?<" not in r["re"], r["id"] + ": lookbehind not portable"


def write_re_policies() -> None:
    for name, cat, display in RE_POLICIES:
        rules = [r for r in RULES if r["cat"] == cat and r["sev_in"] == "BLOCK"]
        by_src = {}
        for r in rules:
            by_src.setdefault(r["src"], []).append(r)
        lines = [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            "<!-- GENERATED by StaticGuardrails/build.py - do not edit by hand. -->",
            # continueOnError=true: JS-SG-Decide reads regularexpressionprotection.<name>.failed and
            # raises a sanitized fault (the default fault message echoes regex + user input).
            '<RegularExpressionProtection async="false" continueOnError="true" enabled="true" name="%s">' % name,
            "    <DisplayName>%s</DisplayName>" % xml_escape(display),
            "    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>",
        ]
        for src in ("norm", "raw"):
            if src not in by_src:
                continue
            lines.append('    <Variable name="%s">' % VAR_BY_SRC[src])
            for r in by_src[src]:
                lines.append("        <!-- %s: %s -->" % (r["id"], xml_escape(r["desc"])))
                lines.append("        <Pattern>%s</Pattern>" % xml_escape(r["re"]))
            lines.append("    </Variable>")
        lines.append("</RegularExpressionProtection>")
        path = os.path.join(BUNDLE, "policies", name + ".xml")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        print("wrote", os.path.relpath(path, HERE), "(%d patterns)" % len(rules))


def write_js_rules() -> None:
    entries = []
    for r in RULES:
        entries.append(
            "  {id: %s, cat: %s, src: %s, sevIn: %s, sevOut: %s, desc: %s, re: new RegExp(%s)}"
            % (
                json.dumps(r["id"]),
                json.dumps(r["cat"]),
                json.dumps(r["src"]),
                json.dumps(r["sev_in"]),
                json.dumps(r["sev_out"]),
                json.dumps(r["desc"], ensure_ascii=True),
                json.dumps(r["re"], ensure_ascii=True),
            )
        )
    re_map = ",\n".join("  %s: %s" % (json.dumps(n), json.dumps(c)) for n, c, _ in RE_POLICIES)
    body = (
        "/* GENERATED by StaticGuardrails/build.py - do not edit by hand. */\n"
        "var SG_RULES = [\n" + ",\n".join(entries) + "\n];\n"
        "var SG_RE_POLICIES = {\n" + re_map + "\n};\n"
    )
    path = os.path.join(BUNDLE, "resources", "jsc", "sg-rules.js")
    with open(path, "w", encoding="ascii") as fh:
        fh.write(body)
    print("wrote", os.path.relpath(path, HERE), "(%d rules)" % len(RULES))


def write_properties() -> None:
    src = os.path.join(HERE, "src", "sg.properties.src")
    dst = os.path.join(HERE, "env", "sg.properties")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(src, encoding="utf-8") as fh:
        text = fh.read()
    with open(dst, "w", encoding="ascii") as fh:
        fh.write("# GENERATED from src/sg.properties.src by build.py (non-ASCII escaped as \\uXXXX)\n")
        fh.write(props_ascii(text))
    print("wrote", os.path.relpath(dst, HERE))


def sync_proxy() -> None:
    os.makedirs(PROXY_JSC, exist_ok=True)
    for f in ("sg-common.js", "sg-rules.js"):
        shutil.copyfile(os.path.join(BUNDLE, "resources", "jsc", f), os.path.join(PROXY_JSC, f))
        print("synced", f, "->", os.path.relpath(PROXY_JSC, HERE))


if __name__ == "__main__":
    validate_rules()
    write_re_policies()
    write_js_rules()
    write_properties()
    sync_proxy()
