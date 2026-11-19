
const parsearMovimientos = (texto) => {
  try {
    const lista = JSON.parse(texto || '[]');
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
};

const UMBRAL_SALIDA_ESTIMADA_SEG_DEFECTO = 120; // 2 minutos

const obtenerUmbralSalidaEstimadaSeg = (override) => {
  if (override !== undefined && override !== null) {
    return Math.max(Number(override) || 0, 0);
  }
  if (
    process.env.UMBRAL_SALIDA_ESTIMADA_SEG !== undefined &&
    process.env.UMBRAL_SALIDA_ESTIMADA_SEG !== ''
  ) {
    return Math.max(Number(process.env.UMBRAL_SALIDA_ESTIMADA_SEG) || 0, 0);
  }
  return UMBRAL_SALIDA_ESTIMADA_SEG_DEFECTO;
};

const horaASegundos = (horaTexto) => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(horaTexto || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const seg = Number(m[3] || 0);
  if (h < 0 || h > 23 || min < 0 || min > 59 || seg < 0 || seg > 59) return null;
  return h * 3600 + min * 60 + seg;
};

const segundosAHora = (totalSegundos) => {
  const segNormalizados = Math.max(0, Math.min(86399, Math.floor(Number(totalSegundos) || 0)));
  const h = String(Math.floor(segNormalizados / 3600)).padStart(2, '0');
  const min = String(Math.floor((segNormalizados % 3600) / 60)).padStart(2, '0');
  const seg = String(segNormalizados % 60).padStart(2, '0');
  return `${h}:${min}:${seg}`;
};

const calcularHoraIntermedia = (horaInicio, horaFin) => {
  const segInicio = horaASegundos(horaInicio);
  const segFin = horaASegundos(horaFin);
  if (segInicio === null && segFin === null) return '12:00:00';
  if (segInicio === null) return segundosAHora(segFin);
  if (segFin === null || segFin < segInicio) return segundosAHora(segInicio);
  return segundosAHora(Math.floor((segInicio + segFin) / 2));
};

/**
 * Devuelve la última hora conocida en la que la persona seguía dentro del edificio
 * (la última ENTRADA o ACCESO_INTERNO registrado en movimientos_json, o hora_ingreso como respaldo).
 */
const obtenerUltimaHoraPresencia = (movimientos, horaIngresoFallback = null) => {
  for (let i = movimientos.length - 1; i >= 0; i -= 1) {
    const mov = movimientos[i];
    if (
      mov &&
      (mov.tipo === 'ENTRADA' || mov.tipo === 'ACCESO_INTERNO') &&
      horaASegundos(mov.hora) !== null
    ) {
      return mov.hora;
    }
  }
  if (horaASegundos(horaIngresoFallback) !== null) {
    return horaIngresoFallback;
  }
  return null;
};

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {object} datos
 * @param {string} datos.evId               ID único del evento en UniFi
 * @param {string} datos.actorId            unifi_user_id del empleado
 * @param {{cedula: string, nombre_completo: string}} datos.empleado
 * @param {string} datos.puertaNombre
 * @param {string|null} datos.direccion     'entry' | 'exit' | vacío
 * @param {string} datos.horaEvento         'HH:MM:SS'
 * @param {boolean} datos.enPuertaPrincipal
 * @returns {Promise<'registrado'|'duplicado'>}
 */
const registrarEventoRostroEmpleado = async (
  pool,
  {
    evId,
    actorId,
    empleado,
    puertaNombre,
    direccion,
    horaEvento,
    enPuertaPrincipal,
    umbralSalidaEstimadaSeg,
  }
) => {
  const conexion = await pool.getConnection();
  let mensajeLog = null;

  try {
    await conexion.beginTransaction();

    // 1) Marcar el evento. La clave primaria actúa como candado contra dobles procesamientos.
    try {
      await conexion.query(
        'INSERT INTO eventos_empleados_unifi (id_evento, unifi_user_id) VALUES (?, ?)',
        [evId, actorId]
      );
    } catch (errorMarca) {
      if (errorMarca && errorMarca.code === 'ER_DUP_ENTRY') {
        await conexion.rollback();
        return 'duplicado';
      }
      throw errorMarca;
    }

    // 2) Buscar (y bloquear) el único registro diario del empleado hoy
    const [registroDia] = await conexion.query(
      `SELECT id_registro, hora_ingreso, hora_salida, total_entradas, total_salidas, movimientos_json
       FROM registros_ingreso
       WHERE cedula = ? AND fecha_ingreso = CURRENT_DATE
       ORDER BY id_registro DESC
       LIMIT 1
       FOR UPDATE`,
      [empleado.cedula]
    );

    if (registroDia.length === 0) {
      // 1.ª lectura del día
      const esSalidaDirecta = enPuertaPrincipal && direccion === 'exit';
      const movimientosIniciales = JSON.stringify([
        {
          tipo: esSalidaDirecta ? 'SALIDA' : 'ENTRADA',
          hora: horaEvento,
          puerta: puertaNombre,
        },
      ]);

      await conexion.query(
        `INSERT INTO registros_ingreso (
          cedula,
          motivo,
          fecha_ingreso,
          hora_ingreso,
          hora_salida,
          total_entradas,
          total_salidas,
          movimientos_json
        ) VALUES (?, ?, CURRENT_DATE, ?, ?, ?, ?, ?)`,
        [
          empleado.cedula,
          `Ingreso por reconocimiento facial (${puertaNombre})`,
          horaEvento,
          esSalidaDirecta ? horaEvento : null,
          esSalidaDirecta ? 0 : 1,
          esSalidaDirecta ? 1 : 0,
          movimientosIniciales,
        ]
      );
      mensajeLog = `[Monitor Rostro UniFi] Primer registro del día (${esSalidaDirecta ? 'SALIDA' : 'ENTRADA'} a las ${horaEvento}) para ${empleado.nombre_completo} en '${puertaNombre}'`;
    } else {
      const reg = registroDia[0];
      const movimientos = parsearMovimientos(reg.movimientos_json);
      const entradasPrevias = Number(reg.total_entradas) || 0;
      const salidasPrevias = Number(reg.total_salidas) || 0;

      // SALIDA: en Puerta Ppal LIRA con lector 'exit' (o alternado si no trae dirección)
      const esSalida =
        enPuertaPrincipal &&
        (direccion === 'exit' || (!direccion && entradasPrevias > salidasPrevias));
      const esEntrada =
        enPuertaPrincipal &&
        (direccion === 'entry' || (!direccion && entradasPrevias <= salidasPrevias));

      if (esSalida) {
        const nuevasSalidas = salidasPrevias + 1;
        movimientos.push({ tipo: 'SALIDA', hora: horaEvento, puerta: puertaNombre });

        await conexion.query(
          `UPDATE registros_ingreso
           SET hora_salida = ?,
               total_salidas = ?,
               movimientos_json = ?
           WHERE id_registro = ?`,
          [horaEvento, nuevasSalidas, JSON.stringify(movimientos), reg.id_registro]
        );
        mensajeLog = `[Monitor Rostro UniFi] Salida #${nuevasSalidas} (${horaEvento}) en '${puertaNombre}' registrada para ${empleado.nombre_completo}`;
      } else if (esEntrada) {
        let salidasActualizadas = salidasPrevias;
        let horaSalidaEstimada = null;

        // Si ya figuraba adentro (entradasPrevias > salidasPrevias), salió con la puerta abierta sin lectura
        if (entradasPrevias > salidasPrevias) {
          const ultimaHoraPresencia = obtenerUltimaHoraPresencia(movimientos, reg.hora_ingreso);
          const segPrev = horaASegundos(ultimaHoraPresencia);
          const segNuevo = horaASegundos(horaEvento);
          const umbralSeg = obtenerUmbralSalidaEstimadaSeg(umbralSalidaEstimadaSeg);

          // Si las dos lecturas de entrada ocurren casi al mismo tiempo (< umbralSeg), es un rebote en la puerta
          if (
            segPrev !== null &&
            segNuevo !== null &&
            segNuevo >= segPrev &&
            segNuevo - segPrev < umbralSeg
          ) {
            await conexion.commit();
            return 'registrado';
          }

          horaSalidaEstimada = calcularHoraIntermedia(
            ultimaHoraPresencia || horaEvento,
            horaEvento
          );
          salidasActualizadas = salidasPrevias + 1;
          movimientos.push({
            tipo: 'SALIDA',
            hora: horaSalidaEstimada,
            puerta: puertaNombre,
            detalle: 'Salida estimada (sin lectura de salida previa)',
            estimada: true,
          });
        }

        // Reingreso en Puerta Principal: suma a total_entradas y conserva la última hora_salida visible
        const nuevasEntradas = entradasPrevias + 1;
        movimientos.push({ tipo: 'ENTRADA', hora: horaEvento, puerta: puertaNombre });

        if (horaSalidaEstimada) {
          await conexion.query(
            `UPDATE registros_ingreso
             SET hora_ingreso = COALESCE(hora_ingreso, ?),
                 hora_salida = ?,
                 total_entradas = ?,
                 total_salidas = ?,
                 movimientos_json = ?
             WHERE id_registro = ?`,
            [
              horaEvento,
              horaSalidaEstimada,
              nuevasEntradas,
              salidasActualizadas,
              JSON.stringify(movimientos),
              reg.id_registro,
            ]
          );
          mensajeLog = `[Monitor Rostro UniFi] Salida intermedia estimada (${horaSalidaEstimada}) + Entrada #${nuevasEntradas} (${horaEvento}) en '${puertaNombre}' para ${empleado.nombre_completo}`;
        } else {
          await conexion.query(
            `UPDATE registros_ingreso
             SET hora_ingreso = COALESCE(hora_ingreso, ?),
                 total_entradas = ?,
                 movimientos_json = ?
             WHERE id_registro = ?`,
            [horaEvento, nuevasEntradas, JSON.stringify(movimientos), reg.id_registro]
          );
          mensajeLog = `[Monitor Rostro UniFi] Entrada #${nuevasEntradas} (${horaEvento}) en '${puertaNombre}' acumulada para ${empleado.nombre_completo}`;
        }
      } else {
        // Puerta interna (ej. Gestión Humana): no altera hora_salida ni contadores del edificio
        movimientos.push({ tipo: 'ACCESO_INTERNO', hora: horaEvento, puerta: puertaNombre });

        await conexion.query(
          `UPDATE registros_ingreso
           SET movimientos_json = ?
           WHERE id_registro = ?`,
          [JSON.stringify(movimientos), reg.id_registro]
        );
      }
    }

    await conexion.commit();
    if (mensajeLog) console.log(mensajeLog);
    return 'registrado';
  } catch (errorTransaccion) {
    await conexion.rollback().catch(() => {});
    throw errorTransaccion;
  } finally {
    conexion.release();
  }
};

/**
 * Registra de forma atómica una entrada manual desde recepción (POST /api/visitas),
 * bloqueando la fila con SELECT ... FOR UPDATE para no pisarse con el monitor ni con otra petición.
 */
const registrarEntradaManual = async (
  pool,
  { cedula, motivo = null, horaActual: horaActualOverride = null, umbralSalidaEstimadaSeg }
) => {
  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();

    const [personasEncontradas] = await conexion.query(
      'SELECT cedula FROM personas WHERE cedula = ? LIMIT 1 FOR UPDATE',
      [cedula]
    );

    if (personasEncontradas.length === 0) {
      await conexion.rollback();
      return { estado: 'no_encontrada' };
    }

    const horaActual = horaActualOverride || new Date().toTimeString().slice(0, 8);

    const [registroHoy] = await conexion.query(
      `SELECT id_registro, hora_ingreso, total_entradas, total_salidas, movimientos_json
       FROM registros_ingreso
       WHERE cedula = ? AND fecha_ingreso = CURRENT_DATE
       ORDER BY id_registro DESC
       LIMIT 1
       FOR UPDATE`,
      [cedula]
    );

    if (registroHoy.length > 0) {
      const reg = registroHoy[0];
      const listaMovimientos = parsearMovimientos(reg.movimientos_json);
      const entradasPrevias = Number(reg.total_entradas) || 1;
      let salidasActualizadas = Number(reg.total_salidas) || 0;

      if (entradasPrevias > salidasActualizadas) {
        const ultimaHoraPresencia = obtenerUltimaHoraPresencia(
          listaMovimientos,
          reg.hora_ingreso
        );
        const segPrev = horaASegundos(ultimaHoraPresencia);
        const segNuevo = horaASegundos(horaActual);
        const umbralSeg = obtenerUmbralSalidaEstimadaSeg(umbralSalidaEstimadaSeg);

        if (
          segPrev === null ||
          segNuevo === null ||
          segNuevo < segPrev ||
          segNuevo - segPrev >= umbralSeg
        ) {
          const horaSalidaEstimada = calcularHoraIntermedia(
            ultimaHoraPresencia || horaActual,
            horaActual
          );
          salidasActualizadas += 1;
          listaMovimientos.push({
            tipo: 'SALIDA',
            hora: horaSalidaEstimada,
            detalle: 'Salida estimada (sin lectura de salida previa)',
            estimada: true,
          });
        }
      }

      listaMovimientos.push({
        tipo: 'ENTRADA',
        hora: horaActual,
        detalle: motivo || 'Reingreso en el día',
      });

      const nuevasEntradas = entradasPrevias + 1;
      await conexion.query(
        `UPDATE registros_ingreso
         SET hora_ingreso = COALESCE(hora_ingreso, CURRENT_TIME),
             hora_salida = NULL,
             total_entradas = ?,
             total_salidas = ?,
             movimientos_json = ?,
             motivo = COALESCE(?, motivo)
         WHERE id_registro = ?`,
        [
          nuevasEntradas,
          salidasActualizadas,
          JSON.stringify(listaMovimientos),
          motivo,
          reg.id_registro,
        ]
      );

      await conexion.commit();
      return {
        estado: 'acumulada',
        id_registro: reg.id_registro,
        total_entradas: nuevasEntradas,
        total_salidas: salidasActualizadas,
      };
    }

    const movimientosIniciales = JSON.stringify([
      {
        tipo: 'ENTRADA',
        hora: horaActual,
        detalle: motivo || 'Ingreso inicial',
      },
    ]);

    const [resultadoInsercion] = await conexion.query(
      `INSERT INTO registros_ingreso (cedula, motivo, total_entradas, total_salidas, movimientos_json)
       VALUES (?, ?, 1, 0, ?)`,
      [cedula, motivo, movimientosIniciales]
    );

    await conexion.commit();
    return {
      estado: 'creada',
      id_registro: resultadoInsercion.insertId,
      total_entradas: 1,
      total_salidas: 0,
    };
  } catch (errorEntrada) {
    await conexion.rollback().catch(() => {});
    throw errorEntrada;
  } finally {
    conexion.release();
  }
};

/**
 * Registra de forma atómica una salida manual desde recepción (PATCH /api/visitas/:idRegistro/salida),
 * bloqueando la fila con SELECT ... FOR UPDATE para no pisarse con el monitor ni con otra petición.
 */
const registrarSalidaManual = async (pool, { idRegistro }) => {
  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();

    const [filasRegistro] = await conexion.query(
      `SELECT id_registro, hora_ingreso, total_entradas, total_salidas, movimientos_json
       FROM registros_ingreso
       WHERE id_registro = ?
       LIMIT 1
       FOR UPDATE`,
      [idRegistro]
    );

    if (filasRegistro.length === 0) {
      await conexion.rollback();
      return { estado: 'no_encontrado' };
    }

    const regActual = filasRegistro[0];
    const entradasActuales = Number(regActual.total_entradas) || 0;
    const salidasActuales = Number(regActual.total_salidas) || 0;

    if (regActual.hora_ingreso === null || entradasActuales <= 0) {
      await conexion.rollback();
      return { estado: 'sin_entrada' };
    }

    if (salidasActuales >= entradasActuales) {
      await conexion.rollback();
      return { estado: 'ya_salio' };
    }

    const listaMovimientos = parsearMovimientos(regActual.movimientos_json);
    const horaActual = new Date().toTimeString().slice(0, 8);

    listaMovimientos.push({
      tipo: 'SALIDA',
      hora: horaActual,
      detalle: 'Salida registrada',
    });

    const nuevasSalidas = salidasActuales + 1;
    await conexion.query(
      `UPDATE registros_ingreso
       SET hora_salida = CURRENT_TIME,
           total_salidas = ?,
           movimientos_json = ?
       WHERE id_registro = ?`,
      [nuevasSalidas, JSON.stringify(listaMovimientos), idRegistro]
    );

    await conexion.commit();
    return {
      estado: 'registrada',
      total_salidas: nuevasSalidas,
    };
  } catch (errorSalida) {
    await conexion.rollback().catch(() => {});
    throw errorSalida;
  } finally {
    conexion.release();
  }
};

/**
 * Persiste en una única transacción la persona, el registro de ingreso (con hora_ingreso = NULL)
 * y el código QR activo en `accesos_qr`. Si falla cualquier consulta, hace ROLLBACK completo.
 */
const guardarVisitaConQrEnBd = async (
  pool,
  { datosPersona, motivo, visitanteUnifi, limiteUsos, qrBase64 }
) => {
  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();

    await conexion.query(
      `INSERT INTO personas (cedula, nombre_completo, telefono, eps, arl, id_rol)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         nombre_completo = VALUES(nombre_completo),
         telefono = COALESCE(VALUES(telefono), personas.telefono),
         eps = COALESCE(VALUES(eps), personas.eps),
         arl = COALESCE(VALUES(arl), personas.arl),
         id_rol = VALUES(id_rol)`,
      [
        datosPersona.cedula,
        datosPersona.nombre_completo,
        datosPersona.telefono,
        datosPersona.eps,
        datosPersona.arl,
        datosPersona.id_rol,
      ]
    );

    const [resultadoIngreso] = await conexion.query(
      'INSERT INTO registros_ingreso (cedula, motivo, hora_ingreso) VALUES (?, ?, NULL)',
      [datosPersona.cedula, motivo]
    );
    const idRegistro = resultadoIngreso.insertId;

    const [resultadoQr] = await conexion.query(
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
        qrBase64,
      ]
    );

    await conexion.commit();
    return {
      idRegistro,
      idQr: resultadoQr.insertId,
    };
  } catch (errorBd) {
    await conexion.rollback().catch(() => {});
    throw errorBd;
  } finally {
    conexion.release();
  }
};

module.exports = {
  registrarEventoRostroEmpleado,
  registrarEntradaManual,
  registrarSalidaManual,
  guardarVisitaConQrEnBd,
  calcularHoraIntermedia,
};
