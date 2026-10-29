const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Configura la conexión a tu base de datos en XAMPP / phpMyAdmin
const db = mysql.createConnection({
    host: 'localhost',
    port: 3306,                    // Puerto por defecto de MySQL
    user: 'root',
    password: '',                  // Pon tu contraseña de phpMyAdmin si tienes una
    database: 'db_inregrsolira'    // ⚠️ Reemplaza esto por el nombre real de tu base de datos
});

db.connect((err) => {
    if (err) {
        console.error('Error al conectar a la base de datos:', err);
        return;
    }
    console.log('¡Conectado exitosamente a la base de datos MySQL!');
});

// Ruta que llamará tu función obtenerVisitas() en React
app.get('/api/visitas', (req, res) => {
    const query = `
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
    JOIN personas ON registros_ingreso.cedula = personas.cedula
    JOIN roles ON personas.id_rol = roles.id_rol
    ORDER BY registros_ingreso.fecha_ingreso DESC, registros_ingreso.hora_ingreso DESC;
    `;

    db.query(query, (err, results) => {
        if (err) {
            console.error('Error al consultar las visitas:', err);
            return res.status(500).json({ error: 'Error en el servidor' });
        }
        res.json(results);
    });
});

// Inicia el servidor en el puerto 3006 (para que coincida con tu api.js actual)
app.listen(3006, () => {
    console.log('Servidor backend corriendo en http://localhost:3006');
});