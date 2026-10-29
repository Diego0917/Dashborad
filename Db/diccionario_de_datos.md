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