#!/usr/bin/env python3
"""Add a public YouTube video URL to the hand-edited sermon catalog.

Run from any working directory:
  python scripts/add_sermon.py "https://youtu.be/VIDEO_ID" --series be-wise --title "Message Title" --scripture "Proverbs 3"

No network requests, API keys, third-party packages, or automatic scraping.
"""
import argparse
import json
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT=Path(__file__).resolve().parents[1]
SERIES=ROOT/'data'/'series.json'
SERMONS=ROOT/'data'/'sermons.json'
ID=re.compile(r'^[a-zA-Z0-9_-]{11}$')

def video_id(value):
    value=value.strip()
    if ID.fullmatch(value): return value
    p=urlparse(value)
    host=p.hostname.lower() if p.hostname else ''
    host=host.removeprefix('www.').removeprefix('m.')
    if p.scheme not in ('https','http'): return None
    if host=='youtu.be': candidate=p.path.strip('/').split('/')[0]
    elif host in ('youtube.com','youtube-nocookie.com','music.youtube.com'):
        parts=p.path.strip('/').split('/')
        candidate=parse_qs(p.query).get('v',[''])[0]
        if not candidate and len(parts)>=2 and parts[0] in ('shorts','live','embed'):
            candidate=parts[1]
    else: return None
    return candidate if ID.fullmatch(candidate) else None

def main():
    parser=argparse.ArgumentParser(description='Add or update a Hope Bethlehem sermon by pasting a YouTube video URL.')
    parser.add_argument('url',help='YouTube watch / share / live / Shorts URL or 11-character video ID')
    parser.add_argument('--series',required=True,help='Series ID from data/series.json, e.g. be-wise')
    parser.add_argument('--title',required=True,help='Sermon title')
    parser.add_argument('--scripture',default='',help='Optional Bible reference')
    parser.add_argument('--date',default='',help='Optional YYYY-MM-DD publication date')
    args=parser.parse_args()
    ident=video_id(args.url)
    if not ident: parser.error('Not a recognized YouTube video URL or video ID.')
    if args.date and not re.fullmatch(r'\d{4}-\d{2}-\d{2}',args.date):parser.error('--date must be YYYY-MM-DD')
    groups=json.loads(SERIES.read_text(encoding='utf-8'))
    if args.series not in {g['id'] for g in groups}:
        parser.error('Unknown series. Valid IDs: '+', '.join(g['id'] for g in groups))
    items=json.loads(SERMONS.read_text(encoding='utf-8'))
    record={"title":args.title,"seriesId":args.series,"scripture":args.scripture,
            "url":f'https://www.youtube.com/watch?v={ident}'}
    if args.date:record['published']=args.date
    # Update existing entry by YouTube ID, or fill in a title-only placeholder.
    existing=next((i for i,x in enumerate(items) if video_id(x.get('url',''))==ident),None)
    if existing is None:
        existing=next((i for i,x in enumerate(items) if not x.get('url') and x.get('seriesId')==args.series and x.get('title','').strip().lower()==args.title.strip().lower()),None)
    if existing is not None:
        items[existing]={**items[existing],**record}
        operation='Updated'
    else:
        items.append(record)
        operation='Added'
    SERMONS.write_text(json.dumps(items,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    print(f'{operation}: {args.title} -> {record["url"]}')
    print(f'Catalog: {SERMONS}')

if __name__=='__main__':main()
