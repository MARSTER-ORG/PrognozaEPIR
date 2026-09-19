#!/usr/bin/env python3
"""One-shot/idempotent migration of PrognozaEPIR pages to one shared stylesheet.

The script intentionally changes presentation wiring only. It does not rewrite inline
application JavaScript or meteorological logic.
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = "20260919-ui1"
PAGES = {
    "index.html": "index",
    "fog.html": "fog",
    "radar.html": "radar",
    "sat-fog.html": "sat-fog",
    "taf.html": "taf",
    "arch.html": "arch",
    "lightning-alerts.html": "lightning-alerts",
}
STYLE_RE = re.compile(r"<style(?:\s[^>]*)?>(.*?)</style\s*>", re.I | re.S)
OLD_THEME_SCRIPT_RE = re.compile(
    r"\s*<script\b[^>]*\bsrc=[\"'](?:\./)?theme-control\.js(?:\?[^\"']*)?[\"'][^>]*>\s*</script\s*>\s*",
    re.I,
)


def _find_open_brace(text: str, start: int) -> int:
    quote = None
    comment = False
    escape = False
    i = start
    while i < len(text):
        c = text[i]
        n = text[i + 1] if i + 1 < len(text) else ""
        if comment:
            if c == "*" and n == "/":
                comment = False
                i += 2
                continue
            i += 1
            continue
        if quote:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == quote:
                quote = None
            i += 1
            continue
        if c == "/" and n == "*":
            comment = True
            i += 2
            continue
        if c in "'\"":
            quote = c
            i += 1
            continue
        if c == "{":
            return i
        i += 1
    return -1


def _find_close_brace(text: str, open_pos: int) -> int:
    depth = 1
    quote = None
    comment = False
    escape = False
    i = open_pos + 1
    while i < len(text):
        c = text[i]
        n = text[i + 1] if i + 1 < len(text) else ""
        if comment:
            if c == "*" and n == "/":
                comment = False
                i += 2
                continue
            i += 1
            continue
        if quote:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == quote:
                quote = None
            i += 1
            continue
        if c == "/" and n == "*":
            comment = True
            i += 2
            continue
        if c in "'\"":
            quote = c
            i += 1
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ValueError("Unbalanced CSS braces")


def _split_selectors(selector_text: str) -> list[str]:
    parts: list[str] = []
    start = 0
    paren = bracket = 0
    quote = None
    escape = False
    for i, c in enumerate(selector_text):
        if quote:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == quote:
                quote = None
            continue
        if c in "'\"":
            quote = c
        elif c == "(":
            paren += 1
        elif c == ")":
            paren = max(0, paren - 1)
        elif c == "[":
            bracket += 1
        elif c == "]":
            bracket = max(0, bracket - 1)
        elif c == "," and paren == 0 and bracket == 0:
            parts.append(selector_text[start:i].strip())
            start = i + 1
    parts.append(selector_text[start:].strip())
    return [p for p in parts if p]


def _scope_selector(selector: str, page: str) -> str:
    scope = f'html[data-epir-page="{page}"]'
    s = selector.strip()
    if s.startswith(":root"):
        return scope + s[len(":root"):]
    if re.match(r"^html(?=$|[\s.#:\[])", s):
        return re.sub(r"^html", scope, s, count=1)
    if re.match(r"^body(?=$|[\s.#:\[])", s):
        return f"{scope} {s}"
    return f"{scope} {s}"


def _leading_trivia(segment: str) -> tuple[str, str]:
    # Preserve whitespace/comments that precede a selector or at-rule.
    pos = 0
    while True:
        m = re.match(r"\s+", segment[pos:])
        if m:
            pos += m.end()
            continue
        if segment.startswith("/*", pos):
            end = segment.find("*/", pos + 2)
            if end < 0:
                return segment, ""
            pos = end + 2
            continue
        break
    return segment[:pos], segment[pos:].strip()


def scope_css(css: str, page: str) -> str:
    out: list[str] = []
    pos = 0
    while pos < len(css):
        open_pos = _find_open_brace(css, pos)
        if open_pos < 0:
            out.append(css[pos:])
            break
        raw_prelude = css[pos:open_pos]
        leading, prelude = _leading_trivia(raw_prelude)
        close_pos = _find_close_brace(css, open_pos)
        body = css[open_pos + 1:close_pos]
        low = prelude.lower()
        out.append(leading)
        if low.startswith(("@media", "@supports", "@container", "@layer", "@document")):
            out.append(prelude + "{" + scope_css(body, page) + "}")
        elif low.startswith(("@keyframes", "@-webkit-keyframes", "@font-face", "@page", "@property")):
            out.append(prelude + "{" + body + "}")
        elif low.startswith("@"):
            out.append(prelude + "{" + body + "}")
        else:
            selectors = _split_selectors(prelude)
            if not selectors:
                out.append(prelude + "{" + body + "}")
            else:
                out.append(",".join(_scope_selector(s, page) for s in selectors) + "{" + body + "}")
        pos = close_pos + 1
    return "".join(out).strip()


SHARED_CSS = r'''
/* ========================================================================== */
/* PrognozaEPIR shared design system — source of truth: index.html appearance */
/* ========================================================================== */
html[data-epir-page]{
  --bg:#f4f4f2;--ink:#232323;--text:#232323;--muted:#6e6e6e;
  --line:#8d8d8d;--border:#b5b5b5;--panel:#ffffff;--panel2:#f7f7f7;
  --surface:#ffffff;--surface2:#f7f7f7;--soft:#f4f4f2;
  --blue:#22268d;--blue2:#1f2a75;--blueText:#1f2a75;--accent:#1f2a75;
  --green:#0aa52b;--ok:#2c7a3f;--warn:#8a5a00;--orange:#c54c20;
  --bad:#8a2d2d;--red:#d43d31;--violet:#7b32a8;
  --error:#8a2d2d;--errorBg:#fff4f4;--errorBorder:#d1a0a0;--errorText:#8a2d2d;
  --hover:#edf1ff;--shadow:0 2px 10px rgba(0,0,0,.08);
  color-scheme:light;
}
html[data-epir-page][data-theme="dark"]{
  --bg:#111418;--ink:#e7e9ed;--text:#e7e9ed;--muted:#a6acb5;
  --line:#646b74;--border:#4e5660;--panel:#181c21;--panel2:#20252b;
  --surface:#181c21;--surface2:#20252b;--soft:#20252b;
  --blue:#8fa2ff;--blue2:#9aabff;--blueText:#9aabff;--accent:#8fa2ff;
  --green:#62c980;--ok:#76c58b;--warn:#e7bf72;--orange:#e5a45d;
  --bad:#ffb8c0;--red:#ff8076;--violet:#c194e4;
  --error:#ffb8c0;--errorBg:#2a1719;--errorBorder:#7d4148;--errorText:#ffb8c0;
  --hover:#222a42;--shadow:none;
  color-scheme:dark;
}
html[data-epir-page] body{background:var(--bg);color:var(--ink);font-family:Arial,Helvetica,sans-serif;transition:background-color .12s ease,color .12s ease}
html[data-epir-page] a{color:var(--blueText)}
html[data-epir-page] :is(button,select,input,textarea){font:inherit}
html[data-epir-page] :is(button,select,input,textarea):focus-visible,
html[data-epir-page] a:focus-visible{outline:2px solid var(--blueText);outline-offset:2px}
html[data-epir-page] #themeToggle{display:none!important}

/* Common navigation */
html[data-epir-page] .epir-global-nav{
  display:flex;flex-wrap:wrap;gap:5px;align-items:stretch;width:100%;
  margin:0 0 8px;padding:6px;border:1px solid var(--border);border-radius:9px;
  background:var(--surface);box-shadow:var(--shadow);
}
html[data-epir-page] .epir-global-nav>a{
  flex:1 1 108px;display:flex;align-items:center;justify-content:center;min-height:34px;
  padding:7px 8px;border:1px solid var(--border);border-radius:7px;background:var(--surface2);
  color:var(--ink);font-size:10px;font-weight:700;text-decoration:none;text-align:center;
}
html[data-epir-page] .epir-global-nav>a:hover{background:var(--soft);text-decoration:none}
html[data-epir-page] .epir-global-nav>a.active,
html[data-epir-page] .epir-global-nav>a[aria-current="page"]{background:var(--blueText);border-color:var(--blueText);color:#fff}
html[data-epir-page] .epir-theme-slot{display:flex;align-items:center;gap:5px;padding:0 2px 0 5px;color:var(--muted);font-size:9px;font-weight:700;white-space:nowrap}
html[data-epir-page] .epir-theme-slot select{min-height:34px;border:1px solid var(--border);border-radius:7px;padding:5px 7px;background:var(--surface2);color:var(--ink);font-size:10px;font-weight:700}

/* Shared components; page-specific layout remains in the page sections above. */
html[data-epir-page] :is(.card,.panel,.toolbar,.wrap,.section-info){border-color:var(--border)}
html[data-epir-page] :is(.card,.panel,.toolbar,.section-info,.stat,.metric,.empty){color:var(--ink)}
html[data-epir-page] :is(.badge,.pill){border-color:var(--border)}
html[data-epir-page][data-theme="light"] :is(input,select,textarea){background:var(--surface);color:var(--ink);border-color:var(--border)}
html[data-epir-page][data-theme="dark"] :is(input,select,textarea){background:var(--surface2);color:var(--ink);border-color:var(--border)}
html[data-epir-page] :is(.muted,.note,.statusline,.footer,.status,.place){color:var(--muted)}
html[data-epir-page] table{color:var(--ink)}
html[data-epir-page][data-theme="light"] th{background:#eef2f5;color:#263d4b}
html[data-epir-page][data-theme="dark"] th{background:var(--surface2);color:var(--ink)}

/* TAF had historically hard-coded dark surfaces; make it obey the global theme. */
html[data-epir-page="taf"][data-theme="light"] :is(.taf,.raw,.fog-mode-control,.checklist li){background:var(--surface)!important;color:var(--ink)!important;border-color:var(--border)!important}
html[data-epir-page="taf"][data-theme="light"] .controls select{background:var(--surface)!important;color:var(--ink)!important;border-color:var(--border)!important}
html[data-epir-page="taf"][data-theme="light"] .card{box-shadow:var(--shadow)}
html[data-epir-page="taf"][data-theme="dark"] :is(.taf,.raw,.fog-mode-control,.checklist li){background:var(--surface)!important;color:var(--ink)!important;border-color:var(--border)!important}

@media(max-width:700px){
  html[data-epir-page] .epir-global-nav{padding:5px;gap:4px}
  html[data-epir-page] .epir-global-nav>a{flex:1 1 calc(33.333% - 4px);min-height:32px;padding:6px 4px;font-size:9px}
  html[data-epir-page] .epir-theme-slot{width:100%;justify-content:flex-end;padding-top:1px}
}
@media(max-width:430px){html[data-epir-page] .epir-global-nav>a{flex-basis:calc(50% - 4px)}}
@media print{html[data-epir-page] .epir-global-nav{display:none!important}}
'''.strip()

THEME_JS = r'''"use strict";
(()=>{
  if(window.__PROGNOZA_EPIR_SHARED_UI__)return;
  window.__PROGNOZA_EPIR_SHARED_UI__=true;
  const KEY="prognozaepir.theme.preference";
  const allowed=new Set(["system","light","dark"]);
  const file=(location.pathname.split("/").pop()||"index.html").replace(/\.html?$/i,"")||"index";
  const page=file==="index"?"index":file;
  document.documentElement.dataset.epirPage=page;
  const media=window.matchMedia?window.matchMedia("(prefers-color-scheme: dark)"):null;
  const read=()=>{try{const v=localStorage.getItem(KEY);return allowed.has(v)?v:"system"}catch(_){return"system"}};
  let pref=read();
  const resolved=()=>pref==="light"||pref==="dark"?pref:(media&&media.matches?"dark":"light");
  const apply=()=>{
    const theme=resolved();
    document.documentElement.dataset.theme=theme;
    document.documentElement.dataset.themePreference=pref;
    document.documentElement.style.colorScheme=theme;
    const meta=document.querySelector('meta[name="color-scheme"]');
    if(meta)meta.setAttribute("content",theme);
    const select=document.getElementById("prognozaepir-theme-select");
    if(select&&select.value!==pref)select.value=pref;
    return theme;
  };
  const setPref=value=>{
    pref=allowed.has(value)?value:"system";
    try{localStorage.setItem(KEY,pref)}catch(_){}
    const theme=apply();
    try{window.dispatchEvent(new CustomEvent("prognozaepir:themechange",{detail:{preference:pref,theme}}))}catch(_){}
  };
  apply();
  if(media){const onChange=()=>{if(pref==="system")apply()};if(media.addEventListener)media.addEventListener("change",onChange);else if(media.addListener)media.addListener(onChange)}

  const NAV=[
    ["index.html","METEOGRAM","index"],
    ["fog.html","EPIR FOG","fog"],
    ["radar.html","RADAR","radar"],
    ["sat-fog.html","MGŁA SAT","sat-fog"],
    ["lightning-alerts.html","WYŁADOWANIA","lightning-alerts"],
    ["taf.html","TAF GENERATOR","taf"],
    ["arch.html","ARCHIWUM","arch"]
  ];
  const mount=()=>{
    if(new URLSearchParams(location.search).has("taf-engine"))return;
    let nav=document.getElementById("epirGlobalNav");
    if(!nav){
      nav=document.createElement("nav");nav.id="epirGlobalNav";
      const root=document.querySelector(".app,.wrap,main")||document.body;
      root.insertBefore(nav,root.firstChild);
    }
    nav.classList.add("epir-global-nav");
    nav.setAttribute("aria-label","Główna nawigacja PrognozaEPIR");
    nav.innerHTML=NAV.map(([href,label,id])=>`<a href="${href}"${id===page?' class="active" aria-current="page"':''}>${label}</a>`).join("")+
      '<label class="epir-theme-slot" for="prognozaepir-theme-select">Motyw <select id="prognozaepir-theme-select" aria-label="Motyw strony"><option value="system">Systemowy</option><option value="light">Jasny</option><option value="dark">Ciemny</option></select></label>';
    const select=nav.querySelector("#prognozaepir-theme-select");
    select.value=pref;select.addEventListener("change",()=>setPref(select.value));
    const old=document.getElementById("themeToggle");
    if(old){old.setAttribute("aria-hidden","true");old.tabIndex=-1}
  };
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mount,{once:true});else mount();
  window.PrognozaEPIRTheme=Object.freeze({getPreference:()=>pref,getResolved:resolved,setPreference:setPref});
})();
'''

STYLE_GUIDE = '''# PrognozaEPIR — wspólny system UI

Od migracji `20260919-ui1` aktywne strony aplikacji korzystają z jednego pliku `app.css` i jednego kontrolera `theme.js`.

## Zasady

- `index.html` jest wzorcem kolorów, typografii, obramowań i podstawowych komponentów.
- Nie dodawaj nowych bloków `<style>` do plików HTML.
- Reguły specyficzne dla strony dopisuj do jej sekcji `EPIR-PAGE-START/END` w `app.css` i zawsze ograniczaj przez `html[data-epir-page="..."]`.
- Wspólne kolory bierz ze zmiennych w sekcji `EPIR-SHARED-START/END`; nie twórz osobnych palet jasnej/ciemnej dla podstron.
- `theme.js` przechowuje wybór `system / jasny / ciemny` w `localStorage` i buduje wspólną nawigację.
- Logika meteorologiczna, modele, TAF, Fog Engine, radar i archiwum nie należą do warstwy UI i nie powinny być zmieniane przy edycji stylów.

## Kontrola

Uruchom:

```bash
python3 scripts/migrate-shared-ui.py --check
node --check theme.js
```

Migrator jest idempotentny: ponowne uruchomienie nie usuwa wcześniej przeniesionych sekcji CSS.
'''


def extract_existing_sections(app_css: str) -> dict[str, str]:
    found: dict[str, str] = {}
    pattern = re.compile(r"/\* EPIR-PAGE-START:([^ ]+) \*/\n(.*?)\n/\* EPIR-PAGE-END:\1 \*/", re.S)
    for m in pattern.finditer(app_css):
        found[m.group(1)] = m.group(2).strip()
    return found


def migrate_html(path: Path, page: str) -> tuple[str, str]:
    text = path.read_text(encoding="utf-8")
    head_end = re.search(r"</head\s*>", text, re.I)
    if not head_end:
        raise RuntimeError(f"{path.name}: missing </head>")
    prefix = text[: head_end.start()]
    suffix = text[head_end.start():]
    css_blocks = STYLE_RE.findall(prefix)
    prefix = STYLE_RE.sub("", prefix)
    text = prefix + suffix
    text = OLD_THEME_SCRIPT_RE.sub("\n", text)

    # Add or refresh stable page identity on <html>.
    html_tag = re.search(r"<html\b[^>]*>", text, re.I)
    if not html_tag:
        raise RuntimeError(f"{path.name}: missing <html>")
    tag = html_tag.group(0)
    tag = re.sub(r"\sdata-epir-page=[\"'][^\"']*[\"']", "", tag, flags=re.I)
    tag = tag[:-1] + f' data-epir-page="{page}">'
    text = text[:html_tag.start()] + tag + text[html_tag.end():]

    # Remove stale copies then insert theme before CSS so dataset is ready before paint.
    text = re.sub(r"\s*<link\b[^>]*href=[\"']app\.css(?:\?[^\"']*)?[\"'][^>]*>\s*", "\n", text, flags=re.I)
    text = re.sub(r"\s*<script\b[^>]*src=[\"']theme\.js(?:\?[^\"']*)?[\"'][^>]*>\s*</script\s*>\s*", "\n", text, flags=re.I)
    insertion = f'<script src="theme.js?v={VERSION}"></script>\n<link rel="stylesheet" href="app.css?v={VERSION}">\n'
    text = re.sub(r"</head\s*>", insertion + "</head>", text, count=1, flags=re.I)
    css = "\n\n".join(block.strip() for block in css_blocks if block.strip())
    return text, css


def build_css(sections: dict[str, str]) -> str:
    chunks = ["/* Generated/maintained by scripts/migrate-shared-ui.py. */"]
    for filename, page in PAGES.items():
        css = sections.get(page, "").strip()
        if not css:
            raise RuntimeError(f"Missing CSS section for {filename} ({page})")
        chunks.append(f"/* EPIR-PAGE-START:{page} */\n{css}\n/* EPIR-PAGE-END:{page} */")
    chunks.append(f"/* EPIR-SHARED-START */\n{SHARED_CSS}\n/* EPIR-SHARED-END */")
    return "\n\n".join(chunks).rstrip() + "\n"


def check() -> None:
    errors: list[str] = []
    app = ROOT / "app.css"
    theme = ROOT / "theme.js"
    if not app.exists(): errors.append("missing app.css")
    if not theme.exists(): errors.append("missing theme.js")
    app_text = app.read_text(encoding="utf-8") if app.exists() else ""
    for filename, page in PAGES.items():
        path = ROOT / filename
        if not path.exists():
            errors.append(f"missing {filename}")
            continue
        text = path.read_text(encoding="utf-8")
        head = text.split("</head>", 1)[0].lower()
        if "<style" in head: errors.append(f"{filename}: inline <style> remains in <head>")
        if "app.css" not in head: errors.append(f"{filename}: app.css not linked")
        if "theme.js" not in head: errors.append(f"{filename}: theme.js not linked")
        if f'data-epir-page="{page}"' not in text: errors.append(f"{filename}: missing page scope")
        if f"EPIR-PAGE-START:{page}" not in app_text: errors.append(f"app.css: missing {page} section")
    if "EPIR-SHARED-START" not in app_text: errors.append("app.css: shared section missing")
    if "theme-control.js" in "\n".join((ROOT / p).read_text(encoding="utf-8") for p in PAGES):
        errors.append("legacy theme-control.js still referenced by active HTML")
    if errors:
        raise SystemExit("Shared UI check failed:\n- " + "\n- ".join(errors))
    print("Shared UI check: OK")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check(); return

    app_path = ROOT / "app.css"
    existing = extract_existing_sections(app_path.read_text(encoding="utf-8")) if app_path.exists() else {}
    migrated: dict[str, str] = {}
    for filename, page in PAGES.items():
        path = ROOT / filename
        new_html, raw_css = migrate_html(path, page)
        if raw_css:
            migrated[page] = scope_css(raw_css, page)
        elif page in existing:
            migrated[page] = existing[page]
        else:
            raise RuntimeError(f"{filename}: no inline CSS and no existing app.css section")
        path.write_text(new_html, encoding="utf-8")
        print(f"migrated {filename}: {len(raw_css)} inline CSS chars")

    app_path.write_text(build_css(migrated), encoding="utf-8")
    (ROOT / "theme.js").write_text(THEME_JS.rstrip() + "\n", encoding="utf-8")
    docs = ROOT / "docs"
    docs.mkdir(exist_ok=True)
    (docs / "UI_STYLE_GUIDE.md").write_text(STYLE_GUIDE, encoding="utf-8")
    check()


if __name__ == "__main__":
    main()
