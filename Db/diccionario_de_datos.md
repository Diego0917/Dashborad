# Diccionario de Datos
Este documento contiene la estructura detallada de las tablas que componen la base de datos para el control de acceso de visitantes, empleados y proveedores.

## 1. Tabla: Roles

| Campo | Tipo de Dato | Llave | Null | Descripción |
| :--- | :--- | :---: | :---: | :--- |
| `id_rol` | INT | PK | NO | Identificador único del rol |
| `nombre_rol` | VARCHAR(50) | - | NO | Tipo de usuario: visitante, empleado o proveedor |

## 2. Tabla: Persona

| Campo | Tipo de Dato | Llave | Null | Descripción |
| :--- | :--- | :---: | :---: | :--- |
| `cedula` | VARCHAR(20) | PK | NO | Documento de identidad (clave principal) |
| `nombre_completo` | VARCHAR(100) | - | NO | Nombres y apellidos completos |
| `telefono` | VARCHAR(20) | - | SÍ | Número telefónico de contacto |
| `EPS` | VARCHAR(50) | - | SÍ | Entidad promotora de salud |
| `ARL` | VARCHAR(50) | - | SÍ | Aseguradora de riesgos laborales |
| `id_rol` | INT | FK | NO | Relación con la tabla roles |

## 3. Tabla: Visitas

| Campo | Tipo de Dato | Llave | Null | Descripción |
| :--- | :--- | :---: | :---: | :--- |
| `id_registro` | INT | PK | NO | Identificador único del evento de ingreso |
| `cedula` | VARCHAR(20) | FK | NO | Relación con la persona que ingresa |
| `motivo` | VARCHAR(255) | - | NO | Razón o motivo de la visita |
| `fecha_ingreso` | DATE | - | NO | Fecha en la que ingresa el usuario |
| `hora_ingreso` | TIME | - | NO | Hora en la que ingresa el usuario |
| `hora_salida` | TIME | - | SÍ | Hora en la que sale el usuario |

## 4. Tabla: Usuarios (Acceso al Dashboard)

| Campo | Tipo de Dato | Llave | Null | Descripción |
| :--- | :--- | :---: | :---: | :--- |
| `id_usuario` | INT | PK | NO | Identificador único del usuario del sistema |
| `nombre_usuario` | VARCHAR(50) | UNIQUE | NO | Nombre de usuario para iniciar sesión |
| `nombre_completo` | VARCHAR(100) | - | NO | Nombre completo del operador o administrador |
| `contrasena_hash` | VARCHAR(255) | - | NO | Contraseña encriptada mediante bcrypt |
| `activo` | TINYINT(1) | - | NO | Estado de la cuenta (`1` = activo, `0` = inactivo) |
| `fecha_creacion` | TIMESTAMP | - | NO | Fecha y hora de creación del usuario |

## 5. Tabla: Accesos QR (Integración UniFi Access)

| Campo | Tipo de Dato | Llave | Null | Descripción |
| :--- | :--- | :---: | :---: | :--- |
| `id_qr` | INT | PK | NO | Identificador único de la credencial QR |
| `id_registro` | INT | FK / UNIQUE | NO | Relación con el evento en `registros_ingreso` |
| `unifi_visitor_id` | VARCHAR(64) | - | NO | ID del visitante generado en la consola UniFi Access |
| `puertas_json` | TEXT | - | NO | Lista JSON de IDs de puertas asignadas al visitante |
| `usos_actuales` | INT | - | NO | Cantidad de aperturas concedidas registradas (`0`, `1`, `2`) |
| `max_usos` | INT | - | NO | Límite de aperturas antes de revocar el QR (por defecto `2`: entrada y salida) |
| `eventos_vistos_json` | TEXT | - | SÍ | Lista JSON de IDs de eventos de apertura ya contabilizados |
| `inicio_timestamp` | BIGINT | - | NO | Epoch en segundos del inicio de vigencia del QR |
| `fin_timestamp` | BIGINT | - | NO | Epoch en segundos del fin de vigencia del QR (ej. `+3600` seg) |
| `estado` | ENUM | - | NO | Estado del QR: `'ACTIVO'`, `'COMPLETADO'`, `'EXPIRADO'` o `'REVOCADO'` |
| `qr_base64` | LONGTEXT | - | SÍ | Imagen PNG del QR con margen blanco (*quiet zone*) en formato Base64 |
| `fecha_creacion` | TIMESTAMP | - | NO | Fecha y hora de emisión del QR |

