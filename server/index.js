const fs = require('fs');
const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const {
  obtenerConfiguracionUnifi,
  modoPruebaUnifiSolicitado,
  esEntornoProduccion,
  esVisitanteSimulado,
  dividirNombreCompleto,
  crearVisitanteUnifi,
  eliminarVisitanteUnifi,
  listarPuertasUnifi,
  generarQrVisitanteUnifi,
  obtenerLogsVisitanteUnifi,
  obtenerLogsPuertasGeneralesUnifi,
  buscarUsuariosUnifi,
  esAccesoConcedidoUnifi,
  obtenerPuertaDeEventoUnifi,
  esPuertaPrincipalUnifi,
  ordenarEventosUnifiCronologicamente,
  obtenerDireccionYHoraEventoUnifi,
  evaluarEventosQrConAntirrebote,
  enviarQrPorCorreo,
} = require('./unifiAccess');
const { obtenerSecretoJwt, obtenerContrasenaAdminInicial } = require('./validarSecretos');
const {
  registrarEventoRostroEmpleado,
  registrarEntradaManual,
  registrarSalidaManual,
  guardarVisitaConQrEnBd,
} = require('./eventosRostro');
const { inicializarBaseDatosConReintentos } = require('./migraciones');
const { crearLimitadorLogin } = require('./limitadorLogin');
const { procesarWebhookWhatsapp } = require('./flujoWhatsapp');
const {
  whatsappConfigurado,
  obtenerVerifyTokenWhatsapp,
  normalizarUltimos10Digitos,
  normalizarTelefonoWhatsapp,
  enviarTextoWhatsapp,
  enviarImagenQrWhatsapp,
  enviarPlantillaWhatsapp,
  verificarFirmaMeta,
} = require('./whatsappApi');

// Carga automática de server/.env si existe (soportado nativamente en Node >= 20.12)
const rutaArchivoEnv = path.join(__dirname, '.env');
if (fs.existsSync(rutaArchivoEnv) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(rutaArchivoEnv);
}

const aplicacion = express();
// Confiar en el primer proxy (Nginx en Docker) para leer la IP real en X-Forwarded-For
aplicacion.set('trust proxy', 1);
const puertoServidor = Number(process.env.PUERTO_SERVIDOR) || 3006;

const {
  middlewareVerificarBloqueoLogin,
  registrarFalloLogin,
  limpiarIntentosLogin,
} = crearLimitadorLogin();

let SECRETO_JWT;
try {
  SECRETO_JWT = obtenerSecretoJwt();
} catch (errorSecreto) {
  console.error(`[Seguridad] ${errorSecreto.message}`);
  process.exit(1);
}
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

aplicacion.use(
  express.json({
    verify: (solicitud, _respuesta, buf) => {
      solicitud.rawBody = buf;
    },
  })
);

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

const asegurarUsuarioAdminInicial = async () => {
  const [conteoFilas] = await poolBaseDatos.query(
    'SELECT COUNT(*) AS total FROM usuarios'
  );
  const totalUsuarios = Number(conteoFilas[0]?.total) || 0;

  if (totalUsuarios === 0) {
    const usuarioInicial = (process.env.USUARIO_ADMIN_INICIAL || 'admin').trim();
    let contrasenaInicial;
    try {
      contrasenaInicial = obtenerContrasenaAdminInicial();
    } catch (errorContrasenaAdmin) {
      // Sin una contraseña segura no se crea un admin con clave conocida: se detiene el servidor.
      console.error(`[Seguridad] ${errorContrasenaAdmin.message}`);
      process.exit(1);
    }
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

// Ruta de inicio de sesión con emisión de token JWT y límite de intentos fallidos
aplicacion.post(
  '/api/auth/login',
  middlewareVerificarBloqueoLogin,
  async (solicitud, respuesta) => {
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
        registrarFalloLogin(solicitud, usuarioLimpio);
        return respuesta.status(401).json({
          error: 'Usuario o contraseña incorrectos',
        });
      }

      const usuarioBd = usuariosEncontrados[0];
      if (!usuarioBd.activo) {
        registrarFalloLogin(solicitud, usuarioLimpio);
        return respuesta.status(403).json({
          error: 'Esta cuenta de usuario se encuentra desactivada',
        });
      }

      const contrasenaValida = await bcrypt.compare(
        contrasenaTexto,
        usuarioBd.contrasena_hash
      );

      if (!contrasenaValida) {
        registrarFalloLogin(solicitud, usuarioLimpio);
        return respuesta.status(401).json({
          error: 'Usuario o contraseña incorrectos',
        });
      }

      limpiarIntentosLogin(solicitud, usuarioLimpio);

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
        registros_ingreso.total_entradas,
        registros_ingreso.total_salidas,
        registros_ingreso.movimientos_json,
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

    // Expresión reutilizable que replica la lógica del último movimiento real en movimientos_json
    const condicionActualmenteDentroSql = `(
      (
        JSON_VALID(registros_ingreso.movimientos_json)
        AND JSON_LENGTH(registros_ingreso.movimientos_json) > 0
        AND JSON_UNQUOTE(
          JSON_EXTRACT(
            registros_ingreso.movimientos_json,
            CONCAT('$[', JSON_LENGTH(registros_ingreso.movimientos_json) - 1, '].tipo')
          )
        ) IN ('ENTRADA', 'ACCESO_INTERNO')
      )
      OR (
        (
          registros_ingreso.movimientos_json IS NULL
          OR NOT JSON_VALID(registros_ingreso.movimientos_json)
          OR JSON_LENGTH(registros_ingreso.movimientos_json) = 0
        )
        AND (
          registros_ingreso.total_entradas > registros_ingreso.total_salidas
          OR registros_ingreso.hora_salida IS NULL
        )
      )
    )`;

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
              AND registros_ingreso.fecha_ingreso = CURRENT_DATE
              AND ${condicionActualmenteDentroSql}
            THEN 1
            ELSE 0
          END
        ) AS en_edificio_hoy,
        SUM(
          CASE
            WHEN (accesos_qr.id_qr IS NULL OR accesos_qr.usos_actuales >= 1)
              AND registros_ingreso.hora_ingreso IS NOT NULL
              AND registros_ingreso.fecha_ingreso = CURRENT_DATE
              AND NOT ${condicionActualmenteDentroSql}
            THEN 1
            ELSE 0
          END
        ) AS por_fuera_hoy,
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
        porFueraHoy: Number(fila.por_fuera_hoy) || 0,
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
aplicacion.post('/api/visitas', verificarTokenJwt, async (solicitud, respuesta) => {
  try {
    const { cedula, motivo = null } = solicitud.body || {};
    const cedulaLimpia = String(cedula ?? '').trim();

    if (!cedulaLimpia) {
      return respuesta.status(400).json({ error: 'La cédula es obligatoria' });
    }

    const motivoLimpio = motivo ? String(motivo).trim() : null;
    const resultado = await registrarEntradaManual(poolBaseDatos, {
      cedula: cedulaLimpia,
      motivo: motivoLimpio,
    });

    if (resultado.estado === 'no_encontrada') {
      return respuesta.status(404).json({
        error: 'La persona no está registrada. Regístrala primero antes de crear el ingreso.',
      });
    }

    if (resultado.estado === 'acumulada') {
      return respuesta.status(200).json({
        mensaje: `Entrada #${resultado.total_entradas} acumulada en el registro de hoy`,
        id_registro: resultado.id_registro,
        total_entradas: resultado.total_entradas,
        total_salidas: resultado.total_salidas,
      });
    }

    return respuesta.status(201).json({
      mensaje: 'Ingreso registrado correctamente',
      id_registro: resultado.id_registro,
      total_entradas: resultado.total_entradas,
      total_salidas: resultado.total_salidas,
    });
  } catch (errorInsercion) {
    console.error('Error al registrar el ingreso:', errorInsercion);
    return respuesta.status(500).json({ error: 'Error en el servidor al registrar ingreso' });
  }
});

// Ruta para registrar la hora de salida de una visita
aplicacion.patch('/api/visitas/:idRegistro/salida', verificarTokenJwt, async (solicitud, respuesta) => {
  try {
    const idRegistro = Number(solicitud.params.idRegistro);
    if (!Number.isInteger(idRegistro) || idRegistro <= 0) {
      return respuesta.status(400).json({ error: 'Identificador de registro inválido' });
    }

    const resultado = await registrarSalidaManual(poolBaseDatos, { idRegistro });
    if (resultado.estado === 'no_encontrado') {
      return respuesta.status(404).json({
        error: 'Registro no encontrado',
      });
    }

    if (resultado.estado === 'sin_entrada') {
      return respuesta.status(409).json({
        error: 'No se puede registrar una salida porque esta visita aún no tiene una entrada registrada.',
      });
    }

    if (resultado.estado === 'ya_salio') {
      return respuesta.status(409).json({
        error: 'La salida ya fue registrada. Debe registrarse una nueva entrada antes de otra salida.',
      });
    }

    return respuesta.json({
      mensaje: `Hora de salida #${resultado.total_salidas} registrada correctamente`,
      total_salidas: resultado.total_salidas,
    });
  } catch (errorSalida) {
    console.error('Error al registrar la salida:', errorSalida);
    return respuesta.status(500).json({ error: 'Error en el servidor al registrar salida' });
  }
});

// Ruta para registrar una persona nueva (usada por crearPersona en React)
aplicacion.post('/api/personas', verificarTokenJwt, async (solicitud, respuesta) => {
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
aplicacion.get('/api/personas/:cedula', verificarTokenJwt, async (solicitud, respuesta) => {
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
      // Si no está aún en MySQL, intentar buscar en UniFi Access (/api/v1/developer/users/search)
      try {
        const usuariosUnifi = await buscarUsuariosUnifi(cedulaLimpia);
        const coincidencia = usuariosUnifi.find(
          (u) =>
            u.cedula.toLowerCase() === cedulaLimpia.toLowerCase() ||
            u.nombre_completo.toLowerCase().includes(cedulaLimpia.toLowerCase())
        );

        if (coincidencia) {
          await poolBaseDatos.query(
            `INSERT INTO personas (cedula, nombre_completo, telefono, id_rol, unifi_user_id)
             VALUES (?, ?, ?, 2, ?)
             ON DUPLICATE KEY UPDATE
               nombre_completo = VALUES(nombre_completo),
               telefono = COALESCE(VALUES(telefono), personas.telefono),
               unifi_user_id = COALESCE(VALUES(unifi_user_id), personas.unifi_user_id)`,
            [
              coincidencia.cedula,
              coincidencia.nombre_completo,
              coincidencia.telefono,
              coincidencia.unifi_user_id,
            ]
          );

          return respuesta.json({
            cedula: coincidencia.cedula,
            nombre_completo: coincidencia.nombre_completo,
            telefono: coincidencia.telefono,
            eps: null,
            arl: null,
            id_rol: 2,
            rol: 'Empleado',
            unifi_user_id: coincidencia.unifi_user_id,
          });
        }
      } catch {
        // Si la consola UniFi no está alcanzable en este momento, continuar con 404 normal
      }

      return respuesta.status(404).json({ error: 'Persona no encontrada' });
    }

    return respuesta.json(filas[0]);
  } catch (errorBusqueda) {
    console.error('Error al buscar persona por cédula:', errorBusqueda);
    return respuesta.status(500).json({ error: 'Error al consultar la persona' });
  }
});

// Ruta para buscar usuarios (empleados con registro por rostro) directamente en UniFi Access via GET /api/v1/developer/users/search
aplicacion.get('/api/unifi/usuarios/buscar', verificarTokenJwt, async (solicitud, respuesta) => {
  try {
    const keyword = String(solicitud.query.keyword ?? '').trim();
    const usuarios = await buscarUsuariosUnifi(keyword);
    return respuesta.json({
      total: usuarios.length,
      usuarios,
    });
  } catch (errorBuscarUnifi) {
    console.error('Error al buscar usuarios en UniFi Access:', errorBuscarUnifi.message);
    return respuesta.status(502).json({
      error: `No se pudo consultar /api/v1/developer/users/search en UniFi Access: ${errorBuscarUnifi.message}`,
    });
  }
});

// Ruta para sincronizar los usuarios ya cargados en UniFi Access (empleados con rostro) hacia la tabla personas en MySQL
aplicacion.post('/api/unifi/usuarios/sincronizar', verificarTokenJwt, async (_solicitud, respuesta) => {
  try {
    const usuariosUnifi = await buscarUsuariosUnifi('');
    let sincronizados = 0;

    for (const emp of usuariosUnifi) {
      await poolBaseDatos.query(
        `INSERT INTO personas (cedula, nombre_completo, telefono, id_rol, unifi_user_id)
         VALUES (?, ?, ?, 2, ?)
         ON DUPLICATE KEY UPDATE
           nombre_completo = VALUES(nombre_completo),
           telefono = COALESCE(VALUES(telefono), personas.telefono),
           id_rol = VALUES(id_rol),
           unifi_user_id = VALUES(unifi_user_id)`,
        [
          emp.cedula,
          emp.nombre_completo,
          emp.telefono,
          emp.unifi_user_id,
        ]
      );
      sincronizados += 1;
    }

    return respuesta.json({
      mensaje: `Se sincronizaron ${sincronizados} empleados desde UniFi Access hacia la base de datos.`,
      sincronizados,
      usuarios: usuariosUnifi,
    });
  } catch (errorSincronizar) {
    console.error('Error al sincronizar empleados de UniFi Access:', errorSincronizar.message);
    return respuesta.status(502).json({
      error: `No se pudo conectar con UniFi Access (/api/v1/developer/users/search): ${errorSincronizar.message}`,
    });
  }
});

// Ruta para listar puertas disponibles desde la consola UniFi Access
aplicacion.get('/api/unifi/puertas', verificarTokenJwt, async (_solicitud, respuesta) => {
  const configUnifi = obtenerConfiguracionUnifi();
  try {
    const puertas = await listarPuertasUnifi();
    return respuesta.json({
      puertas,
      puertaDefecto: configUnifi.puertaDefecto,
      puertasVisitante: configUnifi.puertasVisitante,
      conectado: true,
    });
  } catch (errorPuertas) {
    console.warn('No se pudo listar puertas desde UniFi Access:', errorPuertas.message);
    return respuesta.json({
      puertas: configUnifi.puertasVisitante.map((idPuerta) => ({
        id: idPuerta,
        nombre:
          idPuerta === configUnifi.puertaPrincipalId
            ? configUnifi.puertaPrincipalNombre
            : `Puerta (${idPuerta})`,
        estado: 'configurada',
      })),
      puertaDefecto: configUnifi.puertaDefecto,
      puertasVisitante: configUnifi.puertasVisitante,
      conectado: false,
      advertencia: errorPuertas.message,
    });
  }
});

// Ruta para registrar los datos de validación de la persona, crear el ingreso y generar su código QR de invitación en UniFi Access
aplicacion.post('/api/visitas/con-qr', verificarTokenJwt, async (solicitud, respuesta) => {
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

    // 1) Validar puertas y parámetros ANTES de escribir en MySQL o en UniFi Access
    const configUnifi = obtenerConfiguracionUnifi();
    const puertasEnviadas = Array.isArray(puertas)
      ? Array.from(new Set(puertas.map((p) => String(p).trim()).filter(Boolean)))
      : [];
    const puertasSeleccionadas =
      puertasEnviadas.length > 0 ? puertasEnviadas : configUnifi.puertasVisitante;

    if (puertasSeleccionadas.length < 2) {
      return respuesta.status(400).json({
        error:
          'Debes configurar o seleccionar mínimo 2 puertas (UNIFI_PUERTAS_VISITANTE en server/.env, ej. Puerta Ppal + puerta interna) para habilitar el código QR.',
      });
    }

    const telefonoLimpio = telefono ? String(telefono).trim() : null;
    const epsLimpia = eps ? String(eps).trim() : null;
    const arlLimpia = arl ? String(arl).trim() : null;

    const datosPersona = {
      cedula: cedulaLimpia,
      nombre_completo: nombreLimpio,
      telefono: telefonoLimpio,
      eps: epsLimpia,
      arl: arlLimpia,
      id_rol: idRolNumerico,
    };

    const { nombres, apellidos } = dividirNombreCompleto(datosPersona.nombre_completo);
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

    // 2) Crear el visitante temporal en la consola UniFi Access
    const visitanteUnifi = await crearVisitanteUnifi({
      nombres,
      apellidos,
      motivo: motivoLimpio,
      telefono: datosPersona.telefono || '0000000000',
      doorIds: puertasSeleccionadas,
      email: correoLimpio,
      ventanaSegundos: duracionVigencia,
    });

    // 3) Emitir el QR y guardar persona + ingreso + QR en una sola transacción MySQL.
    //    Si falla cualquiera de los dos pasos, eliminamos el visitante en UniFi para no dejarlo huérfano.
    let qrGenerado;
    let idRegistro;
    let idQr;
    try {
      qrGenerado = await generarQrVisitanteUnifi(visitanteUnifi.visitorId);
      const guardado = await guardarVisitaConQrEnBd(poolBaseDatos, {
        datosPersona,
        motivo: motivoLimpio,
        visitanteUnifi,
        limiteUsos,
        qrBase64: qrGenerado.base64DataUrl,
      });
      idRegistro = guardado.idRegistro;
      idQr = guardado.idQr;
    } catch (errorPosteriorAUnifi) {
      await eliminarVisitanteUnifi(visitanteUnifi.visitorId, true).catch((errLimpieza) => {
        console.warn(
          `Advertencia al limpiar visitante huérfano ${visitanteUnifi.visitorId} en UniFi:`,
          errLimpieza.message
        );
      });
      throw errorPosteriorAUnifi;
    }

    let estadoCorreo = { enviado: false, mensaje: null };
    if (correoLimpio && visitanteUnifi.simulado) {
      estadoCorreo = {
        enviado: false,
        mensaje: 'QR de prueba: no se envía por correo porque no abre ninguna puerta.',
      };
    } else if (correoLimpio) {
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
      id_qr: idQr,
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
    return respuesta.status(errorConQr.codigoHttp || 502).json({
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
aplicacion.post('/api/visitas/:idRegistro/qr/correo', verificarTokenJwt, async (solicitud, respuesta) => {
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
        accesos_qr.unifi_visitor_id,
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
    if (esVisitanteSimulado(fila.unifi_visitor_id)) {
      return respuesta.status(409).json({
        error:
          'Este QR es de prueba (UniFi no respondió) y NO abre ninguna puerta; no se puede enviar por correo.',
      });
    }
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

// ── MONITOR EN SEGUNDO PLANO: Control de Tiempo de Vida, Usos de QR y Entradas/Salidas por Rostro (Empleados) ──
let monitoreoEnCurso = false;

const procesarEventosRostroEmpleadosUnifi = async () => {
  try {
    const [empleadosVinculados] = await poolBaseDatos.query(
      'SELECT cedula, nombre_completo, unifi_user_id FROM personas WHERE unifi_user_id IS NOT NULL'
    );
    if (empleadosVinculados.length === 0) return;

    const mapaPorUnifiId = new Map();
    for (const emp of empleadosVinculados) {
      mapaPorUnifiId.set(String(emp.unifi_user_id), emp);
    }

    // Consultar eventos desde el inicio del día actual
    const inicioHoySeg = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    let eventosCrudos;
    try {
      eventosCrudos = await obtenerLogsPuertasGeneralesUnifi(inicioHoySeg);
    } catch {
      // Consola UniFi no disponible en la red actual: se reintenta en el siguiente ciclo
      return;
    }

    // UniFi devuelve los eventos del más reciente al más antiguo; los ordenamos por @timestamp
    const eventos = ordenarEventosUnifiCronologicamente(eventosCrudos);

    for (const ev of eventos) {
      const src = (ev && (ev._source || ev)) || {};
      const actorId = String(src.actor?.id || '').trim();
      const evId = String(ev._id || ev.id || ev['@timestamp'] || '').trim();

      if (!evId || !actorId || !mapaPorUnifiId.has(actorId)) continue;
      if (!esAccesoConcedidoUnifi(ev, actorId)) continue;

      // Atajo barato para no abrir transacción en eventos ya procesados
      const [yaProcesado] = await poolBaseDatos.query(
        'SELECT id_evento FROM eventos_empleados_unifi WHERE id_evento = ? LIMIT 1',
        [evId]
      );
      if (yaProcesado.length > 0) continue;

      const empleado = mapaPorUnifiId.get(actorId);
      const { direccion, hora: horaEvento } = obtenerDireccionYHoraEventoUnifi(ev);

      try {
        // Marca del evento + entrada/salida en una sola transacción
        await registrarEventoRostroEmpleado(poolBaseDatos, {
          evId,
          actorId,
          empleado,
          puertaNombre: obtenerPuertaDeEventoUnifi(ev),
          direccion,
          horaEvento,
          enPuertaPrincipal: esPuertaPrincipalUnifi(ev),
        });
      } catch (errorEvento) {
        console.error(
          `[Monitor Rostro UniFi] No se pudo registrar el evento ${evId} de ${empleado.nombre_completo}; se reintentará en el siguiente ciclo:`,
          errorEvento.message
        );
        // Detener el ciclo para conservar el orden cronológico (la alternancia entrada/salida depende de él)
        break;
      }
    }
  } catch (errorGeneral) {
    console.error('[Monitor Rostro UniFi] Error inesperado procesando eventos de rostro:', errorGeneral.message);
  }
};

const procesarCicloMonitoreoQr = async () => {
  if (monitoreoEnCurso) return;
  monitoreoEnCurso = true;

  try {
    await procesarEventosRostroEmpleadosUnifi();
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
        let eventosCrudosVisitante = [];

        // Consultar logs de apertura de puerta en UniFi Access desde inicio_timestamp
        try {
          eventosCrudosVisitante = await obtenerLogsVisitanteUnifi(
            qr.unifi_visitor_id,
            qr.inicio_timestamp
          );
        } catch (errorLogUnifi) {
          // Si la consola UniFi no responde momentáneamente, aún verificamos expiración por tiempo
          console.warn(
            `[Monitor QR] No se pudieron leer logs de ${qr.unifi_visitor_id}: ${errorLogUnifi.message}`
          );
        }

        const {
          totalAccesosConcedidos,
          eventosVistosJson,
          huboCambioEventos,
          huboSalidaPuertaPrincipal,
          logsConsola,
        } = evaluarEventosQrConAntirrebote({
          eventos: eventosCrudosVisitante,
          eventosVistosRaw: qr.eventos_vistos_json,
          visitorId: qr.unifi_visitor_id,
        });

        for (const lineaLog of logsConsola) {
          console.log(lineaLog);
        }

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
              eventosVistosJson,
              qr.id_qr,
            ]
          );

          // Registrar automáticamente la hora de salida en registros_ingreso únicamente si la salida fue por la Puerta Principal
          if (huboSalidaPuertaPrincipal) {
            await poolBaseDatos.query(
              `UPDATE registros_ingreso
               SET hora_salida = CURRENT_TIME,
                   total_salidas = total_salidas + 1
               WHERE id_registro = ? AND hora_salida IS NULL`,
              [qr.id_registro]
            );
          }
          continue;
        }

        // Si tuvo una lectura de salida en la Puerta Principal antes de agotar todos los usos
        if (huboSalidaPuertaPrincipal) {
          await poolBaseDatos.query(
            `UPDATE registros_ingreso
             SET hora_salida = CURRENT_TIME,
                 total_salidas = total_salidas + 1
             WHERE id_registro = ? AND hora_salida IS NULL`,
            [qr.id_registro]
          );
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
              eventosVistosJson,
              qr.id_qr,
            ]
          );
          continue;
        }

        // Caso 3: Hubo un nuevo evento (contado o descartado por antirrebote), actualizar en BD
        if (huboCambioEventos) {
          await poolBaseDatos.query(
            `UPDATE accesos_qr
             SET usos_actuales = ?,
                 eventos_vistos_json = ?
             WHERE id_qr = ?`,
            [
              totalAccesosConcedidos,
              eventosVistosJson,
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

// ── WEBHOOK DE META WHATSAPP CLOUD API ──

aplicacion.get('/api/whatsapp/webhook', (solicitud, respuesta) => {
  const modo = solicitud.query['hub.mode'];
  const tokenRecibido = solicitud.query['hub.verify_token'];
  const reto = solicitud.query['hub.challenge'];
  const tokenEsperado = obtenerVerifyTokenWhatsapp();

  if (modo === 'subscribe' && tokenEsperado && tokenRecibido === tokenEsperado) {
    console.log('[WhatsApp Webhook] Verificación de webhook de Meta completada exitosamente.');
    return respuesta.status(200).send(String(reto || ''));
  }

  console.warn('[WhatsApp Webhook] Falló verificación de webhook (verify_token inválido o no configurado).');
  return respuesta.sendStatus(403);
});

aplicacion.post('/api/whatsapp/webhook', (solicitud, respuesta) => {
  const firmaHeader = solicitud.headers['x-hub-signature-256'];
  if (!verificarFirmaMeta(solicitud.rawBody, firmaHeader)) {
    console.warn('[WhatsApp Webhook] Firma X-Hub-Signature-256 inválida. Solicitud rechazada.');
    return respuesta.sendStatus(401);
  }

  const mensajesEntrantes =
    solicitud.body?.entry?.[0]?.changes?.[0]?.value?.messages?.length || 0;
  console.log(
    `[WhatsApp Webhook] POST recibido (mensajes=${mensajesEntrantes}, campo=${solicitud.body?.entry?.[0]?.changes?.[0]?.field || 'desconocido'})`
  );

  // Responder 200 OK de inmediato para que Meta no reintente la entrega
  respuesta.sendStatus(200);

  procesarWebhookWhatsapp(poolBaseDatos, solicitud.body).catch((errorWebhook) => {
    console.error('[WhatsApp Webhook] Error procesando evento entrante:', errorWebhook.message);
  });
});

// ── RUTAS PÚBLICAS DE INVITACIÓN POR WHATSAPP (protegidas por token único temporal) ──

aplicacion.get('/api/invitaciones-publicas/:token', async (solicitud, respuesta) => {
  try {
    const token = String(solicitud.params.token || '').trim();
    if (!token || token.length < 16) {
      return respuesta.status(404).json({ error: 'Enlace de invitación inválido.' });
    }

    const [filas] = await poolBaseDatos.query(
      `SELECT id_solicitud, origen, rol_invitado, estado, nombre_anfitrion, motivo,
              nombre_whatsapp_visitante, telefono_visitante,
              token_expira_en, (token_expira_en IS NOT NULL AND token_expira_en < NOW()) AS expirado
       FROM solicitudes_visita_whatsapp
       WHERE token_formulario = ?
       LIMIT 1`,
      [token]
    );

    if (filas.length === 0) {
      return respuesta.status(404).json({ error: 'Enlace de invitación no encontrado.' });
    }

    const sol = filas[0];
    if (sol.estado === 'COMPLETADA') {
      return respuesta.status(410).json({
        error: 'Este enlace ya fue utilizado y el código QR ya fue generado.',
      });
    }
    if (sol.estado !== 'APROBADA' || Number(sol.expirado) === 1) {
      return respuesta.status(410).json({
        error: 'Este enlace de invitación ha expirado. Solicita uno nuevo por WhatsApp.',
      });
    }

    const origen = sol.origen || 'VISITANTE';
    const telefonoSugerido = normalizarUltimos10Digitos(sol.telefono_visitante || '');

    return respuesta.json({
      origen,
      rol_invitado: Number(sol.rol_invitado) === 3 ? 3 : 1,
      requiere_datos_contacto: origen === 'ANFITRION' || !telefonoSugerido,
      nombre_anfitrion: sol.nombre_anfitrion,
      motivo: sol.motivo,
      nombre_sugerido: sol.nombre_whatsapp_visitante || '',
      telefono_sugerido: telefonoSugerido,
      expira_en: sol.token_expira_en,
    });
  } catch (errorToken) {
    console.error('Error al consultar invitación pública:', errorToken);
    return respuesta.status(500).json({ error: 'Error al validar el enlace de invitación.' });
  }
});

aplicacion.post('/api/invitaciones-publicas/:token/completar', async (solicitud, respuesta) => {
  try {
    const token = String(solicitud.params.token || '').trim();
    if (!token || token.length < 16) {
      return respuesta.status(404).json({ error: 'Enlace de invitación inválido.' });
    }

    const { cedula, nombre_completo, id_rol = 1, telefono = '', eps = '', arl = '' } =
      solicitud.body || {};

    const cedulaLimpia = String(cedula ?? '').trim();
    const nombreLimpio = String(nombre_completo ?? '').trim();
    const telefonoLimpio = String(telefono ?? '').trim();
    const epsLimpia = String(eps ?? '').trim();
    const arlLimpia = String(arl ?? '').trim();
    const idRolSeguro = Number(id_rol) === 3 ? 3 : 1;

    if (!cedulaLimpia || !nombreLimpio || !telefonoLimpio || !epsLimpia || !arlLimpia) {
      return respuesta.status(400).json({
        error: 'Todos los campos (cédula, nombre completo, celular WhatsApp, EPS y ARL) son obligatorios.',
      });
    }

    const telefonoWhatsappVisitante = normalizarTelefonoWhatsapp(telefonoLimpio);
    if (normalizarUltimos10Digitos(telefonoLimpio).length < 7) {
      return respuesta.status(400).json({
        error: 'Ingresa un número de celular / WhatsApp válido (mínimo 10 dígitos).',
      });
    }

    const [filas] = await poolBaseDatos.query(
      `SELECT *, (token_expira_en IS NOT NULL AND token_expira_en < NOW()) AS expirado
       FROM solicitudes_visita_whatsapp
       WHERE token_formulario = ?
       LIMIT 1`,
      [token]
    );

    if (filas.length === 0) {
      return respuesta.status(404).json({ error: 'Enlace de invitación no encontrado.' });
    }

    const sol = filas[0];
    if (sol.estado === 'COMPLETADA') {
      return respuesta.status(409).json({
        error: 'Este enlace ya fue utilizado y el código QR ya fue generado.',
      });
    }
    if (sol.estado !== 'APROBADA' || Number(sol.expirado) === 1) {
      return respuesta.status(410).json({
        error: 'Este enlace de invitación ha expirado. Solicita uno nuevo por WhatsApp.',
      });
    }

    const idRolFinal =
      solicitud.body?.id_rol !== undefined
        ? idRolSeguro
        : Number(sol.rol_invitado) === 3
          ? 3
          : 1;
    const telefonoDestinoVisitante =
      normalizarTelefonoWhatsapp(sol.telefono_visitante || '') || telefonoWhatsappVisitante;

    const configUnifi = obtenerConfiguracionUnifi();
    const puertasSeleccionadas = configUnifi.puertasVisitante;
    if (puertasSeleccionadas.length < 2) {
      return respuesta.status(500).json({
        error:
          'No hay suficientes puertas configuradas en el servidor (UNIFI_PUERTAS_VISITANTE) para generar el QR.',
      });
    }

    const { nombres, apellidos } = dividirNombreCompleto(nombreLimpio);
    const duracionVigencia = Math.max(
      Number(process.env.WHATSAPP_QR_VENTANA_SEGUNDOS) || 7200,
      300
    );
    const limiteUsos = configUnifi.maxAccesos || 6;
    const motivoRegistro = sol.motivo
      ? `${sol.motivo} (Anfitrión: ${sol.nombre_anfitrion})`
      : `Visita a ${sol.nombre_anfitrion}`;

    const visitanteUnifi = await crearVisitanteUnifi({
      nombres,
      apellidos,
      motivo: motivoRegistro,
      telefono: telefonoLimpio,
      doorIds: puertasSeleccionadas,
      ventanaSegundos: duracionVigencia,
    });

    let qrGenerado;
    let idRegistro;
    let idQr;
    try {
      qrGenerado = await generarQrVisitanteUnifi(visitanteUnifi.visitorId);
      const guardado = await guardarVisitaConQrEnBd(poolBaseDatos, {
        datosPersona: {
          cedula: cedulaLimpia,
          nombre_completo: nombreLimpio,
          telefono: telefonoLimpio,
          eps: epsLimpia,
          arl: arlLimpia,
          id_rol: idRolFinal,
        },
        motivo: motivoRegistro,
        visitanteUnifi,
        limiteUsos,
        qrBase64: qrGenerado.base64DataUrl,
        idSolicitudWhatsapp: sol.id_solicitud,
        telefonoWhatsappVisitante: telefonoDestinoVisitante,
      });
      idRegistro = guardado.idRegistro;
      idQr = guardado.idQr;
    } catch (errorPosteriorAUnifi) {
      await eliminarVisitanteUnifi(visitanteUnifi.visitorId, true).catch(() => {});
      throw errorPosteriorAUnifi;
    }

    let whatsappEnviado = false;
    let motivoWhatsapp = null;
    if (whatsappConfigurado() && telefonoDestinoVisitante && !visitanteUnifi.simulado) {
      try {
        const horaFin = new Date(Number(visitanteUnifi.finTimestamp) * 1000).toLocaleTimeString(
          'es-CO',
          { hour: '2-digit', minute: '2-digit' }
        );
        await enviarImagenQrWhatsapp(
          telefonoDestinoVisitante,
          qrGenerado.bufferPng,
          `🎫 Pase de ingreso QR — ${nombreLimpio}\n` +
            `👤 Anfitrión: ${sol.nombre_anfitrion}\n` +
            `⏰ Válido hasta: ${horaFin} (${limiteUsos} accesos)\n` +
            'Presenta este código frente al lector de entrada.'
        );
        whatsappEnviado = true;
      } catch (errWaFoto) {
        const plantillaQr = String(process.env.WHATSAPP_TEMPLATE_QR || '').trim();
        if (errWaFoto.codigoMeta === 131047 && plantillaQr) {
          try {
            await enviarPlantillaWhatsapp(telefonoDestinoVisitante, plantillaQr, {
              idioma: 'es',
            });
            whatsappEnviado = true;
          } catch (errPlantilla) {
            motivoWhatsapp = 'ventana_24h';
            console.warn(
              '[WhatsApp Bot] No se pudo enviar plantilla de respaldo al visitante:',
              errPlantilla.message
            );
          }
        } else {
          motivoWhatsapp = errWaFoto.codigoMeta === 131047 ? 'ventana_24h' : 'error_envio';
          console.warn(
            '[WhatsApp Bot] No se pudo enviar la imagen del QR al visitante:',
            errWaFoto.message
          );
        }
      }

      if (sol.telefono_anfitrion) {
        const etiquetaRol = idRolFinal === 3 ? 'Proveedor' : 'Visitante';
        await enviarTextoWhatsapp(
          sol.telefono_anfitrion,
          `🎫 ${nombreLimpio} (${etiquetaRol}, C.C. ${cedulaLimpia}, Tel. ${telefonoLimpio}) completó su registro y ya tiene su código QR de ingreso.`
        ).catch(() => {});
      }
    }

    return respuesta.status(201).json({
      mensaje: 'Registro completado y código QR generado exitosamente',
      id_registro: idRegistro,
      id_qr: idQr,
      origen: sol.origen || 'VISITANTE',
      rol_invitado: idRolFinal,
      cedula: cedulaLimpia,
      nombre_completo: nombreLimpio,
      motivo: sol.motivo || 'Visita autorizada',
      fin_timestamp: visitanteUnifi.finTimestamp,
      max_usos: limiteUsos,
      qr_base64: qrGenerado.base64DataUrl,
      simulado: Boolean(visitanteUnifi.simulado),
      whatsapp: { enviado: whatsappEnviado, motivo: motivoWhatsapp },
    });
  } catch (errorCompletar) {
    console.error('Error al completar registro público de visitante:', errorCompletar);
    return respuesta.status(errorCompletar.codigoHttp || 502).json({
      error:
        errorCompletar.message ||
        'No se pudo generar el código QR en la consola UniFi Access.',
    });
  }
});

const { pollIntervalMs } = obtenerConfiguracionUnifi();
let intervaloMonitorQr = null;
let servidorHttp = null;

const iniciarServidor = async () => {
  try {
    await inicializarBaseDatosConReintentos(poolBaseDatos, {
      pasoAdicional: asegurarUsuarioAdminInicial,
    });
  } catch (errorFatalBd) {
    console.error(`[BD] Error crítico en el arranque: ${errorFatalBd.message}`);
    await poolBaseDatos.end().catch(() => {});
    process.exit(1);
  }

  intervaloMonitorQr = setInterval(
    procesarCicloMonitoreoQr,
    Math.max(pollIntervalMs, 3000)
  );

  servidorHttp = aplicacion.listen(puertoServidor, () => {
    console.log(`Servidor backend corriendo en http://localhost:${puertoServidor}`);
    if (whatsappConfigurado()) {
      console.log('[WhatsApp Bot] Integración Meta Cloud API activa en /api/whatsapp/webhook.');
    }
    if (modoPruebaUnifiSolicitado()) {
      if (esEntornoProduccion()) {
        console.warn(
          '[UniFi] UNIFI_MODO_PRUEBA=true IGNORADO: NODE_ENV=production. Nunca se emitirán QR simulados.'
        );
      } else {
        console.warn(
          '[UniFi] MODO PRUEBA ACTIVO: si la consola UniFi no responde se emitirán QR FALSOS que NO abren puertas. No usar en producción.'
        );
      }
    }
  });
};

iniciarServidor();

const cerrarServidor = async () => {
  if (intervaloMonitorQr) {
    clearInterval(intervaloMonitorQr);
  }
  const finalizarPool = async () => {
    try {
      await poolBaseDatos.end();
    } catch (errorCierre) {
      console.error('Error al cerrar el pool de MySQL:', errorCierre);
    }
    process.exit(0);
  };

  if (servidorHttp) {
    servidorHttp.close(finalizarPool);
  } else {
    await finalizarPool();
  }
};

process.on('SIGINT', cerrarServidor);
process.on('SIGTERM', cerrarServidor);
