const fs = require('fs');
const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// Carga automática de server/.env si existe (soportado nativamente en Node >= 20.12)
const rutaArchivoEnv = path.join(__dirname, '.env');
if (fs.existsSync(rutaArchivoEnv) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(rutaArchivoEnv);
}

const aplicacion = express();
const puertoServidor = Number(process.env.PUERTO_SERVIDOR) || 3006;
const SECRETO_JWT =
  process.env.JWT_SECRET || 'clave_secreta_desarrollo_lira_seguridad_2026';
const EXPIRACION_JWT = process.env.JWT_EXPIRACION || '8h';

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

const asegurarTablaUsuarios = async () => {
  await poolBaseDatos.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id_usuario INT AUTO_INCREMENT PRIMARY KEY,
      nombre_usuario VARCHAR(50) NOT NULL UNIQUE,
      nombre_completo VARCHAR(100) NOT NULL,
      contrasena_hash VARCHAR(255) NOT NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const [conteoFilas] = await poolBaseDatos.query(
    'SELECT COUNT(*) AS total FROM usuarios'
  );
  const totalUsuarios = Number(conteoFilas[0]?.total) || 0;

  if (totalUsuarios === 0) {
    const usuarioInicial = (process.env.USUARIO_ADMIN_INICIAL || 'admin').trim();
    const contrasenaInicial = process.env.CONTRASENA_ADMIN_INICIAL || 'admin123';
    const hashContrasena = await bcrypt.hash(contrasenaInicial, 10);

    await poolBaseDatos.query(
      `INSERT INTO usuarios (nombre_usuario, nombre_completo, contrasena_hash, activo)
       VALUES (?, ?, ?, 1)`,
      [usuarioInicial, 'Administrador Lira', hashContrasena]
    );
    console.log(
      `Usuario inicial '${usuarioInicial}' creado automáticamente en la tabla usuarios.`
    );
  }
};

const verificarConexionInicial = async () => {
  try {
    const conexion = await poolBaseDatos.getConnection();
    conexion.release();
    console.log('¡Conectado exitosamente al pool de la base de datos MySQL!');
    await asegurarTablaUsuarios();
  } catch (errorConexion) {
    console.error('Error al conectar a la base de datos:', errorConexion.message);
  }
};

verificarConexionInicial();

// Middleware para verificar el token JWT en rutas protegidas
const verificarTokenJwt = (solicitud, respuesta, siguiente) => {
  const cabeceraAutorizacion = solicitud.headers.authorization || '';
  if (!cabeceraAutorizacion.startsWith('Bearer ')) {
    return respuesta.status(401).json({
      error: 'Acceso no autorizado. Se requiere iniciar sesión.',
    });
  }

  const token = cabeceraAutorizacion.slice(7).trim();
  if (!token) {
    return respuesta.status(401).json({
      error: 'Token de autenticación no proporcionado.',
    });
  }

  try {
    const payloadDecodificado = jwt.verify(token, SECRETO_JWT);
    solicitud.usuarioAutenticado = payloadDecodificado;
    return siguiente();
  } catch {
    return respuesta.status(401).json({
      error: 'La sesión ha expirado o el token es inválido. Inicia sesión nuevamente.',
    });
  }
};

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

// Ruta de inicio de sesión con emisión de token JWT
aplicacion.post('/api/auth/login', async (solicitud, respuesta) => {
  try {
    const { nombreUsuario, contrasena } = solicitud.body || {};
    const usuarioLimpio = String(nombreUsuario ?? '').trim();
    const contrasenaTexto = String(contrasena ?? '');

    if (!usuarioLimpio || !contrasenaTexto) {
      return respuesta.status(400).json({
        error: 'El usuario y la contraseña son obligatorios',
      });
    }

    const [usuariosEncontrados] = await poolBaseDatos.query(
      `SELECT id_usuario, nombre_usuario, nombre_completo, contrasena_hash, activo
       FROM usuarios
       WHERE nombre_usuario = ?
       LIMIT 1`,
      [usuarioLimpio]
    );

    if (usuariosEncontrados.length === 0) {
      return respuesta.status(401).json({
        error: 'Usuario o contraseña incorrectos',
      });
    }

    const usuarioBd = usuariosEncontrados[0];
    if (!usuarioBd.activo) {
      return respuesta.status(403).json({
        error: 'Esta cuenta de usuario se encuentra desactivada',
      });
    }

    const contrasenaValida = await bcrypt.compare(
      contrasenaTexto,
      usuarioBd.contrasena_hash
    );

    if (!contrasenaValida) {
      return respuesta.status(401).json({
        error: 'Usuario o contraseña incorrectos',
      });
    }

    const datosUsuario = {
      id_usuario: usuarioBd.id_usuario,
      nombreUsuario: usuarioBd.nombre_usuario,
      nombreCompleto: usuarioBd.nombre_completo,
    };

    const token = jwt.sign(datosUsuario, SECRETO_JWT, {
      expiresIn: EXPIRACION_JWT,
    });

    return respuesta.json({
      mensaje: 'Inicio de sesión exitoso',
      token,
      usuario: datosUsuario,
    });
  } catch (errorLogin) {
    console.error('Error en inicio de sesión:', errorLogin);
    return respuesta.status(500).json({
      error: 'Error en el servidor al procesar el inicio de sesión',
    });
  }
});

// Ruta para validar sesión activa mediante el token JWT
aplicacion.get('/api/auth/perfil', verificarTokenJwt, (solicitud, respuesta) => {
  return respuesta.json({
    usuario: solicitud.usuarioAutenticado,
  });
});

const LIMITE_POR_DEFECTO = 50;
const LIMITE_MAXIMO = 5000;

const construirCondicionesFiltro = ({ fechaInicio, fechaFin, rol, busqueda }) => {
  const condicionesSql = [];
  const parametrosFiltro = [];

  if (fechaInicio) {
    condicionesSql.push('registros_ingreso.fecha_ingreso >= ?');
    parametrosFiltro.push(String(fechaInicio));
  }

  if (fechaFin) {
    condicionesSql.push('registros_ingreso.fecha_ingreso <= ?');
    parametrosFiltro.push(String(fechaFin));
  }

  if (rol && rol !== 'todos') {
    condicionesSql.push('roles.nombre_rol = ?');
    parametrosFiltro.push(String(rol));
  }

  if (busqueda && String(busqueda).trim() !== '') {
    const terminoBusqueda = `%${String(busqueda).trim()}%`;
    condicionesSql.push(
      '(personas.nombre_completo LIKE ? OR personas.cedula LIKE ?)'
    );
    parametrosFiltro.push(terminoBusqueda, terminoBusqueda);
  }

  const clausulaWhere =
    condicionesSql.length > 0 ? `WHERE ${condicionesSql.join(' AND ')}` : '';

  return { clausulaWhere, parametrosFiltro };
};

// Ruta que llamará tu función obtenerVisitas() en React (paginada de a 50 por defecto)
aplicacion.get('/api/visitas', verificarTokenJwt, async (solicitud, respuesta) => {
  try {
    const {
      fechaInicio,
      fechaFin,
      rol,
      busqueda,
      limite = LIMITE_POR_DEFECTO,
      desplazamiento = 0,
      incluirTotal,
    } = solicitud.query;

    const { clausulaWhere, parametrosFiltro } = construirCondicionesFiltro({
      fechaInicio,
      fechaFin,
      rol,
      busqueda,
    });

    const limiteSeguro = Math.min(
      Math.max(Number(limite) || LIMITE_POR_DEFECTO, 1),
      LIMITE_MAXIMO
    );
    const desplazamientoSeguro = Math.max(Number(desplazamiento) || 0, 0);

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

    const parametrosSql = [...parametrosFiltro, limiteSeguro, desplazamientoSeguro];
    const [registros] = await poolBaseDatos.query(consultaSql, parametrosSql);

    if (incluirTotal === 'true' || incluirTotal === '1') {
      const consultaTotalSql = `
        SELECT COUNT(*) AS total
        FROM registros_ingreso
        INNER JOIN personas ON registros_ingreso.cedula = personas.cedula
        INNER JOIN roles ON personas.id_rol = roles.id_rol
        ${clausulaWhere};
      `;
      const [resultadoTotal] = await poolBaseDatos.query(
        consultaTotalSql,
        parametrosFiltro
      );
      const totalRegistros = Number(resultadoTotal[0]?.total) || 0;

      return respuesta.json({
        registros,
        total: totalRegistros,
        limite: limiteSeguro,
        desplazamiento: desplazamientoSeguro,
      });
    }

    respuesta.json(registros);
  } catch (errorConsulta) {
    console.error('Error al consultar las visitas:', errorConsulta);
    respuesta.status(500).json({ error: 'Error en el servidor al consultar visitas' });
  }
});

// Ruta para obtener estadísticas agregadas respetando los mismos filtros del servidor
aplicacion.get('/api/visitas/estadisticas', verificarTokenJwt, async (solicitud, respuesta) => {
  try {
    const { fechaInicio, fechaFin, rol, busqueda } = solicitud.query;
    const { clausulaWhere, parametrosFiltro } = construirCondicionesFiltro({
      fechaInicio,
      fechaFin,
      rol,
      busqueda,
    });

    const consultaPorRolSql = `
      SELECT
        roles.nombre_rol AS rol,
        COUNT(*) AS total_entradas,
        COUNT(DISTINCT registros_ingreso.cedula) AS visitantes_unicos,
        SUM(
          CASE
            WHEN registros_ingreso.hora_salida IS NULL
              AND registros_ingreso.fecha_ingreso = CURRENT_DATE
            THEN 1
            ELSE 0
          END
        ) AS en_edificio_hoy,
        SUM(
          CASE
            WHEN registros_ingreso.hora_salida IS NULL
              AND registros_ingreso.fecha_ingreso < CURRENT_DATE
            THEN 1
            ELSE 0
          END
        ) AS sin_salida_anteriores,
        SUM(
          CASE
            WHEN registros_ingreso.hora_salida IS NOT NULL
              AND registros_ingreso.hora_salida >= registros_ingreso.hora_ingreso
            THEN TIME_TO_SEC(TIMEDIFF(registros_ingreso.hora_salida, registros_ingreso.hora_ingreso)) / 60
            ELSE 0
          END
        ) AS suma_minutos,
        SUM(
          CASE
            WHEN registros_ingreso.hora_salida IS NOT NULL
              AND registros_ingreso.hora_salida >= registros_ingreso.hora_ingreso
            THEN 1
            ELSE 0
          END
        ) AS visitas_cerradas
      FROM registros_ingreso
      INNER JOIN personas ON registros_ingreso.cedula = personas.cedula
      INNER JOIN roles ON personas.id_rol = roles.id_rol
      ${clausulaWhere}
      GROUP BY roles.nombre_rol;
    `;

    const consultaPorHoraSql = `
      SELECT
        CONCAT(LPAD(HOUR(registros_ingreso.hora_ingreso), 2, '0'), ':00') AS hora,
        COUNT(*) AS cantidad
      FROM registros_ingreso
      INNER JOIN personas ON registros_ingreso.cedula = personas.cedula
      INNER JOIN roles ON personas.id_rol = roles.id_rol
      ${clausulaWhere}
      GROUP BY hora
      ORDER BY hora ASC;
    `;

    const consultaPorDiaSql = `
      SELECT
        registros_ingreso.fecha_ingreso AS fecha,
        COUNT(*) AS cantidad
      FROM registros_ingreso
      INNER JOIN personas ON registros_ingreso.cedula = personas.cedula
      INNER JOIN roles ON personas.id_rol = roles.id_rol
      ${clausulaWhere}
      GROUP BY registros_ingreso.fecha_ingreso
      ORDER BY registros_ingreso.fecha_ingreso ASC;
    `;

    const [[filasPorRol], [filasPorHora], [filasPorDia]] = await Promise.all([
      poolBaseDatos.query(consultaPorRolSql, parametrosFiltro),
      poolBaseDatos.query(consultaPorHoraSql, parametrosFiltro),
      poolBaseDatos.query(consultaPorDiaSql, parametrosFiltro),
    ]);

    respuesta.json({
      porRol: filasPorRol.map((fila) => ({
        rol: fila.rol || 'Sin rol',
        totalEntradas: Number(fila.total_entradas) || 0,
        visitantesUnicos: Number(fila.visitantes_unicos) || 0,
        enEdificioHoy: Number(fila.en_edificio_hoy) || 0,
        sinSalidaAnteriores: Number(fila.sin_salida_anteriores) || 0,
        sumaMinutos: Number(fila.suma_minutos) || 0,
        visitasCerradas: Number(fila.visitas_cerradas) || 0,
      })),
      porHora: filasPorHora.map((fila) => ({
        hora: fila.hora,
        cantidad: Number(fila.cantidad) || 0,
      })),
      porDia: filasPorDia.map((fila) => ({
        fecha: fila.fecha,
        cantidad: Number(fila.cantidad) || 0,
      })),
    });
  } catch (errorEstadisticas) {
    console.error('Error al consultar estadísticas de visitas:', errorEstadisticas);
    respuesta
      .status(500)
      .json({ error: 'Error en el servidor al consultar estadísticas' });
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
