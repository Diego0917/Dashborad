const fs = require('fs');
const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

// Carga automática de server/.env si existe (soportado nativamente en Node >= 20.12)
const rutaArchivoEnv = path.join(__dirname, '.env');
if (fs.existsSync(rutaArchivoEnv) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(rutaArchivoEnv);
}

const aplicacion = express();
const puertoServidor = Number(process.env.PUERTO_SERVIDOR) || 3006;

const origenesPermitidos = (
  process.env.ORIGENES_CORS || 'http://localhost:5173,http://127.0.0.1:5173'
)
  .split(',')
  .map((origen) => origen.trim())
  .filter(Boolean);

aplicacion.use(
  cors({
    origin: (origenSolicitud, confirmarOrigen) => {
      // Permitir herramientas locales sin cabecera Origin (ej. curl, Postman) y orígenes autorizados
      if (!origenSolicitud || origenesPermitidos.includes(origenSolicitud)) {
        return confirmarOrigen(null, true);
      }
      return confirmarOrigen(new Error('Origen no permitido por CORS'));
    },
  })
);

aplicacion.use(express.json());

// Configura el pool de conexiones a tu base de datos en XAMPP / MySQL
const poolBaseDatos = mysql.createPool({
  host: process.env.HOST_BD || 'localhost',
  port: Number(process.env.PUERTO_BD) || 3306,
  user: process.env.USUARIO_BD || 'root',
  password: process.env.CONTRASENA_BD ?? '',
  database: process.env.NOMBRE_BD || 'db_inregrsolira',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true, // Devuelve DATE como 'YYYY-MM-DD' y TIME como 'HH:MM:SS' sin desfase UTC
});

const verificarConexionInicial = async () => {
  try {
    const conexion = await poolBaseDatos.getConnection();
    conexion.release();
    console.log('¡Conectado exitosamente al pool de la base de datos MySQL!');
  } catch (errorConexion) {
    console.error('Error al conectar a la base de datos:', errorConexion.message);
  }
};

verificarConexionInicial();

// Comprobación rápida de estado del servidor y la BD
aplicacion.get('/api/salud', async (_solicitud, respuesta) => {
  try {
    await poolBaseDatos.query('SELECT 1');
    respuesta.json({ estado: 'ok' });
  } catch (errorSalud) {
    console.error('Error en verificación de salud:', errorSalud);
    respuesta.status(503).json({ error: 'Base de datos no disponible' });
  }
});

// Ruta que llamará tu función obtenerVisitas() en React
aplicacion.get('/api/visitas', async (solicitud, respuesta) => {
  try {
    const {
      fechaInicio,
      fechaFin,
      rol,
      busqueda,
      limite = 1000,
      desplazamiento = 0,
    } = solicitud.query;

    const condicionesSql = [];
    const parametrosSql = [];

    if (fechaInicio) {
      condicionesSql.push('registros_ingreso.fecha_ingreso >= ?');
      parametrosSql.push(String(fechaInicio));
    }

    if (fechaFin) {
      condicionesSql.push('registros_ingreso.fecha_ingreso <= ?');
      parametrosSql.push(String(fechaFin));
    }

    if (rol && rol !== 'todos') {
      condicionesSql.push('roles.nombre_rol = ?');
      parametrosSql.push(String(rol));
    }

    if (busqueda && String(busqueda).trim() !== '') {
      const terminoBusqueda = `%${String(busqueda).trim()}%`;
      condicionesSql.push(
        '(personas.nombre_completo LIKE ? OR personas.cedula LIKE ?)'
      );
      parametrosSql.push(terminoBusqueda, terminoBusqueda);
    }

    const limiteSeguro = Math.min(Math.max(Number(limite) || 1000, 1), 5000);
    const desplazamientoSeguro = Math.max(Number(desplazamiento) || 0, 0);

    const clausulaWhere =
      condicionesSql.length > 0 ? `WHERE ${condicionesSql.join(' AND ')}` : '';

    const consultaSql = `
      SELECT
        registros_ingreso.id_registro,
        personas.cedula,
        personas.nombre_completo,
        roles.nombre_rol AS rol,
        personas.telefono,
        personas.eps,
        personas.arl,
        registros_ingreso.motivo,
        registros_ingreso.fecha_ingreso,
        registros_ingreso.hora_ingreso,
        registros_ingreso.hora_salida
      FROM registros_ingreso
      INNER JOIN personas ON registros_ingreso.cedula = personas.cedula
      INNER JOIN roles ON personas.id_rol = roles.id_rol
      ${clausulaWhere}
      ORDER BY registros_ingreso.fecha_ingreso DESC, registros_ingreso.hora_ingreso DESC
      LIMIT ? OFFSET ?;
    `;

    parametrosSql.push(limiteSeguro, desplazamientoSeguro);

    const [registros] = await poolBaseDatos.query(consultaSql, parametrosSql);
    respuesta.json(registros);
  } catch (errorConsulta) {
    console.error('Error al consultar las visitas:', errorConsulta);
    respuesta.status(500).json({ error: 'Error en el servidor al consultar visitas' });
  }
});

// Ruta para registrar un nuevo ingreso (usada por registrarIngreso en React)
aplicacion.post('/api/visitas', async (solicitud, respuesta) => {
  try {
    const { cedula, motivo = null } = solicitud.body || {};
    const cedulaLimpia = String(cedula ?? '').trim();

    if (!cedulaLimpia) {
      return respuesta.status(400).json({ error: 'La cédula es obligatoria' });
    }

    const [personasEncontradas] = await poolBaseDatos.query(
      'SELECT cedula FROM personas WHERE cedula = ? LIMIT 1',
      [cedulaLimpia]
    );

    if (personasEncontradas.length === 0) {
      return respuesta.status(404).json({
        error: 'La persona no está registrada. Regístrala primero antes de crear el ingreso.',
      });
    }

    const motivoLimpio = motivo ? String(motivo).trim() : null;
    const [resultadoInsercion] = await poolBaseDatos.query(
      'INSERT INTO registros_ingreso (cedula, motivo) VALUES (?, ?)',
      [cedulaLimpia, motivoLimpio]
    );

    return respuesta.status(201).json({
      mensaje: 'Ingreso registrado correctamente',
      id_registro: resultadoInsercion.insertId,
    });
  } catch (errorInsercion) {
    console.error('Error al registrar el ingreso:', errorInsercion);
    return respuesta.status(500).json({ error: 'Error en el servidor al registrar ingreso' });
  }
});

// Ruta para registrar la hora de salida de una visita
aplicacion.patch('/api/visitas/:idRegistro/salida', async (solicitud, respuesta) => {
  try {
    const idRegistro = Number(solicitud.params.idRegistro);
    if (!Number.isInteger(idRegistro) || idRegistro <= 0) {
      return respuesta.status(400).json({ error: 'Identificador de registro inválido' });
    }

    const [resultadoActualizacion] = await poolBaseDatos.query(
      'UPDATE registros_ingreso SET hora_salida = CURRENT_TIME WHERE id_registro = ? AND hora_salida IS NULL',
      [idRegistro]
    );

    if (resultadoActualizacion.affectedRows === 0) {
      return respuesta.status(404).json({
        error: 'Registro no encontrado o ya cuenta con hora de salida',
      });
    }

    return respuesta.json({ mensaje: 'Hora de salida registrada correctamente' });
  } catch (errorSalida) {
    console.error('Error al registrar la salida:', errorSalida);
    return respuesta.status(500).json({ error: 'Error en el servidor al registrar salida' });
  }
});

// Ruta para registrar una persona nueva (usada por crearPersona en React)
aplicacion.post('/api/personas', async (solicitud, respuesta) => {
  try {
    const {
      cedula,
      nombre_completo,
      telefono = null,
      eps = null,
      arl = null,
      id_rol,
    } = solicitud.body || {};

    const cedulaLimpia = String(cedula ?? '').trim();
    const nombreLimpio = String(nombre_completo ?? '').trim();
    const idRolNumerico = Number(id_rol);

    if (!cedulaLimpia || !nombreLimpio || !Number.isInteger(idRolNumerico) || idRolNumerico <= 0) {
      return respuesta.status(400).json({
        error: 'Los campos cedula, nombre_completo e id_rol son obligatorios',
      });
    }

    await poolBaseDatos.query(
      `INSERT INTO personas (cedula, nombre_completo, telefono, eps, arl, id_rol)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        cedulaLimpia,
        nombreLimpio,
        telefono ? String(telefono).trim() : null,
        eps ? String(eps).trim() : null,
        arl ? String(arl).trim() : null,
        idRolNumerico,
      ]
    );

    return respuesta.status(201).json({
      mensaje: 'Persona registrada correctamente',
      cedula: cedulaLimpia,
    });
  } catch (errorPersona) {
    if (errorPersona && errorPersona.code === 'ER_DUP_ENTRY') {
      return respuesta.status(409).json({ error: 'Ya existe una persona con esa cédula' });
    }
    if (errorPersona && errorPersona.code === 'ER_NO_REFERENCED_ROW_2') {
      return respuesta.status(400).json({ error: 'El rol especificado no existe' });
    }
    console.error('Error al registrar persona:', errorPersona);
    return respuesta.status(500).json({ error: 'Error en el servidor al guardar la persona' });
  }
});

const servidorHttp = aplicacion.listen(puertoServidor, () => {
  console.log(`Servidor backend corriendo en http://localhost:${puertoServidor}`);
});

const cerrarServidor = async () => {
  servidorHttp.close(async () => {
    try {
      await poolBaseDatos.end();
    } catch (errorCierre) {
      console.error('Error al cerrar el pool de MySQL:', errorCierre);
    }
    process.exit(0);
  });
};

process.on('SIGINT', cerrarServidor);
process.on('SIGTERM', cerrarServidor);
