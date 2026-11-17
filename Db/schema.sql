-- Creacion tabla roles
CREATE TABLE roles (
    id_rol INT AUTO_INCREMENT PRIMARY KEY,
    nombre_rol VARCHAR(50) NOT NULL UNIQUE
);

-- Ingreso de roles
INSERT INTO roles (nombre_rol) VALUES ('Visitante'), ('Empleado'), ('Proveedor');

-- Creacion tablas personas
CREATE TABLE personas (
    cedula VARCHAR(20) PRIMARY KEY,
    nombre_completo VARCHAR(100) NOT NULL,
    telefono VARCHAR(20),
    eps VARCHAR(50),
    arl VARCHAR(50),
    id_rol INT NOT NULL,
    unifi_user_id VARCHAR(64) NULL UNIQUE,
    INDEX idx_personas_rol (id_rol),
    INDEX idx_personas_nombre (nombre_completo),
    CONSTRAINT fk_persona_rol FOREIGN KEY (id_rol) REFERENCES roles(id_rol)
);

-- Creacion tabla registros
CREATE TABLE registros_ingreso (
    id_registro INT AUTO_INCREMENT PRIMARY KEY,
    cedula VARCHAR(20) NOT NULL,
    motivo VARCHAR(255),
    fecha_ingreso DATE NOT NULL DEFAULT (CURRENT_DATE),
    hora_ingreso TIME NULL DEFAULT (CURRENT_TIME),
    hora_salida TIME NULL,
    total_entradas INT NOT NULL DEFAULT 1,
    total_salidas INT NOT NULL DEFAULT 0,
    movimientos_json TEXT NULL,
    INDEX idx_registros_fecha_hora (fecha_ingreso, hora_ingreso),
    INDEX idx_registros_cedula (cedula),
    CONSTRAINT fk_registro_persona FOREIGN KEY (cedula) REFERENCES personas(cedula)
);

-- Sentencias opcionales si las tablas ya fueron creadas previamente:
-- CREATE INDEX idx_personas_nombre ON personas (nombre_completo);
-- CREATE INDEX idx_registros_fecha_hora ON registros_ingreso (fecha_ingreso, hora_ingreso);

-- Creacion tabla usuarios (acceso al Dashboard con autenticacion JWT)
CREATE TABLE IF NOT EXISTS usuarios (
    id_usuario INT AUTO_INCREMENT PRIMARY KEY,
    nombre_usuario VARCHAR(50) NOT NULL UNIQUE,
    nombre_completo VARCHAR(100) NOT NULL,
    contrasena_hash VARCHAR(255) NOT NULL,
    activo TINYINT(1) NOT NULL DEFAULT 1,
    fecha_creacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Creacion tabla accesos_qr (control de tiempo de vida y usos de QR en UniFi Access)
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
