#!/usr/bin/env python3
"""Blattner brand gate for HTML artifacts (blattner-data-vis plugin self-check).

Verifies: no rgba()/rgb(), no gradients, no external font imports, Arial-only
font stacks, every hex on-palette (after stripping the inlined logo <svg>),
exactly one inlined <svg>, and that the inlined <svg> hash-matches the official
Blattner Burst-B white logo asset.

Usage: py scripts/brandcheck.py index.html /path/to/Blattner_B_Burst_B_-_White.svg
"""
import re, sys, hashlib

ALLOWED = {"#000000","#02568A","#2DA2DB","#B9E5FB","#F2F2F2","#BCBCBC",
           "#76777B","#333333","#FFFFFF","#EC9522","#C9DB30"}
FONT_OK = re.compile(r"^(?:'Arial Black', Arial, sans-serif|Arial, Helvetica, sans-serif)$")

def fail(msg):
    print("BRAND FAIL:", msg); sys.exit(1)

def main():
    html_path, logo_path = sys.argv[1], sys.argv[2]
    src = open(html_path, encoding="utf-8").read()

    if re.search(r"rgba?\(", src): fail("rgba()/rgb() present")
    if re.search(r"gradient\(", src): fail("gradient present")
    if re.search(r"fonts\.googleapis|@import url", src): fail("external font import")

    fonts = sorted(set(m.strip() for m in re.findall(r"font-family:\s*([^;}]+)", src)))
    for f in fonts:
        if not FONT_OK.match(f.strip()):
            fail(f"non-Arial font-family: {f!r}")
    print("fonts:", fonts)

    svgs = re.findall(r"<svg.*?</svg>", src, flags=re.DOTALL)
    if len(svgs) != 1: fail(f"expected exactly 1 inlined <svg>, found {len(svgs)}")

    stripped = re.sub(r"<svg.*?</svg>", "", src, flags=re.DOTALL)
    hexes = sorted({h.upper() for h in re.findall(r"#[0-9A-Fa-f]{3,8}", stripped)})
    bad = [h for h in hexes if h not in ALLOWED]
    print("hex (post-strip):", hexes)
    if bad: fail(f"off-palette hex: {bad}")

    def sig(svg_text):
        return hashlib.sha256(re.sub(r"\s+", "", svg_text).encode()).hexdigest()
    logo_src = open(logo_path, encoding="utf-8").read()
    logo_svg = re.search(r"<svg.*?</svg>", logo_src, flags=re.DOTALL).group(0)
    if sig(svgs[0]) != sig(logo_svg):
        fail("inlined logo does not hash-match the official asset")
    print("logo hash-match: OK")
    print("BRAND OK")

if __name__ == "__main__":
    main()
