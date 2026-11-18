/**
 * Sistema ligero de migraciones de esquema que se ejecutan UNA sola vez por base de datos.
 *
 * Cada migración aplicada queda registrada en `migraciones_schema`. En los arranques siguientes,
 * las migraciones ya registradas se omiten sin ejecutar ningún ALTER TABLE ni UPDATE.
 */

const CODIGOS_COLUMNA_O_INDICE_EXISTENTE = new Set([
  'ER_DUP_FIELDNAME', // 1060: Duplicate column name
  'ER_DUP_KEYNAME', // 1061: Duplicate key name
]);

const ejecutarAlterIdempotente = async (pool, sql) => {
  try {
    await pool.query(sql);
  } catch (errorSql) {
    if (
      errorSql &&
      (CODIGOS_COLUMNA_O_INDICE_EXISTENTE.has(errorSql.code) ||
        errorSql.errno === 1060 ||
        errorSql.errno === 1061)
    ) {
      return;
    }
    throw errorSql;
  }
};

const MIGRACIONES = [
  {
    id: '001_esquema_base_unifi_y_qr',
    aplicar: async (pool) => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS usuarios (
          id_usuario INT AUTO_INCREMENT PRIMARY KEY,
          nombre_usuario VARCHAR(50) NOT NULL UNIQUE,
          nombre_completo VARCHAR(100) NOT NULL,
          contrasena_hash VARCHAR(255) NOT NULL,
          activo TINYINT(1) NOT NULL DEFAULT 1,
          fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
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
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS eventos_empleados_unifi (
          id_evento VARCHAR(128) PRIMARY KEY,
          unifi_user_id VARCHAR(64) NOT NULL,
          fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await ejecutarAlterIdempotente(
        pool,
        'ALTER TABLE registros_ingreso MODIFY COLUMN hora_ingreso TIME NULL DEFAULT (CURRENT_TIME)'
      );
      await ejecutarAlterIdempotente(
        pool,
        'ALTER TABLE personas ADD COLUMN unifi_user_id VARCHAR(64) NULL UNIQUE'
      );
      await ejecutarAlterIdempotente(
        pool,
        'ALTER TABLE registros_ingreso ADD COLUMN total_entradas INT NOT NULL DEFAULT 1'
      );
      await ejecutarAlterIdempotente(
        pool,
        'ALTER TABLE registros_ingreso ADD COLUMN total_salidas INT NOT NULL DEFAULT 0'
      );
      await ejecutarAlterIdempotente(
        pool,
        'ALTER TABLE registros_ingreso ADD COLUMN movimientos_json TEXT NULL'
      );
    },
  },
];

/**
 * Ejecuta únicamente las migraciones que aún no figuren en `migraciones_schema`.
 */
const ejecutarMigracionesPendientes = async (pool) => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migraciones_schema (
      id VARCHAR(64) PRIMARY KEY,
      ejecutada_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const [filasAplicadas] = await pool.query('SELECT id FROM migraciones_schema');
  const aplicadas = new Set(filasAplicadas.map((f) => String(f.id)));

  for (const migracion of MIGRACIONES) {
    if (aplicadas.has(migracion.id)) continue;

    await migracion.aplicar(pool);
    await pool.query('INSERT INTO migraciones_schema (id) VALUES (?)', [migracion.id]);
    console.log(`[Migraciones] Aplicada migración '${migracion.id}'.`);
  }
};

module.exports = {
  ejecutarMigracionesPendientes,
  MIGRACIONES,
};
