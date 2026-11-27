# Dashboard de Control de Ingresos

Sistema web para el registro y monitoreo en tiempo real de ingresos y salidas de **empleados, visitantes y proveedores**, integrado con **UniFi Access** (reconocimiento facial y emisión de códigos QR temporales).

## Herramientas

- **Frontend:** React + Vite (`src/`), servido por Nginx en producción.
- **Backend:** Node.js + Express (`server/`).
- **Base de datos:** MySQL 8.4 (`Db/schema.sql`).

---

## 1. Configuración de variables de entorno

El proyecto utiliza dos archivos `.env` (excluidos de Git):

1. **`.env` (en la raíz):** variables para `docker-compose.yml` (credenciales de MySQL y puerto web).
2. **`server/.env`:** variables para el servidor backend (conexión a BD, seguridad JWT, UniFi Access y SMTP).

Copia las plantillas antes de iniciar:

```bash
cp .env.example .env
cp server/.env.example server/.env
```

### Variables en `.env` (raíz — Docker)

| Variable | Descripción |
|---|---|
| `CONTRASENA_ROOT_BD` | Contraseña del usuario `root` de MySQL (obligatoria en Docker). |
| `USUARIO_BD` | Usuario de aplicación para MySQL. |
| `CONTRASENA_BD` | Contraseña del usuario de aplicación en MySQL (obligatoria en Docker). |
| `NOMBRE_BD` | Nombre de la base de datos. |
| `PUERTO_WEB` | Puerto HTTP local para la aplicación web. |
| `ORIGENES_CORS` | Orígenes permitidos por CORS (separados por coma). |

### Variables en `server/.env` (Backend)

#### Seguridad y base de datos

| Variable | Descripción |
|---|---|
| `JWT_SECRET` | Clave secreta para firmar tokens JWT (obligatoria en producción). |
| `CONTRASENA_ADMIN_INICIAL` | Contraseña para crear el usuario administrador inicial cuando la tabla `usuarios` está vacía (obligatoria en producción). |
| `USUARIO_ADMIN_INICIAL` | Nombre de usuario del administrador inicial. |
| `HOST_BD`, `PUERTO_BD`, `USUARIO_BD`, `CONTRASENA_BD`, `NOMBRE_BD` | Datos de conexión a MySQL. |

#### UniFi Access

| Variable | Descripción |
|---|---|
| `UNIFI_HOST` | Dirección IP o hostname de la consola UniFi Access. |
| `UNIFI_PORT` | Puerto de la API de UniFi Access. |
| `UNIFI_TOKEN` | Token de API generado en la consola UniFi Access. |
| `UNIFI_VERIFY_SSL` | Verificación de certificado SSL (`true` o `false`). |
| `UNIFI_PUERTA_PRINCIPAL_ID` | ID de la puerta principal en UniFi Access. |
| `UNIFI_PUERTA_PRINCIPAL_NOMBRE` | Nombre de la puerta principal. |
| `UNIFI_PUERTA_DEFECTO` | ID de la puerta por defecto. |
| `UNIFI_PUERTAS_VISITANTE` | IDs de las puertas asignadas a las invitaciones QR (separados por coma). |
| `UNIFI_VENTANA_SEGUNDOS` | Tiempo de vigencia por defecto del código QR en segundos. |
| `UNIFI_MAX_ACCESOS` | Cantidad máxima de accesos permitidos por defecto para el QR. |
| `UNIFI_POLL_INTERVAL_MS` | Intervalo de consulta de eventos en milisegundos. |
| `UNIFI_TIMEOUT_MS` | Tiempo máximo de espera por petición a UniFi en milisegundos. |
| `UNIFI_QR_COOLDOWN_SEGUNDOS` | Tiempo mínimo en segundos (antirrebote) entre dos lecturas del mismo QR para no descontar dos usos por un doble escaneo. |
| `UNIFI_MODO_PRUEBA` | Por defecto `false` (modo estricto: si UniFi no responde, devuelve error y no emite QR). Si es `true` en entorno de desarrollo, genera un QR simulado de prueba con aviso en pantalla y sin envío por correo. |

#### Correo electrónico (SMTP)

| Variable | Descripción |
|---|---|
| `SMTP_HOST` | Servidor SMTP. |
| `SMTP_PORT` | Puerto SMTP. |
| `SMTP_USER` | Usuario de la cuenta SMTP. |
| `SMTP_PASS` | Contraseña o clave de aplicación SMTP. |
| `SMTP_FROM` | Remitente de los correos enviados. |

#### Meta WhatsApp Cloud API (Invitaciones de visitantes)

| Variable | Descripción |
|---|---|
| `URL_PUBLICA_APP` | URL base accesible desde el celular del visitante para abrir el formulario `/registro-visita/<token>`. |
| `WHATSAPP_API_VERSION` | Versión de Meta Graph API (por defecto `v22.0`). |
| `WHATSAPP_TOKEN` | Token de acceso de Meta WhatsApp Cloud API (temporal de prueba o permanente). |
| `WHATSAPP_PHONE_NUMBER_ID` | ID del número de teléfono de WhatsApp configurado en Meta for Developers. |
| `WHATSAPP_VERIFY_TOKEN` | Cadena secreta usada en `GET /api/whatsapp/webhook` para verificar el webhook ante Meta. |
| `WHATSAPP_APP_SECRET` | Opcional: secreto de la app de Meta para validar la firma `X-Hub-Signature-256`. |
| `WHATSAPP_CODIGO_PAIS_DEFECTO` | Código de país aplicado a teléfonos de 10 dígitos (por defecto `57`). |
| `WHATSAPP_TELEFONO_RESPALDO` | Opcional: teléfono de respaldo para recibir aprobaciones si el empleado no tiene celular registrado. |
| `WHATSAPP_ADMINS_TELEFONOS` | Opcional: teléfonos de administradores/recepción autorizados a aprobar cualquier visita (separados por coma). |
| `WHATSAPP_FORM_EXPIRACION_MIN` | Minutos de validez del enlace único del formulario tras aprobar el anfitrión (por defecto `30`). |
| `WHATSAPP_ANFITRION_FORM_EXPIRACION_HORAS` | Horas de validez del enlace preaprobado cuando un empleado anfitrión genera la invitación (por defecto `24`). |
| `WHATSAPP_QR_VENTANA_SEGUNDOS` | Vigencia del código QR generado desde el formulario público en segundos (por defecto `7200`). |
| `WHATSAPP_TEMPLATE_QR` | Opcional: nombre de plantilla de utilidad aprobada en Meta para notificar a invitados programados fuera de la ventana de 24h. |

---

## 2. Ejecución con Docker Compose

```bash
docker compose up -d --build
```

---

## 3. Ejecución en desarrollo local

```bash
npm install
npm --prefix server install

# Servidor backend
npm --prefix server run dev

# Frontend
npm run dev
```
