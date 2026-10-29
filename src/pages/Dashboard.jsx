import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { obtenerRangoFechas } from '../utils/dateHelpers';
import { isWithinInterval } from 'date-fns';
import { obtenerVisitas } from '../api/unifiApi';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import './Dashboard.css';

const Dashboard = () => {
  const { usuario, cerrarSesion } = useAuth();
  const [textoBusqueda, setTextoBusqueda] = useState('');
  const [periodo, setPeriodo] = useState('hoy');
  const [filtroRol, setFiltroRol] = useState('todos');
  const [fechaInicioPersonalizada, setFechaInicioPersonalizada] = useState('');
  const [fechaFinPersonalizada, setFechaFinPersonalizada] = useState('');
  const [visitas, setVisitas] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [todasLasVisitas, setTodasLasVisitas] = useState([]);
  const [pestañaActiva, setPestañaActiva] = useState('listado');
  const [ultimaActualizacion, setUltimaActualizacion] = useState(new Date());

  const COLORES = ['#0066cc', '#38a169', '#dd6b20'];

  useEffect(() => {
    cargarVisitas();
  }, []);

  useEffect(() => {
    if (pestañaActiva === 'listado') {
      const hoy = new Date();
      const fechaHoy = hoy.toLocaleDateString('es-CO');
      let resultado = [...todasLasVisitas];
      
      if (filtroRol !== 'todos') {
        resultado = resultado.filter(v => v.rol === filtroRol);
      }
      
      if (textoBusqueda) {
        const busqueda = textoBusqueda.toLowerCase();
        resultado = resultado.filter(v => 
          v.nombreCompleto?.toLowerCase().includes(busqueda) ||
          v.cedula?.includes(busqueda)
        );
      }
      
      resultado = resultado.filter(v => {
        try {
          const fechaVisita = new Date(v.fecha.replace(' ', 'T'));
          return fechaVisita.toLocaleDateString('es-CO') === fechaHoy;
        } catch {
          return true;
        }
      });
      
      setVisitas(resultado);
    }
  }, [todasLasVisitas, pestañaActiva]);

  useEffect(() => {
    const intervalo = setInterval(() => {
      cargarVisitas();
      setUltimaActualizacion(new Date());
    }, 300000); // Actualizar cada 5 minutos

    return () => clearInterval(intervalo);
  }, []);

  const cargarVisitas = async () => {
    setCargando(true);
    try {
      const datos = await obtenerVisitas();
      setTodasLasVisitas(datos);
      setUltimaActualizacion(new Date());
      
      if (pestañaActiva === 'listado') {
        const hoy = new Date();
        const fechaHoy = hoy.toLocaleDateString('es-CO');
        let resultado = [...datos];
        
        if (filtroRol !== 'todos') {
          resultado = resultado.filter(v => v.rol === filtroRol);
        }
        
        if (textoBusqueda) {
          const busqueda = textoBusqueda.toLowerCase();
          resultado = resultado.filter(v => 
            v.nombreCompleto?.toLowerCase().includes(busqueda) ||
            v.cedula?.includes(busqueda)
          );
        }
        
        resultado = resultado.filter(v => {
          try {
            const fechaVisita = new Date(v.fecha.replace(' ', 'T'));
            return fechaVisita.toLocaleDateString('es-CO') === fechaHoy;
          } catch {
            return true;
          }
        });
        
        setVisitas(resultado);
      } else {
        setVisitas(datos);
      }
    } catch (error) {
      console.error('Error al cargar visitas:', error);
    } finally {
      setCargando(false);
    }
  };

  const aplicarFiltros = () => {
    const rangoFechas = obtenerRangoFechas(periodo, fechaInicioPersonalizada, fechaFinPersonalizada);
    console.log('Filtrando por:', { textoBusqueda, periodo, filtroRol, rangoFechas });
    
    let resultado = [...todasLasVisitas];
    
    if (filtroRol !== 'todos') {
      resultado = resultado.filter(v => v.rol === filtroRol);
    }
    
    if (textoBusqueda) {
      const busqueda = textoBusqueda.toLowerCase();
      resultado = resultado.filter(v => 
        v.nombreCompleto?.toLowerCase().includes(busqueda) ||
        v.cedula?.includes(busqueda)
      );
    }
    
    resultado = resultado.filter(v => {
      try {
        const fechaVisita = new Date(v.fecha.replace(' ', 'T'));
        return isWithinInterval(fechaVisita, { start: rangoFechas.inicio, end: rangoFechas.fin });
      } catch {
        return true;
      }
    });
    
    setVisitas(resultado);
  };

  const obtenerDatosPorRol = () => {
    const conteo = {
      empleado: 0,
      visitantes: 0,
      proveedores: 0
    };
    visitas.forEach(v => {
      if (conteo[v.rol] !== undefined) {
        conteo[v.rol]++;
      }
    });
    return [
      { nombre: 'Empleado', valor: conteo.empleado },
      { nombre: 'Visitantes', valor: conteo.visitantes },
      { nombre: 'Proveedores', valor: conteo.proveedores }
    ].filter(item => item.valor > 0);
  };

  const obtenerDatosPorHora = () => {
    const conteoPorHora = {};
    visitas.forEach(v => {
      try {
        const fecha = new Date(v.fecha.replace(' ', 'T'));
        const hora = fecha.getHours();
        const clave = `${hora.toString().padStart(2, '0')}:00`;
        conteoPorHora[clave] = (conteoPorHora[clave] || 0) + 1;
      } catch {
        // ignorar
      }
    });
    return Object.keys(conteoPorHora)
      .sort()
      .map(hora => ({
        hora: hora,
        cantidad: conteoPorHora[hora]
      }));
  };

  const obtenerDatosPorDia = () => {
    const conteoPorDia = {};
    visitas.forEach(v => {
      try {
        const fecha = new Date(v.fecha.replace(' ', 'T'));
        const clave = fecha.toLocaleDateString('es-CO');
        conteoPorDia[clave] = (conteoPorDia[clave] || 0) + 1;
      } catch {
        // ignorar
      }
    });
    return Object.keys(conteoPorDia)
      .sort((a, b) => new Date(a.split('/').reverse().join('-')) - new Date(b.split('/').reverse().join('-')))
      .map(dia => ({
        dia: dia,
        cantidad: conteoPorDia[dia]
      }));
  };

  const obtenerEntradasHoy = () => {
    const hoy = new Date();
    const fechaHoy = hoy.toLocaleDateString('es-CO');
    return todasLasVisitas.filter(v => {
      try {
        const fechaVisita = new Date(v.fecha.replace(' ', 'T'));
        return fechaVisita.toLocaleDateString('es-CO') === fechaHoy;
      } catch {
        return false;
      }
    });
  };

  const entradasHoy = obtenerEntradasHoy();
  const totalEntradasHoy = entradasHoy.length;
  const visitantesUnicosHoy = new Set(entradasHoy.map(v => v.cedula)).size;

  const totalVisitas = visitas.length;
  const visitantesUnicos = new Set(visitas.map(v => v.cedula)).size;
  const datosPorRol = obtenerDatosPorRol();
  const datosPorHora = obtenerDatosPorHora();
  const datosPorDia = obtenerDatosPorDia();

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <h1>Dashboard - Lira Seguridad</h1>
        <div className="header-actions">
          <span>Bienvenido, {usuario?.nombreUsuario}</span>
          <button onClick={cargarVisitas} className="apply-filters-button" style={{ height: 'auto' }}>Actualizar</button>
          <button onClick={cerrarSesion} className="logout-button">Cerrar Sesión</button>
        </div>
      </header>

      <div style={{ backgroundColor: '#fff', padding: '0 2rem', borderBottom: '2px solid #e2e8f0' }}>
        <div style={{ display: 'flex', gap: '2rem' }}>
          <button
            onClick={() => {
              setPestañaActiva('listado');
              cargarVisitas();
            }}
            style={{
              padding: '0.75rem 1.5rem',
              background: 'none',
              border: 'none',
              borderBottom: pestañaActiva === 'listado' ? '3px solid #0066cc' : '3px solid transparent',
              color: pestañaActiva === 'listado' ? '#0066cc' : '#4a5568',
              fontWeight: pestañaActiva === 'listado' ? '600' : '400',
              cursor: 'pointer',
              fontSize: '0.95rem'
            }}
          >
            Listado
          </button>
          <button
            onClick={() => setPestañaActiva('estadisticas')}
            style={{
              padding: '0.75rem 1.5rem',
              background: 'none',
              border: 'none',
              borderBottom: pestañaActiva === 'estadisticas' ? '3px solid #0066cc' : '3px solid transparent',
              color: pestañaActiva === 'estadisticas' ? '#0066cc' : '#4a5568',
              fontWeight: pestañaActiva === 'estadisticas' ? '600' : '400',
              cursor: 'pointer',
              fontSize: '0.95rem'
            }}
          >
            Estadísticas
          </button>
        </div>
      </div>

      {pestañaActiva === 'listado' && (
        <>
          <div className="filters-bar">
            <div className="filter-group">
              <label htmlFor="busqueda">Buscar</label>
              <input
                type="text"
                id="busqueda"
                placeholder="Buscar..."
                value={textoBusqueda}
                onChange={(e) => setTextoBusqueda(e.target.value)}
              />
            </div>

            <div className="filter-group">
              <label htmlFor="rol">Rol</label>
              <select
                id="rol"
                value={filtroRol}
                onChange={(e) => setFiltroRol(e.target.value)}
              >
                <option value="todos">Todos</option>
                <option value="empleado">Empleado</option>
                <option value="visitantes">Visitantes</option>
                <option value="proveedores">Proveedores</option>
              </select>
            </div>

            <div className="filter-group">
              <label htmlFor="periodo">Periodo de visita</label>
              <select
                id="periodo"
                value={periodo}
                onChange={(e) => {
                  setPeriodo(e.target.value);
                }}
              >
                <option value="hoy">Hoy</option>
                <option value="ayer">Ayer</option>
                <option value="anteayer">Anteayer</option>
                <option value="7dias">Últimos 7 días</option>
                <option value="semana">Esta semana</option>
                <option value="semanapasada">Semana pasada</option>
                <option value="30dias">Últimos 30 días</option>
                <option value="mes">Este mes</option>
                <option value="personalizado">Personalizado</option>
              </select>
            </div>

            {periodo === 'personalizado' && (
              <>
                <div className="filter-group">
                  <label htmlFor="fechaInicio">Fecha inicio</label>
                  <input
                    type="date"
                    id="fechaInicio"
                    value={fechaInicioPersonalizada}
                    onChange={(e) => setFechaInicioPersonalizada(e.target.value)}
                  />
                </div>
                <div className="filter-group">
                  <label htmlFor="fechaFin">Fecha fin</label>
                  <input
                    type="date"
                    id="fechaFin"
                    value={fechaFinPersonalizada}
                    onChange={(e) => setFechaFinPersonalizada(e.target.value)}
                  />
                </div>
              </>
            )}

            <button onClick={aplicarFiltros} className="apply-filters-button">
              Aplicar Filtros
            </button>
          </div>

          <main className="dashboard-content">
            {cargando ? (
              <p>Cargando...</p>
            ) : (
              <div className="table-container">
                <table className="visits-table">
                  <thead>
                    <tr>
                      <th>Nombre completo</th>
                      <th>Cédula</th>
                      <th>Motivo</th>
                      <th>EPS</th>
                      <th>ARL</th>
                      <th>Teléfono</th>
                      <th>Rol</th>
                      <th>Fecha</th>
                      <th>Hora</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visitas.length === 0 ? (
                      <tr>
                        <td colSpan="9" style={{ textAlign: 'center' }}>
                          No hay visitas para mostrar
                        </td>
                      </tr>
                    ) : (
                      visitas.map((visita, indice) => (
                        <tr key={indice}>
                          <td>{visita.fecha}</td>
                          <td>{visita.hora}</td>
                          <td>{visita.nombreCompleto}</td>
                          <td>{visita.cedula}</td>
                          <td>{visita.motivo}</td>
                          <td>{visita.eps}</td>
                          <td>{visita.arl}</td>
                          <td>{visita.telefono}</td>
                          <td>{visita.rol}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </main>
        </>
      )}

      {pestañaActiva === 'estadisticas' && (
        <main className="dashboard-content">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: '1.3rem' }}>Estadísticas de visitas</h2>
              <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.8rem', color: '#718096' }}>
                Última actualización: {ultimaActualizacion.toLocaleTimeString('es-CO')} • Se actualiza automáticamente cada 5 minutos
              </p>
            </div>
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1rem' }}>
              <div style={{ backgroundColor: '#fff', padding: '1.5rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', borderLeft: '4px solid #0066cc' }}>
                <p style={{ color: '#718096', fontSize: '0.875rem', marginBottom: '0.5rem' }}>Entradas hoy</p>
                <p style={{ fontSize: '2rem', fontWeight: '600', color: '#1a202c', margin: 0 }}>{totalEntradasHoy}</p>
              </div>
              <div style={{ backgroundColor: '#fff', padding: '1.5rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', borderLeft: '4px solid #38a169' }}>
                <p style={{ color: '#718096', fontSize: '0.875rem', marginBottom: '0.5rem' }}>Visitantes únicos hoy</p>
                <p style={{ fontSize: '2rem', fontWeight: '600', color: '#1a202c', margin: 0 }}>{visitantesUnicosHoy}</p>
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '1.5rem' }}>
            <div style={{ backgroundColor: '#fff', padding: '1.5rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
              <h3 style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1.1rem' }}>Entradas por rol</h3>
              {datosPorRol.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={datosPorRol}
                      dataKey="valor"
                      nameKey="nombre"
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                      label
                    >
                      {datosPorRol.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORES[index % COLORES.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <p style={{ textAlign: 'center', color: '#718096' }}>Sin datos</p>
              )}
            </div>

            <div style={{ backgroundColor: '#fff', padding: '1.5rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
              <h3 style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1.1rem' }}>Entradas por hora</h3>
              {datosPorHora.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={datosPorHora}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="hora" />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="cantidad" fill="#0066cc" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p style={{ textAlign: 'center', color: '#718096' }}>Sin datos</p>
              )}
            </div>

            <div style={{ backgroundColor: '#fff', padding: '1.5rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', gridColumn: '1 / -1' }}>
              <h3 style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1.1rem' }}>Entradas por día</h3>
              {datosPorDia.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={datosPorDia}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="dia" />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="cantidad" fill="#38a169" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p style={{ textAlign: 'center', color: '#718096' }}>Sin datos</p>
              )}
            </div>
          </div>
        </main>
      )}
    </div>
  );
};

export default Dashboard;
