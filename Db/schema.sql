--Creacion tabla roles
CREATE TABLE roles (
    id_rol INT AUTO_INCREMENT PRIMARY KEY,
    nombre_rol VARCHAR(50) NOT NULL
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
    CONSTRAINT fk_persona_rol FOREIGN KEY (id_rol) REFERENCES roles(id_rol)
);

--Creacion tabla registros
CREATE TABLE registros_ingreso (
    id_registro INT AUTO_INCREMENT PRIMARY KEY,
    cedula VARCHAR(20) NOT NULL,
    motivo VARCHAR(255),
    fecha_ingreso DATE DEFAULT (CURRENT_DATE),          
    hora_ingreso TIME DEFAULT (CURRENT_TIME),            
    hora_salida TIME NULL,                           
    CONSTRAINT fk_registro_persona FOREIGN KEY (cedula) REFERENCES personas(cedula)
);