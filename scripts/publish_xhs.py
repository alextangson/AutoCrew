#!/usr/bin/env python3
"""
XiaoHongShu (小红书) publisher — publishes image notes via the xhs library.

Uses cookie-based auth with local signing. Defaults to private publishing.

Usage:
  python publish_xhs.py --title "标题" --desc "描述" --images cover.png card1.png --cookie "..."
  python publish_xhs.py --title "标题" --desc "描述" --images cover.png --public --post-time "2026-04-05 10:00"
"""

import argparse
import json
import os
import sys
import time


def extract_a1(cookie: str) -> str | None:
    """Extract the a1 value from a cookie string."""
    for part in cookie.split(";"):
        key, _, value = part.strip().partition("=")
        if key.strip() == "a1":
            return value.strip()
    return None


def validate_cookie(cookie: str) -> list[str]:
    """Check that required XHS cookie fields are present."""
    errors: list[str] = []
    fields = {k.strip(): v.strip() for k, v in (p.partition("=")[::2] for p in cookie.split(";"))}
    if "a1" not in fields or not fields["a1"]:
        errors.append("Cookie missing required field 'a1'. Re-export your cookie from the browser.")
    if "web_session" not in fields or not fields["web_session"]:
        errors.append("Cookie missing required field 'web_session'. Your session may have expired.")
    return errors


def publish(
    title: str,
    desc: str,
    image_paths: list[str],
    cookie: str,
    is_private: bool = True,
    post_time: str | None = None,
    dry_run: bool = False,
) -> dict:
    """Publish an image note to XiaoHongShu."""

    # Validate cookie
    cookie_errors = validate_cookie(cookie)
    if cookie_errors:
        return {"ok": False, "error": "; ".join(cookie_errors)}

    # Validate images exist
    for img in image_paths:
        if not os.path.isfile(img):
            return {"ok": False, "error": f"Image file not found: {img}"}

    if dry_run:
        return {
            "ok": True,
            "dry_run": True,
            "title": title,
            "desc": desc,
            "images": image_paths,
            "is_private": is_private,
            "post_time": post_time,
        }

    try:
        from xhs import XhsClient
        from xhs.help import sign as xhs_sign
    except ImportError:
        return {
            "ok": False,
            "error": "xhs library not installed. Run: pip install xhs",
        }

    a1 = extract_a1(cookie)
    if not a1:
        return {"ok": False, "error": "Could not extract 'a1' from cookie for signing."}

    try:

        def sign(uri: str, data=None, a1: str = "", web_session: str = ""):
            return xhs_sign(uri, data=data, a1=a1, web_session=web_session)

        client = XhsClient(cookie=cookie, sign=sign)

        # Upload images
        uploaded = []
        for img_path in image_paths:
            with open(img_path, "rb") as f:
                image_data = f.read()
            upload_result = client.upload_image(image_data)
            uploaded.append(upload_result)

        # Build note
        note_kwargs: dict = {
            "title": title,
            "desc": desc,
            "images": uploaded,
            "is_private": is_private,
        }

        if post_time:
            note_kwargs["post_time"] = post_time

        result = client.create_image_note(**note_kwargs)

        note_id = result.get("note_id", "")
        return {
            "ok": True,
            "note_id": note_id,
            "url": f"https://www.xiaohongshu.com/explore/{note_id}" if note_id else "",
            "is_private": is_private,
            "raw": result,
        }

    except Exception as e:
        error_msg = str(e)
        # Provide helpful hints for common errors
        if "sign" in error_msg.lower():
            error_msg += " — Signing failed. The a1 cookie value may be stale; re-export from browser."
        elif "401" in error_msg or "unauthorized" in error_msg.lower():
            error_msg += " — Cookie expired. Log in to xiaohongshu.com and re-export the cookie."
        elif "频繁" in error_msg or "frequent" in error_msg.lower():
            error_msg += " — Rate limited. Wait a few minutes before retrying."
        return {"ok": False, "error": error_msg}


def main():
    parser = argparse.ArgumentParser(description="Publish image note to XiaoHongShu")
    parser.add_argument("--title", required=True, help="Note title")
    parser.add_argument("--desc", required=True, help="Note description")
    parser.add_argument("--images", nargs="+", required=True, help="Image file paths")
    parser.add_argument("--cookie", default=None, help="XHS cookie string (or set XHS_COOKIE env)")
    parser.add_argument("--private", dest="is_private", action="store_true", default=True, help="Publish as private (default)")
    parser.add_argument("--public", dest="is_private", action="store_false", help="Publish as public")
    parser.add_argument("--post-time", default=None, help="Scheduled post time (e.g. '2026-04-05 10:00')")
    parser.add_argument("--dry-run", action="store_true", help="Validate inputs without publishing")

    args = parser.parse_args()

    cookie = args.cookie or os.environ.get("XHS_COOKIE", "")
    if not cookie:
        result = {"ok": False, "error": "No cookie provided. Use --cookie or set XHS_COOKIE env variable."}
        print(json.dumps(result))
        sys.exit(1)

    result = publish(
        title=args.title,
        desc=args.desc,
        image_paths=args.images,
        cookie=cookie,
        is_private=args.is_private,
        post_time=args.post_time,
        dry_run=args.dry_run,
    )

    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
