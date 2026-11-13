#!/usr/bin/env python3
"""Attach a public YouTube playlist URL to a series; does not import episodes."""
import argparse,json,re
from pathlib import Path
from urllib.parse import urlparse,parse_qs
ROOT=Path(__file__).resolve().parents[1]
FILE=ROOT/'data'/'series.json'

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('url',help='https://www.youtube.com/playlist?list=PL...')
    parser.add_argument('--series',required=True,help='Series ID from data/series.json')
    a=parser.parse_args()
    p=urlparse(a.url)
    host=(p.hostname or '').lower().removeprefix('www.').removeprefix('m.')
    playlist=parse_qs(p.query).get('list',[''])[0]
    if p.scheme not in ('http','https') or host not in ('youtube.com','music.youtube.com') or not re.fullmatch(r'[A-Za-z0-9_-]{12,}',playlist):
        parser.error('Expected a YouTube playlist link with a valid list= ID.')
    items=json.loads(FILE.read_text(encoding='utf-8'))
    series=next((x for x in items if x['id']==a.series),None)
    if series is None:parser.error('Unknown series ID: '+a.series)
    series['playlistUrl']=f'https://www.youtube.com/playlist?list={playlist}'
    FILE.write_text(json.dumps(items,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print('Linked',a.series,'to',series['playlistUrl'])
    print('Note: this enables embedded playlist playback; it does not auto-create episode cards.')
if __name__=='__main__':main()
