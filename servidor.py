"""Servidor local para probar la web.

Sirve esta carpeta y, bajo /curso/, la carpeta del curso en Google Drive.
Implementa peticiones por rangos (Range), imprescindible para poder saltar
dentro de vídeos de varios GB.

    python servidor.py [puerto]
"""
import os
import re
import socket
import sys
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import unquote

WEB = Path(__file__).parent
CURSO = Path(r"K:\Mi unidad\_Archivos 'vicpiri@gmail.com'\Cursos\Cursos Recibidos"
             r"\Producción Virtual Brainstorm (Marxadella 2026)")
COMPRIMIDOS = Path(r"C:\Users\Victor\whisperx\comprimidos")
TIPOS = {".mp4": "video/mp4", ".mkv": "video/x-matroska", ".vtt": "text/vtt",
         ".json": "application/json; charset=utf-8", ".js": "text/javascript",
         ".css": "text/css", ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8"}


class Manejador(SimpleHTTPRequestHandler):
    def traducir(self, ruta: str) -> Path | None:
        ruta = unquote(ruta.split("?")[0].split("#")[0]).lstrip("/")
        if ruta.startswith("curso/"):
            destino = (CURSO / ruta[len("curso/"):]).resolve()
            raiz = CURSO.resolve()
        elif ruta.startswith("comprimidos/"):
            destino = (COMPRIMIDOS / ruta[len("comprimidos/"):]).resolve()
            raiz = COMPRIMIDOS.resolve()
        else:
            destino = (WEB / (ruta or "index.html")).resolve()
            raiz = WEB.resolve()
        if raiz not in destino.parents and destino != raiz:
            return None  # fuera de las carpetas permitidas
        return destino

    def do_GET(self):  # noqa: N802
        destino = self.traducir(self.path)
        if destino is None or not destino.is_file():
            self.send_error(404, "No encontrado")
            return

        tamano = destino.stat().st_size
        tipo = TIPOS.get(destino.suffix.lower(), "application/octet-stream")
        rango = self.headers.get("Range")
        inicio, fin = 0, tamano - 1
        parcial = False

        if rango and (m := re.match(r"bytes=(\d*)-(\d*)", rango)):
            if m[1]:
                inicio = int(m[1])
                fin = int(m[2]) if m[2] else tamano - 1
            elif m[2]:  # bytes=-N : los últimos N
                inicio = max(0, tamano - int(m[2]))
            if inicio >= tamano:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{tamano}")
                self.end_headers()
                return
            fin = min(fin, tamano - 1)
            parcial = True

        self.send_response(206 if parcial else 200)
        self.send_header("Content-Type", tipo)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(fin - inicio + 1))
        if parcial:
            self.send_header("Content-Range", f"bytes {inicio}-{fin}/{tamano}")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        restante = fin - inicio + 1
        with destino.open("rb") as f:
            f.seek(inicio)
            while restante > 0:
                trozo = f.read(min(1 << 20, restante))
                if not trozo:
                    break
                try:
                    self.wfile.write(trozo)
                except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                    return  # el navegador ha saltado a otro punto
                restante -= len(trozo)

    def do_HEAD(self):  # noqa: N802
        destino = self.traducir(self.path)
        if destino is None or not destino.is_file():
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", TIPOS.get(destino.suffix.lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(destino.stat().st_size))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()

    def log_message(self, formato, *args):
        if "404" in formato % args:
            super().log_message(formato, *args)


class Servidor(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def ip_local() -> str:
    """La IP con la que este equipo sale a la red local."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect(("8.8.8.8", 53))  # no envía nada: solo sirve para elegir la interfaz
        return s.getsockname()[0]


if __name__ == "__main__":
    # Sin --red solo escucha en este equipo. Con --red lo ve toda la red local,
    # y no hay contraseña: cualquiera en esa red puede ver los vídeos.
    en_red = "--red" in sys.argv
    argumentos = [a for a in sys.argv[1:] if a != "--red"]
    puerto = int(argumentos[0]) if argumentos else 8123
    os.chdir(WEB)
    print(f"Web: http://localhost:{puerto}")
    if en_red:
        print(f"En la red local: http://{ip_local()}:{puerto}")
    print(f"Curso: {CURSO}")
    print(f"Comprimidos: {COMPRIMIDOS}")
    Servidor(("0.0.0.0" if en_red else "127.0.0.1", puerto),
             partial(Manejador, directory=str(WEB))).serve_forever()
