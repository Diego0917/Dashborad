
const parsearMovimientos = (texto) => {
  try {
    const lista = JSON.parse(texto || '[]');
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
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
  { evId, actorId, empleado, puertaNombre, direccion, horaEvento, enPuertaPrincipal }
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
        // Reingreso en Puerta Principal: suma a total_entradas y CONSERVA la última hora_salida visible
        const nuevasEntradas = entradasPrevias + 1;
        movimientos.push({ tipo: 'ENTRADA', hora: horaEvento, puerta: puertaNombre });

        await conexion.query(
          `UPDATE registros_ingreso
           SET hora_ingreso = COALESCE(hora_ingreso, ?),
               total_entradas = ?,
               movimientos_json = ?
           WHERE id_registro = ?`,
          [horaEvento, nuevasEntradas, JSON.stringify(movimientos), reg.id_registro]
        );
        mensajeLog = `[Monitor Rostro UniFi] Entrada #${nuevasEntradas} (${horaEvento}) en '${puertaNombre}' acumulada para ${empleado.nombre_completo}`;
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
const registrarEntradaManual = async (pool, { cedula, motivo = null }) => {
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

    const horaActual = new Date().toTimeString().slice(0, 8);

    const [registroHoy] = await conexion.query(
      `SELECT id_registro, total_entradas, total_salidas, movimientos_json
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
      listaMovimientos.push({
        tipo: 'ENTRADA',
        hora: horaActual,
        detalle: motivo || 'Reingreso en el día',
      });

      const nuevasEntradas = (Number(reg.total_entradas) || 1) + 1;
      await conexion.query(
        `UPDATE registros_ingreso
         SET hora_ingreso = COALESCE(hora_ingreso, CURRENT_TIME),
             hora_salida = NULL,
             total_entradas = ?,
             movimientos_json = ?,
             motivo = COALESCE(?, motivo)
         WHERE id_registro = ?`,
        [
          nuevasEntradas,
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
        total_salidas: Number(reg.total_salidas) || 0,
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
      `SELECT id_registro, total_salidas, movimientos_json
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
    const listaMovimientos = parsearMovimientos(regActual.movimientos_json);
    const horaActual = new Date().toTimeString().slice(0, 8);

    listaMovimientos.push({
      tipo: 'SALIDA',
      hora: horaActual,
      detalle: 'Salida registrada',
    });

    const nuevasSalidas = (Number(regActual.total_salidas) || 0) + 1;
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

module.exports = {
  registrarEventoRostroEmpleado,
  registrarEntradaManual,
  registrarSalidaManual,
};
