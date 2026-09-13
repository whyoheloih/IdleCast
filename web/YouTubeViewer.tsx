import {useEffect,useState} from "react";

export function YouTubeViewer({videoId,onSaved}:{videoId:string;onSaved:(id:string)=>void}) {
  const [link,setLink]=useState(videoId ? 'https://www.youtube.com/watch?v='+videoId : '');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [visible,setVisible]=useState(true),[revision,setRevision]=useState(0);
  useEffect(()=>{setLink(videoId ? 'https://www.youtube.com/watch?v='+videoId : '');},[videoId]);
  async function save() {
    setBusy(true);setError('');setNotice('');
    try {
      const r=await fetch('/api/viewer',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({youtubeWatchId:link})});
      const data=await r.json();if(!r.ok)throw Error(data.error);
      onSaved(data.youtubeWatchId);setVisible(true);setRevision(n=>n+1);setNotice(data.youtubeWatchId?'Viewer link saved.':'Viewer link removed.');
    } catch(e){setError(e instanceof Error?e.message:'Could not save viewer link');} finally{setBusy(false);}
  }
  const valid=/^[A-Za-z0-9_-]{11}$/.test(videoId);
  const embed=valid?'https://www.youtube-nocookie.com/embed/'+videoId+'?autoplay=1&mute=1&playsinline=1&rel=0&origin='+encodeURIComponent(window.location.origin):'';
  return <section className="panel youtube-viewer" aria-label="YouTube live preview">
    <div className="panel-heading"><h2>YouTube live preview</h2>{valid&&<div className="viewer-actions"><button type="button" onClick={()=>setVisible(v=>!v)}>{visible?'Hide player':'Show player'}</button><button type="button" onClick={()=>{setRevision(n=>n+1);setVisible(true);}}>Reload player</button><a href={'https://www.youtube.com/watch?v='+videoId} target="_blank" rel="noopener noreferrer">Open on YouTube ↗</a></div>}</div>
    {valid&&visible&&<iframe key={videoId+':'+revision} title="YouTube broadcast viewer" src={embed} allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />}
    <div className="viewer-setup">
      <p className="hint">Watch the broadcast YouTube viewers receive, including YouTube's delay. Starts muted; use the player controls for audio. This player is independent of IdleCast's broadcast controls.</p>
      <form onSubmit={e=>{e.preventDefault();void save();}}><label>YouTube broadcast watch link<input type="text" value={link} onChange={e=>setLink(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" autoComplete="off" /></label><button type="submit" className="primary" disabled={busy}>{busy?'Saving…':'Save viewer link'}</button></form>
      <p className="hint">Copy the broadcast's watch/share link from YouTube Studio. You can update it while live. If YouTube says playback is unavailable, check that the broadcast allows embedding or use Open on YouTube.</p>
      {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    </div>
  </section>;
}
