
import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERMONS = ROOT / "data" / "sermons.json"
SERIES = ROOT / "data" / "series.json"

CHANNEL_HANDLE = "@hopebethlehem"
MIN_DURATION_SECONDS = 180

API_KEY = os.environ["YOUTUBE_API_KEY"]
BASE = "https://www.googleapis.com/youtube/v3/"


def youtube_api(endpoint, **params):
    params["key"] = API_KEY
    url = BASE + endpoint + "?" + urllib.parse.urlencode(params)

    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def video_id(url):
    if not url:
        return None
    parsed = urllib.parse.urlparse(url)
    if parsed.hostname in ("youtu.be", "www.youtu.be"):
        return parsed.path.strip("/") or None
    return urllib.parse.parse_qs(
        parsed.query
    ).get("v", [None])[0]


def duration_seconds(duration):
    match = re.fullmatch(
        r"P(?:(\d+)D)?(?:T(?:(\d+)H)?"
        r"(?:(\d+)M)?(?:(\d+)S)?)?",
        duration,
    )
    if not match:
        return 0

    d, h, m, s = (int(x or 0) for x in match.groups())
    return d * 86400 + h * 3600 + m * 60 + s


def get_all_upload_ids():
    channel = youtube_api(
        "channels",
        part="contentDetails",
        forHandle=CHANNEL_HANDLE,
    )["items"][0]

    uploads_id = channel["contentDetails"][
        "relatedPlaylists"
    ]["uploads"]

    ids = []
    token = None

    while True:
        params = {
            "part": "contentDetails",
            "playlistId": uploads_id,
            "maxResults": 50,
        }
        if token:
            params["pageToken"] = token

        page = youtube_api("playlistItems", **params)

        for item in page.get("items", []):
            vid = item.get("contentDetails", {}).get("videoId")
            if vid:
                ids.append(vid)

        token = page.get("nextPageToken")
        if not token:
            break

    return list(dict.fromkeys(ids))


def main():
    sermons = json.loads(SERMONS.read_text(encoding="utf-8"))
    series = json.loads(SERIES.read_text(encoding="utf-8"))

    existing = set()
    for sermon in sermons:
        vid = (
            sermon.get("videoId")
            or sermon.get("id")
            or video_id(sermon.get("url", ""))
        )
        if vid:
            existing.add(vid)

    ids = get_all_upload_ids()
    print(f"Found {len(ids)} channel uploads")

    added = 0
    skipped_short = 0
    first_added_id = None

    for start in range(0, len(ids), 50):
        batch = ids[start:start + 50]

        response = youtube_api(
            "videos",
            part="snippet,contentDetails,status",
            id=",".join(batch),
        )

        for video in response.get("items", []):
            vid = video["id"]
            info = video["snippet"]
            status = video.get("status", {})

            if status.get("embeddable") is False:
                continue
            if status.get("privacyStatus") != "public":
                continue

            seconds = duration_seconds(
                video["contentDetails"].get("duration", "")
            )

            if seconds <= MIN_DURATION_SECONDS:
                skipped_short += 1
                continue

            if vid in existing:
                continue

            published = info.get("publishedAt", "")

            sermons.append({
                "title": info["title"],
                "seriesId": "other-messages",
                "scripture": "",
                "url": f"https://www.youtube.com/watch?v={vid}",
                "date": published[:10],
                "publishedAt": published,
            })

            existing.add(vid)
            first_added_id = first_added_id or vid
            added += 1

    if added and not any(
        s.get("id") == "other-messages" for s in series
    ):
        series.append({
            "id": "other-messages",
            "title": "Other Messages",
            "description": "Additional teaching and videos from Hope Alliance Bethlehem.",
            "artwork": {
                "videoId": first_added_id,
                "url": ""
            },
            "playlistUrl": ""
        })

    SERMONS.write_text(
        json.dumps(sermons, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    SERIES.write_text(
        json.dumps(series, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    print(f"Added {added} new videos")
    print(f"Excluded {skipped_short} short-duration videos")


if __name__ == "__main__":
    main()

