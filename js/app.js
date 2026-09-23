import { ReproductorLocal, ReproductorYouTube, GrupoSincronizado } from './reproductor.js';

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const crear = (etiqueta, clase, texto) => {
  const el = document.createElement(etiqueta);
  if (clase) el.className = clase;
  if (texto !== undefined) el.textContent = texto;
  return el;
};

const hms = (s) => {
  if (!isFinite(s)) return '--:--';
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return (h ? `${h}:` : '') + `${m}:${String(s % 60).padStart(2, '0')}`;
};

const estado = {
  curso: null,
  dia: null,
  sesion: null,
  grupo: null,
  fuentes: [],     // [{rep, desfase, duracion, el, datos}]
  pistas: [],      // [{etiqueta, caja, fuentes}] un visor por cámara o pantalla
  ampliada: null,  // pista mostrada ahora mismo en grande
  preferida: null, // la que el usuario quiere grande; vuelve en cuanto tenga imagen
  carga: 0,        // identifica la carga en curso: descarta las que quedan obsoletas
  origen: null,    // 'local' o 'youtube'
};

/* YouTube por defecto: está en todas partes y no depende de tener el disco.
   Los archivos locales siguen en el selector, para verlos sin conexión. */
function origenPorDefecto() {
  return 'youtube';
}

function leerPreferencia(clave) {
  try { return localStorage.getItem(clave); } catch { return null; }
}
function guardarPreferencia(clave, valor) {
  try { localStorage.setItem(clave, valor); } catch { /* navegación privada */ }
}

/* ---------- carga ---------- */

async function iniciar() {
  estado.curso = await (await fetch('data/curso.json')).json();
  $('#titulo-curso').textContent = estado.curso.curso;
  dibujarDias();
  estado.origen = leerPreferencia('origen') ?? origenPorDefecto();
  $('#origen').value = estado.origen;
  const guardado = leerPreferencia('ultima-sesion');
  const [dia, sesion] = guardado ? JSON.parse(guardado) : [0, 0];
  abrirSesion(estado.curso.dias[dia] ?? estado.curso.dias[0],
              (estado.curso.dias[dia] ?? estado.curso.dias[0]).sesiones[sesion] ?? null);
}

function dibujarDias() {
  const nav = $('#dias');
  nav.replaceChildren();
  for (const dia of estado.curso.dias) {
    const b = crear('button', 'dia');
    b.append(crear('strong', null, dia.etiqueta), crear('span', null, dia.titulo));
    b.onclick = () => abrirSesion(dia, dia.sesiones[0]);
    b.dataset.id = dia.id;
    nav.append(b);
  }
}

function dibujarIndice() {
  const panel = $('#indice');
  panel.replaceChildren();
  const filtro = $('#buscar').value.trim().toLowerCase();

  for (const sesion of estado.dia.sesiones) {
    const capitulos = sesion.capitulos.filter(
      (c) => !filtro || (c.titulo + ' ' + (c.resumen || '')).toLowerCase().includes(filtro));
    if (filtro && !capitulos.length) continue;

    const bloque = crear('section', 'sesion');
    const cab = crear('button', 'cabecera-sesion');
    cab.append(crear('span', 'n', `Sesión ${sesion.n}`),
               crear('span', 'dur', hms(sesion.duracion)));
    cab.onclick = () => abrirSesion(estado.dia, sesion, 0);
    if (sesion === estado.sesion) cab.classList.add('activa');
    bloque.append(cab);

    if (!capitulos.length) {
      bloque.append(crear('p', 'vacio', 'Sin índice de temas.'));
    }
    for (const cap of capitulos) {
      const b = crear('button', 'capitulo');
      b.append(crear('span', 'tiempo', hms(cap.t)),
               crear('span', 'titulo', cap.titulo));
      if (cap.resumen) b.append(crear('span', 'resumen', cap.resumen));
      b.onclick = () => {
        if (sesion !== estado.sesion) abrirSesion(estado.dia, sesion, cap.t);
        else { estado.grupo.irA(cap.t); estado.grupo.reproducir(); }
      };
      b.dataset.t = cap.t;
      bloque.append(b);
    }
    panel.append(bloque);
  }
}

/* ---------- reproductor ---------- */

async function abrirSesion(dia, sesion, tInicial = 0) {
  const carga = ++estado.carga;
  estado.grupo?.detener();   // corta el bucle y suelta los vídeos anteriores
  estado.grupo = null;
  estado.dia = dia;
  estado.sesion = sesion;
  for (const b of $('#dias').children) {
    b.classList.toggle('activo', b.dataset.id === dia.id);
    // En el móvil la fila de días se desplaza: que el activo quede a la vista.
    if (b.dataset.id === dia.id) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  guardarPreferencia('ultima-sesion',
    JSON.stringify([estado.curso.dias.indexOf(dia), dia.sesiones.indexOf(sesion)]));
  dibujarIndice();
  if (!sesion) return;

  $('#nombre-sesion').textContent = `${dia.etiqueta} · Sesión ${sesion.n}`;
  const escenario = $('#videos');
  escenario.replaceChildren();
  estado.fuentes = [];

  // Los vídeos con la misma etiqueta son tramos consecutivos de la misma cámara:
  // comparten visor y se van encadenando según el tiempo de la sesión.
  estado.pistas = [];
  for (const datos of sesion.fuentes) {
    let pista = estado.pistas.find((p) => p.etiqueta === datos.etiqueta);
    if (!pista) {
      const caja = crear('div', 'caja-video');
      const hueco = crear('div', 'hueco', 'Sin imagen en este tramo');
      // Capa transparente por encima del vídeo: recoge los clics, que de otro modo
      // se quedaría el iframe de YouTube (y pausaría solo ese vídeo, desincronizándolo).
      const capa = crear('div', 'capa');
      const etiqueta = crear('button', 'etiqueta', datos.etiqueta);
      etiqueta.title = 'Intercambiar con la imagen grande';
      caja.append(hueco, capa, etiqueta);
      escenario.append(caja);
      pista = { etiqueta: datos.etiqueta, caja, fuentes: [] };
      // En la miniatura, intercambia; en la imagen grande, reproduce o pausa.
      caja.onclick = () => {
        if (pista !== estado.ampliada) ampliar(pista, true);
        else estado.grupo?.alternar();
      };
      estado.pistas.push(pista);
    }

    const deYouTube = estado.origen === 'youtube' && datos.youtube;
    let elemento, rep;
    if (deYouTube) {
      elemento = crear('div', 'segmento yt');
      rep = new ReproductorYouTube(elemento);
    } else {
      elemento = crear('video', 'segmento');
      elemento.playsInline = true;
      elemento.preload = 'metadata';
      rep = new ReproductorLocal(elemento);
    }
    pista.caja.insertBefore(elemento, pista.caja.querySelector('.capa'));

    const fuente = { rep, el: elemento, datos, pista, origen: deYouTube ? datos.youtube : datos.url,
                     desfase: datos.desfase, duracion: datos.duracion };
    pista.fuentes.push(fuente);
    estado.fuentes.push(fuente);
  }

  const fuentes = estado.fuentes;
  await Promise.all(fuentes.map((f) => f.rep.preparar(f.origen)));
  if (carga !== estado.carga) {          // mientras cargaba se ha pedido otra sesión
    for (const f of fuentes) { f.rep.pausar(); f.rep.soltar(); }
    return;
  }

  // Con YouTube la hora que da cada reproductor es menos fina: más margen antes de corregir.
  const hayYouTube = fuentes.some((f) => f.rep instanceof ReproductorYouTube);
  estado.grupo = new GrupoSincronizado(estado.fuentes, {
    toleranciaS: hayYouTube ? 0.6 : 0.3,
    alCambiar: refrescarControles,
  });
  estado.grupo.velocidad = Number($('#velocidad').value);
  const audible = estado.fuentes.find((f) => !f.datos.mudo) ?? estado.fuentes[0];
  estado.grupo.escuchar(audible.pista.fuentes, audible.pista.etiqueta);
  ampliar(audible.datos.principal ? audible.pista
          : estado.pistas.find((p) => p.fuentes.some((f) => f.datos.principal))
            ?? estado.pistas[0], true);
  estado.grupo.irA(tInicial);
  dibujarBotonesAudio();
  refrescarControles();
}

function ampliar(pista, elegidaPorElUsuario = false) {
  if (elegidaPorElUsuario) estado.preferida = pista;
  estado.ampliada = pista;
  for (const p of estado.pistas) p.caja.classList.toggle('grande', p === pista);
  $('#videos').classList.toggle('una-sola', estado.pistas.length === 1);
}

function dibujarBotonesAudio() {
  const caja = $('#audio');
  caja.replaceChildren(crear('span', 'etiqueta-control', 'Audio:'));
  for (const p of estado.pistas) {
    const b = crear('button', 'chip', p.etiqueta);
    b.onclick = () => estado.grupo.escuchar(p.fuentes, p.etiqueta);
    b.dataset.id = p.etiqueta;
    caja.append(b);
  }
}

/* En los huecos sin cámara pasa a grande una pista que sí tenga imagen,
 * y devuelve la elegida por el usuario en cuanto vuelve a tenerla. */
function ajustarVisor(g) {
  const conImagen = (p) => p.fuentes.some((f) => g.activa(f));
  const objetivo = estado.preferida && conImagen(estado.preferida)
    ? estado.preferida
    : estado.pistas.find(conImagen) ?? estado.preferida;
  if (objetivo && objetivo !== estado.ampliada) ampliar(objetivo);
}

function refrescarControles() {
  const g = estado.grupo;
  if (!g) return;
  ajustarVisor(g);
  $('#reproducir').textContent = g.reproduciendo ? '⏸' : '▶';
  $('#tiempo').textContent = `${hms(g.tiempo)} / ${hms(g.duracion)}`;
  const barra = $('#barra');
  if (document.activeElement !== barra) {
    barra.max = g.duracion;
    barra.value = g.tiempo;
  }
  for (const b of $('#audio').querySelectorAll('.chip')) {
    b.classList.toggle('activo', b.dataset.id === g.sonando);
  }
  // Resalta el capítulo en curso
  const activos = $('#indice').querySelectorAll('.capitulo');
  let actual = null;
  for (const b of activos) {
    b.classList.remove('sonando');
    if (Number(b.dataset.t) <= g.tiempo) actual = b;
  }
  const bloqueActivo = $('#indice').querySelector('.cabecera-sesion.activa');
  if (actual && bloqueActivo && bloqueActivo.parentElement.contains(actual)) {
    actual.classList.add('sonando');
  }
}

/* ---------- controles ---------- */

function conectarControles() {
  $('#reproducir').onclick = () => estado.grupo?.alternar();
  $('#barra').oninput = (e) => estado.grupo?.irA(Number(e.target.value));
  $('#velocidad').onchange = (e) => {
    if (estado.grupo) estado.grupo.velocidad = Number(e.target.value);
  };
  $('#buscar').oninput = dibujarIndice;
  $('#origen').onchange = (e) => {
    estado.origen = e.target.value;
    guardarPreferencia('origen', estado.origen);
    // Reabre la misma sesión en el mismo punto con el nuevo origen.
    if (estado.sesion) abrirSesion(estado.dia, estado.sesion, estado.grupo?.tiempo ?? 0);
  };
  $('#atras').onclick = () => estado.grupo?.irA(estado.grupo.tiempo - 10);
  $('#adelante').onclick = () => estado.grupo?.irA(estado.grupo.tiempo + 10);

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    const g = estado.grupo;
    if (!g) return;
    const saltos = { ArrowLeft: -10, ArrowRight: 10, KeyJ: -30, KeyL: 30 };
    if (e.code === 'Space' || e.code === 'KeyK') { e.preventDefault(); g.alternar(); }
    else if (e.code in saltos) { e.preventDefault(); g.irA(g.tiempo + saltos[e.code]); }
    else if (e.code === 'KeyF') $('#videos').requestFullscreen?.();
    else if (e.code === 'Tab' && estado.pistas.length > 1) {
      e.preventDefault();
      const i = estado.pistas.indexOf(estado.ampliada);
      ampliar(estado.pistas[(i + 1) % estado.pistas.length], true);
    }
  });

  setInterval(refrescarControles, 250);
}

conectarControles();
iniciar();
