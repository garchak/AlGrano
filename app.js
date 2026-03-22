/* ============================================================
   AL GRANO — app.js
   Voz → NLP → Google Calendar + IndexedDB
   ============================================================ */
'use strict';

/* ── Service Worker ── */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js')
    .catch(e => console.warn('[SW]', e));
}

/* ============================================================
   CONFIG
   ============================================================ */
const YES = ['sí','si','vale','correcto','ok','afirmativo','guardar',
             'adelante','perfecto','claro','venga','bueno'];
const NO  = ['no','cancelar','borrar','descartar','olvida'];

const BLOCKS = {
  manana:'09:00', mañana:'09:00',
  tarde: '16:00',
  noche: '21:00',
  mediodia:'13:00', mediodía:'13:00',
};

/* ============================================================
   DB — IndexedDB
   ============================================================ */
const DB = (() => {
  let _db = null;
  const open = () => new Promise((res, rej) => {
    if (_db) return res(_db);
    const r = indexedDB.open('algrano', 2);
    r.onupgradeneeded = e => {
      if (!e.target.result.objectStoreNames.contains('eventos'))
        e.target.result.createObjectStore('eventos', { keyPath: 'id' });
    };
    r.onsuccess = e => { _db = e.target.result; res(_db); };
    r.onerror   = e => rej(e.target.error);
  });
  const tx = (mode, fn) => open().then(db => new Promise((res, rej) => {
    const t = db.transaction('eventos', mode);
    const s = t.objectStore('eventos');
    const r = fn(s);
    if (r) r.onsuccess = () => res(r.result);
    t.oncomplete = () => res();
    t.onerror    = () => rej(t.error);
  }));
  const add    = ev  => tx('readwrite', s => s.add(ev));
  const put    = ev  => tx('readwrite', s => s.put(ev));
  const del    = id  => tx('readwrite', s => s.delete(id));
  const getAll = ()  => open().then(db => new Promise((res, rej) => {
    const r = db.transaction('eventos','readonly').objectStore('eventos').getAll();
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  }));
  return { open, add, put, del, getAll };
})();

/* ============================================================
   NLP — parser español
   ============================================================ */
const NLP = (() => {

  /* normalizar texto: sin tildes, minúsculas, sin puntuación especial */
  const n = t => t.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿¡]/g, '').trim();

  /* ── Fecha ── */
  const parseDate = s => {
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    if (/\bhoy\b/.test(s))           return new Date(hoy);
    if (/\bpasado manana\b/.test(s)) return addD(hoy, 2);
    if (/\bmanana\b/.test(s))        return addD(hoy, 1);

    const dias = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
    const mDia = new RegExp(`\\b(${dias.join('|')})\\b`).exec(s);
    if (mDia) {
      let diff = dias.indexOf(mDia[1]) - new Date().getDay();
      if (diff <= 0) diff += 7;
      return addD(hoy, diff);
    }

    const mFecha = /\bel (?:dia )?(\d{1,2})(?:\s+de\s+(\w+))?\b/.exec(s);
    if (mFecha) {
      const MM = ['enero','febrero','marzo','abril','mayo','junio',
                  'julio','agosto','septiembre','octubre','noviembre','diciembre'];
      let mes = hoy.getMonth();
      if (mFecha[2]) { const i = MM.indexOf(mFecha[2]); if (i >= 0) mes = i; }
      const d = new Date(hoy.getFullYear(), mes, parseInt(mFecha[1]));
      if (d < hoy) d.setFullYear(d.getFullYear() + 1);
      return d;
    }
    return null;
  };

  /* ── Hora ── */
  const parseTime = s => {
    // Bloques de tiempo con preposición: "por la tarde", "esta noche"
    for (const [b, t] of Object.entries(BLOCKS)) {
      const bn = n(b);
      if (s.includes(`por la ${bn}`) || s.includes(`esta ${bn}`) || s.includes(`de ${bn}`))
        return { time: t, block: b };
    }

    // Números escritos: "a las nueve y media"
    const NUMS = {
      una:'01',dos:'02',tres:'03',cuatro:'04',cinco:'05',seis:'06',
      siete:'07',ocho:'08',nueve:'09',diez:'10',once:'11',doce:'12',
      trece:'13',catorce:'14',quince:'15',dieciseis:'16',diecisiete:'17',
      dieciocho:'18',diecinueve:'19',veinte:'20',veintiuna:'21',
      veintidos:'22',veintitres:'23',
    };
    const MINS = { 'y cuarto':'15', 'y media':'30', 'menos cuarto':'45' };

    for (const [w, h] of Object.entries(NUMS)) {
      if (new RegExp(`\\ba las ${w}\\b`).test(s)) {
        let m = '00';
        for (const [mw, mv] of Object.entries(MINS)) {
          if (s.includes(`${w} ${mw}`)) { m = mv; break; }
        }
        let hh = parseInt(h);
        // Heurística AM/PM: < 8 sin mención de "mañana" → tarde
        if (hh < 8 && !s.includes('manana')) hh += 12;
        return { time: `${String(hh).padStart(2,'0')}:${m}`, block: null };
      }
    }

    // Dígitos con dos puntos: "a las 22:45", "9:30"
    const mColon = /\b(?:a las?|las?)?\s*(\d{1,2}):(\d{2})\b/.exec(s);
    if (mColon) {
      let h = parseInt(mColon[1]), m = parseInt(mColon[2]);
      if (h >= 1 && h < 8 && !s.includes('manana')) h += 12;
      if (h < 24 && m < 60) return { time: pad(h) + ':' + pad(m), block: null };
    }

    // Dígitos con espacio: "a las 22 45"
    const mSpace = /\b(?:a las?|las?)\s*(\d{1,2})\s+(\d{2})\b/.exec(s);
    if (mSpace) {
      const h = parseInt(mSpace[1]), m = parseInt(mSpace[2]);
      if (h < 24 && m < 60) return { time: pad(h) + ':' + pad(m), block: null };
    }

    // Solo hora: "a las 9", "las 10"
    const mSolo = /\b(?:a las?|las?)\s*(\d{1,2})\b/.exec(s);
    if (mSolo) {
      let h = parseInt(mSolo[1]);
      if (h >= 1 && h < 8 && !s.includes('manana')) h += 12;
      if (h < 24) return { time: pad(h) + ':00', block: null };
    }

    // Bloques solos: "mañana trabajo" → mañana es fecha, no bloque de hora
    // Aquí solo bloques sin ambigüedad temporal
    for (const [b, t] of Object.entries(BLOCKS)) {
      const bn = n(b);
      // Solo si no es "mañana" suelto (podría ser día)
      if (bn !== 'manana' && bn !== 'mañana' && s.includes(bn))
        return { time: t, block: b };
    }

    return null;
  };

  /* ── Recordatorios ── */
  const parseReminders = s => {
    const rs = [];
    let m;
    const r1 = /(?:avisame?|recuerdame?|aviso|alarma|recordatorio)\s+(?:una?\s+)?(\d+|media)\s+minuto/g;
    while ((m = r1.exec(s)) !== null) rs.push(m[1] === 'media' ? 30 : parseInt(m[1]) || 0);
    const r2 = /(?:avisame?|recuerdame?|aviso|alarma|recordatorio)\s+(una?|\d+)\s+hora/g;
    while ((m = r2.exec(s)) !== null) rs.push(m[1] === 'una' ? 60 : (parseInt(m[1]) || 1) * 60);
    if (/\b(?:un )?cuarto de hora antes\b/.test(s) && !rs.includes(15)) rs.push(15);
    if (/\bmedia hora antes\b/.test(s) && !rs.includes(30))             rs.push(30);
    if (/\buna hora antes\b/.test(s) && !rs.includes(60))               rs.push(60);
    if (/\bdos horas antes\b/.test(s) && !rs.includes(120))             rs.push(120);
    return [...new Set(rs.filter(r => r > 0))];
  };

  /* ── Repetición ── */
  const parseRepeat = s => {
    if (/todos los dias|cada dia/.test(s))       return 'RRULE:FREQ=DAILY';
    if (/todas las semanas|cada semana/.test(s)) return 'RRULE:FREQ=WEEKLY';
    const dd = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
    const m  = new RegExp(`cada (${dd.join('|')})`).exec(s);
    if (m) return `RRULE:FREQ=WEEKLY;BYDAY=${['SU','MO','TU','WE','TH','FR','SA'][dd.indexOf(m[1])]}`;
    return null;
  };

  /* ── Título: eliminar toda la carga temporal del texto ── */
  const extractTitle = text => {
    let t = text;
    [
      /\bpasado mañana\b/gi, /\bpasado manana\b/gi,
      /\bpor la (?:mañana|manana|tarde|noche|madrugada)\b/gi,
      /\bde la (?:mañana|manana|tarde|noche)\b/gi,
      /\besta (?:mañana|manana|tarde|noche|mediodía|mediodia)\b/gi,
      /\btodos los días\b|\btodos los dias\b|\bcada \w+\b/gi,
      /\ba las? \d{1,2}(?::\d{2})?\b/gi,
      /\ba las? \d{1,2}\s+\d{2}\b/gi,
      /\ba las (?:una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)[^,.;]*/gi,
      /\bmañana\b|\bmanana\b|\bhoy\b/gi,
      /\b(?:este\s+)?(?:domingo|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado)\b/gi,
      /\bel (?:día |dia )?\d{1,2}(?:\s+de \w+)?\b/gi,
      /\b(?:tarde|noche|mediodía|mediodia)\b/gi,
      /\bluego\b|\bmás tarde\b|\bmas tarde\b|\bdespués\b|\bdespues\b/gi,
      // Recordatorios
      /\s+(?:avisame?|recuerdame?|aviso|alarma|recordatorio)\b[^.;]*/gi,
      /[¿¡]/g,
    ].forEach(r => { t = t.replace(r, ' '); });

    t = t.replace(/\s+/g, ' ').trim()
         .replace(/^(?:y|e|o|de|el|la|los|las|un|una|con|para|que|a)\s+/i, '')
         .replace(/\s+(?:y|e|o|de|el|la|un|una)$/i, '')
         .trim();

    return (t.charAt(0).toUpperCase() + t.slice(1)) || 'Evento';
  };

  /* ── Parse principal ── */
  const parse = text => {
    const s     = n(text);
    const fecha = parseDate(s);
    const hora  = parseTime(s);
    const hoy   = new Date(); hoy.setHours(0,0,0,0);
    return {
      id:        `ev_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      title:     extractTitle(text),
      date:      (fecha || hoy).toISOString().split('T')[0],
      time:      hora?.time  ?? null,
      block:     hora?.block ?? null,
      reminders: parseReminders(s),
      repeat:    parseRepeat(s),
      status:    (!fecha && !hora) ? 'pending' : 'scheduled',
      createdAt: Date.now(),
      raw:       text,
    };
  };

  /* ── Detectar intención ── */
  const detectIntent = text => {
    const s = n(text);
    if (/\b(?:elimina|borra|quita|cancela|suprime)r?\b/.test(s)) return 'delete';
    if (/\b(?:cambia|mueve|modifica|retrasa|adelanta|pon|actualiza|pasa)r?\b/.test(s)) return 'update';
    return 'create';
  };

  /* ── Extraer término de búsqueda para delete/update ── */
  const searchTerm = text => {
    let s = n(text);
    // Quitar verbo + artículo inicial
    s = s.replace(/^(?:elimina|borra|quita|cancela|suprime|cambia|mueve|modifica|retrasa|adelanta|pon|actualiza|pasa)r?\s+(?:el|la|los|las|un|una)?\s*/i, '');
    // Quitar cola temporal
    s = s.replace(/\s+(?:a las?|al?|para|del?|de la|por la|esta|hoy|manana|mañana|pasado|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b.*/i, '');
    // Artículos sueltos al final
    s = s.replace(/\s+(?:el|la|los|las|un|una|de|del|al|a)$/i, '').trim();
    return s;
  };

  /* ── Buscar evento por similitud ── */
  const findEvent = (term, events) => {
    if (!term || !events.length) return null;
    const t = n(term);
    // Exacto
    let hit = events.find(e => n(e.title) === t);
    if (hit) return hit;
    // Contiene
    hit = events.find(e => n(e.title).includes(t) || t.includes(n(e.title)));
    if (hit) return hit;
    // Por palabras clave con scoring
    const words = t.split(/\s+/).filter(w => w.length > 2);
    if (words.length) {
      const scored = events
        .map(e => ({ e, hits: words.filter(w => n(e.title).includes(w)).length }))
        .filter(x => x.hits > 0)
        .sort((a, b) => b.hits - a.hits);
      if (scored.length) return scored[0].e;
    }
    return null;
  };

  /* ── Extraer cambios para update ── */
  const extractChanges = text => {
    const s = n(text);
    const changes = {};
    const fecha   = parseDate(s);
    const hora    = parseTime(s);
    if (fecha) changes.date  = fecha.toISOString().split('T')[0];
    if (hora)  { changes.time = hora.time; changes.block = hora.block; }
    return changes;
  };

  /* ── Humanizar fecha ── */
  const humanDate = iso => {
    const d   = new Date(iso + 'T12:00:00');
    const hoy = new Date(); hoy.setHours(12,0,0,0);
    const man = new Date(hoy); man.setDate(man.getDate() + 1);
    if (d.toDateString() === hoy.toDateString()) return 'hoy';
    if (d.toDateString() === man.toDateString()) return 'mañana';
    const DD = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    const MM = ['enero','febrero','marzo','abril','mayo','junio',
                'julio','agosto','septiembre','octubre','noviembre','diciembre'];
    return `el ${DD[d.getDay()]} ${d.getDate()} de ${MM[d.getMonth()]}`;
  };

  /* ── Frase de confirmación hablada ── */
  const toSpeech = ev => {
    const parts = [ev.title, humanDate(ev.date)];
    if (ev.time)        parts.push(`a las ${ev.time}`);
    else if (ev.block)  parts.push(`por la ${ev.block}`);
    if (ev.reminders.length)
      parts.push(`aviso ${ev.reminders.map(r => r >= 60 ? `${r/60} hora${r > 60 ? 's' : ''}` : `${r} minutos`).join(' y ')} antes`);
    return parts.join(', ') + '. ¿Lo guardo?';
  };

  /* ── Humanizar repetición (para mostrar) ── */
  const humanRepeat = rule => {
    if (!rule) return null;
    if (rule.includes('FREQ=DAILY'))  return 'Todos los días';
    if (rule.includes('FREQ=WEEKLY') && !rule.includes('BYDAY')) return 'Cada semana';
    const map = { SU:'domingos', MO:'lunes', TU:'martes', WE:'miércoles', TH:'jueves', FR:'viernes', SA:'sábados' };
    const m   = /BYDAY=(\w+)/.exec(rule);
    if (m) return `Cada ${map[m[1]] || m[1]}`;
    return rule;
  };

  const addD = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
  const pad  = n => String(n).padStart(2, '0');

  return { parse, humanDate, humanRepeat, toSpeech, norm: n,
           detectIntent, searchTerm, findEvent, extractChanges };
})();

/* ============================================================
   GOOGLE CALENDAR
   ============================================================ */
const GCal = (() => {
  const pad = n => String(n).padStart(2, '0');

  /* Fecha+hora → formato GCal: YYYYMMDDTHHMMSS */
  const fmt = (isoDate, time) => {
    const d = isoDate.replace(/-/g, '');
    if (!time) return d;
    return `${d}T${time.replace(':', '')}00`;
  };

  const buildUrl = ev => {
    const start = fmt(ev.date, ev.time);
    let end;
    if (ev.time) {
      // +1 hora por defecto
      const [h, m] = ev.time.split(':').map(Number);
      let hh = h + 1;
      // Si pasa de medianoche, ajustar al día siguiente
      if (hh >= 24) hh = 23;
      end = fmt(ev.date, `${pad(hh)}:${pad(m)}`);
    } else {
      // Evento de todo el día
      end = start;
    }

    const p = new URLSearchParams({
      action: 'TEMPLATE',
      text:   ev.title,
      dates:  ev.time ? `${start}/${end}` : `${start}/${start}`,
    });

    // Descripción con los recordatorios
    if (ev.reminders.length) {
      p.set('details', `Aviso: ${ev.reminders.map(r => r >= 60 ? `${r/60}h` : `${r}min`).join(', ')} antes`);
    }

    // Regla de repetición
    if (ev.repeat) p.set('recur', ev.repeat);

    return `https://calendar.google.com/calendar/render?${p.toString()}`;
  };

  /* Abrir en nueva pestaña — llamar ANTES de modificar el estado */
  const open = ev => window.open(buildUrl(ev), '_blank', 'noopener,noreferrer');

  return { open, buildUrl };
})();

/* ============================================================
   SÍNTESIS DE VOZ
   ============================================================ */
const Voice = (() => {
  let voices  = [];
  let selName = localStorage.getItem('ag-voice') || '';
  let cfg     = JSON.parse(localStorage.getItem('ag-vcfg') || '{"rate":1.25,"pitch":1.0}');

  const load = () => { voices = speechSynthesis?.getVoices() || []; return voices; };
  if (window.speechSynthesis) {
    load();
    speechSynthesis.onvoiceschanged = load;
  }

  const rank = v => {
    const nm = v.name.toLowerCase(), lg = v.lang.toLowerCase();
    if (!lg.startsWith('es')) return -1;
    let s = 0;
    if (nm.includes('neural') || nm.includes('natural')) s += 100;
    if (nm.includes('google'))   s += 80;
    if (nm.includes('premium') || nm.includes('enhanced')) s += 70;
    if (nm.includes('monica'))   s += 60;
    if (nm.includes('paulina'))  s += 60;
    if (nm.includes('jorge'))    s += 55;
    if (nm.includes('lucia'))    s += 50;
    if (lg === 'es-es')          s += 10;
    if (v.localService)          s += 5;
    return s;
  };

  const best = () => {
    const vv = load();
    if (selName) { const f = vv.find(v => v.name === selName); if (f) return f; }
    const sp = vv.filter(v => v.lang.toLowerCase().startsWith('es'));
    return sp.sort((a, b) => rank(b) - rank(a))[0] || vv[0] || null;
  };

  const speak = (text, cb) => {
    if (!window.speechSynthesis) { cb?.(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang   = 'es-ES';
    u.rate   = cfg.rate;
    u.pitch  = cfg.pitch;
    u.volume = 1;
    const v  = best(); if (v) u.voice = v;
    // Workaround: Chrome pausa synthesis en segundo plano
    const t  = setInterval(() => { if (speechSynthesis.paused) speechSynthesis.resume(); }, 5000);
    u.onend = u.onerror = () => { clearInterval(t); cb?.(); };
    speechSynthesis.speak(u);
  };

  const cancel  = () => speechSynthesis?.cancel();
  const listES  = () => load().filter(v => v.lang.toLowerCase().startsWith('es')).sort((a,b) => rank(b)-rank(a));
  const selectV = name => { selName = name; localStorage.setItem('ag-voice', name); };
  const setP    = p => { cfg = {...cfg,...p}; localStorage.setItem('ag-vcfg', JSON.stringify(cfg)); };
  const getP    = () => ({...cfg});
  const getBest = () => best()?.name || '';

  return { speak, cancel, listES, selectV, setP, getP, getBest };
})();

/* ============================================================
   GRABACIÓN + WHISPER (MediaRecorder → Groq)
   ============================================================ */
const SR = (() => {
  const KEY   = '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';
  const URL   = 'https://api.groq.com/openai/v1/audio/transcriptions';
  const MODEL = 'whisper-large-v3-turbo';

  let rec    = null;
  let stream = null;
  let chunks = [];
  let active = false;
  let cbOk   = null;
  let cbErr  = null;

  const start = (onOk, onErr) => {
    cbOk = onOk; cbErr = onErr; chunks = []; active = false;

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(s => {
        stream = s; active = true;

        const mime = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4']
          .find(t => MediaRecorder.isTypeSupported(t)) || '';

        rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
        rec.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };
        rec.onstop = async () => {
          stream.getTracks().forEach(t => t.stop()); stream = null;
          const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
          if (blob.size < 1000) { cbErr?.('no-speech'); return; }
          await transcribe(blob);
        };
        rec.start(100);
      })
      .catch(err => {
        active = false;
        cbErr?.(err.name === 'NotAllowedError' ? 'not-allowed' : err.name);
      });
  };

  const stop = () => {
    if (rec && active && rec.state === 'recording') { active = false; rec.stop(); }
    else { active = false; cbErr?.('no-speech'); }
  };

  const abort = () => {
    active = false;
    if (rec && rec.state === 'recording') {
      rec.ondataavailable = null; rec.onstop = null; rec.stop();
    }
    stream?.getTracks().forEach(t => t.stop()); stream = null;
  };

  const transcribe = async blob => {
    const label = document.getElementById('statusLabel');
    if (label) label.textContent = 'Transcribiendo…';
    try {
      const ext  = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'mp4' : 'webm';
      const form = new FormData();
      form.append('file',            new File([blob], `audio.${ext}`, { type: blob.type }));
      form.append('model',           MODEL);
      form.append('language',        'es');
      form.append('response_format', 'json');

      const res  = await fetch(URL, { method:'POST', headers:{ Authorization:`Bearer ${KEY}` }, body:form });
      if (!res.ok) { console.error('[SR] Groq', res.status, await res.text()); cbErr?.('groq-error'); return; }

      const text = (await res.json())?.text?.trim();
      if (text) cbOk?.(text);
      else      cbErr?.('no-speech');
    } catch (e) {
      console.error('[SR]', e);
      cbErr?.('network');
    }
  };

  const isOn = () => active;
  return { start, stop, abort, isOn };
})();

/* ============================================================
   ALARMAS — sonido + notificación (app abierta)
   ============================================================ */
const Alarm = (() => {
  const timers = {};

  const req = () => {
    if ('Notification' in window && Notification.permission === 'default')
      Notification.requestPermission();
  };

  const beep = () => {
    try {
      const ctx  = new (window.AudioContext || window.webkitAudioContext)();
      const play = (f, t, d) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'sine';
        o.frequency.setValueAtTime(f, ctx.currentTime + t);
        g.gain.setValueAtTime(0.45, ctx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + d);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + d + 0.05);
      };
      play(880, 0.0, 0.18); play(988, 0.22, 0.18); play(1109, 0.44, 0.35);
      play(880, 0.9, 0.18); play(988, 1.12, 0.18); play(1109, 1.34, 0.35);
    } catch(e) { console.warn('[Alarm] beep', e); }
  };

  const banner = (title, body) => {
    let el = document.getElementById('alarmBanner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'alarmBanner'; el.className = 'alarm-banner';
      document.body.appendChild(el);
    }
    el.innerHTML = `
      <div class="ab-icon">⏰</div>
      <div class="ab-text"><strong>${title}</strong><span>${body}</span></div>
      <button class="ab-close" onclick="this.parentElement.classList.remove('visible')">✕</button>`;
    requestAnimationFrame(() => el.classList.add('visible'));
    setTimeout(() => el.classList.remove('visible'), 8000);
  };

  const fire = (ev, mins) => {
    const body = mins === 0 ? '¡Ahora!' : mins < 60 ? `En ${mins} min` : `En ${mins/60}h`;
    beep();
    banner(ev.title, body);
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(`⏰ ${ev.title}`, {
          body, icon:'./icons/icon-192.png',
          tag:`alarm-${ev.id}-${mins}`, renotify:true,
          vibrate:[200,100,200,100,200],
        });
      } catch(e) { console.warn('[Alarm] notif', e); }
    }
  };

  const schedule = ev => {
    if (!ev.time) return;
    const evMs  = new Date(`${ev.date}T${ev.time}:00`).getTime();
    const now   = Date.now();
    const maxMs = 7 * 24 * 60 * 60 * 1000;

    // Recordatorios
    (ev.reminders || []).forEach(mins => {
      const key = `${ev.id}-${mins}`, delay = evMs - mins * 60000 - now;
      if (timers[key]) clearTimeout(timers[key]);
      if (delay > 0 && delay < maxMs)
        timers[key] = setTimeout(() => { fire(ev, mins); delete timers[key]; }, delay);
    });

    // Momento exacto
    const key0 = `${ev.id}-0`, delay0 = evMs - now;
    if (timers[key0]) clearTimeout(timers[key0]);
    if (delay0 > 0 && delay0 < maxMs)
      timers[key0] = setTimeout(() => { fire(ev, 0); delete timers[key0]; }, delay0);
  };

  const cancel = evId => {
    Object.keys(timers).filter(k => k.startsWith(evId))
      .forEach(k => { clearTimeout(timers[k]); delete timers[k]; });
  };

  const reload = async () => {
    const all = await DB.getAll();
    all.filter(e => e.status === 'scheduled' && e.time && e.reminders?.length)
       .forEach(schedule);
  };

  return { req, schedule, cancel, reload };
})();

/* ============================================================
   UI
   ============================================================ */
const UI = (() => {
  const $ = id => document.getElementById(id);

  const toast = (msg, type = 'inf', ms = 3200) => {
    const el = document.createElement('div');
    el.className = `toast ${type}`; el.textContent = msg;
    $('toasts').appendChild(el); setTimeout(() => el.remove(), ms);
  };

  const setMode = mode => {
    const btn = $('micBtn'), lbl = $('statusLabel');
    btn.classList.remove('listening','processing','pressed');
    lbl.classList.remove('listening');
    switch (mode) {
      case 'idle':
        lbl.textContent = 'Mantén pulsado para hablar';
        $('transcriptText').textContent = '';
        $('confirmCard').hidden = true;
        $('upcoming').style.opacity = '1';
        $('upcoming').style.pointerEvents = 'auto';
        // Ocultar botón GCal cuando no hay evento nuevo pendiente
        $('btnGcal').hidden = true;
        break;
      case 'listening':
        lbl.textContent = 'Suelta cuando termines…';
        lbl.classList.add('listening');
        btn.classList.add('listening','pressed');
        $('confirmCard').hidden = true;
        break;
      case 'processing':
        lbl.textContent = 'Procesando…';
        btn.classList.add('processing');
        break;
      case 'confirming':
        lbl.textContent = 'Mantén pulsado para responder';
        lbl.classList.add('listening');
        $('upcoming').style.opacity = '0';
        $('upcoming').style.pointerEvents = 'none';
        break;
    }
  };

  const showConfirm = (ev, showGcal = false) => {
    const date = NLP.humanDate(ev.date);
    const time = ev.time    ? `<strong>${ev.time}</strong>`
               : ev.block   ? `por la <strong>${ev.block}</strong>`
               : '<small>sin hora</small>';
    const rem  = ev.reminders.length
      ? `<br><small>🔔 ${ev.reminders.map(r => r >= 60 ? `${r/60}h` : `${r}min`).join(', ')} antes</small>` : '';
    const rep  = ev.repeat ? `<br><small>🔁 ${NLP.humanRepeat(ev.repeat)}</small>` : '';

    $('confirmPreview').innerHTML = `<strong>${ev.title}</strong><br>${date} ${time}${rem}${rep}`;
    $('btnYes').textContent = '✓ Guardar';
    $('btnNo').textContent  = '✗ Cancelar';

    // Mostrar botón GCal solo para eventos nuevos
    $('btnGcal').hidden = !showGcal;

    $('confirmCard').hidden = false;
  };

  const showDelete = ev => {
    $('confirmPreview').innerHTML =
      `<span class="confirm-action-tag delete">Eliminar</span>` +
      `<strong>${ev.title}</strong><br>${NLP.humanDate(ev.date)}${ev.time ? ' · ' + ev.time : ''}`;
    $('btnYes').textContent = '✓ Sí, eliminar';
    $('btnNo').textContent  = '✗ Cancelar';
    $('btnGcal').hidden = true;
    $('confirmCard').hidden = false;
  };

  const showUpdate = (ev, changes) => {
    const parts = [];
    if (changes.date) parts.push(NLP.humanDate(changes.date));
    if (changes.time) parts.push(changes.time);
    else if (changes.block) parts.push(`por la ${changes.block}`);
    $('confirmPreview').innerHTML =
      `<span class="confirm-action-tag update">Modificar</span>` +
      `<strong>${ev.title}</strong><br>${parts.join(' · ')}`;
    $('btnYes').textContent = '✓ Sí, cambiar';
    $('btnNo').textContent  = '✗ Cancelar';
    $('btnGcal').hidden = true;
    $('confirmCard').hidden = false;
  };

  return { toast, setMode, showConfirm, showDelete, showUpdate };
})();

/* ============================================================
   PANEL DE EVENTOS
   ============================================================ */
const Panel = (() => {
  const $ = id => document.getElementById(id);
  let filter = 'hoy';
  const addD = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

  const open  = () => { $('panel').classList.add('open');    $('overlay').classList.add('on');    render(); };
  const close = () => { $('panel').classList.remove('open'); $('overlay').classList.remove('on'); };

  const render = async () => {
    const all  = await DB.getAll();
    const hoy  = new Date(); hoy.setHours(0,0,0,0);
    const ts   = hoy.toISOString().split('T')[0];
    const tm   = addD(hoy,1).toISOString().split('T')[0];
    const tw   = addD(hoy,7).toISOString().split('T')[0];

    const evs = all.filter(e => {
      if (filter === 'hoy')        return e.date === ts && e.status !== 'pending';
      if (filter === 'mañana')     return e.date === tm;
      if (filter === 'semana')     return e.date >= ts && e.date <= tw;
      if (filter === 'pendientes') return e.status === 'pending';
      return true;
    }).sort((a,b) => (a.date+(a.time||'99:99')).localeCompare(b.date+(b.time||'99:99')));

    const list = $('eventsList');
    if (!evs.length) {
      list.innerHTML = '<p class="empty-state">Nada aquí.<br>Pulsa el micrófono y habla.</p>';
      return;
    }

    const groups = {};
    evs.forEach(e => {
      const k = e.status === 'pending' ? 'Pendientes' : NLP.humanDate(e.date);
      (groups[k] = groups[k] || []).push(e);
    });
    list.innerHTML = '';

    for (const [day, items] of Object.entries(groups)) {
      const g = document.createElement('div'); g.className = 'day-group';
      g.innerHTML = `<p class="day-label">${day}</p>`;
      items.forEach(ev => {
        const meta = [
          ev.reminders.length ? `🔔 ${ev.reminders.join(',')}min` : '',
          ev.repeat ? `🔁 ${NLP.humanRepeat(ev.repeat)}` : '',
        ].filter(Boolean).join(' · ');
        const d = document.createElement('div');
        d.className = `ev-item${ev.status === 'pending' ? ' pending' : ''}`;
        d.innerHTML = `
          <div class="ev-time ${!ev.time?'no-t':''}">${ev.time||'—'}</div>
          <div class="ev-info">
            <div class="ev-title">${ev.title}</div>
            ${meta ? `<div class="ev-meta">${meta}</div>` : ''}
          </div>
          <button class="ev-del" data-id="${ev.id}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
              <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
            </svg>
          </button>`;
        d.querySelector('.ev-del').addEventListener('click', async e => {
          const id = e.currentTarget.dataset.id;
          Alarm.cancel(id);
          await DB.del(id);
          render(); UI.toast('Eliminado', 'inf');
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
    $('tabs').querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => {
        $('tabs').querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active'); filter = t.dataset.f; render();
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

  const open  = () => { populate(); $('voiceModal').classList.add('open'); $('overlayVoice').classList.add('on'); };
  const close = () => { $('voiceModal').classList.remove('open'); $('overlayVoice').classList.remove('on'); };

  const populate = () => {
    const voices = Voice.listES(), sel = $('voiceSelect');
    const best   = Voice.getBest(), prm = Voice.getP();

    sel.innerHTML = voices.length
      ? voices.map(v => `<option value="${v.name}" ${v.name===best?'selected':''}>${v.name}${v.name===best?' ★':''} (${v.lang})</option>`).join('')
      : '<option value="">Sin voces en español</option>';
    sel.onchange = () => Voice.selectV(sel.value);

    const rr = $('rateRange'), pr = $('pitchRange');
    const rv = $('rateVal'),   pv = $('pitchVal');
    rr.value = prm.rate;  rv.textContent = prm.rate.toFixed(2);
    pr.value = prm.pitch; pv.textContent = prm.pitch.toFixed(2);
    rr.oninput = () => { Voice.setP({ rate:  parseFloat(rr.value) }); rv.textContent = parseFloat(rr.value).toFixed(2); };
    pr.oninput = () => { Voice.setP({ pitch: parseFloat(pr.value) }); pv.textContent = parseFloat(pr.value).toFixed(2); };
  };

  const init = () => {
    $('btnVoiceSettings').addEventListener('click', open);
    $('btnCloseVoice').addEventListener('click', close);
    $('overlayVoice').addEventListener('click', close);
    $('btnTestVoice').addEventListener('click', () => {
      Voice.selectV($('voiceSelect').value);
      Voice.cancel();
      Voice.speak('Hola, esto es Al Grano. ¿Cómo suena esta voz?');
    });
  };

  return { init };
})();

/* ============================================================
   PRÓXIMOS EVENTOS
   ============================================================ */
const Upcoming = (() => {
  const $ = id => document.getElementById(id);

  const render = async () => {
    const all     = await DB.getAll();
    const now     = new Date();
    const hoy     = new Date(); hoy.setHours(0,0,0,0);
    const todayS  = hoy.toISOString().split('T')[0];
    const tomS    = new Date(hoy.getTime() + 86400000).toISOString().split('T')[0];

    const future = all
      .filter(e => {
        if (e.status === 'pending' || e.date < todayS) return false;
        if (e.date === todayS && e.time) {
          const [h,m] = e.time.split(':').map(Number);
          const t = new Date(); t.setHours(h, m, 0, 0);
          return t > now;
        }
        return true;
      })
      .sort((a,b) => (a.date+(a.time||'99:99')).localeCompare(b.date+(b.time||'99:99')))
      .slice(0, 3);

    const container = $('upcoming'), list = $('upcomingList'), label = $('upcomingLabel');
    if (!future.length) {
      container.classList.add('empty');
      list.innerHTML = '<p class="upcoming-empty">Sin eventos próximos</p>';
      return;
    }
    container.classList.remove('empty');
    label.textContent = future[0].date === todayS ? 'hoy' : 'próximos';

    list.innerHTML = '';
    future.forEach((ev, i) => {
      const isToday = ev.date === todayS;
      const dateTag = isToday ? 'hoy' : ev.date === tomS ? 'mañana' : NLP.humanDate(ev.date);
      const item = document.createElement('div');
      item.className = 'upcoming-item';
      item.style.animationDelay = `${i * 60}ms`;
      item.innerHTML = `
        <div class="upcoming-time">${ev.time || '—'}</div>
        <div class="upcoming-info">
          <span class="upcoming-title">${ev.title}</span>
          ${!isToday ? `<span class="upcoming-date">${dateTag}</span>` : ''}
        </div>
        ${ev.reminders.length ? '<div class="upcoming-bell">🔔</div>' : ''}`;
      list.appendChild(item);
    });
  };

  return { render };
})();

/* ============================================================
   APP — orquestador push-to-talk
   ============================================================ */
const App = (() => {
  let mode     = 'idle';
  let phase    = 'event';   // 'event' | 'delete' | 'update'
  let pressing = false;
  let pending  = null;      // evento nuevo en construcción
  let targetEv = null;      // evento a eliminar/modificar
  let changes  = null;      // cambios del update

  const setMode = m => { mode = m; UI.setMode(m); };

  /* ── PRESS ── */
  const onPress = e => {
    e.preventDefault();
    if (pressing) return;
    pressing = true;
    Voice.cancel();
    phase = mode === 'confirming' ? phase : 'event';
    setMode('listening');

    SR.start(
      text => {
        pressing = false;
        document.getElementById('transcriptText').textContent = text;
        if (mode === 'confirming' || mode === 'processing') processConfirm(text);
        else                                                 processText(text);
      },
      err => {
        pressing = false;
        if (err === 'not-allowed')
          UI.toast('Permiso de micrófono denegado', 'err', 6000);
        else if (err === 'network')
          UI.toast('Sin conexión para el reconocimiento de voz', 'err', 6000);
        else if (err === 'groq-error')
          UI.toast('Error de transcripción. Inténtalo de nuevo.', 'err', 4000);
        setMode(mode === 'confirming' ? 'confirming' : 'idle');
      }
    );
  };

  /* ── RELEASE ── */
  const onRelease = e => {
    e.preventDefault();
    if (!pressing) return;
    setMode('processing');
    SR.stop();
  };

  /* ── Procesar texto hablado ── */
  const processText = async text => {
    setMode('processing');
    const intent = NLP.detectIntent(text);

    if (intent === 'delete') {
      const all  = await DB.getAll();
      const term = NLP.searchTerm(text);
      const ev   = NLP.findEvent(term, all);
      if (!ev) {
        UI.toast(`No encontré "${term}"`, 'err', 4000);
        Voice.speak('No encontré ese evento.');
        setMode('idle'); return;
      }
      targetEv = ev; phase = 'delete';
      UI.showDelete(ev);
      setMode('confirming');
      Voice.speak(`¿Elimino ${ev.title}?`);

    } else if (intent === 'update') {
      const all   = await DB.getAll();
      const term  = NLP.searchTerm(text);
      const ev    = NLP.findEvent(term, all);
      const chg   = NLP.extractChanges(text);
      if (!ev) {
        UI.toast(`No encontré "${term}"`, 'err', 4000);
        Voice.speak('No encontré ese evento.');
        setMode('idle'); return;
      }
      if (!chg.date && !chg.time) {
        UI.toast('No entendí qué cambiar', 'err', 4000);
        Voice.speak('No entendí qué cambiar. Dime la nueva fecha u hora.');
        setMode('idle'); return;
      }
      targetEv = ev; changes = chg; phase = 'update';
      UI.showUpdate(ev, chg);
      setMode('confirming');
      const p = [];
      if (chg.date) p.push(NLP.humanDate(chg.date));
      if (chg.time) p.push(`a las ${chg.time}`);
      else if (chg.block) p.push(`por la ${chg.block}`);
      Voice.speak(`¿Cambio ${ev.title} a ${p.join(' ')}?`);

    } else {
      // Crear evento
      pending = NLP.parse(text);
      phase   = 'event';
      setTimeout(() => {
        UI.showConfirm(pending, true);   // true = mostrar botón GCal
        setMode('confirming');
        Voice.speak(NLP.toSpeech(pending));
      }, 150);
    }
  };

  /* ── Procesar confirmación ── */
  const processConfirm = text => {
    const s = NLP.norm(text);
    if (YES.some(w => s.includes(w))) {
      if      (phase === 'delete') doDelete();
      else if (phase === 'update') doUpdate();
      else                         doSave(false);
    } else if (NO.some(w => s.includes(w))) {
      doCancel();
    } else {
      UI.toast('Di "sí" o "no"', 'inf');
      setMode('confirming');
    }
  };

  /* ── Guardar evento nuevo ── */
  const doSave = async (openGcal = false) => {
    Voice.cancel(); SR.abort();
    if (!pending) { setMode('idle'); return; }
    const ev = pending; // capturar ANTES de limpiar
    try {
      await DB.add(ev);
      Alarm.schedule(ev);
      if (openGcal) GCal.open(ev);   // abrir GCal con el evento capturado
      UI.toast(`✓ ${ev.title} guardado`, 'ok');
      Voice.speak(`Guardado. ${ev.title}.`);
      pending = null; phase = 'event';
      Upcoming.render();
      setMode('idle');
    } catch(e) { console.error(e); UI.toast('Error al guardar','err'); setMode('idle'); }
  };

  /* ── Eliminar evento ── */
  const doDelete = async () => {
    Voice.cancel(); SR.abort();
    if (!targetEv) { setMode('idle'); return; }
    try {
      Alarm.cancel(targetEv.id);
      await DB.del(targetEv.id);
      UI.toast(`${targetEv.title} eliminado`, 'ok');
      Voice.speak(`${targetEv.title} eliminado.`);
      targetEv = null; phase = 'event';
      Upcoming.render(); Panel.render();
      setMode('idle');
    } catch(e) { console.error(e); UI.toast('Error al eliminar','err'); setMode('idle'); }
  };

  /* ── Actualizar evento ── */
  const doUpdate = async () => {
    Voice.cancel(); SR.abort();
    if (!targetEv || !changes) { setMode('idle'); return; }
    try {
      const updated = { ...targetEv, ...changes };
      if (changes.date || changes.time) updated.status = 'scheduled';
      Alarm.cancel(targetEv.id);
      await DB.put(updated);
      Alarm.schedule(updated);
      UI.toast(`${updated.title} actualizado`, 'ok');
      Voice.speak(`${updated.title} actualizado.`);
      targetEv = null; changes = null; phase = 'event';
      Upcoming.render(); Panel.render();
      setMode('idle');
    } catch(e) { console.error(e); UI.toast('Error al actualizar','err'); setMode('idle'); }
  };

  /* ── Cancelar ── */
  const doCancel = () => {
    Voice.cancel(); SR.abort();
    pending = null; targetEv = null; changes = null;
    pressing = false; phase = 'event';
    setMode('idle');
    Voice.speak('Cancelado.');
    UI.toast('Cancelado', 'inf');
  };

  /* ── Input de texto (fallback) ── */
  const submitText = () => {
    const val = document.getElementById('textInput').value.trim();
    if (!val) return;
    document.getElementById('textInput').value = '';
    document.getElementById('transcriptText').textContent = val;
    if (mode === 'confirming') processConfirm(val);
    else                       processText(val);
  };

  /* ── Init ── */
  const init = async () => {
    await DB.open();
    Panel.init();
    VoiceSettings.init();
    await Alarm.reload();
    Alarm.req();
    Upcoming.render();

    const btn = document.getElementById('micBtn');
    btn.addEventListener('touchstart',  onPress,   { passive: false });
    btn.addEventListener('touchend',    onRelease, { passive: false });
    btn.addEventListener('touchcancel', onRelease, { passive: false });
    btn.addEventListener('mousedown',   onPress);
    btn.addEventListener('mouseup',     onRelease);
    btn.addEventListener('mouseleave',  e => { if (pressing) onRelease(e); });

    document.addEventListener('keydown', e => {
      if (e.code === 'Space' && !e.repeat && e.target === document.body) onPress(e);
    });
    document.addEventListener('keyup', e => {
      if (e.code === 'Space' && e.target === document.body) onRelease(e);
    });

    // Confirmación manual
    document.getElementById('btnYes').addEventListener('click', () => {
      if      (phase === 'delete') doDelete();
      else if (phase === 'update') doUpdate();
      else                         doSave(false);
    });
    document.getElementById('btnNo').addEventListener('click', doCancel);

    // Google Calendar
    document.getElementById('btnGcal').addEventListener('click', () => {
      if (phase === 'event' && pending) doSave(true);
    });

    // Texto fallback
    document.getElementById('btnSend').addEventListener('click', submitText);
    document.getElementById('textInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); submitText(); }
    });

    console.log('[Al Grano] listo ✓');
  };

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
