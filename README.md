# OBS Manager

Aplicación local de Windows para controlar varias transmisiones de OBS en paralelo.

## Funciones incluidas

- Perfiles independientes por streamer.
- Claves de transmisión y contraseñas WebSocket cifradas con la protección de Windows.
- Una conexión OBS WebSocket y un puerto diferente por perfil.
- Inicio, detención, estado y cambio de escena desde un único panel.
- Duración individual con apagado automático al llegar a cero.
- Persistencia del horario de finalización: si la app se reinicia, recupera el temporizador y detiene una transmisión vencida al volver a abrirse.
- Si se intenta cerrar la ventana mientras hay un stream programado, la app se minimiza y mantiene activo el temporizador.
- Lanzamiento opcional de una instalación portable de OBS por streamer.
- Instancias ligeras aisladas: todos los perfiles pueden compartir un único OBS instalado; los binarios se enlazan sin duplicar su espacio y cada perfil conserva su propia configuración portable.
- Soporte para servicios conocidos de OBS y servidores RTMP personalizados.
- Al iniciar, conserva el servicio y servidor RTMP válidos de cada OBS y actualiza únicamente la clave de transmisión, evitando reemplazar la URL por una configuración incompleta.
- Actualizaciones automáticas mediante versiones publicadas en GitHub Releases.

## Publicar una actualización

La aplicación instalada consulta las versiones publicadas en [fabri-dz/obs-manager](https://github.com/fabri-dz/obs-manager/releases):

1. Incrementar la versión de `package.json`, por ejemplo con `npm version patch`.
2. Crear y subir un tag con el mismo número: `v0.2.0`.
3. GitHub Actions compila y publica el instalador, `latest.yml` y el blockmap.
4. Las instalaciones existentes detectan la versión, la descargan y muestran **Reiniciar e instalar**.

El repositorio debe permitir descargar públicamente los archivos de Releases. Nunca se debe incluir un token personal de GitHub dentro de la aplicación.

## Configurar cada OBS

Para transmitir simultáneamente sin copiar OBS completo, activá **Usar instancia ligera aislada** en cada perfil:

1. Seleccionar el mismo `obs64.exe` instalado en todos los perfiles.
2. OBS Manager crea una vista portable ligera por streamer usando enlaces de directorio de Windows, sin permisos de administrador y sin duplicar los binarios.
   En el primer inicio también clona la configuración completa del OBS original: escenas, perfiles, fuentes, filtros, audio, transiciones, docks y plugins. La configuración WebSocket se mantiene separada para permitir puertos distintos.
3. En OBS, abrir **Herramientas → Ajustes del servidor WebSocket**.
4. Activar el servidor, asignar una contraseña y usar un puerto exclusivo:
   - Streamer 1: `4455`
   - Streamer 2: `4456`
   - Streamer 3: `4457`
   - Streamer 4: `4458`
5. Importar o crear las escenas del streamer la primera vez que se abre su instancia.
6. Crear el perfil correspondiente en OBS Manager con el mismo puerto y contraseña.

Una cámara física puede no admitir acceso desde dos OBS a la vez. Si hay que compartirla, será necesario distribuir la captura mediante NDI, cámara virtual u otro método.

## Desarrollo

```powershell
npm install
npm run dev
```

Compilar la aplicación:

```powershell
npm run build
```

Generar el instalador de Windows:

```powershell
npm run dist
```
