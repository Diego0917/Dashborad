import { useState, useEffect, useCallback, useMemo } from 'react';
import { isWithinInterval } from 'date-fns';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { useAuth } from '../context/AuthContext';
import {
  obtenerRangoFechas,
  parsearFechaLocal,
  formatearFechaLegible,
  obtenerClaveDia,
  esMismoDia,
  calcularDuracionMinutos,
  formatearDuracionLegible,
} from '../utils/dateHelpers';
import { obtenerVisitas } from '../api/unifiApi';
import './Dashboard.css';

const COLORES = ['#0066cc', '#38a169', '#dd6b20', '#805ad5', '#e53e3e'];

const FILTROS_INICIALES = {
  textoBusqueda: '',
  filtroRol: 'todos',
  periodo: 'hoy',
  fechaInicioPersonalizada: '',
  fechaFinPersonalizada: '',
};

const INTERVALO_ACTUALIZACION_MS = 300000; // 5 minutos

const Dashboard = () => {
  const { usuario, cerrarSesion } = useAuth();

  // Estados de los controles del formulario de filtros
  const [textoBusqueda, setTextoBusqueda] = useState(FILTROS_INICIALES.textoBusqueda);
  const [filtroRol, setFiltroRol] = useState(FILTROS_INICIALES.filtroRol);
  const [periodo, setPeriodo] = useState(FILTROS_INICIALES.periodo);
  const [fechaInicioPersonalizada, setFechaInicioPersonalizada] = useState(
    FILTROS_INICIALES.fechaInicioPersonalizada
  );
  const [fechaFinPersonalizada, setFechaFinPersonalizada] = useState(
    FILTROS_INICIALES.fechaFinPersonalizada
  );

  // Filtros efectivamente aplicados al pulsar "Aplicar Filtros"
  const [filtrosAplicados, setFiltrosAplicados] = useState(FILTROS_INICIALES);

  // Datos y estado de red / UI
  const [todasLasVisitas, setTodasLasVisitas] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState('');
  const [pestanaActiva, setPestanaActiva] = useState('listado');
  const [ultimaActualizacion, setUltimaActualizacion] = useState(null);

  const cargarVisitas = useCallback(async () => {
    setCargando(true);
    setErrorCarga('');
    try {
      const datos = await obtenerVisitas();
      setTodasLasVisitas(Array.isArray(datos) ? datos : []);
      setUltimaActualizacion(new Date());
    } catch (error) {
      console.error('Error al cargar visitas:', error);
      setErrorCarga('No se pudieron cargar las visitas. Verifica que el servidor esté activo.');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    let cancelado = false;

    const inicializar = async () => {
      try {
        const datos = await obtenerVisitas();
        if (!cancelado) {
          setTodasLasVisitas(Array.isArray(datos) ? datos : []);
          setUltimaActualizacion(new Date());
          setErrorCarga('');
        }
      } catch (error) {
        if (!cancelado) {
          console.error('Error al cargar visitas:', error);
          setErrorCarga('No se pudieron cargar las visitas. Verifica que el servidor esté activo.');
        }
      } finally {
        if (!cancelado) {
          setCargando(false);
        }
      }
    };

    inicializar();
    const intervalo = setInterval(() => {
      inicializar();
    }, INTERVALO_ACTUALIZACION_MS);

    return () => {
      cancelado = true;
      clearInterval(intervalo);
    };
  }, []);

  const aplicarFiltros = (evento) => {
    if (evento) evento.preventDefault();
    setFiltrosAplicados({
      textoBusqueda: textoBusqueda.trim(),
      filtroRol,
      periodo,
      fechaInicioPersonalizada,
      fechaFinPersonalizada,
    });
    if (!ultimaActualizacion) {
      setUltimaActualizacion(new Date());
    }
  };

  const limpiarFiltros = () => {
    setTextoBusqueda(FILTROS_INICIALES.textoBusqueda);
    setFiltroRol(FILTROS_INICIALES.filtroRol);
    setPeriodo(FILTROS_INICIALES.periodo);
    setFechaInicioPersonalizada(FILTROS_INICIALES.fechaInicioPersonalizada);
    setFechaFinPersonalizada(FILTROS_INICIALES.fechaFinPersonalizada);
    setFiltrosAplicados(FILTROS_INICIALES);
  };

  // Visitas filtradas para la pestaña "Listado"
  const visitasFiltradas = useMemo(() => {
    if (todasLasVisitas.length === 0 || !ultimaActualizacion) return [];

    const rangoFechas = obtenerRangoFechas(
      filtrosAplicados.periodo,
      filtrosAplicados.fechaInicioPersonalizada,
      filtrosAplicados.fechaFinPersonalizada,
      ultimaActualizacion
    );
    const busqueda = filtrosAplicados.textoBusqueda.toLowerCase();

    return todasLasVisitas.filter((visita) => {
      if (filtrosAplicados.filtroRol !== 'todos' && visita.rol !== filtrosAplicados.filtroRol) {
        return false;
      }

      if (busqueda) {
        const coincideNombre = visita.nombre_completo?.toLowerCase().includes(busqueda);
        const coincideCedula = String(visita.cedula ?? '').toLowerCase().includes(busqueda);
        if (!coincideNombre && !coincideCedula) {
          return false;
        }
      }

      const fechaVisita = parsearFechaLocal(visita.fecha_ingreso);
      if (!fechaVisita) return false;

      return isWithinInterval(fechaVisita, {
        start: rangoFechas.inicio,
        end: rangoFechas.fin,
      });
    });
  }, [todasLasVisitas, filtrosAplicados, ultimaActualizacion]);

  // Métricas y gráficas para la pestaña "Estadísticas" (calculadas una sola vez cuando cambian los datos)
  const {
    totalEntradasHoy,
    visitantesUnicosHoy,
    personasEnEdificioHoy,
    detalleEnEdificio,
    tiempoPromedioVisita,
    detalleTiempoPromedio,
    datosPorRol,
    datosPorHora,
    datosPorDia,
  } = useMemo(() => {
    if (todasLasVisitas.length === 0 || !ultimaActualizacion) {
      return {
        totalEntradasHoy: 0,
        visitantesUnicosHoy: 0,
        personasEnEdificioHoy: 0,
        detalleEnEdificio: 'Sin registros hoy',
        tiempoPromedioVisita: '--',
        detalleTiempoPromedio: 'Sin salidas registradas',
        datosPorRol: [],
        datosPorHora: [],
        datosPorDia: [],
      };
    }

    let conteoEntradasHoy = 0;
    let conteoEnEdificioHoy = 0;
    let salidasPendientesAnteriores = 0;
    const cedulasHoy = new Set();
    const conteoEnEdificioPorRol = {};
    const conteoRol = {};
    const conteoPorHora = {};
    const conteoPorDia = {};

    let sumaMinutosPermanencia = 0;
    let conteoVisitasCerradas = 0;
    const duracionPorRol = {};

    for (const visita of todasLasVisitas) {
      const nombreRol = visita.rol || 'Sin rol';
      const esIngresoDeHoy = esMismoDia(visita.fecha_ingreso, ultimaActualizacion);
      const tieneSalida = Boolean(visita.hora_salida && String(visita.hora_salida).trim() !== '');

      //  día actual y aforo activo
      if (esIngresoDeHoy) {
        conteoEntradasHoy += 1;
        if (visita.cedula) {
          cedulasHoy.add(visita.cedula);
        }
        if (!tieneSalida) {
          conteoEnEdificioHoy += 1;
          conteoEnEdificioPorRol[nombreRol] = (conteoEnEdificioPorRol[nombreRol] || 0) + 1;
        }
      } else if (!tieneSalida) {
        salidasPendientesAnteriores += 1;
      }

      // Tiempo de permanencia (hora_salida - hora_ingreso)
      if (tieneSalida) {
        const duracionMinutos = calcularDuracionMinutos(visita.hora_ingreso, visita.hora_salida);
        if (duracionMinutos !== null) {
          sumaMinutosPermanencia += duracionMinutos;
          conteoVisitasCerradas += 1;

          if (!duracionPorRol[nombreRol]) {
            duracionPorRol[nombreRol] = { suma: 0, cantidad: 0 };
          }
          duracionPorRol[nombreRol].suma += duracionMinutos;
          duracionPorRol[nombreRol].cantidad += 1;
        }
      }

      // Conteo por rol ('Empleado', 'Visitante', 'Proveedor', etc.)
      conteoRol[nombreRol] = (conteoRol[nombreRol] || 0) + 1;

      // Conteo por hora
      if (typeof visita.hora_ingreso === 'string' && visita.hora_ingreso.length >= 2) {
        const claveHora = `${visita.hora_ingreso.substring(0, 2)}:00`;
        conteoPorHora[claveHora] = (conteoPorHora[claveHora] || 0) + 1;
      }

      // Conteo por día ordenable cronológicamente
      const claveIsoDia = obtenerClaveDia(visita.fecha_ingreso);
      if (claveIsoDia) {
        if (!conteoPorDia[claveIsoDia]) {
          conteoPorDia[claveIsoDia] = {
            etiqueta: formatearFechaLegible(visita.fecha_ingreso),
            cantidad: 0,
          };
        }
        conteoPorDia[claveIsoDia].cantidad += 1;
      }
    }

    const resumenRolesDentro = Object.entries(conteoEnEdificioPorRol)
      .map(([rolActual, cantidad]) => `${cantidad} ${rolActual}`)
      .join(' · ');

    let textoDetalleEdificio = resumenRolesDentro || 'Nadie dentro actualmente';
    if (salidasPendientesAnteriores > 0) {
      textoDetalleEdificio += ` (${salidasPendientesAnteriores} sin salida de días previos)`;
    }

    const promedioGeneralMinutos =
      conteoVisitasCerradas > 0 ? sumaMinutosPermanencia / conteoVisitasCerradas : null;

    const promediosPorRolTexto = ['Visitante', 'Proveedor']
      .filter((rolObjetivo) => duracionPorRol[rolObjetivo]?.cantidad > 0)
      .map((rolObjetivo) => {
        const datosRol = duracionPorRol[rolObjetivo];
        return `${rolObjetivo}: ${formatearDuracionLegible(datosRol.suma / datosRol.cantidad)}`;
      })
      .join(' · ');

    const textoDetallePromedio =
      conteoVisitasCerradas === 0
        ? 'Sin salidas registradas aún'
        : promediosPorRolTexto || `Basado en ${conteoVisitasCerradas} salidas registradas`;

    const listaRoles = Object.entries(conteoRol)
      .map(([nombre, valor]) => ({ nombre, valor }))
      .filter((item) => item.valor > 0);

    const listaHoras = Object.keys(conteoPorHora)
      .sort()
      .map((hora) => ({
        hora,
        cantidad: conteoPorHora[hora],
      }));

    const listaDias = Object.keys(conteoPorDia)
      .sort()
      .map((claveIso) => ({
        dia: conteoPorDia[claveIso].etiqueta,
        cantidad: conteoPorDia[claveIso].cantidad,
      }));

    return {
      totalEntradasHoy: conteoEntradasHoy,
      visitantesUnicosHoy: cedulasHoy.size,
      personasEnEdificioHoy: conteoEnEdificioHoy,
      detalleEnEdificio: textoDetalleEdificio,
      tiempoPromedioVisita: formatearDuracionLegible(promedioGeneralMinutos),
      detalleTiempoPromedio: textoDetallePromedio,
      datosPorRol: listaRoles,
      datosPorHora: listaHoras,
      datosPorDia: listaDias,
    };
  }, [todasLasVisitas, ultimaActualizacion]);

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <h1>Dashboard - Lira Seguridad</h1>
        <div className="header-actions">
          <span>Bienvenido, {usuario?.nombreUsuario}</span>
          <button
            type="button"
            onClick={cargarVisitas}
            disabled={cargando}
            className="refresh-button"
          >
            {cargando ? 'Actualizando...' : 'Actualizar'}
          </button>
          <button type="button" onClick={cerrarSesion} className="logout-button">
            Cerrar Sesión
          </button>
        </div>
      </header>

      <nav className="tabs-bar" aria-label="Secciones del dashboard">
        <div className="tabs-list">
          <button
            type="button"
            onClick={() => setPestanaActiva('listado')}
            className={`tab-button ${pestanaActiva === 'listado' ? 'active' : ''}`}
          >
            Listado
          </button>
          <button
            type="button"
            onClick={() => setPestanaActiva('estadisticas')}
            className={`tab-button ${pestanaActiva === 'estadisticas' ? 'active' : ''}`}
          >
            Estadísticas
          </button>
        </div>
      </nav>

      {pestanaActiva === 'listado' && (
        <>
          <form className="filters-bar" onSubmit={aplicarFiltros}>
            <div className="filter-group">
              <label htmlFor="busqueda">Buscar</label>
              <input
                type="text"
                id="busqueda"
                placeholder="Nombre o cédula..."
                value={textoBusqueda}
                onChange={(evento) => setTextoBusqueda(evento.target.value)}
              />
            </div>

            <div className="filter-group">
              <label htmlFor="rol">Rol</label>
              <select
                id="rol"
                value={filtroRol}
                onChange={(evento) => setFiltroRol(evento.target.value)}
              >
                <option value="todos">Todos</option>
                <option value="Empleado">Empleado</option>
                <option value="Visitante">Visitante</option>
                <option value="Proveedor">Proveedor</option>
              </select>
            </div>

            <div className="filter-group">
              <label htmlFor="periodo">Periodo de visita</label>
              <select
                id="periodo"
                value={periodo}
                onChange={(evento) => setPeriodo(evento.target.value)}
              >
                <option value="hoy">Hoy</option>
                <option value="ayer">Ayer</option>
                <option value="7dias">Últimos 7 días</option>
                <option value="30dias">Últimos 30 días</option>
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
                    onChange={(evento) => setFechaInicioPersonalizada(evento.target.value)}
                  />
                </div>
                <div className="filter-group">
                  <label htmlFor="fechaFin">Fecha fin</label>
                  <input
                    type="date"
                    id="fechaFin"
                    value={fechaFinPersonalizada}
                    onChange={(evento) => setFechaFinPersonalizada(evento.target.value)}
                  />
                </div>
              </>
            )}

            <div className="filter-buttons">
              <button type="submit" className="apply-filters-button">
                Aplicar Filtros
              </button>
              <button type="button" onClick={limpiarFiltros} className="clear-filters-button">
                Limpiar
              </button>
            </div>
          </form>

          <main className="dashboard-content">
            {errorCarga && <div className="error-banner">{errorCarga}</div>}

            {cargando && todasLasVisitas.length === 0 ? (
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
                      <th>Entrada</th>
                      <th>Salida</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visitasFiltradas.length === 0 ? (
                      <tr>
                        <td colSpan="10" className="empty-cell">
                          No hay visitas para mostrar en el periodo seleccionado
                        </td>
                      </tr>
                    ) : (
                      visitasFiltradas.map((visita) => {
                        const tieneSalida = Boolean(
                          visita.hora_salida && String(visita.hora_salida).trim() !== ''
                        );
                        const sigueEnEdificioHoy =
                          !tieneSalida &&
                          ultimaActualizacion &&
                          esMismoDia(visita.fecha_ingreso, ultimaActualizacion);

                        return (
                          <tr
                            key={
                              visita.id_registro ??
                              `${visita.cedula}-${visita.fecha_ingreso}-${visita.hora_ingreso}`
                            }
                          >
                            <td>{visita.nombre_completo}</td>
                            <td>{visita.cedula}</td>
                            <td>{visita.motivo || '-'}</td>
                            <td>{visita.eps || 'N/A'}</td>
                            <td>{visita.arl || 'N/A'}</td>
                            <td>{visita.telefono || '-'}</td>
                            <td>{visita.rol}</td>
                            <td>{formatearFechaLegible(visita.fecha_ingreso)}</td>
                            <td>{visita.hora_ingreso}</td>
                            <td>
                              {tieneSalida ? (
                                visita.hora_salida
                              ) : sigueEnEdificioHoy ? (
                                <span className="badge-en-edificio">En el edificio</span>
                              ) : (
                                <span className="texto-pendiente">Sin registrar</span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </main>
        </>
      )}

      {pestanaActiva === 'estadisticas' && (
        <main className="dashboard-content">
          {errorCarga && <div className="error-banner">{errorCarga}</div>}

          <div className="stats-header">
            <div>
              <h2 className="stats-title">Estadísticas de visitas</h2>
              <p className="stats-subtitle">
                {ultimaActualizacion
                  ? `Última actualización: ${ultimaActualizacion.toLocaleTimeString('es-CO')} — Se actualiza automáticamente cada 5 minutos`
                  : 'Cargando datos...'}
              </p>
            </div>
          </div>

          <div className="kpi-grid">
            <div className="kpi-card">
              <p className="kpi-label">Entradas hoy</p>
              <p className="kpi-value">{totalEntradasHoy}</p>
            </div>
            <div className="kpi-card kpi-card--green">
              <p className="kpi-label">Visitantes únicos hoy</p>
              <p className="kpi-value">{visitantesUnicosHoy}</p>
            </div>
            <div className="kpi-card kpi-card--orange">
              <p className="kpi-label">Actualmente en el edificio</p>
              <p className="kpi-value">{personasEnEdificioHoy}</p>
              <p className="kpi-detail">{detalleEnEdificio}</p>
            </div>
            <div className="kpi-card kpi-card--purple">
              <p className="kpi-label">Tiempo promedio de visita</p>
              <p className="kpi-value">{tiempoPromedioVisita}</p>
              <p className="kpi-detail">{detalleTiempoPromedio}</p>
            </div>
          </div>

          <div className="charts-grid">
            <div className="chart-card">
              <h3 className="chart-title">Entradas por rol</h3>
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
                      {datosPorRol.map((entrada, indice) => (
                        <Cell key={entrada.nombre} fill={COLORES[indice % COLORES.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <p className="chart-empty">Sin datos</p>
              )}
            </div>

            <div className="chart-card">
              <h3 className="chart-title">Entradas por hora</h3>
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
                <p className="chart-empty">Sin datos</p>
              )}
            </div>

            <div className="chart-card chart-card--full">
              <h3 className="chart-title">Entradas por día</h3>
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
                <p className="chart-empty">Sin datos</p>
              )}
            </div>
          </div>
        </main>
      )}
    </div>
  );
};

export default Dashboard;
