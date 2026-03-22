/* ══════════════════════════════════════════════════════════
   AL GRANO — app.js
   Voz → NLP → confirmación → IndexedDB
   Optimizado para Chrome desktop + Chrome Android (HTTPS)
══════════════════════════════════════════════════════════ */
'use strict';

/* ── Service Worker ────────────────────────────────────── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js')
      .then(r  => console.log('[SW] Registrado:', r.scope))
      .catch(e => console.warn('[SW] Error:', e));
  });
}

/* ══════════════════════════════════════════════════════════
   CONFIGURACIÓN
══════════════════════════════════════════════════════════ */
const BLOCKS = {
  mañana:   '09:00',
  manana:   '09:00',
  tarde:    '16:00',
  noche:    '21:00',
  mediodía: '13:00',
  mediodia: '13:00',
};

const CONFIRM_YES = ['sí','si','vale','correcto','ok','afirmativo','guardar','adelante','perfecto','claro','venga','bueno'];
const CONFIRM_NO  = ['no','cancelar','cancel','borrar','descartar','olvida','olvídalo'];

/* ══════════════════════════════════════════════════════════
   BASE DE DATOS — IndexedDB
══════════════════════════════════════════════════════════ */
const DB = (() => {
  let _db = null;

  const open = () => new Promise((res, rej) => {
    if (_db) return res(_db);
    const r = indexedDB.open('algrano-v1', 1);
    r.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('eventos')) {
        db.createObjectStore('eventos', { keyPath: 'id' });
      }
    };
    r.onsuccess = e => { _db = e.target.result; res(_db); };
    r.onerror   = e => rej(e.target.error);
  });

  const add = async ev => {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('eventos', 'readwrite');
      tx.objectStore('eventos').add(ev).onsuccess = () => res();
      tx.onerror = () => rej(tx.error);
    });
  };

  const getAll = async () => {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('eventos', 'readonly');
      const r  = tx.objectStore('eventos').getAll();
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
  };

  const remove = async id => {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('eventos', 'readwrite');
      tx.objectStore('eventos').delete(id).onsuccess = () => res();
      tx.onerror = () => rej(tx.error);
    });
  };

  return { open, add, getAll, remove };
})();

/* ══════════════════════════════════════════════════════════
   NLP — Parser de lenguaje natural en español
══════════════════════════════════════════════════════════ */
const NLP = (() => {

  const norm = t =>
    t.toLowerCase()
     .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
     .replace(/[¿¡]/g, '')
     .trim();

  /* ── Fecha ── */
  const parseDate = n => {
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    if (/\bhoy\b/.test(n))           return new Date(hoy);
    if (/\bpasado manana\b/.test(n)) return addDays(hoy, 2);
    if (/\bmanana\b/.test(n))        return addDays(hoy, 1);

    const dias = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
    const mDia = new RegExp(`\\b(${dias.join('|')})\\b`).exec(n);
    if (mDia) {
      const target = dias.indexOf(mDia[1]);
      const hd     = new Date().getDay();
      let diff     = target - hd;
      if (diff <= 0) diff += 7;
      return addDays(hoy, diff);
    }

    const meses  = ['enero','febrero','marzo','abril','mayo','junio',
                    'julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const mFecha = /\bel (?:dia )?(\d{1,2})(?:\s+de\s+(\w+))?\b/.exec(n);
    if (mFecha) {
      let mes = hoy.getMonth();
      if (mFecha[2]) { const i = meses.indexOf(mFecha[2]); if (i >= 0) mes = i; }
      const d = new Date(hoy.getFullYear(), mes, parseInt(mFecha[1]));
      if (d < hoy) d.setFullYear(d.getFullYear() + 1);
      return d;
    }
    return null;
  };

  /* ── Hora ── */
  const parseTime = n => {
    // Bloques con preposición
    for (const [b, t] of Object.entries(BLOCKS)) {
      const bn = norm(b);
      if (n.includes(`por la ${bn}`) || n.includes(`esta ${bn}`) || n.includes(`de ${bn}`))
        return { time: t, block: b };
    }

    // Números escritos "a las nueve"
    const nums = {
      una:'01',dos:'02',tres:'03',cuatro:'04',cinco:'05',seis:'06',
      siete:'07',ocho:'08',nueve:'09',diez:'10',once:'11',doce:'12',
      trece:'13',catorce:'14',quince:'15',dieciseis:'16',diecisiete:'17',
      dieciocho:'18',diecinueve:'19',veinte:'20',veintiuna:'21',
      veintidos:'22',veintitres:'23'
    };
    const minEscritos = { 'y cuarto':'15', 'y media':'30', 'menos cuarto':'45' };

    for (const [esc, num] of Object.entries(nums)) {
      if (new RegExp(`\\ba las ${esc}\\b`).test(n)) {
        let m = '00';
        for (const [me, mv] of Object.entries(minEscritos)) {
          if (n.includes(`${esc} ${me}`)) { m = mv; break; }
        }
        let h = parseInt(num);
        if (h < 8 && !n.includes('manana')) h += 12;
        return { time: `${String(h).padStart(2,'0')}:${m}`, block: null };
      }
    }

    // Dígitos "a las 9" "9:30" "las 21:00"
    const mH = /\b(?:a las?|las?)?\s*(\d{1,2})(?::(\d{2}))?\s*(?:h|hs|horas?)?\b/.exec(n);
    if (mH) {
      let h = parseInt(mH[1]);
      const m = mH[2] ? parseInt(mH[2]) : 0;
      if (h >= 1 && h < 8 && !n.includes('manana')) h += 12;
      if (h < 24 && m < 60) return { time: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`, block: null };
    }

    // Bloques solos
    for (const [b, t] of Object.entries(BLOCKS)) {
      if (n.includes(norm(b))) return { time: t, block: b };
    }
    return null;
  };

  /* ── Recordatorios ── */
  const parseReminders = n => {
    const rs = [];
    const rMin = /(?:avisame?|recuerdame?|aviso|alarma|recordatorio)\s+(?:una?\s+)?(\d+|media)\s+minuto/g;
    let m;
    while ((m = rMin.exec(n)) !== null) rs.push(m[1] === 'media' ? 30 : parseInt(m[1]) || 0);
    const rHr = /(?:avisame?|recuerdame?|aviso|alarma|recordatorio)\s+(una?|\d+)\s+hora/g;
    while ((m = rHr.exec(n)) !== null) rs.push(m[1] === 'una' ? 60 : (parseInt(m[1]) || 1) * 60);
    if (/\b15 minutos antes\b/.test(n) && !rs.includes(15)) rs.push(15);
    if (/\bmedia hora antes\b/.test(n)  && !rs.includes(30)) rs.push(30);
    if (/\buna hora antes\b/.test(n)    && !rs.includes(60)) rs.push(60);
    if (/\bdos horas antes\b/.test(n)   && !rs.includes(120)) rs.push(120);
    return [...new Set(rs)];
  };

  /* ── Repetición ── */
  const parseRepeat = n => {
    if (/todos los dias|cada dia/.test(n))      return 'Todos los días';
    if (/todas las semanas|cada semana/.test(n)) return 'Cada semana';
    const diasEs = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
    const diasSp = ['domingos','lunes','martes','miércoles','jueves','viernes','sábados'];
    const m = new RegExp(`cada (${diasEs.join('|')})`).exec(n);
    if (m) return `Cada ${diasSp[diasEs.indexOf(m[1])]}`;
    return null;
  };

  /* ── Título ── */
  const extractTitle = text => {
    let t = text;
    const rm = [
      /\bhoy\b/gi, /\bmanana\b/gi, /\bpasado manana\b/gi,
      /\best[ao]?\s+(manana|tarde|noche|mediod[ií]a)\b/gi,
      /\bpor la (manana|tarde|noche)\b/gi,
      /\bde la (manana|tarde|noche)\b/gi,
      /\ba las? \d{1,2}(?::\d{2})?\b/gi,
      /\bel (dia )?\d{1,2}(\s+de \w+)?\b/gi,
      /\b(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/gi,
      /\b(?:avisame?|recuerdame?|aviso|alarma|recordatorio)\b.*?\b(antes|hora|minuto)\b/gi,
      /\btodos los dias\b|\bcada \w+\b/gi,
      /\bluego\b|\bmas tarde\b|\bdespues\b/gi,
      /\ba las (una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)[^,.]*/gi,
      /[¿¡]/g
    ];
    rm.forEach(r => { t = t.replace(r, ' '); });
    t = t.replace(/\s+/g, ' ').trim()
         .replace(/^(y|de|el|la|un|una|con|para|que)\s+/i, '');
    return (t.charAt(0).toUpperCase() + t.slice(1)) || 'Evento';
  };

  /* ── Parse principal ── */
  const parse = text => {
    const n         = norm(text);
    const fecha     = parseDate(n);
    const hora      = parseTime(n);
    const reminders = parseReminders(n);
    const repeat    = parseRepeat(n);
    const hoy       = new Date(); hoy.setHours(0,0,0,0);
    const date      = fecha || hoy;

    return {
      id:        `ev_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      title:     extractTitle(text),
      date:      date.toISOString().split('T')[0],
      time:      hora?.time  ?? null,
      block:     hora?.block ?? null,
      reminders,
      repeat,
      status:    (!fecha && !hora) ? 'pending' : 'scheduled',
      createdAt: Date.now(),
      raw:       text
    };
  };

  /* ── Merge (frases encadenadas) ── */
  const merge = (base, text) => {
    const n     = norm(text);
    const hora  = parseTime(n);
    const fecha = parseDate(n);
    const rems  = parseReminders(n);
    const rep   = parseRepeat(n);
    if (hora)        { base.time = hora.time; base.block = hora.block; }
    if (fecha)       { base.date = fecha.toISOString().split('T')[0]; }
    if (rems.length) base.reminders = [...new Set([...base.reminders, ...rems])];
    if (rep)         base.repeat = rep;
    if (hora || fecha) base.status = 'scheduled';
    return base;
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

  /* ── Frase de confirmación ── */
  const toSpeech = ev => {
    const date = humanDate(ev.date);
    const time = ev.time  ? `a las ${ev.time}` : ev.block ? `por la ${ev.block}` : '';
    const rem  = ev.reminders.length
      ? `aviso ${ev.reminders.map(r => r >= 60 ? `${r/60} hora${r > 60 ? 's' : ''}` : `${r} minutos`).join(' y ')} antes`
      : '';
    const rep  = ev.repeat || '';
    return `${[ev.title, date, time, rem, rep].filter(Boolean).join(', ')}. ¿Lo guardo?`;
  };

  const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

  return { parse, merge, humanDate, toSpeech, norm };
})();

/* ══════════════════════════════════════════════════════════
   SÍNTESIS DE VOZ
══════════════════════════════════════════════════════════ */
const Voice = (() => {
  const speak = (text, cb) => {
    if (!window.speechSynthesis) { cb && cb(); return; }
    window.speechSynthesis.cancel();
    const u   = new SpeechSynthesisUtterance(text);
    u.lang    = 'es-ES';
    u.rate    = 0.92;
    u.volume  = 1.0;
    const vv  = window.speechSynthesis.getVoices();
    const v   = vv.find(x => x.lang.startsWith('es') && x.name.includes('Monica'))
             || vv.find(x => x.lang.startsWith('es'));
    if (v) u.voice = v;
    u.onend = u.onerror = () => { cb && cb(); };
    window.speechSynthesis.speak(u);
  };
  const cancel = () => { window.speechSynthesis?.cancel(); };
  return { speak, cancel };
})();

/* ══════════════════════════════════════════════════════════
   RECONOCIMIENTO DE VOZ
   — Robusto para Chrome desktop y Android —
══════════════════════════════════════════════════════════ */
const SR = (() => {
  const SRClass = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SRClass) return null;

  let rec        = null;
  let active     = false;
  let gotResult  = false;
  let finalSent  = false;

  const start = (onFinal, onErr) => {
    // Abortar instancia anterior si existe
    if (rec && active) { try { rec.abort(); } catch(e) {} }

    rec       = new SRClass();
    rec.lang  = 'es-ES';
    rec.interimResults  = false;   // false = más estable en Chrome móvil
    rec.maxAlternatives = 1;
    rec.continuous      = false;
    active    = false;
    gotResult = false;
    finalSent = false;

    rec.onstart = () => {
      active    = true;
      gotResult = false;
      finalSent = false;
      console.log('[SR] iniciado');
    };

    rec.onresult = e => {
      gotResult = true;
      if (!finalSent && e.results[0].isFinal) {
        finalSent = true;
        const text = e.results[0][0].transcript;
        console.log('[SR] resultado:', text);
        onFinal(text);
      }
    };

    rec.onend = () => {
      console.log('[SR] onend · gotResult=', gotResult);
      active = false;
      if (!finalSent) onErr && onErr(gotResult ? null : 'no-speech');
    };

    rec.onerror = e => {
      console.warn('[SR] onerror:', e.error);
      if (e.error === 'aborted') { active = false; return; }
      active = false;
      const silent = ['no-speech','audio-capture'];
      onErr && onErr(silent.includes(e.error) ? 'silent' : e.error);
    };

    // Delay 80ms: necesario tras eventos táctiles en Chrome Android
    setTimeout(() => {
      try { rec.start(); }
      catch(e) {
        console.warn('[SR] start() excepción:', e.name, e.message);
        if (e.name === 'InvalidStateError') {
          setTimeout(() => { try { rec.start(); } catch(_) {} }, 300);
        }
      }
    }, 80);
  };

  const stop  = () => { if (rec && active) { try { rec.stop(); } catch(e) {} } active = false; };
  const abort = () => { if (rec) { try { rec.abort(); } catch(e) {} } active = false; };
  const isOn  = () => active;

  return { start, stop, abort, isOn };
})();

/* ══════════════════════════════════════════════════════════
   NOTIFICACIONES
══════════════════════════════════════════════════════════ */
const Notif = (() => {
  const request = () => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  };
  const schedule = ev => {
    if (!ev.time || !ev.reminders.length) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const evDate = new Date(`${ev.date}T${ev.time}:00`);
    ev.reminders.forEach(mins => {
      const delay = evDate.getTime() - mins * 60000 - Date.now();
      if (delay > 0 && delay < 86400000) {
        setTimeout(() => new Notification(`⏰ ${ev.title}`, {
          body: `En ${mins} minutos`,
          icon: 'icons/icon-192.png',
          tag:  `${ev.id}-${mins}`
        }), delay);
      }
    });
  };
  return { request, schedule };
})();

/* ══════════════════════════════════════════════════════════
   UI
══════════════════════════════════════════════════════════ */
const UI = (() => {
  const $     = id => document.getElementById(id);
  const micBtn      = $('micBtn');
  const statusLabel = $('statusLabel');
  const transcriptEl= $('transcriptText');
  const confirmCard = $('confirmCard');
  const confirmPrev = $('confirmPreview');
  const toastsEl    = $('toasts');

  /* ── Toast ── */
  const toast = (msg, type = 'inf', ms = 3200) => {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    toastsEl.appendChild(el);
    setTimeout(() => el.remove(), ms);
  };

  /* ── Modo ── */
  const setMode = mode => {
    micBtn.classList.remove('listening', 'processing');
    statusLabel.classList.remove('listening');
    switch (mode) {
      case 'idle':
        statusLabel.textContent = 'Toca para hablar';
        transcriptEl.textContent = '';
        confirmCard.hidden = true;
        break;
      case 'listening':
        statusLabel.textContent = 'Escuchando…';
        statusLabel.classList.add('listening');
        micBtn.classList.add('listening');
        confirmCard.hidden = true;
        break;
      case 'processing':
        statusLabel.textContent = 'Procesando…';
        micBtn.classList.add('processing');
        break;
      case 'confirming':
        statusLabel.textContent = 'Di "sí" o "no"';
        statusLabel.classList.add('listening');
        micBtn.classList.add('listening');
        break;
    }
  };

  /* ── Confirmación ── */
  const showConfirm = ev => {
    const date = NLP.humanDate(ev.date);
    const time = ev.time
      ? `<strong>${ev.time}</strong>`
      : ev.block ? `por la <strong>${ev.block}</strong>` : '<small>sin hora fija</small>';
    const rem = ev.reminders.length
      ? `<br><small>🔔 ${ev.reminders.map(r => r >= 60 ? `${r/60}h` : `${r}min`).join(', ')} antes</small>`
      : '';
    const rep = ev.repeat ? `<br><small>🔁 ${ev.repeat}</small>` : '';
    confirmPrev.innerHTML = `<strong>${ev.title}</strong><br>${date} ${time}${rem}${rep}`;
    confirmCard.hidden = false;
  };

  return { toast, setMode, showConfirm, transcriptEl, statusLabel };
})();

/* ══════════════════════════════════════════════════════════
   PANEL DE EVENTOS
══════════════════════════════════════════════════════════ */
const Panel = (() => {
  const $       = id => document.getElementById(id);
  const panel   = $('panel');
  const overlay = $('overlay');
  let filter    = 'hoy';

  const open  = () => { panel.classList.add('open'); overlay.classList.add('on'); render(); };
  const close = () => { panel.classList.remove('open'); overlay.classList.remove('on'); };

  const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

  const render = async () => {
    const all   = await DB.getAll();
    const hoy   = new Date(); hoy.setHours(0,0,0,0);
    const todayS = hoy.toISOString().split('T')[0];
    const tomS   = addDays(hoy, 1).toISOString().split('T')[0];
    const weekS  = addDays(hoy, 7).toISOString().split('T')[0];

    let evs;
    switch (filter) {
      case 'hoy':        evs = all.filter(e => e.date === todayS && e.status !== 'pending'); break;
      case 'mañana':     evs = all.filter(e => e.date === tomS);   break;
      case 'semana':     evs = all.filter(e => e.date >= todayS && e.date <= weekS); break;
      case 'pendientes': evs = all.filter(e => e.status === 'pending'); break;
      default:           evs = all;
    }
    evs.sort((a, b) => (a.date + (a.time || '99:99')).localeCompare(b.date + (b.time || '99:99')));

    const list = $('eventsList');
    if (!evs.length) {
      list.innerHTML = '<p class="empty-state">Nada aquí aún.<br>Pulsa el micrófono y habla.</p>';
      return;
    }

    const groups = {};
    evs.forEach(e => {
      const k = e.status === 'pending' ? 'Pendientes' : NLP.humanDate(e.date);
      (groups[k] = groups[k] || []).push(e);
    });

    list.innerHTML = '';
    for (const [day, items] of Object.entries(groups)) {
      const g = document.createElement('div');
      g.className = 'day-group';
      g.innerHTML = `<p class="day-label">${day}</p>`;
      items.forEach(ev => {
        const meta = [
          ev.reminders.length ? `🔔 ${ev.reminders.join(',')}min` : '',
          ev.repeat ? `🔁 ${ev.repeat}` : ''
        ].filter(Boolean).join(' · ');
        const d = document.createElement('div');
        d.className = `ev-item${ev.status === 'pending' ? ' pending' : ''}`;
        d.innerHTML = `
          <div class="ev-time ${!ev.time ? 'no-t' : ''}">${ev.time || '—'}</div>
          <div class="ev-info">
            <div class="ev-title">${ev.title}</div>
            ${meta ? `<div class="ev-meta">${meta}</div>` : ''}
          </div>
          <button class="ev-del" data-id="${ev.id}" title="Eliminar">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14H6L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4h6v2"/>
            </svg>
          </button>`;
        d.querySelector('.ev-del').addEventListener('click', async e => {
          await DB.remove(e.currentTarget.dataset.id);
          render();
          UI.toast('Evento eliminado', 'inf');
        });
        g.appendChild(d);
      });
      list.appendChild(g);
    }
  };

  const init = () => {
    $('btnPanel').addEventListener('click', open);
    $('btnClose').addEventListener('click', close);
    overlay.addEventListener('click', close);
    document.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        filter = t.dataset.f;
        render();
      });
    });
  };

  return { init, render };
})();

/* ══════════════════════════════════════════════════════════
   APP — Orquestador
══════════════════════════════════════════════════════════ */
const App = (() => {
  let mode    = 'idle';
  let pending = null;
  let recRef  = null;

  /* ── Helpers de modo ── */
  const setMode = m => { mode = m; UI.setMode(m); };

  /* ── Click en micrófono ── */
  const onMicClick = () => {
    if (!SR) {
      UI.toast('Voz no disponible. Usa el campo de texto.', 'err', 5000);
      return;
    }
    Voice.cancel();

    if (mode === 'confirming') { listenConfirm(); return; }
    if (mode === 'listening')  { SR.abort(); setMode('idle'); return; }

    setMode('listening');
    recRef = SR.start(
      text => {
        recRef = null;
        UI.transcriptEl.textContent = text;
        processText(text);
      },
      err => {
        recRef = null;
        console.log('[App] SR err:', err);
        if (err === 'not-allowed') {
          UI.toast('Permiso de micrófono denegado. Actívalo en ajustes del navegador.', 'err', 6000);
        } else if (err === 'network') {
          UI.toast('Sin conexión. El reconocimiento de voz requiere internet en Chrome.', 'err', 6000);
        }
        // no-speech / silent → volver a idle sin ruido
        setMode('idle');
      }
    );
  };

  /* ── Procesar texto ── */
  const processText = text => {
    setMode('processing');
    const ev = NLP.parse(text);
    pending  = ev;
    setTimeout(() => {
      UI.showConfirm(ev);
      setMode('confirming');
      Voice.speak(NLP.toSpeech(ev), () => listenConfirm());
    }, 300);
  };

  /* ── Escuchar confirmación ── */
  const listenConfirm = () => {
    if (!SR) return;
    if (recRef) { SR.abort(); recRef = null; }
    setTimeout(() => {
      recRef = SR.start(
        text => {
          recRef = null;
          const n = NLP.norm(text);
          console.log('[App] confirm escuchado:', n);
          if (CONFIRM_YES.some(w => n.includes(w)))     saveEvent();
          else if (CONFIRM_NO.some(w => n.includes(w))) cancelEvent();
          else UI.toast('Di "sí" para guardar o "no" para cancelar', 'inf');
        },
        () => { recRef = null; /* timeout silencioso */ }
      );
    }, 200);
  };

  /* ── Guardar ── */
  const saveEvent = async () => {
    Voice.cancel();
    if (recRef) { SR.abort(); recRef = null; }
    if (!pending) { setMode('idle'); return; }
    try {
      await DB.add(pending);
      Notif.schedule(pending);
      UI.toast(`✓ ${pending.title} guardado`, 'ok');
      Voice.speak(`Guardado. ${pending.title}.`);
      pending = null;
      setMode('idle');
    } catch(e) {
      console.error('[DB]', e);
      UI.toast('Error al guardar', 'err');
      setMode('idle');
    }
  };

  /* ── Cancelar ── */
  const cancelEvent = () => {
    Voice.cancel();
    if (recRef) { SR.abort(); recRef = null; }
    pending = null;
    setMode('idle');
    Voice.speak('Cancelado.');
    UI.toast('Cancelado', 'inf');
  };

  /* ── Texto fallback ── */
  const submitText = () => {
    const val = document.getElementById('textInput').value.trim();
    if (!val) return;
    document.getElementById('textInput').value = '';
    UI.transcriptEl.textContent = val;
    if (mode === 'confirming') {
      const n = NLP.norm(val);
      if (CONFIRM_YES.some(w => n.includes(w)))     saveEvent();
      else if (CONFIRM_NO.some(w => n.includes(w))) cancelEvent();
      else processText(val);
    } else {
      processText(val);
    }
  };

  /* ── Init ── */
  const init = async () => {
    await DB.open();
    Panel.init();
    Notif.request();

    document.getElementById('micBtn').addEventListener('click', onMicClick);
    document.getElementById('btnSend').addEventListener('click', submitText);
    document.getElementById('textInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); submitText(); }
    });
    document.getElementById('btnYes').addEventListener('click', saveEvent);
    document.getElementById('btnNo').addEventListener('click',  cancelEvent);

    // Espacio como atajo de teclado (escritorio)
    document.addEventListener('keydown', e => {
      if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault();
        onMicClick();
      }
    });

    // Cargar voces en background
    if (window.speechSynthesis) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => {};
    }

    if (!SR) {
      document.getElementById('statusLabel').textContent = 'Escribe tu evento abajo';
    }

    console.log('[App] listo ✓');
  };

  return { init, saveEvent, cancelEvent };
})();

document.addEventListener('DOMContentLoaded', App.init);
