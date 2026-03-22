/* ============================================================
   AL GRANO — app.js  (reescrito limpio)
   Push-to-talk · NLP español · IndexedDB · Voces del sistema
   ============================================================ */
'use strict';

/* ── Service Worker ─────────────────────────────────────── */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js')
    .then(r => console.log('[SW] ok:', r.scope))
    .catch(e => console.warn('[SW] error:', e));
}

/* ============================================================
   CONFIG
   ============================================================ */
const CONFIRM_YES = ['sí','si','vale','correcto','ok','afirmativo',
                     'guardar','adelante','perfecto','claro','venga','bueno'];
const CONFIRM_NO  = ['no','cancelar','borrar','descartar','olvida'];

const TIME_BLOCKS = {
  manana: '09:00', mañana: '09:00',
  tarde:  '16:00',
  noche:  '21:00',
  mediodia:'13:00', mediodía:'13:00',
};

/* ============================================================
   IndexedDB
   ============================================================ */
const DB = (() => {
  let db = null;
  const open = () => new Promise((ok, fail) => {
    if (db) return ok(db);
    const r = indexedDB.open('algrano', 2);
    r.onupgradeneeded = e => {
      if (!e.target.result.objectStoreNames.contains('eventos'))
        e.target.result.createObjectStore('eventos', { keyPath: 'id' });
    };
    r.onsuccess = e => { db = e.target.result; ok(db); };
    r.onerror   = e => fail(e.target.error);
  });
  const add    = async ev  => { const d = await open(); return new Promise((ok,fail) => { const t = d.transaction('eventos','readwrite'); t.objectStore('eventos').add(ev).onsuccess = ok; t.onerror = fail; }); };
  const getAll = async ()  => { const d = await open(); return new Promise((ok,fail) => { const r = d.transaction('eventos','readonly').objectStore('eventos').getAll(); r.onsuccess = () => ok(r.result); r.onerror = fail; }); };
  const del    = async id  => { const d = await open(); return new Promise((ok,fail) => { const t = d.transaction('eventos','readwrite'); t.objectStore('eventos').delete(id).onsuccess = ok; t.onerror = fail; }); };
  return { open, add, getAll, del };
})();

/* ============================================================
   NLP — parser español basado en reglas
   ============================================================ */
const NLP = (() => {
  const n = t => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[¿¡]/g,'').trim();

  const parseDate = s => {
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    if (/\bhoy\b/.test(s))           return new Date(hoy);
    if (/\bpasado manana\b/.test(s)) return ad(hoy,2);
    if (/\bmanana\b/.test(s))        return ad(hoy,1);
    const dd = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
    const m  = new RegExp(`\\b(${dd.join('|')})\\b`).exec(s);
    if (m) { let d = dd.indexOf(m[1]) - new Date().getDay(); if(d<=0)d+=7; return ad(hoy,d); }
    const mf = /\bel (?:dia )?(\d{1,2})(?:\s+de\s+(\w+))?\b/.exec(s);
    if (mf) {
      const meses=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
      let mes = hoy.getMonth();
      if (mf[2]) { const i=meses.indexOf(mf[2]); if(i>=0)mes=i; }
      const r = new Date(hoy.getFullYear(), mes, parseInt(mf[1]));
      if (r < hoy) r.setFullYear(r.getFullYear()+1);
      return r;
    }
    return null;
  };

  const parseTime = s => {
    for (const [b,t] of Object.entries(TIME_BLOCKS)) {
      if (s.includes(`por la ${b}`) || s.includes(`esta ${b}`) || s.includes(`de ${b}`))
        return { time:t, block:b };
    }
    const nums={una:'01',dos:'02',tres:'03',cuatro:'04',cinco:'05',seis:'06',siete:'07',ocho:'08',nueve:'09',diez:'10',once:'11',doce:'12',trece:'13',catorce:'14',quince:'15',dieciseis:'16',diecisiete:'17',dieciocho:'18',diecinueve:'19',veinte:'20',veintiuna:'21',veintidos:'22',veintitres:'23'};
    const mins={'y cuarto':'15','y media':'30','menos cuarto':'45'};
    for (const [esc,num] of Object.entries(nums)) {
      if (new RegExp(`\\ba las ${esc}\\b`).test(s)) {
        let m='00';
        for (const [me,mv] of Object.entries(mins)) { if(s.includes(`${esc} ${me}`)){m=mv;break;} }
        let h=parseInt(num); if(h<8&&!s.includes('manana'))h+=12;
        return { time:`${String(h).padStart(2,'0')}:${m}`, block:null };
      }
    }
    const mh = /\b(?:a las?|las?)?\s*(\d{1,2})(?::(\d{2}))?\b/.exec(s);
    if (mh) {
      let h=parseInt(mh[1]), m=mh[2]?parseInt(mh[2]):0;
      if(h>=1&&h<8)h+=12;
      if(h<24&&m<60) return { time:`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`, block:null };
    }
    for (const [b,t] of Object.entries(TIME_BLOCKS)) { if(s.includes(b)) return {time:t,block:b}; }
    return null;
  };

  const parseReminders = s => {
    const rs=[];
    let m;
    const r1=/(?:avisame?|recuerdame?|aviso|alarma)\s+(?:una?\s+)?(\d+|media)\s+minuto/g;
    while((m=r1.exec(s))!==null) rs.push(m[1]==='media'?30:parseInt(m[1])||0);
    const r2=/(?:avisame?|recuerdame?|aviso|alarma)\s+(una?|\d+)\s+hora/g;
    while((m=r2.exec(s))!==null) rs.push(m[1]==='una'?60:(parseInt(m[1])||1)*60);
    if(/\b15 minutos antes\b/.test(s)&&!rs.includes(15)) rs.push(15);
    if(/\bmedia hora antes\b/.test(s)&&!rs.includes(30))  rs.push(30);
    if(/\buna hora antes\b/.test(s)&&!rs.includes(60))    rs.push(60);
    return [...new Set(rs)];
  };

  const parseRepeat = s => {
    if(/todos los dias|cada dia/.test(s))      return 'Todos los días';
    if(/todas las semanas|cada semana/.test(s)) return 'Cada semana';
    const dd=['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
    const ds=['domingos','lunes','martes','miércoles','jueves','viernes','sábados'];
    const m=new RegExp(`cada (${dd.join('|')})`).exec(s);
    if(m) return `Cada ${ds[dd.indexOf(m[1])]}`;
    return null;
  };

  const extractTitle = text => {
    let t = text;
    [/\bhoy\b/gi,/\bmanana\b/gi,/\bpasado manana\b/gi,
     /\best[ao]?\s+(manana|tarde|noche|mediod[ií]a)\b/gi,
     /\bpor la (manana|tarde|noche)\b/gi,/\bde la (manana|tarde|noche)\b/gi,
     /\ba las? \d{1,2}(?::\d{2})?\b/gi,/\bel (?:dia )?\d{1,2}(?:\s+de \w+)?\b/gi,
     /\b(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/gi,
     /\b(?:avisame?|recuerdame?|aviso|alarma)\b.*?\b(?:antes|hora|minuto)\b/gi,
     /\btodos los dias\b|\bcada \w+\b/gi,/\bluego\b|\bmas tarde\b|\bdespues\b/gi,
     /\ba las (?:una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)[^,.]*/gi,
     /[¿¡]/g
    ].forEach(r => { t = t.replace(r,' '); });
    t = t.replace(/\s+/g,' ').trim().replace(/^(?:y|de|el|la|un|una|con|para|que)\s+/i,'');
    return (t.charAt(0).toUpperCase()+t.slice(1)) || 'Evento';
  };

  const parse = text => {
    const s    = n(text);
    const fecha = parseDate(s);
    const hora  = parseTime(s);
    const hoy   = new Date(); hoy.setHours(0,0,0,0);
    return {
      id:        `ev_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      title:     extractTitle(text),
      date:      (fecha||hoy).toISOString().split('T')[0],
      time:      hora?.time  ?? null,
      block:     hora?.block ?? null,
      reminders: parseReminders(s),
      repeat:    parseRepeat(s),
      status:    (!fecha&&!hora) ? 'pending' : 'scheduled',
      createdAt: Date.now(),
      raw:       text,
    };
  };

  const humanDate = iso => {
    const d=new Date(iso+'T12:00:00'), hoy=new Date(); hoy.setHours(12,0,0,0);
    const man=new Date(hoy); man.setDate(man.getDate()+1);
    if(d.toDateString()===hoy.toDateString()) return 'hoy';
    if(d.toDateString()===man.toDateString()) return 'mañana';
    const DD=['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    const MM=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    return `el ${DD[d.getDay()]} ${d.getDate()} de ${MM[d.getMonth()]}`;
  };

  const toSpeech = ev => {
    const parts=[ev.title, humanDate(ev.date)];
    if(ev.time)  parts.push(`a las ${ev.time}`);
    else if(ev.block) parts.push(`por la ${ev.block}`);
    if(ev.reminders.length) parts.push(`aviso ${ev.reminders.map(r=>r>=60?`${r/60} hora${r>60?'s':''}` :`${r} minutos`).join(' y ')} antes`);
    if(ev.repeat) parts.push(ev.repeat);
    return parts.join(', ') + '. ¿Lo guardo?';
  };

  const ad = (d,n) => { const r=new Date(d); r.setDate(r.getDate()+n); return r; };
  return { parse, humanDate, toSpeech, norm:n };
})();

/* ============================================================
   SÍNTESIS DE VOZ
   ============================================================ */
const Voice = (() => {
  let voices  = [];
  let selName = localStorage.getItem('ag-voice') || '';
  let cfg     = JSON.parse(localStorage.getItem('ag-vcfg') || '{"rate":0.88,"pitch":1.05}');

  const loadVoices = () => { voices = speechSynthesis.getVoices(); return voices; };
  if (window.speechSynthesis) {
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
  }

  const rank = v => {
    const nm = v.name.toLowerCase(), lg = v.lang.toLowerCase();
    if (!lg.startsWith('es')) return -1;
    let s = 0;
    if (nm.includes('neural')||nm.includes('natural')) s+=100;
    if (nm.includes('google'))    s+=80;
    if (nm.includes('premium')||nm.includes('enhanced')) s+=70;
    if (nm.includes('monica'))    s+=60;
    if (nm.includes('paulina'))   s+=60;
    if (nm.includes('jorge'))     s+=55;
    if (nm.includes('marisol'))   s+=55;
    if (nm.includes('lucia'))     s+=50;
    if (nm.includes('diego'))     s+=50;
    if (lg==='es-es')             s+=10;
    if (v.localService)           s+=5;
    return s;
  };

  const best = () => {
    const vv = loadVoices();
    if (selName) { const f=vv.find(v=>v.name===selName); if(f) return f; }
    const sp = vv.filter(v=>v.lang.toLowerCase().startsWith('es'));
    return sp.sort((a,b)=>rank(b)-rank(a))[0] || vv[0] || null;
  };

  const speak = (text, cb) => {
    if (!window.speechSynthesis) { cb&&cb(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'es-ES'; u.rate = cfg.rate; u.pitch = cfg.pitch; u.volume = 1;
    const v = best(); if(v) u.voice = v;
    console.log('[Voice]', v?.name, 'rate='+u.rate, 'pitch='+u.pitch);
    // Workaround Chrome bug: speechSynthesis se pausa sola en pestañas largas
    const timer = setInterval(()=>{ if(speechSynthesis.paused) speechSynthesis.resume(); }, 5000);
    u.onend = u.onerror = () => { clearInterval(timer); cb&&cb(); };
    speechSynthesis.speak(u);
  };

  const cancel    = ()      => { speechSynthesis.cancel?.(); };
  const listES    = ()      => loadVoices().filter(v=>v.lang.toLowerCase().startsWith('es')).sort((a,b)=>rank(b)-rank(a));
  const selectV   = name    => { selName=name; localStorage.setItem('ag-voice',name); };
  const setParams = p       => { cfg={...cfg,...p}; localStorage.setItem('ag-vcfg',JSON.stringify(cfg)); };
  const getParams = ()      => ({...cfg});
  const getBest   = ()      => best()?.name||'';

  return { speak, cancel, listES, selectV, setParams, getParams, getBest, loadVoices };
})();

/* ============================================================
   RECONOCIMIENTO DE VOZ — Push-to-talk
   MediaRecorder graba mientras el botón está pulsado.
   Al soltar, el audio se envía a Groq Whisper para transcribir.
   Funciona en Chrome, Safari, Firefox, Chrome Android, sin excepciones.
   ============================================================ */
const SR = (() => {
  const GROQ_KEY    = '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';
  const GROQ_URL    = 'https://api.groq.com/openai/v1/audio/transcriptions';
  const GROQ_MODEL  = 'whisper-large-v3-turbo';  // más rápido y gratuito

  let mediaRec   = null;
  let chunks     = [];
  let active     = false;
  let cbFinal    = null;
  let cbErr      = null;
  let stream     = null;

  /* ── Iniciar grabación (push) ── */
  const start = (onFinal, onErr) => {
    cbFinal = onFinal;
    cbErr   = onErr;
    chunks  = [];
    active  = false;

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(s => {
        stream = s;
        active = true;

        // Elegir el formato más compatible
        const mimeType = [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/ogg;codecs=opus',
          'audio/mp4',
        ].find(t => MediaRecorder.isTypeSupported(t)) || '';

        mediaRec = new MediaRecorder(stream, mimeType ? { mimeType } : {});

        mediaRec.ondataavailable = e => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };

        mediaRec.onstop = async () => {
          // Liberar micrófono
          stream.getTracks().forEach(t => t.stop());
          stream = null;

          if (chunks.length === 0) { cbErr?.('no-speech'); return; }

          const blob = new Blob(chunks, { type: mediaRec.mimeType || 'audio/webm' });
          console.log('[SR] grabación terminada, tamaño:', blob.size, 'bytes, tipo:', blob.type);

          if (blob.size < 1000) { cbErr?.('no-speech'); return; }

          await transcribe(blob);
        };

        mediaRec.start(100);  // chunk cada 100ms
        console.log('[SR] grabando con MediaRecorder…');
      })
      .catch(err => {
        console.error('[SR] getUserMedia error:', err.name);
        active = false;
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          cbErr?.('not-allowed');
        } else {
          cbErr?.(err.name);
        }
      });
  };

  /* ── Parar grabación (release) → enviar a Whisper ── */
  const stop = () => {
    if (mediaRec && active && mediaRec.state === 'recording') {
      active = false;
      mediaRec.stop();  // dispara onstop → transcribe()
    } else {
      active = false;
      cbErr?.('no-speech');
    }
  };

  /* ── Abortar sin procesar ── */
  const abort = () => {
    active = false;
    if (mediaRec && mediaRec.state === 'recording') {
      mediaRec.ondataavailable = null;
      mediaRec.onstop = null;
      mediaRec.stop();
    }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    chunks = [];
  };

  /* ── Transcribir con Groq Whisper ── */
  const transcribe = async blob => {
    try {
      console.log('[SR] enviando a Groq Whisper…');
      const statusEl = document.getElementById('statusLabel');
      if (statusEl) statusEl.textContent = 'Transcribiendo…';

      const form = new FormData();
      // Whisper necesita extensión en el nombre del fichero
      const ext  = blob.type.includes('ogg') ? 'ogg'
                 : blob.type.includes('mp4') ? 'mp4' : 'webm';
      form.append('file',     new File([blob], `audio.${ext}`, { type: blob.type }));
      form.append('model',    GROQ_MODEL);
      form.append('language', 'es');
      form.append('response_format', 'json');

      const res = await fetch(GROQ_URL, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${GROQ_KEY}` },
        body:    form,
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error('[SR] Groq error:', res.status, errText);
        cbErr?.('groq-error');
        return;
      }

      const data = await res.json();
      const text = data?.text?.trim();
      console.log('[SR] Whisper resultado:', text);

      if (text) cbFinal?.(text);
      else      cbErr?.('no-speech');

    } catch(e) {
      console.error('[SR] fetch error:', e);
      cbErr?.('network');
    }
  };

  const isOn = () => active;
  return { start, stop, abort, isOn };
})();

/* ============================================================
   NOTIFICACIONES
   ============================================================ */
const Notif = (() => {
  const req = () => { if('Notification'in window && Notification.permission==='default') Notification.requestPermission(); };
  const sch = ev => {
    if(!ev.time||!ev.reminders.length) return;
    if(!('Notification'in window)||Notification.permission!=='granted') return;
    const d = new Date(`${ev.date}T${ev.time}:00`);
    ev.reminders.forEach(m => {
      const delay = d.getTime() - m*60000 - Date.now();
      if(delay>0&&delay<86400000) setTimeout(()=>new Notification(`⏰ ${ev.title}`,{body:`En ${m} minutos`,icon:'./icons/icon-192.png'}), delay);
    });
  };
  return { req, sch };
})();

/* ============================================================
   UI — helpers
   ============================================================ */
const UI = (() => {
  const $ = id => document.getElementById(id);

  const toast = (msg, type='inf', ms=3200) => {
    const el=document.createElement('div'); el.className=`toast ${type}`; el.textContent=msg;
    $('toasts').appendChild(el); setTimeout(()=>el.remove(), ms);
  };

  const setMode = mode => {
    const btn   = $('micBtn');
    const label = $('statusLabel');
    btn.classList.remove('listening','processing','pressed');
    label.classList.remove('listening');
    switch(mode) {
      case 'idle':
        label.textContent='Mantén pulsado para hablar';
        $('transcriptText').textContent='';
        $('confirmCard').hidden=true;
        break;
      case 'listening':
        label.textContent='Suelta cuando termines…';
        label.classList.add('listening');
        btn.classList.add('listening','pressed');
        $('confirmCard').hidden=true;
        break;
      case 'processing':
        label.textContent='Procesando…';
        btn.classList.add('processing');
        break;
      case 'confirming':
        label.textContent='Mantén pulsado para responder';
        label.classList.add('listening');
        $('confirmCard').hidden=false;
        break;
    }
  };

  const showConfirm = ev => {
    const date = NLP.humanDate(ev.date);
    const time = ev.time ? `<strong>${ev.time}</strong>`
               : ev.block ? `por la <strong>${ev.block}</strong>`
               : '<small>sin hora</small>';
    const rem = ev.reminders.length
      ? `<br><small>🔔 ${ev.reminders.map(r=>r>=60?`${r/60}h`:`${r}min`).join(', ')} antes</small>` : '';
    const rep = ev.repeat ? `<br><small>🔁 ${ev.repeat}</small>` : '';
    $('confirmPreview').innerHTML = `<strong>${ev.title}</strong><br>${date} ${time}${rem}${rep}`;
  };

  return { toast, setMode, showConfirm };
})();

/* ============================================================
   PANEL DE EVENTOS
   ============================================================ */
const Panel = (() => {
  const $ = id => document.getElementById(id);
  let filter = 'hoy';
  const ad = (d,n) => { const r=new Date(d); r.setDate(r.getDate()+n); return r; };

  const open  = () => { $('panel').classList.add('open');  $('overlay').classList.add('on');      render(); };
  const close = () => { $('panel').classList.remove('open'); $('overlay').classList.remove('on'); };

  const render = async () => {
    const all  = await DB.getAll();
    const hoy  = new Date(); hoy.setHours(0,0,0,0);
    const ts   = hoy.toISOString().split('T')[0];
    const tm   = ad(hoy,1).toISOString().split('T')[0];
    const tw   = ad(hoy,7).toISOString().split('T')[0];

    const evs = all.filter(e => {
      if(filter==='hoy')        return e.date===ts && e.status!=='pending';
      if(filter==='mañana')     return e.date===tm;
      if(filter==='semana')     return e.date>=ts && e.date<=tw;
      if(filter==='pendientes') return e.status==='pending';
      return true;
    }).sort((a,b)=>(a.date+(a.time||'99:99')).localeCompare(b.date+(b.time||'99:99')));

    const list = $('eventsList');
    if (!evs.length) { list.innerHTML='<p class="empty-state">Nada aquí.<br>Pulsa el micrófono y habla.</p>'; return; }

    const groups={};
    evs.forEach(e=>{ const k=e.status==='pending'?'Pendientes':NLP.humanDate(e.date); (groups[k]=groups[k]||[]).push(e); });
    list.innerHTML='';

    for (const [day,items] of Object.entries(groups)) {
      const g=document.createElement('div'); g.className='day-group';
      g.innerHTML=`<p class="day-label">${day}</p>`;
      items.forEach(ev=>{
        const meta=[ev.reminders.length?`🔔 ${ev.reminders.join(',')}min`:'', ev.repeat?`🔁 ${ev.repeat}`:''].filter(Boolean).join(' · ');
        const d=document.createElement('div'); d.className=`ev-item${ev.status==='pending'?' pending':''}`;
        d.innerHTML=`
          <div class="ev-time ${!ev.time?'no-t':''}">${ev.time||'—'}</div>
          <div class="ev-info">
            <div class="ev-title">${ev.title}</div>
            ${meta?`<div class="ev-meta">${meta}</div>`:''}
          </div>
          <button class="ev-del" data-id="${ev.id}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
              <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
            </svg>
          </button>`;
        d.querySelector('.ev-del').addEventListener('click', async e=>{
          await DB.del(e.currentTarget.dataset.id); render(); UI.toast('Eliminado','inf');
        });
        g.appendChild(d);
      });
      list.appendChild(g);
    }
  };

  const init = () => {
    $('btnPanel').addEventListener('click', open);
    $('btnClose').addEventListener('click', close);
    $('overlay').addEventListener('click', close);
    $('tabs').querySelectorAll('.tab').forEach(t=>{
      t.addEventListener('click', ()=>{
        $('tabs').querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
        t.classList.add('active'); filter=t.dataset.f; render();
      });
    });
  };

  return { init, render };
})();

/* ============================================================
   AJUSTES DE VOZ
   ============================================================ */
const VoiceSettings = (() => {
  const $ = id => document.getElementById(id);

  const open = () => {
    $('voiceModal').classList.add('open');
    $('overlayVoice').classList.add('on');
    populate();
  };
  const close = () => {
    $('voiceModal').classList.remove('open');
    $('overlayVoice').classList.remove('on');
  };

  const populate = () => {
    const voices = Voice.listES();
    const sel    = $('voiceSelect');
    const best   = Voice.getBest();
    const prm    = Voice.getParams();

    sel.innerHTML = voices.length
      ? voices.map(v=>`<option value="${v.name}" ${v.name===best?'selected':''}>${v.name}${v.name===best?' ★':''} (${v.lang})</option>`).join('')
      : '<option value="">No hay voces en español instaladas</option>';

    sel.onchange = () => Voice.selectV(sel.value);

    const rr = $('rateRange'),  pr = $('pitchRange');
    const rv = $('rateVal'),    pv = $('pitchVal');
    rr.value = prm.rate;  rv.textContent = prm.rate.toFixed(2);
    pr.value = prm.pitch; pv.textContent = prm.pitch.toFixed(2);
    rr.oninput = () => { Voice.setParams({rate:parseFloat(rr.value)});  rv.textContent=parseFloat(rr.value).toFixed(2); };
    pr.oninput = () => { Voice.setParams({pitch:parseFloat(pr.value)}); pv.textContent=parseFloat(pr.value).toFixed(2); };
  };

  const init = () => {
    $('btnVoiceSettings').addEventListener('click', open);
    $('btnCloseVoice').addEventListener('click',   close);
    $('overlayVoice').addEventListener('click',    close);
    $('btnTestVoice').addEventListener('click', ()=>{
      Voice.selectV($('voiceSelect').value);
      Voice.cancel();
      Voice.speak('Hola, esto es Al Grano. ¿Cómo suena esta voz?');
    });
  };

  return { init };
})();

/* ============================================================
   APP — orquestador push-to-talk
   ============================================================ */
const App = (() => {
  let mode     = 'idle';
  let pending  = null;
  let phase    = 'event';   // 'event' | 'confirm'
  let pressing = false;

  const setMode = m => { mode = m; UI.setMode(m); };

  /* ── PRESS (inicio grabación) ── */
  const onPress = e => {
    e.preventDefault();
    if (pressing) return;
    pressing = true;

    if (!SR) { UI.toast('Reconocimiento de voz no disponible','err',5000); return; }

    Voice.cancel();
    phase = (mode === 'confirming') ? 'confirm' : 'event';
    setMode('listening');

    SR.start(
      // onFinal — se llama desde onend tras stop()
      text => {
        pressing = false;
        if (phase === 'confirm') processConfirm(text);
        else                     processEvent(text);
      },
      // onErr
      err => {
        pressing = false;
        console.log('[App] SR err:', err);
        if      (err === 'not-allowed') UI.toast('Permiso de micrófono denegado. Ve a ajustes del navegador.','err',7000);
        else if (err === 'network')     UI.toast('Sin conexión. Necesitas internet para el reconocimiento de voz.','err',6000);
        else if (err === 'groq-error')  UI.toast('Error en el servidor de voz. Inténtalo de nuevo.','err',4000);
        else if (err === 'no-speech')   { /* silencioso — no habló nada */ }
        else                            UI.toast(`Error: ${err}`,'err',4000);
        setMode(phase==='confirm' ? 'confirming' : 'idle');
      }
    );
  };

  /* ── RELEASE (fin grabación) ── */
  const onRelease = e => {
    e.preventDefault();
    if (!pressing) return;
    // pressing se pone false en los callbacks de SR (onFinal/onErr)
    // Aquí solo paramos la grabación
    if (SR?.isOn()) {
      setMode('processing');
      SR.stop();
    } else {
      pressing = false;
    }
  };

  /* ── Procesar frase del evento ── */
  const processEvent = text => {
    setMode('processing');
    pending = NLP.parse(text);
    setTimeout(() => {
      UI.showConfirm(pending);
      setMode('confirming');
      Voice.speak(NLP.toSpeech(pending));
    }, 150);
  };

  /* ── Procesar confirmación ── */
  const processConfirm = text => {
    const s = NLP.norm(text);
    console.log('[App] confirm:', s);
    if      (CONFIRM_YES.some(w=>s.includes(w))) saveEvent();
    else if (CONFIRM_NO.some(w=>s.includes(w)))  cancelEvent();
    else { UI.toast('Di "sí" para guardar o "no" para cancelar','inf'); setMode('confirming'); }
  };

  /* ── Guardar ── */
  const saveEvent = async () => {
    Voice.cancel(); SR?.abort();
    if (!pending) { setMode('idle'); return; }
    try {
      await DB.add(pending);
      Notif.sch(pending);
      UI.toast(`✓ ${pending.title} guardado`,'ok');
      Voice.speak(`Guardado. ${pending.title}.`);
      pending = null;
      setMode('idle');
    } catch(e) { console.error(e); UI.toast('Error al guardar','err'); setMode('idle'); }
  };

  /* ── Cancelar ── */
  const cancelEvent = () => {
    Voice.cancel(); SR?.abort();
    pending = null; pressing = false;
    setMode('idle');
    Voice.speak('Cancelado.');
    UI.toast('Cancelado','inf');
  };

  /* ── Texto fallback ── */
  const submitText = () => {
    const val = document.getElementById('textInput').value.trim();
    if (!val) return;
    document.getElementById('textInput').value = '';
    document.getElementById('transcriptText').textContent = val;
    if (mode === 'confirming') processConfirm(val);
    else                       processEvent(val);
  };

  /* ── INIT ── */
  const init = async () => {
    await DB.open();
    Panel.init();
    VoiceSettings.init();
    Notif.req();

    const btn = document.getElementById('micBtn');

    // Touch (móvil): passive:false para poder preventDefault
    btn.addEventListener('touchstart',  onPress,   { passive:false });
    btn.addEventListener('touchend',    onRelease, { passive:false });
    btn.addEventListener('touchcancel', onRelease, { passive:false });

    // Mouse (escritorio)
    btn.addEventListener('mousedown', onPress);
    btn.addEventListener('mouseup',   onRelease);
    // Si el ratón sale del botón mientras está pulsado
    btn.addEventListener('mouseleave', e => { if(pressing) onRelease(e); });

    // Teclado: Espacio
    document.addEventListener('keydown', e => {
      if (e.code==='Space' && !e.repeat && e.target===document.body) onPress(e);
    });
    document.addEventListener('keyup', e => {
      if (e.code==='Space' && e.target===document.body) onRelease(e);
    });

    // Botones confirmación manual
    document.getElementById('btnYes').addEventListener('click', saveEvent);
    document.getElementById('btnNo').addEventListener('click',  cancelEvent);

    // Input texto
    document.getElementById('btnSend').addEventListener('click', submitText);
    document.getElementById('textInput').addEventListener('keydown', e => {
      if (e.key==='Enter') { e.preventDefault(); submitText(); }
    });

    if (!SR) document.getElementById('statusLabel').textContent = 'Escribe tu evento abajo';

    console.log('[App] listo ✓ — push-to-talk activo');
  };

  return { init, saveEvent, cancelEvent };
})();

/* ── Arrancar ── */
document.addEventListener('DOMContentLoaded', App.init);
