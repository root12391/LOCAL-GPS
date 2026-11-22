# Localizador de teléfono (antirrobo / pérdida)

Panel web + página que instalas **en tu propio teléfono**, a la vista y con tu permiso.

**Qué hace**
- Cuenta con correo y contraseña, verificada con un código de 6 dígitos enviado por correo.
- Vincula tu teléfono con un código de un solo uso (vence en 15 min).
- Ubicación GPS en un mapa, con historial y última posición conocida.
- Si el GPS está apagado o sin permiso, sigue mostrando la **IP** y una ubicación **aproximada por IP**.
- Botones: **Localizar ahora**, **Hacer sonar**, **Detener alarma**, **Modo perdido** (pantalla roja con tu mensaje y botón "Llamar al dueño"), **Lo recuperé**, y **Llamar a este número** desde el panel.

## 1. Instalar y arrancar

```bash
npm install
npm start          # http://localhost:3000
```

Sin configuración de correo, el código de verificación **se imprime en la consola** del servidor.
Para enviarlo de verdad por correo, define `SMTP_URL` antes de arrancar:

```bash
SMTP_URL="smtps://usuario%40gmail.com:CLAVE_DE_APLICACION@smtp.gmail.com" \
MAIL_FROM="Localizador <usuario@gmail.com>" npm start
```
(En Gmail usa una *contraseña de aplicación*.)

## 2. Conectar con ngrok

El GPS del navegador **solo funciona con HTTPS**, y ngrok te lo da.

```bash
ngrok config add-authtoken TU_TOKEN   # una sola vez
ngrok http 3000
```

Copia la URL `https://xxxx.ngrok-free.app` que muestra ngrok. (Opcional: `PUBLIC_URL=https://xxxx.ngrok-free.app npm start` para que los enlaces de vinculación usen esa URL.)

- La primera vez, ngrok puede mostrar una pantalla de aviso: pulsa **Visit Site**.
- Las URL gratuitas cambian al reiniciar ngrok y el teléfono guarda su vínculo por dirección: si cambia la URL tendrás que vincular otra vez. Usa un **dominio fijo** de tu cuenta de ngrok para evitarlo.

## 3. Probar que funciona

1. Abre la URL de ngrok en tu computadora → **Crear cuenta** → mira la consola, copia el código de 6 dígitos y verifícalo.
2. **Agregar teléfono** → pon nombre y tu número → aparece un código de 8 caracteres y un enlace.
3. En el teléfono abre ese enlace (o `/device.html` y escribe el código) → **Activar protección** → **Permitir** ubicación.
4. En el panel debe aparecer *En línea* y el punto en el mapa. Prueba **Localizar ahora**, **Hacer sonar** y **Modo perdido**.
5. Prueba el respaldo por IP: en el teléfono quita el permiso de ubicación del navegador. A los segundos el panel muestra el aviso naranja y la ubicación aproximada por IP.

## Límites que conviene conocer

- **Es una página web, no una app nativa.** Si el navegador se cierra, el teléfono se bloquea o el sistema pausa la pestaña, deja de enviar datos. La página pide mantener la pantalla encendida, pero no es infalible. Para protección real en segundo plano hace falta una app nativa (Android con servicio en primer plano).
- **Un web no puede encender el GPS por ti.** Si el ladrón lo apaga, solo queda la IP (aproximada, a veces a kilómetros) y la última posición GPS guardada.
- **Sin internet o apagado**, ningún panel puede alcanzar el teléfono.
- La ubicación por una llamada o por el número de teléfono solo la pueden hacer la operadora y la policía; esta app no puede.
- El sonido de la alarma requiere que hayas tocado **Activar protección** antes (regla de los navegadores).

## Si te roban el teléfono

1. Entra al panel → **Modo perdido** y **Localizar ahora**.
2. Usa también Google *Encontrar mi dispositivo* o Apple *Buscar*: funcionan en segundo plano y son más fiables que esta página.
3. Llama a tu operadora para **bloquear la línea y el IMEI**.
4. Haz la denuncia policial y **no vayas tú a recuperarlo**: da a la policía las ubicaciones del panel.
5. Cambia las contraseñas de tu correo y cuentas importantes.

## Seguridad

- Contraseñas con scrypt; sesiones y tokens guardados como hash; límite de intentos en login, registro y vinculación.
- Datos en `data.json` (no lo subas a ningún repositorio).
- Úsalo solo en teléfonos propios o de personas que lo saben y lo aceptan.

## Archivos

- `server.js`: API y servidor.
- `public/index.html`: panel con mapa y botones.
- `public/device.html`: página que corre en el teléfono.
