# Guía Conexion Sistema

Esta guía detalla los pasos necesarios para poner en marcha la arquitectura completa del sistema: Base de Datos (MySQL), Servidor Backend (Node.js/Express) y Frontend (React).

## Prerrequisitos
* Tener instalado **XAMPP** (con los servicios de Apache y MySQL activos).
* Tener instalado **Node.js** en el equipo.

## Paso 1: Configuración de la Base de Datos
1. Abre **phpMyAdmin** desde tu panel de XAMPP (`http://localhost/phpmyadmin/`).
2. Crea una nueva base de datos para tu proyecto.
3. Ejecuta los scripts SQL (schema.sql) para crear las tablas (`roles`, `personas`, `registros_ingreso`) y los registros de prueba correspondientes.

## Paso 2: Configuración y Arranque del Servidor Backend (API)
El backend actúa como puente entre la base de datos y la interfaz gráfica de usuario.

1. Dirígete a la carpeta del servidor (`server/`) en tu terminal e instala sus dependencias si aún no lo has hecho (`npm install`).
2. Copia el archivo `server/.env.example` a `server/.env` y configura la conexión a tu base de datos (`3306` para MySQL):
   ```env
   PUERTO_SERVIDOR=3006
   HOST_BD=localhost
   PUERTO_BD=3306
   USUARIO_BD=root
   CONTRASENA_BD=
   NOMBRE_BD=db_inregrsolira
   ORIGENES_CORS=http://localhost:5173,http://127.0.0.1:5173
   ```
3. Inicia el servidor backend ejecutando el comando desde la raíz (o `npm run dev` dentro de `server/`):
   ```bash
   node server/index.js
   ```
   *El servidor deberá confirmar la conexión al pool de la base de datos y quedar activo en el puerto **3006** (`http://localhost:3006`).*


## Paso 3: Configuración y Arranque del Frontend (React)
La interfaz gráfica consume los datos expuestos por la API local.

1. En la raíz del proyecto frontend, verifica que tu cliente HTTP (`unifiApi.js`) apunte correctamente a la ruta `/api` del backend:
   ```javascript
   const URL_BASE_API = import.meta.env.VITE_UNIFI_API_BASE_URL || 'http://localhost:3006/api';
   ```
2. Instala las dependencias necesarias:
   ```bash
   npm install
   ```
3. Ejecuta el entorno de desarrollo de Vite:
   ```bash
   npm run dev
   ```
4. Abre el enlace proporcionado en tu navegador (usualmente `http://localhost:5173`) para interactuar con el **Dashboard**.

## Resumen de Puertos del Sistema
* **MySQL / phpMyAdmin:** Puerto `3306`
* **Servidor Backend (Node.js):** Puerto `3006`
