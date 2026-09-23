# Producción Virtual Brainstorm (Marxadella 2026)

Índice navegable de las clases del curso: al pulsar un tema, el vídeo salta a ese punto.
Los días grabados a la vez con captura de pantalla (OBS) y cámara se reproducen
sincronizados, y se puede ampliar cualquiera de las dos imágenes y elegir qué audio suena.

## Estructura

```
index.html            página principal
css/estilos.css
js/reproductor.js     ReproductorLocal + GrupoSincronizado (sincronía y reloj común)
js/app.js             índice, navegación y controles
data/curso.json       días, sesiones, vídeos, duraciones y desfases
data/capitulos-*.json índice de temas de cada día
videos/               grabaciones MKV convertidas a MP4 (no se suben al repositorio)
servidor.py           servidor local con soporte de rangos para probarlo
```

## Probar en local

```
python servidor.py        # http://localhost:8123
```

Sirve esta carpeta y, bajo `/curso/`, la carpeta del curso en Google Drive. La ruta está
al principio de `servidor.py`. Hace falta porque el navegador necesita peticiones por
rangos (`Range`) para saltar dentro de vídeos de varios GB, y `http.server` no las admite.

## Cómo se generaron los datos

Los scripts están en `C:\Users\Victor\whisperx`:

| Script | Qué hace |
|---|---|
| `transcribir.py` | Transcribe los vídeos con WhisperX (large-v3, español, diarización). |
| `consolidar.py` | Une las transcripciones de cada día en una sola, eligiendo la mejor fuente. |
| `emparejar.py` | Empareja las grabaciones de OBS y cámara comparando su texto. |
| `desfases.py` | Calcula el desfase de cada pareja por correlación de la energía del audio. |
| `verificar.py` | Comprueba los desfases contrastándolos con las marcas de las transcripciones. |
| `construir_datos.py` | Monta `data/curso.json` con duraciones, desfases y capítulos. |

## Los vídeos en YouTube

La web no sabe de dónde sale el vídeo: todo pasa por una interfaz de reproductor
(`preparar`, `reproducir`, `pausar`, `irA`, `tiempo`, `velocidad`, `silenciado`), que
implementan `ReproductorLocal` y `ReproductorYouTube`. YouTube es el origen por defecto;
los archivos locales siguen en el selector para verlos sin conexión.

Las 45 grabaciones están subidas como ocultas. De lo demás se encarga `youtube.py`:

| Orden | Qué hace |
|---|---|
| `listar` | Lee el canal y guarda `youtube_videos.json`. |
| `emparejar` | Escribe el identificador de cada vídeo en `data/curso.json`. |
| `ocultar` | Pasa a oculto los que sigan privados tras subirlos. |
| `describir` | Descripción con capítulos e idioma; `--aplicar` para escribir. |

Para añadir vídeos basta subirlos a mano dejando el nombre del archivo como título, sin
recortar el principio (o los desfases dejarán de valer), y pasar esas cuatro órdenes.

Con YouTube la sincronía es algo menos precisa, porque los saltos no son exactos al
fotograma: conviene subir la tolerancia de 0,3 s a cerca de 0,5 s.

## Origen de cada grabación

- **Día 1:** la captura de OBS no tiene sonido; se ve la pantalla y se oye la cámara.
- **Días 2 y 3:** solo hay captura de OBS. Dos vídeos del día 3 estaban truncados
  (sin *moov atom*) y se recuperaron con [untrunc](https://github.com/anthwlock/untrunc).
- **Días 4, 5 y 6:** las dos grabaciones tienen sonido. Se usa el audio de OBS, que
  transcribe mejor por tener el micrófono más cerca.
