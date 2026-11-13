/* Hope Bethlehem sermon demo: zero-dependency static client. */
const CHANNEL_URL = 'https://www.youtube.com/@hopebethlehem';

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const $ = selector => document.querySelector(selector);
const clean = value => String(value ?? '').trim();
// The hand-edited catalog accepts any ordinary YouTube watch, share, Shorts, live, or embed URL.
function parseVideoId(value) {
  const raw=clean(value);
  if (YOUTUBE_ID.test(raw)) return raw;
  try {
    const url=new URL(raw);
    const host=url.hostname.toLowerCase().replace(/^www\./,'').replace(/^m\./,'');
    let id='';
    if(host==='youtu.be') id=url.pathname.split('/')[1]||'';
    else if(['youtube.com','youtube-nocookie.com','music.youtube.com'].includes(host)) {
      id=url.searchParams.get('v') || (/^\/(shorts|live|embed)\//.test(url.pathname) ? url.pathname.split('/')[2] : '') || '';
    }
    return YOUTUBE_ID.test(id)?id:'';
  } catch { return ''; }
}
function parsePlaylistId(value) {
  try {
    const url=new URL(clean(value));
    const host=url.hostname.toLowerCase().replace(/^www\./,'').replace(/^m\./,'');
    if (!['youtube.com','music.youtube.com'].includes(host)) return '';
    const id=url.searchParams.get('list')||'';
    return /^[A-Za-z0-9_-]{12,}$/.test(id)?id:'';
  } catch { return ''; }
}

const videoImage = id => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const videoUrl = id => `https://www.youtube.com/watch?v=${id}`;
const slug = name => clean(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const readableTitle = title => clean(title).replace(/^Be Wise\s*[-–:]\s*/i, '');
const naturalDate = date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return '';
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
};

/* Edit data/series.json to change order, descriptions and optional cover overrides. */
const defaultSeries = [
  {id:'be-wise',title:'Be Wise',description:'Wisdom for the decisions we make every day.',artwork:{}},
  {id:'come-and',title:'Come and…',description:'An invitation to encounter Jesus and follow him.',artwork:{}},
  {id:'2-kings',title:'2 Kings',description:'God’s faithfulness through an ancient kingdom.',artwork:{}},
  {id:'other-messages',title:'Other Messages',description:'More teaching from Bethlehem.',artwork:{}}
];
let sermons = [];
let configs = defaultSeries;
let currentSeries = null;
let featuredSeries = null;
const watchView = $('#watch-view');
let returnHash = '#series';
function imgFor(item) {
  if (item && YOUTUBE_ID.test(item.videoId || '')) return videoImage(item.videoId);
  return '';
}
function allowedArtwork(url) {
  const value = clean(url);
  return (/^https:\/\//i.test(value) || /^assets\/[\w./-]+$/i.test(value)) ? value : '';
}
function getGroups() {
  const groups = new Map();
  configs.forEach((config,i) => groups.set(config.id, {...config,_index:i,episodes:[]}));
  for (const sermon of sermons) {
    const match = configs.find(c => c.id === sermon.seriesId || c.title.toLowerCase() === clean(sermon.series).toLowerCase());
    const id = match?.id || slug(sermon.series || 'Other Messages');
    if (!groups.has(id)) groups.set(id,{id,title:sermon.series || 'Other Messages',description:'Explore the teaching series.',artwork:{},_index:999,episodes:[]});
    groups.get(id).episodes.push(sermon);
  }
  return [...groups.values()].sort((a,b)=>a._index-b._index);
}
function newestFirst(a,b){
  if(a.published && b.published && a.published!==b.published) return b.published.localeCompare(a.published);
  return b._order-a._order;
}
function chronologicalEpisodes(group){
  return [...group.episodes].sort((a,b)=>{
    // Always prefer the actual publication date over YouTube playlist position.
    // Playlist positions may be newest-first, so they are only a fallback/tiebreaker.
    if(a.published && b.published && a.published!==b.published) return a.published.localeCompare(b.published);
    if(Number.isInteger(a.episodeNumber) && Number.isInteger(b.episodeNumber) && a.episodeNumber!==b.episodeNumber)
      return a.episodeNumber-b.episodeNumber;
    if(a.published && !b.published) return -1;
    if(!a.published && b.published) return 1;
    return a._order-b._order;
  });
}
function newestEpisodes(group){return chronologicalEpisodes(group).reverse()}
function groupArtwork(group) {
  const override = group.artwork || {};
  const external = allowedArtwork(override.url);
  if (external) return external;
  if (YOUTUBE_ID.test(override.videoId || '')) return videoImage(override.videoId);
  const representative = newestEpisodes(group).find(item => item.videoId);
  return representative ? imgFor(representative) : '';
}
function addArtwork(container,src) {
  if (!src) return;
  const img = document.createElement('img');
  img.src = src; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
  container.classList.add('has-artwork');
  img.addEventListener('error',()=>{img.remove();container.classList.remove('has-artwork')});
  container.append(img);
}

// External controls complement (rather than replace or obscure) YouTube's native controls.
const PROGRESS_KEY = 'hope-sermon-progress-v1';  // Reuses Version 5's saved timestamps.
let ytPlayer = null;
let youtubeReady = false;
let youtubeInit = null;
let activeVideo = null;
let activeSeries = null;
let queueVideos = [];
let queueIndex = -1;
let playlistMode = false;
let scrubbing = false;
let lastStatus = '';
let pendingSession = 0;
let lastProgressWrite = 0;

function status(message) {
  if (message === lastStatus) return;
  lastStatus = message;
  $('#player-status').textContent = message;
}
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const value = Math.floor(seconds);
  const h = Math.floor(value / 3600);
  const m = Math.floor(value % 3600 / 60);
  const sec = String(value % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2,'0')}:${sec}` : `${m}:${sec}`;
}
function readProgressMap() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
    return parsed && typeof parsed==='object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function progressFor(videoId) {
  if (!videoId) return {seconds:0,duration:0,completed:false,updatedAt:0};
  const record=readProgressMap()[videoId];
  // Previous demo versions stored only a numeric timestamp. Preserve that progress.
  if (typeof record==='number') return {seconds:Math.max(0,record),duration:0,completed:false,updatedAt:0};
  if (!record || typeof record!=='object') return {seconds:0,duration:0,completed:false,updatedAt:0};
  const seconds=Number(record.seconds)||0;
  const duration=Number(record.duration)||0;
  return {
    seconds:Math.max(0,seconds),duration:Math.max(0,duration),
    completed:!!record.completed,updatedAt:Number(record.updatedAt)||0
  };
}
function getSavedProgress(videoId) {
  const value=progressFor(videoId);
  return value.completed ? 0 : value.seconds;
}
function saveProgress(videoId, seconds, duration=0, completed=false, force=false) {
  if (!videoId || !Number.isFinite(seconds)) return;
  if (!force && Date.now()-lastProgressWrite<4000) return;
  const map=readProgressMap();
  const before=progressFor(videoId);
  const total=duration>0 ? duration : before.duration;
  const finished=completed || (total>0 && seconds/total>=0.95) || before.completed;
  // Don't store 0s records until the visitor actually watches something.
  if (seconds<3 && !finished) return;
  map[videoId]={seconds:finished && total>0 ? total : Math.max(0,Math.floor(seconds)),
    duration:Math.max(0,Math.floor(total)),completed:finished,updatedAt:Date.now()};
  try {localStorage.setItem(PROGRESS_KEY,JSON.stringify(map));lastProgressWrite=Date.now();}
  catch { /* Privacy settings may prohibit storage. Playback still works. */ }
}
function markCompleted(videoId, duration) {
  if (videoId) saveProgress(videoId,duration||progressFor(videoId).seconds,duration,true,true);
}
function progressLabel(videoId) {
  const p=progressFor(videoId);
  if (p.completed) return 'Watched ✓';
  if (p.seconds>=3 && p.duration>0) return `${Math.min(100,Math.round(100*p.seconds/p.duration))}% watched · Resume ${formatTime(p.seconds)}`;
  if (p.seconds>=3) return `Resume ${formatTime(p.seconds)}`;
  return '';
}
function addProgress(container, videoId) {
  const p=progressFor(videoId);
  if (p.seconds<3 && !p.completed) return;
  const shell=document.createElement('span');shell.className='progress-display';
  const line=document.createElement('span');line.className='progress-track';
  const fill=document.createElement('span');fill.className='progress-fill';
  fill.style.width=`${p.completed?100:p.duration>0?Math.min(100,100*p.seconds/p.duration):0}%`;
  line.append(fill);
  const label=document.createElement('span');label.className='progress-caption';label.textContent=progressLabel(videoId);
  shell.append(line,label);container.append(shell);
}
function updateProgressCopy() {
  const label=activeVideo ? progressLabel(activeVideo.videoId) : '';
  $('#watch-progress-line').textContent=label || 'Progress saved automatically on this browser and device.';
  $('#player-progress-text').textContent=label || 'Progress saves automatically as you watch.';
}
function findSeriesForSermon(sermon) {
  return getGroups().find(group => group.episodes.some(episode => episode.videoId === sermon.videoId));
}
function setPlayerEnabled(ready) {
  ['player-play','player-rewind','player-forward','player-seek','player-mute','player-volume','player-speed'].forEach(id => {
    document.getElementById(id).disabled = !ready;
  });
  $('#player-prev').disabled = !ready || playlistMode || queueIndex <= 0;
  $('#player-next').disabled = !ready || playlistMode || queueIndex >= queueVideos.length - 1;
}
function setVideoDetails() {
  const sermon = activeVideo;
  const title = sermon?.title || (playlistMode && activeSeries ? `${activeSeries.title} · Full playlist` : 'Hope Bethlehem sermons');
  $('#dialog-title').textContent = readableTitle(title);
  $('#watch-title').textContent = title;
  $('#dialog-subtitle').textContent = sermon
    ? [sermon.scripture, naturalDate(sermon.published)].filter(Boolean).join('  ·  ') || 'Hope Alliance Bethlehem teaching'
    : 'The complete YouTube playlist plays here. Add video links for an individual episode queue.';
  $('#watch-eyebrow').textContent = playlistMode && activeSeries
    ? `${activeSeries.title.toUpperCase()} · FULL PLAYLIST`
    : activeSeries ? `${activeSeries.title.toUpperCase()} · ${queueIndex + 1} OF ${queueVideos.length}` : 'HOPE ALLIANCE BETHLEHEM';
  $('#dialog-youtube').href = sermon ? videoUrl(sermon.videoId) : (activeSeries?.playlistUrl || CHANNEL_URL);
  $('#copy-video-link').disabled = !sermon;
  $('#queue-title').textContent = activeSeries?.title || 'Latest recordings';
  $('#queue-meta').textContent = activeSeries ? `${queueVideos.length} linked episode${queueVideos.length===1?'':'s'}` : 'Hope Bethlehem sermons';
}
function queueItem(sermon, index) {
  const b = document.createElement('button');
  b.className = 'queue-item'; b.type = 'button';
  b.setAttribute('aria-label', `Play episode ${index + 1}: ${sermon.title}`);
  if (index === queueIndex) {
    b.classList.add('is-current');
    b.setAttribute('aria-current','true');
  }
  const thumb = document.createElement('span');thumb.className = 'queue-thumb';
  addArtwork(thumb, imgFor(sermon));
  const number = document.createElement('span');number.className='queue-number';
  number.textContent = String(index + 1).padStart(2,'0');
  thumb.append(number);
  const content = document.createElement('span');content.className='queue-item-copy';
  const label = document.createElement('span');label.className='queue-item-label';
  label.textContent = index === queueIndex ? 'NOW PLAYING' : `EPISODE ${index + 1}`;
  const title = document.createElement('strong');title.textContent=readableTitle(sermon.title);
  const detail = document.createElement('span');detail.textContent=sermon.scripture || naturalDate(sermon.published) || 'Sermon recording';
  content.append(label,title,detail);addProgress(content,sermon.videoId);
  b.append(thumb,content);
  b.addEventListener('click',()=>selectQueueVideo(index));
  return b;
}
function renderQueue() {
  setVideoDetails();
  const box = $('#episode-queue');box.replaceChildren();
  if (!queueVideos.length) {
    const empty = document.createElement('p');empty.className='queue-empty';
    empty.textContent='Add individual sermon video URLs to data/sermons.json to populate this episode queue.';
    box.append(empty);
  } else {
    queueVideos.forEach((sermon,i)=>box.append(queueItem(sermon,i)));
    const selected = box.querySelector('.is-current');
    if (selected && window.innerWidth > 820) {
      const delta = selected.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight/3;
      box.scrollTop += delta;
    }
  }
  setPlayerEnabled(youtubeReady);
  updateProgressCopy();
}
function selectQueueVideo(index) {
  if (index < 0 || index >= queueVideos.length) return;
  const sermon=queueVideos[index];
  // One watch URL per episode; browser Back and direct sharing work naturally.
  location.hash=`/watch/${sermon.videoId}`;
}
function saveCurrentTime() {
  if (activeVideo && youtubeReady && ytPlayer?.getCurrentTime) {
    try { saveProgress(activeVideo.videoId, ytPlayer.getCurrentTime(), ytPlayer.getDuration()||0,false,true); } catch {}
  }
}
function loadActiveVideo() {
  if (!youtubeReady || watchView.hidden) return;
  if (playlistMode) {
    try { ytPlayer.loadPlaylist({list:activeSeries.playlistId, listType:'playlist'}); status('Playing the complete series playlist. YouTube controls are available.'); }
    catch { status('Could not load this playlist. Check its URL and public visibility.'); }
    return;
  }
  if (!activeVideo?.videoId) return;
  $('#player-loading').hidden=true;
  const saved = getSavedProgress(activeVideo.videoId);
  // If we have already reached the end, begin at the start instead.
  const startSeconds = saved > 25 ? saved : 0;
  ytPlayer.loadVideoById({videoId:activeVideo.videoId,startSeconds});
  status(startSeconds ? `Resuming from ${formatTime(startSeconds)}. YouTube’s native controls remain available.` : 'You can also use the controls inside the YouTube video.');
  updatePlayerUI();
}
function onYTStateChange(event) {
  if (watchView.hidden) return;
  const playing = event.data === YT.PlayerState.PLAYING;
  $('#player-play').textContent = playing ? '❚❚' : '▶';
  $('#player-play').setAttribute('aria-label',playing ? 'Pause video' : 'Play video');
  if (event.data === YT.PlayerState.ENDED) {
    if (activeVideo) markCompleted(activeVideo.videoId,ytPlayer?.getDuration?.()||0);
    if (!playlistMode && $('#player-autonext').checked && queueIndex < queueVideos.length - 1) {
      selectQueueVideo(queueIndex+1);
      status('Playing the next sermon in this series.');
    } else {
      status('This message has ended. Choose another episode to continue.');
    }
  }
  if (event.data === YT.PlayerState.PLAYING) {
    $('#player-loading').hidden = true;
  }
  updateProgressCopy();
  updatePlayerUI();
}
function updatePlayerUI() {
  if (!youtubeReady || watchView.hidden || !ytPlayer) return;
  let current=0,duration=0;
  try { current=ytPlayer.getCurrentTime() || 0; duration=ytPlayer.getDuration() || 0; }
  catch { return; }
  if (!scrubbing) {
    $('#player-current').textContent = formatTime(current);
    $('#player-seek').value = duration ? Math.round((current/duration)*1000) : '0';
  }
  $('#player-duration').textContent = duration ? formatTime(duration) : '–:––';
  $('#player-seek').disabled = duration <= 0;
  try {
    const muted=ytPlayer.isMuted();
    $('#player-mute').textContent=muted?'◖×':'◖))';
    $('#player-mute').setAttribute('aria-label',muted?'Unmute':'Mute');
    if (!muted) $('#player-volume').value=ytPlayer.getVolume();
  } catch {}
  if (activeVideo && duration > 0 && current > 3) {
    saveProgress(activeVideo.videoId,current,duration);
  }
  updateProgressCopy();
}
function ensureYouTubePlayer() {
  if (youtubeReady) return Promise.resolve();
  if (youtubeInit) return youtubeInit;
  youtubeInit = new Promise((resolve,reject)=>{
    let settled=false;
    const fail = () => {
      if (settled) return;
      settled=true;
      status('Could not load YouTube here. Check your connection or use the YouTube link.');
      $('#player-loading').querySelector('span:last-child').textContent='YouTube could not load. Please use the YouTube link below.';
      reject(new Error('YouTube API not available'));
    };
    const timer=setTimeout(fail,15000);
    const setup=()=>{
      if (settled) return;
      try {
        const options={
          width:'100%',height:'100%',
          playerVars:{playsinline:1,controls:1,rel:0,enablejsapi:1, ...(location.protocol.startsWith('http')?{origin:location.origin}:{})},
          events:{
            onReady:event=>{
              if (settled) return;
              clearTimeout(timer);settled=true;
              ytPlayer=event.target;youtubeReady=true;
              $('#player-loading').hidden=true;
              setPlayerEnabled(true);renderQueue();
              resolve();
            },
            onStateChange:onYTStateChange,
            onAutoplayBlocked:()=>status('Your browser blocked autoplay. Press Play in the YouTube video to begin.'),
            onError:event=>status(event.data===153 ? 'YouTube requires a normal hosted page with a referrer. Open the site through GitHub Pages, not file://.' : 'This video may be unavailable or embedding may be disabled. Use the YouTube link if necessary.')
          }
        };
        ytPlayer = new YT.Player('player-mount',options);
      } catch { clearTimeout(timer);fail(); }
    };
    if (window.YT?.Player) setup();
    else {
      window.onYouTubeIframeAPIReady=setup;
      const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';script.async=true;script.onerror=fail;
      document.head.append(script);
    }
  });
  return youtubeInit;
}
function startWatch(sermon, playlistGroup=null) {
  const isPlaylist=!!playlistGroup && !!playlistGroup.playlistId;
  if (!isPlaylist && !sermon?.videoId) return;
  const nextId=isPlaylist?`playlist:${playlistGroup.id}`:sermon.videoId;
  const currentId=playlistMode?`playlist:${activeSeries?.id}`:activeVideo?.videoId;
  if (nextId===currentId && !watchView.hidden) return;
  saveCurrentTime();
  const session=++pendingSession;
  activeVideo=isPlaylist ? null : sermon;
  playlistMode=isPlaylist;
  activeSeries=isPlaylist ? playlistGroup : findSeriesForSermon(sermon);
  queueVideos=activeSeries ? chronologicalEpisodes(activeSeries).filter(s=>YOUTUBE_ID.test(s.videoId||'')) : (activeVideo?[activeVideo]:[]);
  queueIndex=activeVideo ? Math.max(0,queueVideos.findIndex(v=>v.videoId===activeVideo.videoId)) : -1;
  $('#player-loading').hidden=youtubeReady;
  lastStatus='';status('Loading YouTube…');renderQueue();
  window.scrollTo({top:0,behavior:'instant'});
  ensureYouTubePlayer().then(()=>{if(session===pendingSession && !watchView.hidden)loadActiveVideo();}).catch(()=>{});
}
function openPlayer(sermon, playlistGroup=null) {
  const isPlaylist=!!playlistGroup && !!playlistGroup.playlistId;
  if (!isPlaylist && !YOUTUBE_ID.test(sermon?.videoId||'')) return;
  if (!/^#\/(watch|playlist)\//.test(location.hash))returnHash=location.hash||'#series';
  location.hash=isPlaylist ? `/playlist/${encodeURIComponent(playlistGroup.id)}` : `/watch/${sermon.videoId}`;
}
function openPlaylist(group) {if(group?.playlistId)openPlayer(null,group);}
function closePlayer() {
  const destination=returnHash && !/^#\/(watch|playlist)\//.test(returnHash) ? returnHash
    : activeSeries ? `#/series/${encodeURIComponent(activeSeries.id)}` : '#series';
  location.hash=destination;
}
$('#close-dialog').addEventListener('click',closePlayer);
window.addEventListener('pagehide',saveCurrentTime);
// The page itself is the player; no modal backdrop, Escape trap, or popup state.
$('#player-play').addEventListener('click',()=>{
  if (!youtubeReady) return;
  ytPlayer.getPlayerState()===YT.PlayerState.PLAYING ? ytPlayer.pauseVideo() : ytPlayer.playVideo();
});
$('#player-rewind').addEventListener('click',()=>{if(youtubeReady)ytPlayer.seekTo(Math.max(0,ytPlayer.getCurrentTime()-10),true)});
$('#player-forward').addEventListener('click',()=>{if(youtubeReady)ytPlayer.seekTo(Math.min(ytPlayer.getDuration()||Infinity,ytPlayer.getCurrentTime()+10),true)});
$('#player-prev').addEventListener('click',()=>selectQueueVideo(queueIndex-1));
$('#player-next').addEventListener('click',()=>selectQueueVideo(queueIndex+1));
$('#player-seek').addEventListener('input',event=>{
  scrubbing=true;
  const d=ytPlayer?.getDuration?.()||0;
  $('#player-current').textContent=formatTime(d*Number(event.target.value)/1000);
});
$('#player-seek').addEventListener('change',event=>{
  const d=ytPlayer?.getDuration?.()||0;
  if (youtubeReady && d)ytPlayer.seekTo(d*Number(event.target.value)/1000,true);
  scrubbing=false;
});
$('#player-mute').addEventListener('click',()=>{if(youtubeReady){ytPlayer.isMuted()?ytPlayer.unMute():ytPlayer.mute();updatePlayerUI()}});
$('#player-volume').addEventListener('input',event=>{if(youtubeReady){ytPlayer.setVolume(Number(event.target.value));if(Number(event.target.value)>0)ytPlayer.unMute()}});
$('#player-speed').addEventListener('change',event=>{
  if(!youtubeReady)return;
  ytPlayer.setPlaybackRate(Number(event.target.value));
  setTimeout(()=>{
    const actual=ytPlayer.getPlaybackRate();
    $('#player-speed').value=String(actual);
    if(actual!==Number(event.target.value))status('YouTube does not support the requested speed for this video.');
  },200);
});
$('#player-fullscreen').addEventListener('click',()=>{
  const frame=ytPlayer?.getIframe?.();
  if(frame?.requestFullscreen)frame.requestFullscreen().catch(()=>status('Fullscreen is unavailable in this browser.'));
  else status('Use the fullscreen button inside the YouTube player.');
});
$('#copy-video-link').addEventListener('click',async()=>{
  if(!activeVideo)return;
  try {await navigator.clipboard.writeText(videoUrl(activeVideo.videoId));status('YouTube link copied.');}
  catch {status('Copying is blocked; use the Watch in YouTube link.');}
});
watchView.addEventListener('keydown',event=>{
  if(event.target.closest('input,select,textarea,button,a,iframe'))return;
  if(event.key===' '){event.preventDefault();$('#player-play').click()}
  if(event.key==='ArrowLeft'){event.preventDefault();$('#player-rewind').click()}
  if(event.key==='ArrowRight'){event.preventDefault();$('#player-forward').click()}
});
setInterval(updatePlayerUI,800);

function coverButton(sermon,context='grid'){
  const playable=YOUTUBE_ID.test(sermon.videoId || '');
  const cover=document.createElement(playable?'button':'div');
  cover.className=`sermon-cover ${context}-cover${playable?'':' unlinked-cover'}`;
  if (playable) {cover.type='button';cover.setAttribute('aria-label',`Play: ${sermon.title}`);}
  else cover.setAttribute('title','Add a YouTube URL for this sermon in data/sermons.json');
  addArtwork(cover,imgFor(sermon));
  const fallback=document.createElement('span');fallback.className='cover-art';
  const small=document.createElement('small');small.textContent='HOPE BETHLEHEM';
  const strong=document.createElement('strong');strong.textContent=sermon.series;
  fallback.append(small,strong);cover.append(fallback);
  const play=document.createElement('span');play.className='cover-play';play.setAttribute('aria-hidden','true');play.textContent=playable?'▶':'+';
  cover.append(play);
  if (playable) cover.addEventListener('click',()=>openPlayer(sermon));
  return cover;
}
function sermonCard(sermon,variant='grid'){
  const card=document.createElement('article');card.className=`sermon-card ${variant}-card`;
  card.append(coverButton(sermon,variant));
  const meta=document.createElement('div');meta.className='sermon-meta';
  const label=document.createElement('div');label.className='meta-series';label.textContent=sermon.series;
  const title=document.createElement('h3');title.textContent=readableTitle(sermon.title);
  const bottom=document.createElement('div');bottom.className='meta-bottom';bottom.textContent=[sermon.scripture,naturalDate(sermon.published),sermon.videoId?'':'Awaiting YouTube URL'].filter(Boolean).join(' · ') || 'Sermon recording';
  meta.append(label,title,bottom);addProgress(meta,sermon.videoId);card.append(meta);
  return card;
}
function renderSeries(){
  const rail=$('#series-rail');rail.replaceChildren();
  const groups=getGroups();
  for (const [index,group] of groups.entries()) {
    const button=document.createElement('button');button.className='series-card';button.type='button';
    button.dataset.tone=String(index%5);
    button.setAttribute('aria-label',`Explore ${group.title}, ${group.episodes.length} episodes`);
    addArtwork(button,groupArtwork(group));
    const content=document.createElement('span');content.className='series-inner';
    const tag=document.createElement('span');tag.className='series-kicker';tag.textContent='SERMON SERIES';
    const title=document.createElement('span');title.className='series-title';title.textContent=group.title;
    const count=document.createElement('span');count.className='series-count';
    const watched=group.episodes.filter(s=>progressFor(s.videoId).completed).length;
    count.textContent=`${group.episodes.length} episode${group.episodes.length===1?'':'s'}${watched?' · '+watched+' watched':''}  ·  Explore →`;
    content.append(tag,title,count);button.append(content);
    button.addEventListener('click',()=>{location.hash=`/series/${encodeURIComponent(group.id)}`});
    rail.append(button);
  }
}
function renderContinue() {
  const seen=new Set();
  const resumed=[...sermons].filter(s=>{
    if (!s.videoId || seen.has(s.videoId))return false;
    seen.add(s.videoId);
    const p=progressFor(s.videoId);
    return p.seconds>=3 && !p.completed;
  }).sort((a,b)=>progressFor(b.videoId).updatedAt-progressFor(a.videoId).updatedAt).slice(0,12);
  $('#continue-section').hidden=!resumed.length;
  const rail=$('#continue-rail');rail.replaceChildren();
  resumed.forEach(s=>rail.append(sermonCard(s,'latest')));
}
function renderLatest(){
  const rail=$('#latest-rail');rail.replaceChildren();
  [...sermons].filter(s=>s.videoId).sort(newestFirst).slice(0,12).forEach(s=>rail.append(sermonCard(s,'latest')));
  if (!rail.children.length) {const p=document.createElement('p');p.className='empty-rail';p.textContent='Add a YouTube video URL in data/sermons.json to show playable episodes here.';rail.append(p);}
}
function renderBrowse(){
  const q=clean($('#search').value).toLowerCase();
  const results=[...sermons].sort((a,b)=>-newestFirst(a,b)).filter(s=>[s.title,s.series,s.scripture].join(' ').toLowerCase().includes(q));
  const grid=$('#sermon-grid');grid.replaceChildren();
  for(const s of results)grid.append(sermonCard(s));
  $('#result-count').textContent=`${results.length} message${results.length===1?'':'s'}`;
  $('#empty-state').hidden=results.length>0;
}
function renderFeatured(){
  const groups=getGroups();
  const top=[...sermons].filter(s=>s.videoId).sort(newestFirst)[0];
  featuredSeries=groups.find(g=>g.episodes.includes(top)) || groups[0] || null;
  if (!featuredSeries) return;
  $('#hero-title').textContent=featuredSeries.title;
  $('#hero-description').textContent=featuredSeries.description;
  $('#hero-meta').textContent=`${featuredSeries.episodes.length} catalogued episode${featuredSeries.episodes.length===1?'':'s'} · Hope Alliance Bethlehem`;
  const image=groupArtwork(featuredSeries);
  $('#featured-image').style.backgroundImage=image?`url("${image.replace(/["\\]/g,'')}")`:'';
}
function renderDetail(group){
  currentSeries=group;
  $('#detail-title').textContent=group.title;
  $('#detail-description').textContent=group.description;
  $('#detail-meta').textContent=`Hope Alliance Bethlehem  ·  ${group.episodes.length} episode${group.episodes.length===1?'':'s'}`;
  const finished=group.episodes.filter(s=>progressFor(s.videoId).completed).length;
  $('#series-progress').textContent=finished?`${finished} of ${group.episodes.length} episodes watched on this device`:'';
  const pl=$('#play-youtube-playlist');pl.hidden=!group.playlistId;pl.onclick=()=>openPlaylist(group);
  const firstPlayable=chronologicalEpisodes(group).find(s=>s.videoId);
  $('#play-series-first').disabled=!firstPlayable;
  $('#play-series-first').textContent=firstPlayable?'▶ Play first episode':'No linked episodes yet';
  $('#episode-count').textContent=group.episodes.length;
  const image=groupArtwork(group);
  $('#detail-art').style.backgroundImage=image?`url("${image.replace(/["\\]/g,'')}")`:'';
  const chronological=chronologicalEpisodes(group);
  const resumeEpisode=chronological.find(s=>s.videoId && progressFor(s.videoId).seconds>=3 && !progressFor(s.videoId).completed)
    || chronological.find(s=>s.videoId && !progressFor(s.videoId).completed);
  $('#resume-series').hidden=!resumeEpisode;
  if (resumeEpisode) {
    $('#resume-series').textContent=progressFor(resumeEpisode.videoId).seconds>=3 ? `↻ Resume from ${formatTime(progressFor(resumeEpisode.videoId).seconds)}` : '▶ Continue series';
    $('#resume-series').onclick=()=>openPlayer(resumeEpisode);
  }
  const numberBySermon=new Map(chronological.map((s,i)=>[s.id||s.videoId||s.title,i+1]));
  const sorted=$('#episode-sort').value==='oldest'?chronological:[...chronological].reverse();
  const list=$('#episode-list');list.replaceChildren();
  for (const sermon of sorted) {
    const row=document.createElement('button');row.type='button';row.className='episode-row';
    row.setAttribute('aria-label',`${sermon.videoId?'Play':'Not linked'} episode ${numberBySermon.get(sermon.id||sermon.videoId||sermon.title)}: ${sermon.title}`);
    row.disabled=!sermon.videoId;
    if (!sermon.videoId) row.classList.add('episode-unlinked');
    const episodeNumber=document.createElement('span');episodeNumber.className='episode-number';episodeNumber.textContent=String(numberBySermon.get(sermon.id||sermon.videoId||sermon.title)).padStart(2,'0');
    const still=document.createElement('span');still.className='episode-still';addArtwork(still,imgFor(sermon));
    const stillPlay=document.createElement('span');stillPlay.textContent='▶';stillPlay.className='episode-still-play';still.append(stillPlay);
    const copy=document.createElement('span');copy.className='episode-copy';
    const name=document.createElement('strong');name.textContent=readableTitle(sermon.title);
    const subtitle=document.createElement('span');subtitle.textContent=[sermon.scripture,naturalDate(sermon.published)].filter(Boolean).join('  ·  ') || 'Sermon recording';
    copy.append(name,subtitle);addProgress(copy,sermon.videoId);
    const action=document.createElement('span');action.className='episode-action';action.textContent=sermon.videoId?'Watch  ▶':'Add URL';
    row.append(episodeNumber,still,copy,action);
    row.addEventListener('click',()=>openPlayer(sermon));
    list.append(row);
  }
  $('#play-series-first').onclick=()=>{if(firstPlayable)openPlayer(firstPlayable)};
  $('#detail-footnote').textContent=group.episodes.some(s=>!s.videoId)
    ? 'Some episodes have no YouTube URL yet. Add them to data/sermons.json to enable playback.'
    : group.playlistId?'You can watch individual episodes or play the complete YouTube playlist.':'Episodes play here through YouTube.';
}
function renderRoute(){
  let decoded='';
  try {decoded=decodeURIComponent(location.hash);} catch {decoded='';}
  const seriesMatch=decoded.match(/^#\/series\/([a-z0-9-]+)$/);
  const watchMatch=decoded.match(/^#\/watch\/([A-Za-z0-9_-]{11})$/);
  const playlistMatch=decoded.match(/^#\/playlist\/([a-z0-9-]+)$/);
  const group=seriesMatch && getGroups().find(g=>g.id===seriesMatch[1]);
  const watchSermon=watchMatch && sermons.find(s=>s.videoId===watchMatch[1]);
  const playlistGroup=playlistMatch && getGroups().find(g=>g.id===playlistMatch[1] && g.playlistId);
  const watching=!!(watchSermon || playlistGroup);
  const wasWatching=!watchView.hidden;
  if(wasWatching && !watching){
    saveCurrentTime();
    pendingSession++;
    try{ytPlayer?.pauseVideo?.();}catch{}
    // Clear active video only after recording its progress.
    activeVideo=null;activeSeries=null;playlistMode=false;
    renderContinue();renderSeries();renderBrowse();renderLatest();
  }
  watchView.hidden=!watching;
  document.body.classList.toggle('watching',watching);
  $('#home-view').hidden=watching||!!group;
  $('#series-detail').hidden=watching||!group;
  if(watching){
    startWatch(watchSermon||null,playlistGroup||null);
    return;
  }
  if(group){
    renderDetail(group);
    window.scrollTo({top:0,behavior:'instant'});
  } else {
    currentSeries=null;
    if(/^#(top|series|latest|browse)$/.test(location.hash))
      requestAnimationFrame(()=>document.getElementById(location.hash.slice(1))?.scrollIntoView());
  }
}
function renderAll(){renderFeatured();renderSeries();renderContinue();renderLatest();renderBrowse();renderRoute()}

$('#featured-explore').addEventListener('click',()=>{if(featuredSeries)location.hash=`/series/${encodeURIComponent(featuredSeries.id)}`});
$('#watch-latest').addEventListener('click',()=>{const latest=[...sermons].filter(s=>s.videoId).sort(newestFirst)[0];if(latest)openPlayer(latest)});
$('#search').addEventListener('input',renderBrowse);
$('#episode-sort').addEventListener('change',()=>{if(currentSeries)renderDetail(currentSeries)});
window.addEventListener('hashchange',renderRoute);
for(const arrow of document.querySelectorAll('.rail-arrow')){
  arrow.addEventListener('click',()=>{
    const rail=document.getElementById(arrow.dataset.rail);
    const distance=rail.clientWidth*0.78*Number(arrow.dataset.direction);
    rail.scrollBy({left:distance,behavior:'smooth'});
  });
}
renderAll();

(async function loadCatalog(){
  try {
    const response=await fetch('data/series.json',{cache:'no-store'});
    if (response.ok) {
      const values=await response.json();
      if (Array.isArray(values) && values.length) configs=values.filter(c=>c&&c.id&&c.title).map(c=>({
        ...c,playlistId:parsePlaylistId(c.playlistUrl||'') || (/^[A-Za-z0-9_-]{12,}$/.test(c.playlistId||'')?c.playlistId:'')
      }));
    }
  } catch { /* Local file:// previews may restrict file access. */ }
  try {
    const response=await fetch('data/sermons.json',{cache:'no-store'});
    if (!response.ok) throw new Error('Unable to load data/sermons.json');
    const items=await response.json();
    if (!Array.isArray(items)) throw new Error('Expected an array of sermons');
    sermons=items.filter(s=>s&&s.title).map((s,i)=>{
      const id=parseVideoId(s.url||s.videoUrl||s.videoId||'');
      const cfg=configs.find(c=>c.id===s.seriesId);
      return {
        id:id||`unlinked-${i}`,videoId:id,title:clean(s.title),
        seriesId:clean(s.seriesId),series:cfg?.title||clean(s.series)||'Other Messages',
        scripture:clean(s.scripture),published:clean(s.published||s.date),
        episodeNumber:Number.isInteger(s.episodeNumber)?s.episodeNumber:null,_order:i
      };
    });
    const linked=sermons.filter(s=>s.videoId).length;
    $('#sync-note').textContent=`Sermon catalog · ${linked} playable of ${sermons.length} messages`;
  } catch (error) {
    sermons=[];
    $('#sync-note').textContent='Catalog unavailable · Serve the files through GitHub Pages or localhost';
    console.warn(error);
  }
  $('#watch-latest').disabled=!sermons.some(s=>s.videoId);
  renderAll();
})();
