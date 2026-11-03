--Creacion tabla roles
CREATE TABLE roles (
    id_rol INT AUTO_INCREMENT PRIMARY KEY,
    nombre_rol VARCHAR(50) NOT NULL UNIQUE
);

--Ingreso de roles
INSERT INTO roles (nombre_rol) VALUES ('Visitante'), ('Empleado'), ('Proveedor');

--Creacion tablas personas
CREATE TABLE personas (
    cedula VARCHAR(20) PRIMARY KEY,
    nombre_completo VARCHAR(100) NOT NULL,
    telefono VARCHAR(20),
    eps VARCHAR(50),
    arl VARCHAR(50),
    id_rol INT NOT NULL,
    INDEX idx_personas_rol (id_rol),
    INDEX idx_personas_nombre (nombre_completo),
    CONSTRAINT fk_persona_rol FOREIGN KEY (id_rol) REFERENCES roles(id_rol)
);

--Creacion tabla registros
CREATE TABLE registros_ingreso (
    id_registro INT AUTO_INCREMENT PRIMARY KEY,
    cedula VARCHAR(20) NOT NULL,
    motivo VARCHAR(255),
    fecha_ingreso DATE NOT NULL DEFAULT (CURRENT_DATE),
    hora_ingreso TIME NOT NULL DEFAULT (CURRENT_TIME),
    hora_salida TIME NULL,
    INDEX idx_registros_fecha_hora (fecha_ingreso, hora_ingreso),
    INDEX idx_registros_cedula (cedula),
    CONSTRAINT fk_registro_persona FOREIGN KEY (cedula) REFERENCES personas(cedula)
);

-- Sentencias opcionales si las tablas ya fueron creadas previamente:
-- CREATE INDEX idx_personas_nombre ON personas (nombre_completo);
-- CREATE INDEX idx_registros_fecha_hora ON registros_ingreso (fecha_ingreso, hora_ingreso);
