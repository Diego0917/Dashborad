const fs = require('fs');
const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const {
  obtenerConfiguracionUnifi,
  dividirNombreCompleto,
  crearVisitanteUnifi,
  eliminarVisitanteUnifi,
  listarPuertasUnifi,
  generarQrVisitanteUnifi,
  obtenerLogsVisitanteUnifi,
  esAccesoConcedidoUnifi,
  obtenerPuertaDeEventoUnifi,
  enviarQrPorCorreo,
} = require('./unifiAccess');

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
  database: process.env.NOMBRE_BD || 'ingreso_lira',
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

const asegurarTablaAccesosQr = async () => {
  await poolBaseDatos.query(`
    CREATE TABLE IF NOT EXISTS accesos_qr (
      id_qr INT AUTO_INCREMENT PRIMARY KEY,
      id_registro INT NOT NULL UNIQUE,
      unifi_visitor_id VARCHAR(64) NOT NULL,
      puertas_json TEXT NOT NULL,
      usos_actuales INT NOT NULL DEFAULT 0,
      max_usos INT NOT NULL DEFAULT 2,
      eventos_vistos_json TEXT NULL,
      inicio_timestamp BIGINT NOT NULL,
      fin_timestamp BIGINT NOT NULL,
      estado ENUM('ACTIVO', 'COMPLETADO', 'EXPIRADO', 'REVOCADO') NOT NULL DEFAULT 'ACTIVO',
      qr_base64 LONGTEXT NULL,
      fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_accesos_qr_estado (estado),
      INDEX idx_accesos_qr_visitor (unifi_visitor_id),
      CONSTRAINT fk_qr_registro FOREIGN KEY (id_registro) REFERENCES registros_ingreso(id_registro) ON DELETE CASCADE
    );
  `);

  // Permitir hora_ingreso NULL para invitaciones con QR que aún no han sido leídas en cámara UniFi
  await poolBaseDatos
    .query(
      'ALTER TABLE registros_ingreso MODIFY COLUMN hora_ingreso TIME NULL DEFAULT (CURRENT_TIME)'
    )
    .catch(() => {});

  // Si existen registros con QR sin usos (0 lecturas en cámara), dejar hora_ingreso en NULL hasta que llegue la persona
  await poolBaseDatos
    .query(`
      UPDATE registros_ingreso
      INNER JOIN accesos_qr ON accesos_qr.id_registro = registros_ingreso.id_registro
      SET registros_ingreso.hora_ingreso = NULL
      WHERE accesos_qr.usos_actuales = 0 AND registros_ingreso.hora_salida IS NULL
    `)
    .catch(() => {});
};

const verificarConexionInicial = async () => {
  try {
    const conexion = await poolBaseDatos.getConnection();
    conexion.release();
    console.log('¡Conectado exitosamente al pool de la base de datos MySQL!');
    await asegurarTablaUsuarios();
    await asegurarTablaAccesosQr();
  } catch (errorConexion) {
    console.error('Error al conectar a la base de datos:', errorConexion.message);
  }
};

verificarConexionInicial();

// Ruta pública de verificación de salud (healthcheck para Docker y monitoreo)
aplicacion.get('/api/salud', async (_solicitud, respuesta) => {
  try {
    await poolBaseDatos.query('SELECT 1');
    return respuesta.json({ estado: 'ok', bd: 'conectada' });
  } catch (errorSalud) {
    return respuesta.status(500).json({
      estado: 'error',
      mensaje: errorSalud.message,
    });
  }
});

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
        registros_ingreso.hora_salida,
        accesos_qr.id_qr,
        accesos_qr.unifi_visitor_id,
        accesos_qr.estado AS estado_qr,
        accesos_qr.usos_actuales,
        accesos_qr.max_usos,
        accesos_qr.inicio_timestamp,
        accesos_qr.fin_timestamp
      FROM registros_ingreso
      INNER JOIN personas ON registros_ingreso.cedula = personas.cedula
      INNER JOIN roles ON personas.id_rol = roles.id_rol
      LEFT JOIN accesos_qr ON registros_ingreso.id_registro = accesos_qr.id_registro
      ${clausulaWhere}
      ORDER BY
        registros_ingreso.fecha_ingreso DESC,
        COALESCE(registros_ingreso.hora_ingreso, '23:59:59') DESC,
        registros_ingreso.id_registro DESC
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
        SUM(
          CASE
            WHEN (accesos_qr.id_qr IS NULL OR accesos_qr.usos_actuales >= 1)
              AND registros_ingreso.hora_ingreso IS NOT NULL
            THEN 1
            ELSE 0
          END
        ) AS total_entradas,
        COUNT(
          DISTINCT CASE
            WHEN (accesos_qr.id_qr IS NULL OR accesos_qr.usos_actuales >= 1)
              AND registros_ingreso.hora_ingreso IS NOT NULL
            THEN registros_ingreso.cedula
            ELSE NULL
          END
        ) AS visitantes_unicos,
        SUM(
          CASE
            WHEN (accesos_qr.id_qr IS NULL OR accesos_qr.usos_actuales >= 1)
              AND registros_ingreso.hora_ingreso IS NOT NULL
              AND registros_ingreso.hora_salida IS NULL
              AND registros_ingreso.fecha_ingreso = CURRENT_DATE
            THEN 1
            ELSE 0
          END
        ) AS en_edificio_hoy,
        SUM(
          CASE
            WHEN (accesos_qr.id_qr IS NULL OR accesos_qr.usos_actuales >= 1)
              AND registros_ingreso.hora_ingreso IS NOT NULL
              AND registros_ingreso.hora_salida IS NULL
              AND registros_ingreso.fecha_ingreso < CURRENT_DATE
            THEN 1
            ELSE 0
          END
        ) AS sin_salida_anteriores,
        SUM(
          CASE
            WHEN registros_ingreso.hora_ingreso IS NOT NULL
              AND registros_ingreso.hora_salida IS NOT NULL
              AND registros_ingreso.hora_salida >= registros_ingreso.hora_ingreso
            THEN TIME_TO_SEC(TIMEDIFF(registros_ingreso.hora_salida, registros_ingreso.hora_ingreso)) / 60
            ELSE 0
          END
        ) AS suma_minutos,
        SUM(
          CASE
            WHEN registros_ingreso.hora_ingreso IS NOT NULL
              AND registros_ingreso.hora_salida IS NOT NULL
              AND registros_ingreso.hora_salida >= registros_ingreso.hora_ingreso
            THEN 1
            ELSE 0
          END
        ) AS visitas_cerradas
      FROM registros_ingreso
      INNER JOIN personas ON registros_ingreso.cedula = personas.cedula
      INNER JOIN roles ON personas.id_rol = roles.id_rol
      LEFT JOIN accesos_qr ON registros_ingreso.id_registro = accesos_qr.id_registro
      ${clausulaWhere}
      GROUP BY roles.nombre_rol;
    `;

    const condicionIngresados =
      clausulaWhere.length > 0
        ? `${clausulaWhere} AND (accesos_qr.id_qr IS NULL OR accesos_qr.usos_actuales >= 1) AND registros_ingreso.hora_ingreso IS NOT NULL`
        : 'WHERE (accesos_qr.id_qr IS NULL OR accesos_qr.usos_actuales >= 1) AND registros_ingreso.hora_ingreso IS NOT NULL';

    const consultaPorHoraSql = `
      SELECT
        CONCAT(LPAD(HOUR(registros_ingreso.hora_ingreso), 2, '0'), ':00') AS hora,
        COUNT(*) AS cantidad
      FROM registros_ingreso
      INNER JOIN personas ON registros_ingreso.cedula = personas.cedula
      INNER JOIN roles ON personas.id_rol = roles.id_rol
      LEFT JOIN accesos_qr ON registros_ingreso.id_registro = accesos_qr.id_registro
      ${condicionIngresados}
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
      LEFT JOIN accesos_qr ON registros_ingreso.id_registro = accesos_qr.id_registro
      ${condicionIngresados}
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

// Ruta para buscar una persona por cédula (autocompletado en formulario de validación/invitación)
aplicacion.get('/api/personas/:cedula', async (solicitud, respuesta) => {
  try {
    const cedulaLimpia = String(solicitud.params.cedula ?? '').trim();
    if (!cedulaLimpia) {
      return respuesta.status(400).json({ error: 'La cédula es obligatoria' });
    }

    const [filas] = await poolBaseDatos.query(
      `SELECT
        personas.cedula,
        personas.nombre_completo,
        personas.telefono,
        personas.eps,
        personas.arl,
        personas.id_rol,
        roles.nombre_rol AS rol
       FROM personas
       INNER JOIN roles ON personas.id_rol = roles.id_rol
       WHERE personas.cedula = ?
       LIMIT 1`,
      [cedulaLimpia]
    );

    if (filas.length === 0) {
      return respuesta.status(404).json({ error: 'Persona no encontrada' });
    }

    return respuesta.json(filas[0]);
  } catch (errorBusqueda) {
    console.error('Error al buscar persona por cédula:', errorBusqueda);
    return respuesta.status(500).json({ error: 'Error al consultar la persona' });
  }
});

// Ruta para listar puertas disponibles desde la consola UniFi Access
aplicacion.get('/api/unifi/puertas', async (_solicitud, respuesta) => {
  const configUnifi = obtenerConfiguracionUnifi();
  try {
    const puertas = await listarPuertasUnifi();
    return respuesta.json({
      puertas,
      puertaDefecto: configUnifi.puertaDefecto,
      conectado: true,
    });
  } catch (errorPuertas) {
    console.warn('No se pudo listar puertas desde UniFi Access:', errorPuertas.message);
    return respuesta.json({
      puertas: [
        {
          id: configUnifi.puertaDefecto,
          nombre: 'Puerta Principal / Gestión Humana (Por defecto)',
          estado: 'configurada',
        },
      ],
      puertaDefecto: configUnifi.puertaDefecto,
      conectado: false,
      advertencia: errorPuertas.message,
    });
  }
});

// Ruta para registrar los datos de validación de la persona, crear el ingreso y generar su código QR de invitación en UniFi Access
aplicacion.post('/api/visitas/con-qr', async (solicitud, respuesta) => {
  try {
    const {
      cedula,
      nombre_completo,
      telefono = null,
      eps = null,
      arl = null,
      id_rol = 1,
      motivo = '',
      correo = '',
      puertas = [],
      modoActivacion = 'ambos',
      ventanaSegundos,
      maxUsos,
    } = solicitud.body || {};

    const cedulaLimpia = String(cedula ?? '').trim();
    const nombreLimpio = String(nombre_completo ?? '').trim();
    const idRolNumerico = Number(id_rol) || 1;
    const correoLimpio = correo ? String(correo).trim() : '';

    if (!cedulaLimpia || !nombreLimpio) {
      return respuesta.status(400).json({
        error: 'La cédula y el nombre completo son obligatorios en el formulario de validación.',
      });
    }

    const telefonoLimpio = telefono ? String(telefono).trim() : null;
    const epsLimpia = eps ? String(eps).trim() : null;
    const arlLimpia = arl ? String(arl).trim() : null;

    // 1) Guardar o actualizar la información de validación de la persona en la tabla personas
    await poolBaseDatos.query(
      `INSERT INTO personas (cedula, nombre_completo, telefono, eps, arl, id_rol)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         nombre_completo = VALUES(nombre_completo),
         telefono = COALESCE(VALUES(telefono), personas.telefono),
         eps = COALESCE(VALUES(eps), personas.eps),
         arl = COALESCE(VALUES(arl), personas.arl),
         id_rol = VALUES(id_rol)`,
      [
        cedulaLimpia,
        nombreLimpio,
        telefonoLimpio,
        epsLimpia,
        arlLimpia,
        idRolNumerico,
      ]
    );

    const datosPersona = {
      cedula: cedulaLimpia,
      nombre_completo: nombreLimpio,
      telefono: telefonoLimpio,
      eps: epsLimpia,
      arl: arlLimpia,
      id_rol: idRolNumerico,
    };

    // 2) Crear el visitante temporal en la consola UniFi Access y emitir su QR con quiet zone
    const configUnifi = obtenerConfiguracionUnifi();
    const { nombres, apellidos } = dividirNombreCompleto(datosPersona.nombre_completo);
    const puertasSeleccionadas =
      Array.isArray(puertas) && puertas.length > 0
        ? puertas.filter(Boolean)
        : [configUnifi.puertaDefecto];

    const esSoloTiempo = modoActivacion === 'tiempo' || Number(maxUsos) === 0;
    const esSoloUsos = modoActivacion === 'usos';

    const duracionVigencia = esSoloUsos
      ? 86400 // 24 horas de margen en UniFi mientras completa los usos configurados
      : Number(ventanaSegundos) >= 60
        ? Number(ventanaSegundos)
        : configUnifi.ventanaSegundos;

    const limiteUsos = esSoloTiempo
      ? 0
      : Number(maxUsos) >= 1
        ? Number(maxUsos)
        : configUnifi.maxAccesos;

    const motivoLimpio = motivo ? String(motivo).trim() : 'Visita autorizada';

    const visitanteUnifi = await crearVisitanteUnifi({
      nombres,
      apellidos,
      motivo: motivoLimpio,
      telefono: datosPersona.telefono || '0000000000',
      doorIds: puertasSeleccionadas,
      email: correoLimpio,
      ventanaSegundos: duracionVigencia,
    });

    let qrGenerado;
    try {
      qrGenerado = await generarQrVisitanteUnifi(visitanteUnifi.visitorId);
    } catch (errorQr) {
      // Si falla la emisión del QR, limpiamos el visitante en UniFi para no dejar huérfanos
      await eliminarVisitanteUnifi(visitanteUnifi.visitorId, true).catch(() => {});
      throw errorQr;
    }

    // 3) Guardar el registro de invitación (hora_ingreso queda NULL hasta que la cámara UniFi detecte el 1er escaneo del QR)
    const [resultadoIngreso] = await poolBaseDatos.query(
      'INSERT INTO registros_ingreso (cedula, motivo, hora_ingreso) VALUES (?, ?, NULL)',
      [cedulaLimpia, motivoLimpio]
    );

    const idRegistro = resultadoIngreso.insertId;

    const [resultadoQr] = await poolBaseDatos.query(
      `INSERT INTO accesos_qr (
        id_registro,
        unifi_visitor_id,
        puertas_json,
        usos_actuales,
        max_usos,
        eventos_vistos_json,
        inicio_timestamp,
        fin_timestamp,
        estado,
        qr_base64
      ) VALUES (?, ?, ?, 0, ?, '[]', ?, ?, 'ACTIVO', ?)`,
      [
        idRegistro,
        visitanteUnifi.visitorId,
        JSON.stringify(visitanteUnifi.puertasAsignadas),
        limiteUsos,
        visitanteUnifi.inicioTimestamp,
        visitanteUnifi.finTimestamp,
        qrGenerado.base64DataUrl,
      ]
    );

    let estadoCorreo = { enviado: false, mensaje: null };
    if (correoLimpio) {
      try {
        await enviarQrPorCorreo({
          destinatario: correoLimpio,
          qrBase64: qrGenerado.base64DataUrl,
          nombreCompleto: datosPersona.nombre_completo,
          cedula: cedulaLimpia,
          motivo: motivoLimpio,
          finTimestamp: visitanteUnifi.finTimestamp,
          maxUsos: limiteUsos,
        });
        estadoCorreo = {
          enviado: true,
          mensaje: `Código QR enviado al correo ${correoLimpio}`,
        };
      } catch (errorEmail) {
        estadoCorreo = {
          enviado: false,
          mensaje: errorEmail.message,
        };
      }
    }

    return respuesta.status(201).json({
      mensaje: 'Datos de la persona guardados y código QR de invitación generado exitosamente',
      id_registro: idRegistro,
      id_qr: resultadoQr.insertId,
      cedula: cedulaLimpia,
      nombre_completo: datosPersona.nombre_completo,
      motivo: motivoLimpio,
      unifi_visitor_id: visitanteUnifi.visitorId,
      estado_qr: 'ACTIVO',
      modo_activacion: esSoloTiempo ? 'tiempo' : esSoloUsos ? 'usos' : 'ambos',
      usos_actuales: 0,
      max_usos: limiteUsos,
      inicio_timestamp: visitanteUnifi.inicioTimestamp,
      fin_timestamp: visitanteUnifi.finTimestamp,
      qr_base64: qrGenerado.base64DataUrl,
      simulado: Boolean(visitanteUnifi.simulado),
      correo: estadoCorreo,
    });
  } catch (errorConQr) {
    console.error('Error al generar ingreso con QR:', errorConQr);
    return respuesta.status(502).json({
      error:
        errorConQr.message ||
        'No se pudo generar el código QR en la consola UniFi Access',
    });
  }
});

// Ruta para consultar el detalle e imagen del QR de un registro de ingreso
aplicacion.get('/api/visitas/:idRegistro/qr', verificarTokenJwt, async (solicitud, respuesta) => {
  try {
    const idRegistro = Number(solicitud.params.idRegistro);
    if (!Number.isInteger(idRegistro) || idRegistro <= 0) {
      return respuesta.status(400).json({ error: 'Identificador de registro inválido' });
    }

    const [filas] = await poolBaseDatos.query(
      `SELECT
        accesos_qr.id_qr,
        accesos_qr.id_registro,
        accesos_qr.unifi_visitor_id,
        accesos_qr.puertas_json,
        accesos_qr.usos_actuales,
        accesos_qr.max_usos,
        accesos_qr.inicio_timestamp,
        accesos_qr.fin_timestamp,
        accesos_qr.estado AS estado_qr,
        accesos_qr.qr_base64,
        personas.cedula,
        personas.nombre_completo,
        registros_ingreso.motivo
       FROM accesos_qr
       INNER JOIN registros_ingreso ON accesos_qr.id_registro = registros_ingreso.id_registro
       INNER JOIN personas ON registros_ingreso.cedula = personas.cedula
       WHERE accesos_qr.id_registro = ?
       LIMIT 1`,
      [idRegistro]
    );

    if (filas.length === 0) {
      return respuesta.status(404).json({
        error: 'Este registro de ingreso no tiene un código QR asociado',
      });
    }

    return respuesta.json(filas[0]);
  } catch (errorDetalleQr) {
    console.error('Error al obtener detalle del QR:', errorDetalleQr);
    return respuesta.status(500).json({ error: 'Error al consultar el código QR' });
  }
});

// Ruta para enviar o reenviar el código QR de una visita por correo electrónico
aplicacion.post('/api/visitas/:idRegistro/qr/correo', async (solicitud, respuesta) => {
  try {
    const idRegistro = Number(solicitud.params.idRegistro);
    const { correo } = solicitud.body || {};
    const correoLimpio = String(correo ?? '').trim();

    if (!Number.isInteger(idRegistro) || idRegistro <= 0) {
      return respuesta.status(400).json({ error: 'Identificador de registro inválido' });
    }
    if (!correoLimpio) {
      return respuesta
        .status(400)
        .json({ error: 'Debes indicar una dirección de correo electrónico' });
    }

    const [filas] = await poolBaseDatos.query(
      `SELECT
        accesos_qr.qr_base64,
        accesos_qr.fin_timestamp,
        accesos_qr.max_usos,
        personas.cedula,
        personas.nombre_completo,
        registros_ingreso.motivo
       FROM accesos_qr
       INNER JOIN registros_ingreso ON accesos_qr.id_registro = registros_ingreso.id_registro
       INNER JOIN personas ON registros_ingreso.cedula = personas.cedula
       WHERE accesos_qr.id_registro = ?
       LIMIT 1`,
      [idRegistro]
    );

    if (filas.length === 0 || !filas[0].qr_base64) {
      return respuesta
        .status(404)
        .json({ error: 'No se encontró la imagen QR para este ingreso' });
    }

    const fila = filas[0];
    await enviarQrPorCorreo({
      destinatario: correoLimpio,
      qrBase64: fila.qr_base64,
      nombreCompleto: fila.nombre_completo,
      cedula: fila.cedula,
      motivo: fila.motivo,
      finTimestamp: fila.fin_timestamp,
      maxUsos: fila.max_usos,
    });

    return respuesta.json({
      mensaje: `Código QR enviado correctamente al correo ${correoLimpio}`,
    });
  } catch (errorCorreo) {
    console.error('Error al enviar QR por correo:', errorCorreo);
    return respuesta.status(502).json({
      error: errorCorreo.message || 'No se pudo enviar el código QR por correo',
    });
  }
});

// Ruta para revocar manualmente un código QR antes de que venza
aplicacion.delete('/api/visitas/:idRegistro/qr', verificarTokenJwt, async (solicitud, respuesta) => {
  try {
    const idRegistro = Number(solicitud.params.idRegistro);
    if (!Number.isInteger(idRegistro) || idRegistro <= 0) {
      return respuesta.status(400).json({ error: 'Identificador de registro inválido' });
    }

    const [filas] = await poolBaseDatos.query(
      'SELECT id_qr, unifi_visitor_id, estado FROM accesos_qr WHERE id_registro = ? LIMIT 1',
      [idRegistro]
    );

    if (filas.length === 0) {
      return respuesta.status(404).json({ error: 'No existe un QR para este ingreso' });
    }

    const qrActual = filas[0];
    if (qrActual.unifi_visitor_id) {
      await eliminarVisitanteUnifi(qrActual.unifi_visitor_id, true).catch((err) => {
        console.warn(
          `Advertencia al eliminar visitante ${qrActual.unifi_visitor_id} en UniFi:`,
          err.message
        );
      });
    }

    await poolBaseDatos.query(
      "UPDATE accesos_qr SET estado = 'REVOCADO' WHERE id_qr = ?",
      [qrActual.id_qr]
    );

    return respuesta.json({
      mensaje: 'Credencial QR revocada y eliminada de UniFi Access correctamente',
    });
  } catch (errorRevocar) {
    console.error('Error al revocar QR:', errorRevocar);
    return respuesta.status(500).json({ error: 'Error al revocar el código QR' });
  }
});

// ── MONITOR EN SEGUNDO PLANO: Control de Tiempo de Vida y Usos (1 Entrada + 1 Salida) ──
let monitoreoEnCurso = false;

const procesarCicloMonitoreoQr = async () => {
  if (monitoreoEnCurso) return;
  monitoreoEnCurso = true;

  try {
    const [qrsActivos] = await poolBaseDatos.query(
      `SELECT
        id_qr,
        id_registro,
        unifi_visitor_id,
        usos_actuales,
        max_usos,
        eventos_vistos_json,
        inicio_timestamp,
        fin_timestamp
       FROM accesos_qr
       WHERE estado = 'ACTIVO'`
    );

    if (qrsActivos.length === 0) return;

    const ahoraSegundos = Math.floor(Date.now() / 1000);

    for (const qr of qrsActivos) {
      try {
        let eventosVistos = [];
        try {
          eventosVistos = JSON.parse(qr.eventos_vistos_json || '[]');
          if (!Array.isArray(eventosVistos)) eventosVistos = [];
        } catch {
          eventosVistos = [];
        }

        const conjuntoVistos = new Set(eventosVistos);
        let huboCambioEventos = false;

        // Consultar logs de apertura de puerta en UniFi Access desde inicio_timestamp
        try {
          const eventos = await obtenerLogsVisitanteUnifi(
            qr.unifi_visitor_id,
            qr.inicio_timestamp
          );

          for (const ev of eventos) {
            const evId = String(ev._id || ev.id || ev['@timestamp'] || '');
            if (!evId || conjuntoVistos.has(evId)) continue;

            if (esAccesoConcedidoUnifi(ev, qr.unifi_visitor_id)) {
              conjuntoVistos.add(evId);
              huboCambioEventos = true;
              console.log(
                `[Monitor QR] Acceso CONCEDIDO #${conjuntoVistos.size} para visitante ${qr.unifi_visitor_id} en '${obtenerPuertaDeEventoUnifi(ev)}'`
              );
            }
          }
        } catch (errorLogUnifi) {
          // Si la consola UniFi no responde momentáneamente, aún verificamos expiración por tiempo
          console.warn(
            `[Monitor QR] No se pudieron leer logs de ${qr.unifi_visitor_id}: ${errorLogUnifi.message}`
          );
        }

        const totalAccesosConcedidos = conjuntoVistos.size;

        // Si la cámara UniFi detectó el primer acceso (Entrada) y aún no tenía hora_ingreso, registrarla ahora
        if (totalAccesosConcedidos >= 1 && Number(qr.usos_actuales) === 0) {
          await poolBaseDatos.query(
            `UPDATE registros_ingreso
             SET fecha_ingreso = CURRENT_DATE,
                 hora_ingreso = COALESCE(hora_ingreso, CURRENT_TIME)
             WHERE id_registro = ?`,
            [qr.id_registro]
          );
        }

        // Caso 1: Alcanzó el máximo de usos configurados (solo aplica cuando max_usos > 0)
        if (Number(qr.max_usos) > 0 && totalAccesosConcedidos >= Number(qr.max_usos)) {
          console.log(
            `[Monitor QR] Visitante ${qr.unifi_visitor_id} completó ${totalAccesosConcedidos}/${qr.max_usos} usos. Registrando salida y revocando QR...`
          );

          await eliminarVisitanteUnifi(qr.unifi_visitor_id, true).catch((err) => {
            console.warn(
              `[Monitor QR] Error al borrar visitante completado ${qr.unifi_visitor_id}:`,
              err.message
            );
          });

          await poolBaseDatos.query(
            `UPDATE accesos_qr
             SET usos_actuales = ?,
                 eventos_vistos_json = ?,
                 estado = 'COMPLETADO'
             WHERE id_qr = ?`,
            [
              totalAccesosConcedidos,
              JSON.stringify(Array.from(conjuntoVistos)),
              qr.id_qr,
            ]
          );

          // Registrar automáticamente la hora de salida en registros_ingreso
          await poolBaseDatos.query(
            `UPDATE registros_ingreso
             SET hora_salida = CURRENT_TIME
             WHERE id_registro = ? AND hora_salida IS NULL`,
            [qr.id_registro]
          );
          continue;
        }

        // Caso 2: Venció la ventana de tiempo (ej. 1 hora) sin completar todos los usos
        if (ahoraSegundos >= Number(qr.fin_timestamp)) {
          console.log(
            `[Monitor QR] Ventana de tiempo vencida para visitante ${qr.unifi_visitor_id}. Eliminando credencial en UniFi...`
          );

          await eliminarVisitanteUnifi(qr.unifi_visitor_id, true).catch((err) => {
            console.warn(
              `[Monitor QR] Error al borrar visitante expirado ${qr.unifi_visitor_id}:`,
              err.message
            );
          });

          await poolBaseDatos.query(
            `UPDATE accesos_qr
             SET usos_actuales = ?,
                 eventos_vistos_json = ?,
                 estado = 'EXPIRADO'
             WHERE id_qr = ?`,
            [
              totalAccesosConcedidos,
              JSON.stringify(Array.from(conjuntoVistos)),
              qr.id_qr,
            ]
          );
          continue;
        }

        // Caso 3: Hubo un nuevo uso (ej. Uso #1 = Entrada), actualizar contador en BD
        if (huboCambioEventos && totalAccesosConcedidos !== qr.usos_actuales) {
          await poolBaseDatos.query(
            `UPDATE accesos_qr
             SET usos_actuales = ?,
                 eventos_vistos_json = ?
             WHERE id_qr = ?`,
            [
              totalAccesosConcedidos,
              JSON.stringify(Array.from(conjuntoVistos)),
              qr.id_qr,
            ]
          );
        }
      } catch (errorItemQr) {
        console.error(
          `[Monitor QR] Error procesando QR #${qr.id_qr}:`,
          errorItemQr.message
        );
      }
    }
  } catch (errorGeneralMonitor) {
    console.error('[Monitor QR] Error en ciclo de monitoreo:', errorGeneralMonitor.message);
  } finally {
    monitoreoEnCurso = false;
  }
};

const { pollIntervalMs } = obtenerConfiguracionUnifi();
const intervaloMonitorQr = setInterval(
  procesarCicloMonitoreoQr,
  Math.max(pollIntervalMs, 3000)
);

const servidorHttp = aplicacion.listen(puertoServidor, () => {
  console.log(`Servidor backend corriendo en http://localhost:${puertoServidor}`);
});

const cerrarServidor = async () => {
  clearInterval(intervaloMonitorQr);
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
