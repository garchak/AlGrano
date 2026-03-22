/* ══════════════════════════════════════════════════════════════
   AL GRANO — app.js
   Motor principal: voz → NLP → confirmación → IndexedDB
══════════════════════════════════════════════════════════════ */

'use strict';

// ── Registro del Service Worker ──────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js')
      .then(r => console.log('[SW] Registrado:', r.scope))
      .catch(e => console.warn('[SW] Error:', e));
  });
}

/* ══════════════════════════════════════════════════════════════
   CONFIGURACIÓN CENTRAL
══════════════════════════════════════════════════════════════ */
const CONFIG = {
  db: {
    name: 'algrano-db',
    version: 1,
    store: 'eventos'
  },
  timeBlocks: {
    mañana:   '09:00',
    tarde:    '16:00',
    noche:    '21:00',
    mediodía: '13:00',
    mediodia: '13:00',
  },
  voice: {
    lang: 'es-ES',
    interimResults: true,
    maxAlternatives: 3,
  },
  confirmWords: {
    yes: ['sí', 'si', 'vale', 'correcto', 'ok', 'afirmativo', 'guardar', 'adelante', 'perfecto', 'claro'],
    no:  ['no', 'cancelar', 'cancel', 'borrar', 'descartar', 'olvida', 'olvídalo'],
  }
};

/* ══════════════════════════════════════════════════════════════
   BASE DE DATOS — IndexedDB
══════════════════════════════════════════════════════════════ */
const DB = (() => {
  let _db = null;

  const open = () => new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open(CONFIG.db.name, CONFIG.db.version);

    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CONFIG.db.store)) {
        const store = db.createObjectStore(CONFIG.db.store, { keyPath: 'id' });
        store.createIndex('date', 'date', { unique: false });
        store.createIndex('status', 'status', { unique: false });
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(e.target.error);
  });

  const add = async (evento) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(CONFIG.db.store, 'readwrite');
      const store = tx.objectStore(CONFIG.db.store);
      const req   = store.add(evento);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  };

  const getAll = async () => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(CONFIG.db.store, 'readonly');
      const store = tx.objectStore(CONFIG.db.store);
      const req   = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  };

  const remove = async (id) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(CONFIG.db.store, 'readwrite');
      const store = tx.objectStore(CONFIG.db.store);
      const req   = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  };

  return { open, add, getAll, remove };
})();

/* ══════════════════════════════════════════════════════════════
   PARSER DE LENGUAJE NATURAL (basado en reglas, español)
══════════════════════════════════════════════════════════════ */
const NLP = (() => {

  // ── Normalización ────────────────────────────
  const normalize = (text) =>
    text.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // sin tildes para matching
      .replace(/[¿¡]/g, '')
      .trim();

  // ── Detección de fecha ───────────────────────
  const parseDate = (norm, originalText) => {
    const now  = new Date();
    const hoy  = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // hoy / mañana / pasado mañana
    if (/\bhoy\b/.test(norm))            return new Date(hoy);
    if (/\bpasado manana\b/.test(norm))  return addDays(hoy, 2);
    if (/\bmanana\b/.test(norm))         return addDays(hoy, 1);

    // días de la semana
    const diasSemana = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
    const diasRegex  = /\b(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/;
    const matchDia   = diasRegex.exec(norm);
    if (matchDia) {
      const targetDay = diasSemana.indexOf(matchDia[1]);
      const today     = now.getDay();
      let diff        = targetDay - today;
      if (diff <= 0) diff += 7;       // siempre hacia adelante
      return addDays(hoy, diff);
    }

    // "el 15" "el día 5" "el 3 de mayo"
    const meses = ['enero','febrero','marzo','abril','mayo','junio',
                   'julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const matchFechaCorta = /\bel (?:dia )?(\d{1,2})(?:\s+de\s+(\w+))?\b/.exec(norm);
    if (matchFechaCorta) {
      const dia = parseInt(matchFechaCorta[1]);
      let mes   = now.getMonth();
      if (matchFechaCorta[2]) {
        const mIdx = meses.findIndex(m => m === matchFechaCorta[2]);
        if (mIdx >= 0) mes = mIdx;
      }
      const d = new Date(now.getFullYear(), mes, dia);
      if (d < hoy) d.setFullYear(d.getFullYear() + 1); // año siguiente si ya pasó
      return d;
    }

    return null; // sin fecha detectada
  };

  // ── Detección de hora ────────────────────────
  const parseTime = (norm) => {
    // Bloque de tiempo primero (mañana por la tarde, etc.)
    for (const [block, time] of Object.entries(CONFIG.timeBlocks)) {
      const regex = new RegExp(`\\bpor la ${block}\\b|\\bpor la ${block}\\b|\\bde ${block}\\b|\\besta ${block}\\b`);
      if (regex.test(norm) || norm.includes(`por la ${block}`) || norm.includes(`esta ${block}`)) {
        return { time, block };
      }
    }

    // "a las nueve y media" → número escrito
    const numerosEscritos = {
      'una':'01','dos':'02','tres':'03','cuatro':'04','cinco':'05','seis':'06',
      'siete':'07','ocho':'08','nueve':'09','diez':'10','once':'11','doce':'12',
      'trece':'13','catorce':'14','quince':'15','dieciseis':'16','diecisiete':'17',
      'dieciocho':'18','diecinueve':'19','veinte':'20','veintiuna':'21',
      'veintidos':'22','veintitres':'23'
    };

    const minutosEscritos = {
      'y cuarto':'15','y media':'30','menos cuarto':'45'
    };

    // "a las X" con número escrito
    for (const [escrito, num] of Object.entries(numerosEscritos)) {
      const r = new RegExp(`\\ba las ${escrito}\\b`);
      if (r.test(norm)) {
        let mins = '00';
        for (const [mEscrito, mNum] of Object.entries(minutosEscritos)) {
          if (norm.includes(`${escrito} ${mEscrito}`)) { mins = mNum; break; }
        }
        const h = parseInt(num);
        const hFinal = (h < 8 && !norm.includes('manana')) ? h + 12 : h; // heurística am/pm
        return { time: `${String(hFinal).padStart(2,'0')}:${mins}`, block: null };
      }
    }

    // "a las 9:30" "a las 9" "las 9:30" "9:30"
    const matchHora = /\b(?:a las?|las?)?\s*(\d{1,2})(?::(\d{2}))?\b/.exec(norm);
    if (matchHora) {
      let h    = parseInt(matchHora[1]);
      const m  = matchHora[2] ? parseInt(matchHora[2]) : 0;
      // Si la hora es ambigua (< 8) y no se menciona "de la mañana", asumir PM
      if (h >= 1 && h < 8 && !norm.includes('manana') && !norm.includes('mañana')) h += 12;
      if (h >= 0 && h < 24 && m >= 0 && m < 60) {
        return { time: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`, block: null };
      }
    }

    // Bloques sin "por la"
    for (const [block, time] of Object.entries(CONFIG.timeBlocks)) {
      if (norm.includes(block)) return { time, block };
    }

    return null;
  };

  // ── Detección de recordatorios ───────────────
  const parseReminders = (norm) => {
    const reminders = [];

    // "avisar / avisame / recuérdame X minutos antes"
    const matchMin = /\b(?:avisar?me?|recuerdame?|aviso|alarma)\s+(?:una?\s+)?(\d+|una|media|dos|tres)\s+minuto(?:s)?\s+antes\b/g;
    let m;
    while ((m = matchMin.exec(norm)) !== null) {
      const val = parseInt(m[1]) || (m[1] === 'media' ? 30 : m[1] === 'una' ? 1 : 0);
      if (val > 0) reminders.push(val);
    }

    // "avisar X hora(s) antes"
    const matchHora = /\b(?:avisar?me?|recuerdame?|aviso|alarma)\s+(una?|dos|tres|\d+)\s+hora(?:s)?\s+antes\b/g;
    while ((m = matchHora.exec(norm)) !== null) {
      const val = m[1] === 'una' ? 60 : parseInt(m[1]) * 60 || 60;
      reminders.push(val);
    }

    // Atajos comunes
    if (/\b15 minutos antes\b/.test(norm) && !reminders.includes(15)) reminders.push(15);
    if (/\bmedia hora antes\b/.test(norm)  && !reminders.includes(30)) reminders.push(30);
    if (/\buna hora antes\b/.test(norm)    && !reminders.includes(60)) reminders.push(60);

    return [...new Set(reminders)]; // sin duplicados
  };

  // ── Detección de repetición ──────────────────
  const parseRepeat = (norm) => {
    if (/\btodos los dias\b|\bcada dia\b/.test(norm))     return 'daily';
    if (/\btodas las semanas\b|\bcada semana\b/.test(norm)) return 'weekly';
    const diasSemana = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
    const m = /\bcada (lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.exec(norm);
    if (m) return `weekly:${diasSemana.indexOf(m[1])}`;
    return null;
  };

  // ── Detección de "sin hora" ──────────────────
  const isPending = (norm) =>
    /\bluego\b|\bmas tarde\b|\bdespues\b/.test(norm) ||
    (!parseTime(norm) && !parseDate(norm));

  // ── Extracción del título del evento ─────────
  const extractTitle = (text, norm) => {
    let title = text;

    // Eliminar palabras temporales comunes para quedarnos con el título
    const removePatterns = [
      /\bhoy\b/gi, /\bmanana\b/gi, /\bpasado manana\b/gi,
      /\besta? (manana|tarde|noche|mediod[ií]a)\b/gi,
      /\bpor la (manana|tarde|noche)\b/gi,
      /\bde la (manana|tarde|noche)\b/gi,
      /\ba las? \d{1,2}(?::\d{2})?\b/gi,
      /\bel (dia )?\d{1,2}(\s+de \w+)?\b/gi,
      /\b(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/gi,
      /\b(?:avisar?me?|recuerdame?|aviso|alarma)\s+.*?\s+antes\b/gi,
      /\btodos los dias\b|\bcada dia\b|\bcada \w+\b/gi,
      /\bluego\b|\bmas tarde\b|\bdespues\b/gi,
      /\ba las (una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce).*?\b/gi,
      /[¿¡]/g
    ];

    removePatterns.forEach(p => { title = title.replace(p, ' '); });

    title = title
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(y|de|el|la|un|una|con|para|que)\s+/i, '');

    // Primera letra mayúscula
    return title.charAt(0).toUpperCase() + title.slice(1) || 'Evento';
  };

  // ── Función principal de parseo ──────────────
  const parse = (text) => {
    const norm   = normalize(text);
    const fecha  = parseDate(norm, text);
    const hora   = parseTime(norm);
    const repeat = parseRepeat(norm);
    const reminders = parseReminders(norm);
    const pending   = !fecha && !hora;
    const title     = extractTitle(text, norm);

    const now = new Date();
    const eventDate = fecha
      ? fecha
      : new Date(now.getFullYear(), now.getMonth(), now.getDate()); // hoy por defecto

    const isoDate = eventDate.toISOString().split('T')[0];

    return {
      id:        `ev_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
      title:     title,
      date:      isoDate,
      time:      hora?.time   ?? null,
      block:     hora?.block  ?? null,
      reminders: reminders.length ? reminders : [],
      repeat:    repeat,
      status:    (pending && !fecha) ? 'pending' : 'scheduled',
      createdAt: Date.now(),
      rawInput:  text
    };
  };

  // ── Merge (para frases encadenadas) ─────────
  const merge = (base, extra) => {
    const norm  = normalize(extra);
    const hora  = parseTime(norm);
    const rems  = parseReminders(norm);
    const rep   = parseRepeat(norm);
    const fecha = parseDate(norm, extra);

    if (hora)  { base.time = hora.time; base.block = hora.block; }
    if (fecha) { base.date = fecha.toISOString().split('T')[0]; }
    if (rems.length)  base.reminders = [...new Set([...base.reminders, ...rems])];
    if (rep)          base.repeat    = rep;
    if (hora || fecha) base.status   = 'scheduled';
    return base;
  };

  // ── Generar frase de confirmación ───────────
  const toSpeech = (ev) => {
    const dateStr  = humanDate(ev.date);
    const timeStr  = ev.time  ? `a las ${ev.time}` : ev.block ? `por la ${ev.block}` : '';
    const remStr   = ev.reminders.length
      ? `con aviso ${ev.reminders.map(r => r >= 60 ? `${r/60} hora${r>60?'s':''}` : `${r} minutos`).join(' y ')} antes`
      : '';
    const repStr   = ev.repeat ? `repetiéndose ${humanRepeat(ev.repeat)}` : '';
    const parts    = [ev.title, dateStr, timeStr, remStr, repStr].filter(Boolean);
    return `Evento: ${parts.join(', ')}. ¿Lo guardo?`;
  };

  const humanDate = (isoDate) => {
    const d   = new Date(isoDate + 'T12:00:00');
    const hoy = new Date(); hoy.setHours(12,0,0,0);
    const man = new Date(hoy); man.setDate(man.getDate() + 1);
    if (d.toDateString() === hoy.toDateString()) return 'hoy';
    if (d.toDateString() === man.toDateString()) return 'mañana';
    const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    const mes  = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    return `el ${dias[d.getDay()]} ${d.getDate()} de ${mes[d.getMonth()]}`;
  };

  const humanRepeat = (rep) => {
    if (rep === 'daily')  return 'todos los días';
    if (rep === 'weekly') return 'cada semana';
    if (rep.startsWith('weekly:')) {
      const dias = ['los domingos','los lunes','los martes','los miércoles','los jueves','los viernes','los sábados'];
      return dias[parseInt(rep.split(':')[1])];
    }
    return rep;
  };

  const addDays = (date, n) => {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  };

  return { parse, merge, toSpeech, humanDate };
})();

// (Arreglo: addDays estaba en NLP scope pero también se usa en parseDate que está dentro)
// Ya está bien — addDays es closure local dentro de NLP.

/* ══════════════════════════════════════════════════════════════
   SÍNTESIS DE VOZ
══════════════════════════════════════════════════════════════ */
const Voice = (() => {
  let speaking = false;

  const speak = (text, onEnd) => {
    if (!('speechSynthesis' in window)) { onEnd && onEnd(); return; }
    window.speechSynthesis.cancel();
    const utt  = new SpeechSynthesisUtterance(text);
    utt.lang   = 'es-ES';
    utt.rate   = 0.92;
    utt.pitch  = 1.0;
    utt.volume = 1.0;

    // Preferir voz femenina española si disponible
    const voices = window.speechSynthesis.getVoices();
    const pref   = voices.find(v => v.lang.startsWith('es') && v.name.toLowerCase().includes('monica'))
                || voices.find(v => v.lang.startsWith('es') && !v.localService === false)
                || voices.find(v => v.lang.startsWith('es'));
    if (pref) utt.voice = pref;

    utt.onstart = () => { speaking = true; };
    utt.onend   = () => { speaking = false; onEnd && onEnd(); };
    utt.onerror = () => { speaking = false; onEnd && onEnd(); };

    window.speechSynthesis.speak(utt);
  };

  const cancel = () => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    speaking = false;
  };

  const isSpeaking = () => speaking;

  return { speak, cancel, isSpeaking };
})();

/* ══════════════════════════════════════════════════════════════
   RECONOCIMIENTO DE VOZ
══════════════════════════════════════════════════════════════ */
const SpeechRec = (() => {
  const SRClass = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SRClass) return null;

  let rec      = null;
  let onResult = null;
  let onEnd    = null;
  let active   = false;

  const create = () => {
    rec = new SRClass();
    rec.lang            = CONFIG.voice.lang;
    rec.interimResults  = CONFIG.voice.interimResults;
    rec.maxAlternatives = CONFIG.voice.maxAlternatives;
    rec.continuous      = false;

    rec.onresult = (e) => {
      let interim = '', final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final   += e.results[i][0].transcript;
        else                       interim += e.results[i][0].transcript;
      }
      onResult && onResult({ interim, final });
    };

    rec.onend  = () => { active = false; onEnd && onEnd(); };
    rec.onerror = (e) => {
      console.warn('[SR] Error:', e.error);
      active = false;
      onEnd && onEnd(e.error);
    };
  };

  const start = (resultCb, endCb) => {
    onResult = resultCb;
    onEnd    = endCb;
    create();
    try { rec.start(); active = true; }
    catch(e) { console.warn('[SR] No se pudo iniciar:', e); }
  };

  const stop = () => {
    if (rec && active) { try { rec.stop(); } catch(e) {} }
    active = false;
  };

  const isActive = () => active;

  return { start, stop, isActive };
})();

/* ══════════════════════════════════════════════════════════════
   NOTIFICACIONES
══════════════════════════════════════════════════════════════ */
const Notif = (() => {
  const request = async () => {
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  };

  const schedule = (evento) => {
    if (!evento.time || !evento.reminders.length) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const [h, m]    = evento.time.split(':').map(Number);
    const eventDate = new Date(evento.date + 'T' + evento.time + ':00');

    evento.reminders.forEach(minsBefore => {
      const triggerTime = new Date(eventDate.getTime() - minsBefore * 60 * 1000);
      const now         = Date.now();
      const delay       = triggerTime.getTime() - now;

      if (delay > 0 && delay < 24 * 60 * 60 * 1000) { // máximo 24h
        setTimeout(() => {
          new Notification(`⏰ ${evento.title}`, {
            body: `En ${minsBefore} minutos`,
            icon: 'icons/icon-192.png',
            tag:  `${evento.id}-${minsBefore}`
          });
        }, delay);
      }
    });
  };

  return { request, schedule };
})();

/* ══════════════════════════════════════════════════════════════
   INTERFAZ DE USUARIO
══════════════════════════════════════════════════════════════ */
const UI = (() => {

  // ── Referencias DOM ──────────────────────────
  const micBtn        = document.getElementById('micBtn');
  const statusLabel   = document.getElementById('statusLabel');
  const transcriptEl  = document.getElementById('transcriptText');
  const confirmCard   = document.getElementById('confirmCard');
  const confirmPreview= document.getElementById('confirmPreview');
  const btnYes        = document.getElementById('btnYes');
  const btnNo         = document.getElementById('btnNo');
  const eventsPanel   = document.getElementById('eventsPanel');
  const eventsList    = document.getElementById('eventsList');
  const btnViewToggle = document.getElementById('btnViewToggle');
  const btnClosePanel = document.getElementById('btnClosePanel');
  const overlay       = document.getElementById('overlay');
  const toastContainer= document.getElementById('toastContainer');
  const dayTabs       = document.querySelectorAll('.day-tab');

  // ── Estado de la app ─────────────────────────
  let state = {
    mode:         'idle',    // idle | listening | processing | confirming
    pendingEvent: null,
    currentFilter:'hoy',
    allEvents:    [],
    confirmReady: false
  };

  // ── Toast helper ─────────────────────────────
  const toast = (msg, type = 'info', duration = 3000) => {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    toastContainer.appendChild(el);
    setTimeout(() => el.remove(), duration);
  };

  // ── Set mode ─────────────────────────────────
  const setMode = (mode) => {
    state.mode = mode;
    micBtn.classList.remove('listening', 'processing');
    statusLabel.classList.remove('listening');

    switch(mode) {
      case 'idle':
        statusLabel.textContent = 'Toca para hablar';
        transcriptEl.textContent = '';
        confirmCard.hidden = true;
        state.confirmReady = false;
        break;
      case 'listening':
        statusLabel.textContent = 'Escuchando…';
        statusLabel.classList.add('listening');
        micBtn.classList.add('listening');
        transcriptEl.textContent = '';
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
        state.confirmReady = true;
        break;
    }
  };

  // ── Mostrar confirmación ─────────────────────
  const showConfirm = (ev) => {
    const dateStr = NLP.humanDate(ev.date);
    const timeStr = ev.time  ? `<strong>${ev.time}</strong>` : ev.block ? `por la <strong>${ev.block}</strong>` : '';
    const remStr  = ev.reminders.length
      ? `<br><small>🔔 ${ev.reminders.map(r => r >= 60 ? `${r/60}h antes` : `${r}min antes`).join(', ')}</small>`
      : '';
    const repStr  = ev.repeat ? `<br><small>🔁 ${ev.repeat}</small>` : '';
    const statusBadge = ev.status === 'pending' ? `<br><small>⏳ Sin hora fija</small>` : '';

    confirmPreview.innerHTML =
      `<strong>${ev.title}</strong><br>${dateStr} ${timeStr}${remStr}${repStr}${statusBadge}`;

    confirmCard.hidden = false;
  };

  // ── Renderizar lista de eventos ──────────────
  const renderEvents = async () => {
    state.allEvents = await DB.getAll();
    const filter    = state.currentFilter;
    const now       = new Date();
    const hoyStr    = now.toISOString().split('T')[0];
    const manStr    = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1)
                        .toISOString().split('T')[0];

    let filtered;
    switch(filter) {
      case 'hoy':
        filtered = state.allEvents.filter(e => e.date === hoyStr && e.status !== 'pending');
        break;
      case 'mañana':
        filtered = state.allEvents.filter(e => e.date === manStr);
        break;
      case 'semana': {
        const fin = new Date(now.getFullYear(), now.getMonth(), now.getDate()+7)
                      .toISOString().split('T')[0];
        filtered  = state.allEvents.filter(e => e.date >= hoyStr && e.date <= fin);
        break;
      }
      case 'pendientes':
        filtered = state.allEvents.filter(e => e.status === 'pending');
        break;
      default:
        filtered = state.allEvents;
    }

    // Ordenar por fecha + hora
    filtered.sort((a, b) => {
      const da = a.date + (a.time || '99:99');
      const db = b.date + (b.time || '99:99');
      return da.localeCompare(db);
    });

    if (!filtered.length) {
      eventsList.innerHTML = `<p class="empty-state">Nada aquí aún.<br>Pulsa el micrófono y habla.</p>`;
      return;
    }

    // Agrupar por fecha
    const groups = {};
    filtered.forEach(ev => {
      const k = ev.status === 'pending' ? 'Pendientes' : NLP.humanDate(ev.date);
      if (!groups[k]) groups[k] = [];
      groups[k].push(ev);
    });

    eventsList.innerHTML = '';
    for (const [day, evs] of Object.entries(groups)) {
      const group = document.createElement('div');
      group.className = 'day-group';
      group.innerHTML = `<p class="day-group-title">${day}</p>`;
      evs.forEach(ev => {
        const item = document.createElement('div');
        item.className = `event-item status-${ev.status}`;
        item.innerHTML = `
          <div class="event-time ${!ev.time ? 'no-time' : ''}">${ev.time || '—'}</div>
          <div class="event-info">
            <div class="event-title">${ev.title}</div>
            <div class="event-meta">${buildMeta(ev)}</div>
          </div>
          <button class="event-delete" data-id="${ev.id}" title="Eliminar" aria-label="Eliminar evento">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
              <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
            </svg>
          </button>`;
        group.appendChild(item);
      });
      eventsList.appendChild(group);
    }

    // Delete handlers
    eventsList.querySelectorAll('.event-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.dataset.id;
        await DB.remove(id);
        renderEvents();
        toast('Evento eliminado', 'info');
      });
    });
  };

  const buildMeta = (ev) => {
    const parts = [];
    if (ev.block)      parts.push(ev.block);
    if (ev.reminders.length) parts.push(`🔔 ${ev.reminders.join(', ')}min`);
    if (ev.repeat)     parts.push(`🔁`);
    return parts.join(' · ') || '';
  };

  // ── Panel toggle ─────────────────────────────
  const openPanel = () => {
    eventsPanel.classList.add('open');
    eventsPanel.setAttribute('aria-hidden', 'false');
    overlay.classList.add('visible');
    renderEvents();
  };

  const closePanel = () => {
    eventsPanel.classList.remove('open');
    eventsPanel.setAttribute('aria-hidden', 'true');
    overlay.classList.remove('visible');
  };

  // ── Inicializar listeners ────────────────────
  const init = () => {
    btnViewToggle.addEventListener('click', openPanel);
    btnClosePanel.addEventListener('click', closePanel);
    overlay.addEventListener('click', closePanel);

    dayTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        dayTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        state.currentFilter = tab.dataset.day;
        renderEvents();
      });
    });

    btnYes.addEventListener('click', () => App.saveEvent());
    btnNo.addEventListener('click',  () => App.cancelEvent());
  };

  return {
    init, setMode, showConfirm, renderEvents, toast,
    getState: () => state,
    setPendingEvent: (ev) => { state.pendingEvent = ev; },
    transcriptEl, statusLabel
  };
})();

/* ══════════════════════════════════════════════════════════════
   APP — Orquestador principal
══════════════════════════════════════════════════════════════ */
const App = (() => {

  let chainMode    = false;   // modo de frases encadenadas
  let chainTimeout = null;

  // ── Iniciar escucha ──────────────────────────
  const startListening = () => {
    if (!SpeechRec) {
      UI.toast('Tu navegador no soporta reconocimiento de voz', 'error');
      return;
    }

    Voice.cancel();
    const { mode, confirmReady } = UI.getState();

    // Si estamos en modo confirmar, escuchar respuesta
    if (mode === 'confirming') {
      listenForConfirmation();
      return;
    }

    UI.setMode('listening');

    SpeechRec.start(
      ({ interim, final }) => {
        if (interim) UI.transcriptEl.textContent = interim;
        if (final) {
          UI.transcriptEl.textContent = final;
          SpeechRec.stop();
          processInput(final);
        }
      },
      (err) => {
        if (err === 'no-speech') {
          UI.setMode('idle');
        } else if (err) {
          UI.toast('No te escuché. Inténtalo de nuevo.', 'error');
          UI.setMode('idle');
        }
      }
    );
  };

  // ── Procesar input de texto ──────────────────
  const processInput = (text) => {
    UI.setMode('processing');

    const state = UI.getState();
    let ev;

    if (chainMode && state.pendingEvent) {
      // Modo encadenado: fusionar con evento en progreso
      ev = NLP.merge({ ...state.pendingEvent }, text);
    } else {
      ev = NLP.parse(text);
    }

    chainMode = false;
    UI.setPendingEvent(ev);

    setTimeout(() => {
      const speech = NLP.toSpeech(ev);
      UI.showConfirm(ev);
      UI.setMode('confirming');
      Voice.speak(speech, () => {
        // Después de hablar, escuchar confirmación automáticamente
        listenForConfirmation();
      });
    }, 400);
  };

  // ── Escuchar confirmación ────────────────────
  const listenForConfirmation = () => {
    if (!SpeechRec) return;
    UI.setMode('confirming');

    SpeechRec.start(
      ({ final }) => {
        if (!final) return;
        SpeechRec.stop();
        const norm = final.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

        if (CONFIG.confirmWords.yes.some(w => norm.includes(w))) {
          saveEvent();
        } else if (CONFIG.confirmWords.no.some(w => norm.includes(w))) {
          cancelEvent();
        } else {
          // Puede ser una modificación ("cámbialo a las 10")
          UI.toast('No entendí. Di "sí" para guardar o "no" para cancelar.', 'info');
          listenForConfirmation();
        }
      },
      () => { /* timeout silencioso */ }
    );
  };

  // ── Guardar evento ───────────────────────────
  const saveEvent = async () => {
    Voice.cancel();
    SpeechRec && SpeechRec.stop();
    const state = UI.getState();
    const ev    = state.pendingEvent;
    if (!ev) { UI.setMode('idle'); return; }

    try {
      await DB.add(ev);
      Notif.schedule(ev);

      UI.setMode('idle');
      UI.setPendingEvent(null);
      chainMode = false;

      Voice.speak(`Guardado. ${ev.title}.`);
      UI.toast(`✓ ${ev.title} guardado`, 'success');
    } catch(e) {
      console.error('[DB] Error al guardar:', e);
      UI.toast('Error al guardar el evento', 'error');
      UI.setMode('idle');
    }
  };

  // ── Cancelar ─────────────────────────────────
  const cancelEvent = () => {
    Voice.cancel();
    SpeechRec && SpeechRec.stop();
    UI.setPendingEvent(null);
    chainMode = false;
    UI.setMode('idle');
    Voice.speak('Cancelado.');
    UI.toast('Cancelado', 'info');
  };

  // ── Init ─────────────────────────────────────
  const init = async () => {
    UI.init();
    await DB.open();
    await Notif.request();

    // Cargar voces (asíncrono en algunos navegadores)
    if (window.speechSynthesis) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.addEventListener('voiceschanged', () => {});
    }

    // Botón micrófono
    document.getElementById('micBtn').addEventListener('click', startListening);

    // Atajo de teclado: Espacio
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault();
        startListening();
      }
    });

    // Check soporte Speech Recognition
    if (!SpeechRec) {
      document.getElementById('statusLabel').textContent = 'Voz no disponible en este navegador';
    }
  };

  return { init, saveEvent, cancelEvent };
})();

// ── Arrancar ─────────────────────────────────
document.addEventListener('DOMContentLoaded', App.init);
