# Diccionario de Datos — Base de Datos `ingreso_lira`

Este documento contiene la estructura actualizada de las **8 tablas** que componen la base de datos MySQL 8.4 para el sistema de control de acceso de visitantes, empleados y proveedores (**Lira Seguridad**), alineada con `Db/schema.sql` y las migraciones `001` a `004`.

---

## 1. Tabla: `roles`

| Campo | Tipo de Dato | Llave / Índice | Nulo | Default | Descripción |
| :--- | :--- | :---: | :---: | :--- | :--- |
| `id_rol` | `INT` | PK | NO | `AUTO_INCREMENT` | Identificador único del rol (`1` = Visitante, `2` = Empleado, `3` = Proveedor) |
| `nombre_rol` | `VARCHAR(50)` | UNIQUE | NO | — | Nombre único del rol |

---

## 2. Tabla: `personas`

| Campo | Tipo de Dato | Llave / Índice | Nulo | Default | Descripción |
| :--- | :--- | :---: | :---: | :--- | :--- |
| `cedula` | `VARCHAR(20)` | PK | NO | — | Documento de identidad (o `UNIFI-...` para empleados sincronizados sin cédula registrada) |
| `nombre_completo` | `VARCHAR(100)` | INDEX | NO | — | Nombres y apellidos completos |
| `telefono` | `VARCHAR(20)` | — | SÍ | `NULL` | Número telefónico de contacto / WhatsApp |
| `eps` | `VARCHAR(50)` | — | SÍ | `NULL` | Entidad promotora de salud |
| `arl` | `VARCHAR(50)` | — | SÍ | `NULL` | Aseguradora de riesgos laborales |
| `id_rol` | `INT` | FK, INDEX | NO | — | Relación con `roles(id_rol)` (`fk_persona_rol`) |
| `unifi_user_id` | `VARCHAR(64)` | UNIQUE | SÍ | `NULL` | Identificador único del usuario en la consola UniFi Access |

---

## 3. Tabla: `registros_ingreso`

| Campo | Tipo de Dato | Llave / Índice | Nulo | Default | Descripción |
| :--- | :--- | :---: | :---: | :--- | :--- |
| `id_registro` | `INT` | PK | NO | `AUTO_INCREMENT` | Identificador único del registro diario de ingreso |
| `cedula` | `VARCHAR(20)` | FK, INDEX | NO | — | Relación con `personas(cedula)` (`fk_registro_persona`) |
| `motivo` | `VARCHAR(255)` | — | SÍ | `NULL` | Razón o motivo de la visita / acceso |
| `fecha_ingreso` | `DATE` | INDEX | NO | `CURRENT_DATE` | Fecha del ingreso (zona horaria `America/Bogota`) |
| `hora_ingreso` | `TIME` | INDEX | SÍ | `CURRENT_TIME` | Hora de primera entrada (`NULL` mientras el QR no haya sido escaneado en puerta) |
| `hora_salida` | `TIME` | — | SÍ | `NULL` | Hora de última salida registrada |
| `total_entradas` | `INT` | — | NO | `1` | Total acumulado de entradas en el día |
| `total_salidas` | `INT` | — | NO | `0` | Total acumulado de salidas en el día |
| `movimientos_json` | `TEXT` | — | SÍ | `NULL` | Arreglo JSON cronológico de movimientos (`ENTRADA`, `ACCESO_INTERNO`, `SALIDA`, hora y puerta) |

---

## 4. Tabla: `usuarios` (Acceso al Dashboard)

| Campo | Tipo de Dato | Llave / Índice | Nulo | Default | Descripción |
| :--- | :--- | :---: | :---: | :--- | :--- |
| `id_usuario` | `INT` | PK | NO | `AUTO_INCREMENT` | Identificador único del usuario del Dashboard |
| `nombre_usuario` | `VARCHAR(50)` | UNIQUE | NO | — | Nombre de usuario para iniciar sesión |
| `nombre_completo` | `VARCHAR(100)` | — | NO | — | Nombre completo del operador o administrador |
| `contrasena_hash` | `VARCHAR(255)` | — | NO | — | Contraseña encriptada mediante `bcrypt` |
| `activo` | `TINYINT(1)` | — | NO | `1` | Estado de la cuenta (`1` = activo, `0` = inactivo) |
| `fecha_creacion` | `TIMESTAMP` | — | NO | `CURRENT_TIMESTAMP` | Fecha y hora de creación del usuario |

---

## 5. Tabla: `accesos_qr` (Integración UniFi Access)

| Campo | Tipo de Dato | Llave / Índice | Nulo | Default | Descripción |
| :--- | :--- | :---: | :---: | :--- | :--- |
| `id_qr` | `INT` | PK | NO | `AUTO_INCREMENT` | Identificador único de la credencial QR |
| `id_registro` | `INT` | FK, UNIQUE | NO | — | Relación `1:1` con `registros_ingreso(id_registro)` (`fk_qr_registro`, `ON DELETE CASCADE`) |
| `unifi_visitor_id` | `VARCHAR(64)` | INDEX | NO | — | ID del visitante temporal generado en la consola UniFi Access |
| `puertas_json` | `TEXT` | — | NO | — | Lista JSON de IDs de puertas asignadas al visitante |
| `usos_actuales` | `INT` | — | NO | `0` | Cantidad de aperturas concedidas válidas contabilizadas (con antirrebote por puerta) |
| `max_usos` | `INT` | — | NO | `2` | Límite máximo de accesos antes de revocar el QR (`0` = solo límite por tiempo) |
| `eventos_vistos_json` | `TEXT` | — | SÍ | `NULL` | Lista JSON de eventos UniFi ya evaluados (`id`, `tsMs`, `puerta`, `contado`) |
| `inicio_timestamp` | `BIGINT` | — | NO | — | Epoch en segundos del inicio de vigencia del QR |
| `fin_timestamp` | `BIGINT` | — | NO | — | Epoch en segundos del fin de vigencia del QR |
| `estado` | `ENUM` | INDEX | NO | `'ACTIVO'` | Estado del QR: `'ACTIVO'`, `'COMPLETADO'`, `'EXPIRADO'` o `'REVOCADO'` |
| `qr_base64` | `LONGTEXT` | — | SÍ | `NULL` | Imagen PNG del QR con margen blanco (*quiet zone*) en Data URL Base64 |
| `fecha_creacion` | `TIMESTAMP` | — | NO | `CURRENT_TIMESTAMP` | Fecha y hora de emisión del QR |

---

## 6. Tabla: `solicitudes_visita_whatsapp` (Bot Dual Meta WhatsApp Cloud API)

| Campo | Tipo de Dato | Llave / Índice | Nulo | Default | Descripción |
| :--- | :--- | :---: | :---: | :--- | :--- |
| `id_solicitud` | `INT` | PK | NO | `AUTO_INCREMENT` | Identificador único de la solicitud conversacional de WhatsApp |
| `origen` | `ENUM` | — | NO | `'VISITANTE'` | Origen del flujo: `'VISITANTE'` (espontáneo) o `'ANFITRION'` (programado por empleado) |
| `rol_invitado` | `TINYINT` | — | NO | `1` | Rol del invitado (`1` = Visitante, `3` = Proveedor) |
| `telefono_visitante` | `VARCHAR(32)` | INDEX | SÍ | `NULL` | Teléfono E.164 del visitante (`NULL` hasta completar formulario cuando `origen = 'ANFITRION'`) |
| `nombre_whatsapp_visitante` | `VARCHAR(120)` | — | SÍ | `NULL` | Nombre del perfil WhatsApp del visitante o nombre indicado por el anfitrión |
| `estado` | `ENUM` | INDEX | NO | `'ESPERANDO_ANFITRION'` | Estado en la máquina de estados (`ESPERANDO_ANFITRION`, `ELIGIENDO_ANFITRION`, `ESPERANDO_MOTIVO`, `PENDIENTE_APROBACION`, `ANFITRION_ESPERANDO_NOMBRE`, `ANFITRION_ESPERANDO_MOTIVO`, `APROBADA`, `RECHAZADA`, `COMPLETADA`, `EXPIRADA`) |
| `candidatos_json` | `TEXT` | — | SÍ | `NULL` | Lista JSON temporal de empleados candidatos cuando hay múltiples coincidencias |
| `cedula_anfitrion` | `VARCHAR(20)` | — | SÍ | `NULL` | Cédula del empleado anfitrión |
| `nombre_anfitrion` | `VARCHAR(120)` | — | SÍ | `NULL` | Nombre completo del empleado anfitrión |
| `telefono_anfitrion` | `VARCHAR(32)` | INDEX | SÍ | `NULL` | Teléfono E.164 del anfitrión |
| `motivo` | `VARCHAR(255)` | — | SÍ | `NULL` | Motivo de la visita |
| `token_formulario` | `VARCHAR(64)` | UNIQUE, INDEX | SÍ | `NULL` | Token único de 48 caracteres hexadecimales para `/registro-visita/:token` |
| `token_expira_en` | `DATETIME` | — | SÍ | `NULL` | Fecha y hora límite de validez del enlace |
| `id_registro` | `INT` | — | SÍ | `NULL` | Referencia al registro generado en `registros_ingreso` al completar el formulario |
| `creado_en` | `TIMESTAMP` | — | NO | `CURRENT_TIMESTAMP` | Fecha y hora de creación de la solicitud |
| `actualizado_en` | `TIMESTAMP` | — | NO | `CURRENT_TIMESTAMP` | Última actualización (`ON UPDATE CURRENT_TIMESTAMP`) |

---

## 7. Tabla: `eventos_empleados_unifi` (Deduplicación Reconocimiento Facial)

| Campo | Tipo de Dato | Llave / Índice | Nulo | Default | Descripción |
| :--- | :--- | :---: | :---: | :--- | :--- |
| `id_evento` | `VARCHAR(128)` | PK | NO | — | ID único del evento de rostro en `/system/logs` de UniFi Access |
| `unifi_user_id` | `VARCHAR(64)` | — | NO | — | Identificador del empleado en UniFi Access |
| `fecha_creacion` | `TIMESTAMP` | — | NO | `CURRENT_TIMESTAMP` | Fecha y hora de registro para evitar duplicados |

---

## 8. Tabla: `migraciones_schema` (Control de Migraciones)

| Campo | Tipo de Dato | Llave / Índice | Nulo | Default | Descripción |
| :--- | :--- | :---: | :---: | :--- | :--- |
| `id` | `VARCHAR(64)` | PK | NO | — | Identificador único de la migración aplicada (ej. `001_esquema_base_unifi_y_qr`, `004_flujo_anfitrion_whatsapp`) |
| `ejecutada_en` | `TIMESTAMP` | — | NO | `CURRENT_TIMESTAMP` | Fecha y hora en que se aplicó la migración |
