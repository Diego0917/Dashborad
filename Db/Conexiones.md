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

1. Dirígete a la carpeta del servidor (`server/`) en tu terminal.
2. Asegúrate de configurar la conexión a la base de datos separando el host y el puerto (`3306` para MySQL):
   ```javascript
   const db = mysql.createConnection({
       host: 'localhost',
       port: 3306,
       user: 'root',
       password: '',
       database: 'nombre_de_tu_bd'
   });
   ```
3. Inicia el servidor backend ejecutando el comando:
   ```bash
   node server/index.js
   ```
   *El servidor deberá confirmar la conexión a la base de datos y quedar activo en el puerto **3006** (`http://localhost:3006`).*


## Paso 3: Configuración y Arranque del Frontend (React)
La interfaz gráfica consume los datos expuestos por la API local.

1. En la raíz del proyecto frontend, verifica que tu cliente HTTP (`unifiApi.js`) apunte correctamente al puerto del backend:
   ```javascript
   const URL_BASE_API = import.meta.env.VITE_UNIFI_API_BASE_URL || 'http://localhost:3006';
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