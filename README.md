# Hope Alliance Bethlehem — Sermon Library (v6)

A **free, static, GitHub Pages-ready** prototype for the public [@hopebethlehem YouTube channel](https://www.youtube.com/@hopebethlehem). This is a demo, not an official church website. Videos still stream through YouTube; this site does **not** host videos or require channel administrator permissions.

**Version 5 adds an optional one-time YouTube playlist importer.** The website itself stays entirely static. You can also keep editing both JSON files manually.


## New in v6: Full-page player and watch progress

- Choosing a message navigates to a **full-width watch page** (`#/watch/VIDEO_ID`) rather than a popup. The player includes a series queue; the back button returns to your previous series/library view. Playlist playback uses `#/playlist/SERIES_ID`.
- Individual sermon progress is saved **locally in each visitor's browser**. A sermon can be resumed from its saved timestamp, episodes show a percentage watched, and completed sermons get a **Watched** label. The library has a **Continue watching** rail when there are unfinished sermons.
- Previously stored v5 progress timestamps continue to work. Progress may be unavailable in private browsing or when storage is disabled, and it will be lost if someone clears browser site data. This is **not** synced between devices or an admin analytics dashboard; those would require user identity and a backend.
- Episodes and the **Up Next** queue are sorted **oldest first** by video publication date. YouTube playlist positions are used only as fallbacks/tiebreakers. If a sermon was uploaded later than it was preached, manual `published` dates in `data/sermons.json` can correct chronology.
- **Do not overwrite your imported `data/series.json` or `data/sermons.json`.** Updating from v5 needs just `index.html`, `app.js`, `styles.css`; the included example data files are only a seed catalog.

## What is included?

- Dark Netflix-style responsive interface with 15 series in a carousel, series episode pages, search, and embedded YouTube player with an episode queue.
- `data/series.json`: the **15 playlist URLs you provided** with provisional `Series 01`–`Series 15` labels and seed thumbnails.
- `data/sermons.json`: one actual linked video ID for each series, so the demo is playable before an import, if those recordings allow embedding.
- `scripts/import_playlists.py`: read **public** playlist titles, descriptions, and **all video pages** via YouTube Data API v3; write the two JSON files. No Python packages needed.
- `.github/workflows/import-playlists.yml`: optional manual **Actions** button to import on GitHub and immediately deploy.
- `.github/workflows/deploy.yml`: deploy without importing, for hand-edited catalog updates.
- `scripts/add_sermon.py` and `scripts/set_playlist.py`: manual helpers from v4.

**Important:** The first three supplied playlist IDs are shorter than most of the others. They are included exactly as provided. If YouTube's API cannot find them, the importer prints a warning and leaves the corresponding placeholder entries intact. You may need to recopy those links.

## Option A: Import using GitHub Actions (no Python setup on your computer)

1. Create a GitHub repository and put the **contents** of this folder at the root, including `.github/workflows`.
2. In GitHub repository **Settings → Pages**, choose **GitHub Actions** under *Build and deployment*.
3. In [Google Cloud Console](https://console.cloud.google.com/), select or create a project. Enable **YouTube Data API v3** under *APIs & Services → Library*. Then under *Credentials*, create an **API key**. You do **not** have to own the `@hopebethlehem` channel or authenticate as it to access public playlists.
4. In GitHub **Settings → Secrets and variables → Actions**, create a **repository secret** named `YOUTUBE_API_KEY` containing the key. **Never put the key in `data/*.json`, HTML, or JavaScript.** Restrict the key to the YouTube Data API v3 in Google Cloud. Do not apply an IP restriction if running from GitHub-hosted Actions runners with changing IP addresses.
5. Open the **Actions** tab, choose **Import YouTube playlists (on demand)**, and select **Run workflow**.
6. The workflow fetches each playlist, updates `data/series.json` and `data/sermons.json`, commits the changes, and deploys the site to GitHub Pages. If some playlists are not accessible, it warns and imports the rest. If none can be imported, it fails without modifying the JSON files.

The importer does **not** run on a schedule. New videos appear when you manually run it again or add them manually.

## Option B: Import locally using Python

You need Python 3.9+ and your own YouTube Data API v3 key. In the demo's root folder, run:

```bash
python scripts/import_playlists.py
```

It prompts for the API key without echoing it. To preview without modifying files:

```bash
python scripts/import_playlists.py --dry-run
```

Or set the `YOUTUBE_API_KEY` environment variable in your terminal and run the script. **Do not paste API keys into public repositories, commits, logs, or screenshots.** The script only reads public metadata and does not modify the church's YouTube account. After a local import, commit the two updated JSON files to GitHub; the standard Pages deployment workflow handles publication.

## Editing sermon titles, artwork, and Scripture yourself

After an import, you can change the `title`, `scripture`, or other fields in `data/sermons.json` or edit the series `title` and `description` in `data/series.json`. A later import **preserves existing non-placeholder titles, Scripture, descriptions, and custom covers**, and adds any newly discovered episodes.

To use an original series cover, add the image, for example `assets/be-wise.jpg`, and change the appropriate series entry to:

```json
"artwork": { "videoId": "", "url": "assets/be-wise.jpg" }
```

For automatic thumbnail cover art, leave `artwork.url` and `artwork.videoId` empty: the website uses a linked sermon thumbnail. The 15 starter entries are pinned to the representative video ID you supplied; delete that `videoId` to use the latest linked episode thumbnail instead.

The importer sets `episodeNumber` based on **YouTube playlist order**, but the player and series page now prefer actual publication dates so episodes are **oldest first**. You can use the **Newest first** menu if desired. The importer does not remove manually added episodes.

## Publish and test

For a new repository: **Settings → Pages → GitHub Actions**, then run **Deploy sermon demo (manual catalog)** once. Find your demo at `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/` after successful deployment.

For a local preview (which works without the API key if you keep the seeded catalog):

```bash
python -m http.server 8000
```

Open `http://localhost:8000`. Don't double-click the HTML file: `file://` may block JSON fetches or video embeds.

The YouTube API can retrieve metadata from public playlists with an API key; unavailable/private/deleted or explicitly nonembeddable recordings may be omitted, and individual videos can change their embed restrictions later. Playback on the final site must be tested separately because embedded YouTube is controlled by YouTube.

## Development checks

```bash
python -m unittest discover -s tests -v
node --check app.js
python -m py_compile scripts/import_playlists.py
```

No Google API client libraries are required. No API keys are included in these files.
