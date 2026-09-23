/* Capa de reproductor: aísla al resto de la aplicación de si el vídeo es un
 * <video> local o un reproductor de YouTube. Las dos clases comparten interfaz:
 *   preparar(origen) -> Promise, reproducir(), pausar(), irA(s), soltar(),
 *   tiempo, duracion, pausado, esperando, velocidad, silenciado
 */

export class ReproductorLocal {
  constructor(elemento) {
    this.el = elemento;        // un <video>
    this.listo = false;
  }

  preparar(url) {
    return new Promise((resolve) => {
      this.el.preload = 'metadata';
      this.el.src = url;
      const fin = () => { this.listo = true; resolve(); };
      this.el.addEventListener('loadedmetadata', fin, { once: true });
      this.el.addEventListener('error', fin, { once: true });  // que no bloquee la sesión
      this.el.load();
    });
  }

  reproducir() { return this.el.play().catch(() => {}); }
  pausar() { this.el.pause(); }
  irA(segundos) { this.el.currentTime = Math.max(0, segundos); }

  /* Vacía el elemento para que el navegador deje de descargar y de sonar.
   * Quitarlo del DOM no basta: sigue reproduciendo hasta que se recoge. */
  soltar() {
    this.listo = false;
    this.el.removeAttribute('src');
    this.el.load();
  }

  get tiempo() { return this.el.currentTime; }
  get duracion() { return this.el.duration || 0; }
  get pausado() { return this.el.paused; }
  get esperando() { return this.el.readyState < 3; }

  set velocidad(v) { this.el.playbackRate = v; }
  get velocidad() { return this.el.playbackRate; }

  set silenciado(s) { this.el.muted = s; }
  get silenciado() { return this.el.muted; }
}

/* ---------- YouTube ---------- */

let apiYouTube = null;

/* Carga una sola vez la IFrame Player API de YouTube. */
function cargarApiYouTube() {
  apiYouTube ??= new Promise((resolve) => {
    if (window.YT?.Player) return resolve(window.YT);
    const previo = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { previo?.(); resolve(window.YT); };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.append(script);
  });
  return apiYouTube;
}

// Estados de YT.PlayerState, sin depender de que la API ya esté cargada.
const YT_SIN_EMPEZAR = -1;
const YT_REPRODUCIENDO = 1;
const YT_CARGANDO = 3;
const YT_PREPARADO = 5;

export class ReproductorYouTube {
  constructor(elemento) {
    this.el = elemento;        // un <div> que contendrá el iframe
    this.listo = false;
    this.estado = -1;
    this.yt = null;
    // Aviso opcional con la calidad que YouTube está sirviendo ('hd1080', 'large'…).
    // No se puede fijar desde fuera, pero sí saberla: sirve para diagnosticar.
    this.alCambiarCalidad = null;
  }

  async preparar(idVideo) {
    const YT = await cargarApiYouTube();
    const hueco = document.createElement('div');
    this.el.append(hueco);
    await new Promise((resolve) => {
      this.yt = new YT.Player(hueco, {
        videoId: idVideo,
        width: '100%',
        height: '100%',
        playerVars: {
          controls: 0,          // los controles son los de la web
          disablekb: 1,         // el teclado lo gestiona la web
          rel: 0,
          playsinline: 1,
          iv_load_policy: 3,
          fs: 0,
          origin: location.origin,
        },
        events: {
          onReady: () => {
            this.listo = true;
            this.alCambiarCalidad?.(this.calidad);
            resolve();
          },
          onPlaybackQualityChange: (e) => this.alCambiarCalidad?.(e.data),
          onStateChange: (e) => {
            this.estado = e.data;
            // seekTo sobre un vídeo sin empezar lo pone en marcha: se deshace aquí.
            if (this.pausarTrasSalto && e.data === YT_REPRODUCIENDO) {
              this.pausarTrasSalto = false;
              this.yt.pauseVideo();
            }
          },
          onError: (e) => {
            console.warn(`YouTube ${idVideo}: error ${e.data}`);
            resolve();              // que un vídeo caído no bloquee la sesión
          },
        },
      });
    });
  }

  reproducir() {
    this.pausarTrasSalto = false;
    this.yt?.playVideo?.();
  }

  pausar() { this.yt?.pauseVideo?.(); }

  irA(segundos) {
    // YouTube arranca el vídeo si se salta antes de haberlo reproducido nunca.
    if (this.estado === YT_SIN_EMPEZAR || this.estado === YT_PREPARADO) {
      this.pausarTrasSalto = true;
    }
    this.yt?.seekTo?.(Math.max(0, segundos), true);
  }

  soltar() {
    this.listo = false;
    this.yt?.destroy?.();
    this.yt = null;
  }

  get tiempo() { return this.yt?.getCurrentTime?.() ?? 0; }
  get duracion() { return this.yt?.getDuration?.() ?? 0; }
  get calidad() { return this.yt?.getPlaybackQuality?.() ?? 'unknown'; }
  // Mientras carga cuenta como "en marcha": si no, se le pediría play una y otra vez.
  get pausado() { return this.estado !== YT_REPRODUCIENDO && this.estado !== YT_CARGANDO; }
  get esperando() { return this.estado === YT_CARGANDO; }

  set velocidad(v) { this.yt?.setPlaybackRate?.(v); }
  get velocidad() { return this.yt?.getPlaybackRate?.() ?? 1; }

  set silenciado(s) { s ? this.yt?.mute?.() : this.yt?.unMute?.(); }
  get silenciado() { return this.yt?.isMuted?.() ?? true; }
}

/* ---------- sincronía ---------- */

/* Sincroniza varias fuentes con un reloj común: el tiempo de la sesión.
 * Cada fuente tiene un desfase: el segundo de la sesión en que empieza su vídeo.
 * Una fuente cuyo tramo aún no ha llegado (o ya ha pasado) se queda en pausa.
 */
export class GrupoSincronizado {
  constructor(fuentes, { toleranciaS = 0.3, esperaEntreSaltosMs = 1500,
                         alCambiar = () => {} } = {}) {
    this.fuentes = fuentes;            // [{rep, desfase, duracion, el}]
    this.tolerancia = toleranciaS;
    // Tras corregir una fuente se le da un respiro: con YouTube cada salto provoca
    // una recarga, y corregir otra vez durante ella encadena saltos sin fin.
    this.esperaEntreSaltos = esperaEntreSaltosMs;
    this.alCambiar = alCambiar;
    this.maestra = fuentes[0];
    this.reproduciendo = false;
    this.vivo = true;
    this._bucle = this._bucle.bind(this);
    requestAnimationFrame(this._bucle);
  }

  /* Detiene el grupo y suelta los vídeos. Imprescindible al cambiar de sesión:
   * si no, este bucle sigue corrigiendo y relanzando vídeos ya retirados. */
  detener() {
    this.vivo = false;
    for (const f of this.fuentes) {
      f.rep.pausar();
      f.rep.soltar();
    }
  }

  /* Tiempo de la sesión, calculado siempre desde la fuente maestra. */
  get tiempo() { return this.maestra.rep.tiempo + this.maestra.desfase; }

  get duracion() {
    return Math.max(...this.fuentes.map((f) => f.desfase + f.duracion));
  }

  activa(fuente, t = this.tiempo) {
    return t >= fuente.desfase && t <= fuente.desfase + fuente.duracion;
  }

  irA(t) {
    const ahora = performance.now();
    for (const f of this.fuentes) {
      f.rep.irA(Math.min(Math.max(0, t - f.desfase), f.duracion));
      f.ultimoSalto = ahora;
    }
    this.alCambiar();
  }

  reproducir() {
    this.reproduciendo = true;
    for (const f of this.fuentes) if (this.activa(f)) f.rep.reproducir();
    this.alCambiar();
  }

  pausar() {
    this.reproduciendo = false;
    for (const f of this.fuentes) f.rep.pausar();
    this.alCambiar();
  }

  alternar() { this.reproduciendo ? this.pausar() : this.reproducir(); }

  set velocidad(v) { for (const f of this.fuentes) f.rep.velocidad = v; }
  get velocidad() { return this.maestra.rep.velocidad; }

  /* Solo suena una pista a la vez, aunque esté partida en varios tramos. */
  escuchar(fuentes, nombre) {
    const suenan = new Set(fuentes);
    for (const f of this.fuentes) f.rep.silenciado = !suenan.has(f);
    this.sonando = nombre;
    this.alCambiar();
  }

  /* Cada fotograma: corrige las fuentes que se hayan ido del tiempo de sesión. */
  _bucle() {
    if (!this.vivo) return;
    const t = this.tiempo;
    const ahora = performance.now();
    // Si la maestra se ha quedado cargando, las demás esperan con ella.
    const enMarcha = this.reproduciendo && !this.maestra.rep.esperando;

    for (const f of this.fuentes) {
      if (f === this.maestra) continue;
      const dentro = this.activa(f, t);
      f.el.classList.toggle('fuera-de-tramo', !dentro);
      if (!dentro) {
        if (!f.rep.pausado) f.rep.pausar();
        continue;
      }
      const esperado = t - f.desfase;
      if (Math.abs(f.rep.tiempo - esperado) > this.tolerancia
          && !f.rep.esperando
          && ahora - (f.ultimoSalto ?? 0) > this.esperaEntreSaltos) {
        f.rep.irA(esperado);
        f.ultimoSalto = ahora;
      }
      if (enMarcha && f.rep.pausado) f.rep.reproducir();
      if (!enMarcha && !f.rep.pausado) f.rep.pausar();
    }

    // Si la maestra se para sola (fin del vídeo), el grupo también.
    if (this.reproduciendo && this.maestra.rep.pausado && !this.maestra.rep.esperando
        && this.maestra.rep.duracion > 0
        && this.maestra.rep.tiempo >= this.maestra.rep.duracion - 0.5) {
      this.reproduciendo = false;
      this.alCambiar();
    }
    requestAnimationFrame(this._bucle);
  }
}
