#!/usr/bin/env python3
"""Import public YouTube playlists into the static Hope sermon library.

Python 3.9+ and standard library only. No account/channel ownership needed.
You provide an API key for the YouTube Data API v3.

Run from any directory:
    python scripts/import_playlists.py
    YOUTUBE_API_KEY='...' python scripts/import_playlists.py --dry-run

The key is never stored in the repository or generated JSON.
This script is invoked manually, not by the GitHub Pages site.
"""
from __future__ import annotations

import argparse
import copy
import getpass
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
SERIES_FILE = ROOT / "data" / "series.json"
SERMONS_FILE = ROOT / "data" / "sermons.json"
API_ROOT = "https://www.googleapis.com/youtube/v3"
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
PLAYLIST_ID = re.compile(r"^[A-Za-z0-9_-]{12,}$")
PLACEHOLDER_DESCRIPTION = "Teaching from Hope Alliance Bethlehem."


class YouTubeError(Exception):
    """User-facing error with no URL or API key embedded."""


def load_array(path: Path) -> list[dict]:
    obj = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(obj, list):
        raise ValueError(f"Expected a JSON array in {path}")
    return obj


def save_atomic(path: Path, data: list[dict]) -> None:
    content = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    with tempfile.NamedTemporaryFile(
        "w", dir=path.parent, prefix=".tmp-import-", suffix=".json",
        delete=False, encoding="utf-8"
    ) as tmp:
        tmp.write(content)
        tmp_path = Path(tmp.name)
    try:
        tmp_path.replace(path)
    finally:
        tmp_path.unlink(missing_ok=True)


def get_playlist_id(value: str) -> str | None:
    """Extract ID from a YouTube playlist URL or a raw playlist ID."""
    value = str(value or "").strip()
    if PLAYLIST_ID.fullmatch(value):
        return value
    try:
        u = urlparse(value)
        host = (u.hostname or "").lower().removeprefix("www.").removeprefix("m.")
        if u.scheme not in {"http", "https"} or host not in {"youtube.com", "music.youtube.com"}:
            return None
        ident = parse_qs(u.query).get("list", [""])[0]
        return ident if PLAYLIST_ID.fullmatch(ident) else None
    except ValueError:
        return None


def get_video_id(value: str) -> str | None:
    value = str(value or "").strip()
    if VIDEO_ID.fullmatch(value):
        return value
    try:
        u = urlparse(value)
        host = (u.hostname or "").lower().removeprefix("www.").removeprefix("m.")
        if u.scheme not in {"http", "https"}:
            return None
        if host == "youtu.be":
            ident = u.path.strip("/").split("/")[0]
        elif host in {"youtube.com", "music.youtube.com", "youtube-nocookie.com"}:
            ident = parse_qs(u.query).get("v", [""])[0]
            if not ident:
                parts = u.path.strip("/").split("/")
                ident = parts[1] if len(parts) >= 2 and parts[0] in {"live", "shorts", "embed"} else ""
        else:
            return None
        return ident if VIDEO_ID.fullmatch(ident) else None
    except ValueError:
        return None


def youtube_get(resource: str, key: str, **params) -> dict:
    """Read a public resource. Explicitly avoid exposing API-key-containing URLs on failure."""
    params = {"key": key, **params}
    uri = f"{API_ROOT}/{resource}?{urlencode(params)}"
    try:
        with urlopen(Request(uri, headers={"Accept": "application/json", "User-Agent": "HopeSermonLibraryImporter/1.0"}), timeout=25) as response:
            return json.load(response)
    except HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8"))
            message = detail.get("error", {}).get("message", "YouTube request failed")
            reason = ", ".join(
                item.get("reason", "") for item in detail.get("error", {}).get("errors", [])
                if isinstance(item, dict) and item.get("reason")
            )
        except (ValueError, UnicodeDecodeError):
            message, reason = "YouTube request failed", ""
        raise YouTubeError(f"HTTP {exc.code}: {message}" + (f" ({reason})" if reason else "")) from None
    except (TimeoutError, URLError, OSError) as exc:
        # No raw URL in this error (it would disclose the API key).
        raise YouTubeError(f"Network problem retrieving {resource}: {type(exc).__name__}") from None
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise YouTubeError(f"Unexpected response while reading {resource}") from None


def chunks(values, size=50):
    for start in range(0, len(values), size):
        yield values[start : start + size]


def load_playlist_metadata(ids: list[str], key: str) -> dict[str, dict]:
    results = {}
    for batch in chunks(ids):
        response = youtube_get("playlists", key, part="snippet", id=",".join(batch), maxResults=50)
        for item in response.get("items", []):
            results[item["id"]] = item
    return results


def load_playlist_items(playlist_id: str, key: str) -> list[dict]:
    records: list[dict] = []
    token = None
    seen_tokens = set()
    while True:
        params = {"part": "snippet,contentDetails", "playlistId": playlist_id, "maxResults": 50}
        if token:
            params["pageToken"] = token
        page = youtube_get("playlistItems", key, **params)
        records.extend(page.get("items", []))
        token = page.get("nextPageToken")
        if not token:
            break
        if token in seen_tokens:
            raise YouTubeError("YouTube returned a repeated page token")
        seen_tokens.add(token)
    return records


def load_video_details(ids: list[str], key: str) -> dict[str, dict]:
    result = {}
    for batch in chunks(list(dict.fromkeys(ids))):
        response = youtube_get("videos", key, part="snippet,status", id=",".join(batch), maxResults=50)
        for item in response.get("items", []):
            result[item["id"]] = item
    return result


def summary_description(raw: str) -> str:
    # Prefer an introductory paragraph over multi-page timestamps and social links.
    text = (raw or "").strip().replace("\r\n", "\n")
    paragraph = next((p.strip().replace("\n", " ") for p in text.split("\n\n") if p.strip()), "")
    if len(paragraph) > 320:
        paragraph = paragraph[:317].rsplit(" ", 1)[0] + "…"
    return paragraph or PLACEHOLDER_DESCRIPTION


def youtube_title_is_placeholder(title: str) -> bool:
    return (not title or bool(re.match(r"^Series\s+\d+\s*[—–-]\s*rename$", title, re.I)))


def episode_title_is_placeholder(title: str) -> bool:
    return not title or "linked sermon (rename)" in title.lower()


def apply_import(series: list[dict], sermons: list[dict], key: str, *, verbose=True) -> tuple[list[dict], list[dict], dict]:
    """Merge remote public metadata with local records, without deleting hand-edited entries.

    Existing non-placeholder titles, scripture references, descriptions, custom artwork,
    extra fields, and manual episodes are retained. Video/series records are keyed
    by (series ID, video ID), allowing reuse of a video in multiple playlists.
    """
    new_series = copy.deepcopy(series)
    new_sermons = copy.deepcopy(sermons)
    parsed = {}
    errors = []
    for entry in new_series:
        ident = get_playlist_id(entry.get("playlistUrl", ""))
        if not ident:
            errors.append(f"{entry.get('id', '<unknown>')}: missing or malformed playlistUrl")
        else:
            parsed[entry["id"]] = ident
    if not parsed:
        raise YouTubeError("No valid playlist URLs in data/series.json")

    metadata = load_playlist_metadata(list(dict.fromkeys(parsed.values())), key)
    existing_by_key = {}
    for entry in new_sermons:
        vid = get_video_id(entry.get("url") or entry.get("videoId") or "")
        if vid:
            existing_by_key[(entry.get("seriesId"), vid)] = entry

    success = 0
    processed = 0
    skipped = 0
    for group in new_series:
        series_id = group.get("id", "")
        playlist_id = parsed.get(series_id)
        if not playlist_id:
            continue
        info = metadata.get(playlist_id)
        if not info:
            errors.append(f"{series_id}: playlist not publicly accessible or ID not recognized ({playlist_id})")
            continue
        snippet = info.get("snippet", {})
        try:
            items = load_playlist_items(playlist_id, key)
            video_ids = []
            for item in items:
                snippet_item = item.get("snippet", {})
                vid = (item.get("contentDetails", {}).get("videoId")
                       or snippet_item.get("resourceId", {}).get("videoId"))
                if vid and VIDEO_ID.fullmatch(vid) and snippet_item.get("title") not in ("Private video", "Deleted video"):
                    video_ids.append(vid)
            if not video_ids:
                errors.append(f"{series_id}: no accessible video entries found; existing entries kept")
                continue
            details = load_video_details(video_ids, key)
        except YouTubeError as error:
            errors.append(f"{series_id}: {error}")
            continue

        # Do not overwrite manually edited series titles/descriptions/artwork.
        remote_title = snippet.get("title", "")
        if youtube_title_is_placeholder(group.get("title", "")) and remote_title:
            group["title"] = remote_title
        if not group.get("description") or group.get("description") == PLACEHOLDER_DESCRIPTION:
            group["description"] = summary_description(snippet.get("description", ""))
        group["playlistUrl"] = f"https://www.youtube.com/playlist?list={playlist_id}"
        imported_videos = set()
        added = 0
        for position, vid in enumerate(video_ids, 1):
            video = details.get(vid)
            if not video:
                skipped += 1
                continue
            if video.get("status", {}).get("embeddable") is False:
                skipped += 1
                continue
            data = video.get("snippet", {})
            title = data.get("title", "")
            if title in ("Private video", "Deleted video") or not title:
                skipped += 1
                continue
            imported_videos.add(vid)
            date = (data.get("publishedAt") or "")[:10]
            current = existing_by_key.get((series_id, vid))
            if current:
                if episode_title_is_placeholder(current.get("title", "")):
                    current["title"] = title
                if not current.get("published") and re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
                    current["published"] = date
                current["episodeNumber"] = position
                if current.get("source") == "seed":
                    current["source"] = "youtube"
                # Existing hand-entered scripture, custom fields, and title are retained.
            else:
                record = {"title": title, "seriesId": series_id, "scripture": "",
                          "url": f"https://www.youtube.com/watch?v={vid}",
                          "episodeNumber": position, "source": "youtube"}
                if re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
                    record["published"] = date
                new_sermons.append(record)
                existing_by_key[(series_id, vid)] = record
                added += 1
        if not imported_videos:
            errors.append(f"{series_id}: no embeddable public videos; existing entries kept")
            continue
        # Remove only synthetic *seed* records whose videos aren't present in the playlist.
        new_sermons = [item for item in new_sermons if not (
            item.get("seriesId") == series_id and item.get("source") == "seed"
            and get_video_id(item.get("url") or "") not in imported_videos
        )]
        success += 1
        processed += len(imported_videos)
        if verbose:
            print(f"✓ {group['title']}: {len(imported_videos)} embeddable videos ({added} new)")
    if not success:
        raise YouTubeError("No playlists imported. Existing catalog has not been changed. " + " | ".join(errors[:3]))
    return new_series, new_sermons, {"success": success, "total": len(parsed), "videos": processed,
                                     "skipped": skipped, "warnings": errors}


def main():
    parser = argparse.ArgumentParser(description="Import the church's public YouTube playlists into GitHub Pages JSON files.")
    parser.add_argument("--dry-run", action="store_true", help="Preview results without writing files")
    args = parser.parse_args()
    key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if not key:
        if not sys.stdin.isatty():
            parser.error("Set YOUTUBE_API_KEY in your environment or GitHub Actions secret.")
        key = getpass.getpass("YouTube Data API key (hidden): ").strip()
    if not key:
        parser.error("An API key is required.")
    try:
        series = load_array(SERIES_FILE)
        sermons = load_array(SERMONS_FILE)
        new_series, new_sermons, report = apply_import(series, sermons, key)
    except (YouTubeError, ValueError, OSError, KeyError) as exc:
        print(f"Import failed: {exc}", file=sys.stderr)
        return 1
    print(f"\nImported {report['videos']} playable entries across {report['success']}/{report['total']} playlists.")
    if report["skipped"]:
        print(f"Skipped {report['skipped']} unavailable/unembeddable entries.")
    for warning in report["warnings"]:
        print(f"WARNING: {warning}", file=sys.stderr)
    if args.dry_run:
        print("Dry run: no files changed.")
    else:
        save_atomic(SERIES_FILE, new_series)
        save_atomic(SERMONS_FILE, new_sermons)
        print(f"Saved: {SERIES_FILE.relative_to(ROOT)}, {SERMONS_FILE.relative_to(ROOT)}")
        print("Commit these JSON files to publish the updated catalog.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
