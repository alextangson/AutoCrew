#!/usr/bin/env python3
"""
XiaoHongShu card renderer — converts content into 1080x1440 (3:4) card images.

Uses Playwright to screenshot locally-rendered HTML. No external requests.

Usage:
  python render_xhs_cards.py --title "标题" --content "内容文本" --output-dir ./cards
  python render_xhs_cards.py --title "标题" --content ./article.md --output-dir ./cards --theme minimal
"""

import argparse
import json
import os
import sys
import textwrap
from pathlib import Path

CARD_WIDTH = 1080
CARD_HEIGHT = 1440
DEVICE_SCALE = 2

# Approximate character limit per card for Chinese text (accounts for title card being separate)
CHARS_PER_CARD = 320

HTML_TEMPLATE = """\
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width={width}, initial-scale=1">
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  html, body {{
    width: {width}px;
    height: {height}px;
    overflow: hidden;
    font-family: -apple-system, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;
    background: {bg_color};
    color: {text_color};
  }}
  .card {{
    width: {width}px;
    height: {height}px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    padding: 96px 80px;
  }}
  .card.cover {{
    justify-content: center;
  }}
  .cover h1 {{
    font-size: 64px;
    font-weight: 700;
    line-height: 1.4;
    text-align: center;
    letter-spacing: 2px;
  }}
  .cover .subtitle {{
    margin-top: 32px;
    font-size: 28px;
    color: {muted_color};
    text-align: center;
  }}
  .content-card {{
    justify-content: flex-start;
    padding-top: 80px;
  }}
  .content-card .page-num {{
    position: absolute;
    bottom: 48px;
    right: 72px;
    font-size: 24px;
    color: {muted_color};
  }}
  .content-card .body {{
    font-size: 36px;
    line-height: 1.8;
    letter-spacing: 1px;
    white-space: pre-wrap;
    word-break: break-all;
  }}
  .content-card h2 {{
    font-size: 44px;
    font-weight: 600;
    margin-bottom: 32px;
    line-height: 1.4;
  }}
</style>
</head>
<body>
{body}
</body>
</html>
"""

THEMES = {
    "minimal": {
        "bg_color": "#FFFFFF",
        "text_color": "#1A1A1A",
        "muted_color": "#999999",
    },
    "dark": {
        "bg_color": "#1A1A1A",
        "text_color": "#F0F0F0",
        "muted_color": "#666666",
    },
    "warm": {
        "bg_color": "#FFF8F0",
        "text_color": "#2D2015",
        "muted_color": "#A08060",
    },
}


def split_content(text: str, chars_per_card: int = CHARS_PER_CARD) -> list[str]:
    """Split long text into chunks for multiple cards."""
    # Split on double newlines first (paragraph boundaries)
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]

    cards: list[str] = []
    current = ""

    for para in paragraphs:
        if len(current) + len(para) + 2 > chars_per_card and current:
            cards.append(current.strip())
            current = para
        else:
            current = current + "\n\n" + para if current else para

    if current.strip():
        cards.append(current.strip())

    return cards if cards else [text]


def escape_html(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_cover_html(title: str, subtitle: str = "") -> str:
    body = f'<div class="card cover"><h1>{escape_html(title)}</h1>'
    if subtitle:
        body += f'<div class="subtitle">{escape_html(subtitle)}</div>'
    body += "</div>"
    return body


def build_content_html(text: str, page_num: int, total_pages: int) -> str:
    # Check if text starts with a markdown heading
    lines = text.split("\n", 1)
    heading = ""
    body_text = text
    if lines[0].startswith("# ") or lines[0].startswith("## "):
        heading = lines[0].lstrip("#").strip()
        body_text = lines[1] if len(lines) > 1 else ""

    body = '<div class="card content-card">'
    if heading:
        body += f"<h2>{escape_html(heading)}</h2>"
    body += f'<div class="body">{escape_html(body_text.strip())}</div>'
    body += f'<div class="page-num">{page_num}/{total_pages}</div>'
    body += "</div>"
    return body


def render_cards(
    title: str,
    content: str,
    output_dir: str,
    theme: str = "minimal",
) -> dict:
    """Render content into XHS card images."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return {"ok": False, "error": "playwright not installed. Run: pip install playwright && playwright install chromium"}

    theme_colors = THEMES.get(theme, THEMES["minimal"])
    os.makedirs(output_dir, exist_ok=True)

    # Strip markdown formatting lightly (keep paragraphs)
    clean_content = content
    for prefix in ["# ", "## ", "### "]:
        # Keep headings as text but remove the markdown prefix on cover detection
        pass

    chunks = split_content(clean_content)
    total_pages = len(chunks)
    output_files: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(
            viewport={"width": CARD_WIDTH, "height": CARD_HEIGHT},
            device_scale_factor=DEVICE_SCALE,
        )

        # Render cover
        cover_body = build_cover_html(title)
        cover_html = HTML_TEMPLATE.format(
            width=CARD_WIDTH,
            height=CARD_HEIGHT,
            body=cover_body,
            **theme_colors,
        )
        cover_path = os.path.join(output_dir, "cover.png")
        page.set_content(cover_html)
        page.screenshot(path=cover_path, full_page=False)
        output_files.append(cover_path)

        # Render content cards
        for i, chunk in enumerate(chunks):
            card_body = build_content_html(chunk, i + 1, total_pages)
            card_html = HTML_TEMPLATE.format(
                width=CARD_WIDTH,
                height=CARD_HEIGHT,
                body=card_body,
                **theme_colors,
            )
            card_path = os.path.join(output_dir, f"card_{i + 1}.png")
            page.set_content(card_html)
            page.screenshot(path=card_path, full_page=False)
            output_files.append(card_path)

        browser.close()

    return {
        "ok": True,
        "output_dir": output_dir,
        "files": output_files,
        "cover": output_files[0] if output_files else "",
        "card_count": len(output_files),
    }


def main():
    parser = argparse.ArgumentParser(description="Render XiaoHongShu card images")
    parser.add_argument("--title", required=True, help="Card title")
    parser.add_argument("--content", required=True, help="Markdown text or path to a .md file")
    parser.add_argument("--output-dir", required=True, help="Output directory for card images")
    parser.add_argument("--theme", default="minimal", choices=list(THEMES.keys()), help="Visual theme")

    args = parser.parse_args()

    # If content looks like a file path, read it
    content = args.content
    if os.path.isfile(content):
        content = Path(content).read_text(encoding="utf-8")

    result = render_cards(
        title=args.title,
        content=content,
        output_dir=args.output_dir,
        theme=args.theme,
    )

    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
