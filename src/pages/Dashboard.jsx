import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
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
  formatearFechaLegible,
  obtenerClaveDia,
  esMismoDia,
  formatearDuracionLegible,
} from '../utils/dateHelpers';
import {
  obtenerVisitas,
  obtenerEstadisticasVisitas,
  sincronizarEmpleadosUnifi,
  revocarQrVisita,
} from '../api/unifiApi';
import logoLira from '../assets/logo-lira.png';
import './Dashboard.css';

const COLORES = ['#0066cc', '#38a169', '#dd6b20', '#805ad5', '#e53e3e'];

const LIMITE_POR_PAGINA = 50;

const FILTROS_INICIALES = {
  textoBusqueda: '',
  filtroRol: 'todos',
  periodo: 'hoy',
  fechaInicioPersonalizada: '',
  fechaFinPersonalizada: '',
};

const ETIQUETAS_PERIODO = {
  hoy: 'Hoy',
  ayer: 'Ayer',
  '7dias': 'Últimos 7 días',
  '30dias': 'Últimos 30 días',
  personalizado: 'Periodo personalizado',
};

const INTERVALO_ACTUALIZACION_MS = 300000; // 5 minutos

const construirParametrosFiltroServidor = (filtros) => {
  const rangoFechas = obtenerRangoFechas(
    filtros.periodo,
    filtros.fechaInicioPersonalizada,
    filtros.fechaFinPersonalizada
  );

  const parametros = {};
  const fechaInicio = obtenerClaveDia(rangoFechas.inicio);
  const fechaFin = obtenerClaveDia(rangoFechas.fin);

  if (fechaInicio) parametros.fechaInicio = fechaInicio;
  if (fechaFin) parametros.fechaFin = fechaFin;
  if (filtros.filtroRol && filtros.filtroRol !== 'todos') {
    parametros.rol = filtros.filtroRol;
  }
  if (filtros.textoBusqueda && filtros.textoBusqueda.trim() !== '') {
    parametros.busqueda = filtros.textoBusqueda.trim();
  }

  return parametros;
};

const Dashboard = () => {
  const { usuario, cerrarSesion } = useAuth();
  const navegar = useNavigate();

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

  // Filtros efectivamente aplicados al servidor y paginación
  const [filtrosAplicados, setFiltrosAplicados] = useState(FILTROS_INICIALES);
  const [paginaActual, setPaginaActual] = useState(1);

  // Datos y estado de red / UI
  const [visitasPagina, setVisitasPagina] = useState([]);
  const [totalRegistros, setTotalRegistros] = useState(0);
  const [estadisticasServidor, setEstadisticasServidor] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState('');
  const [pestanaActiva, setPestanaActiva] = useState('listado');
  const [ultimaActualizacion, setUltimaActualizacion] = useState(null);
  const [visitaDetalleModal, setVisitaDetalleModal] = useState(null);
  const [sincronizandoEmpleados, setSincronizandoEmpleados] = useState(false);
  const [mensajeSincronizacion, setMensajeSincronizacion] = useState('');
  const [revocandoQr, setRevocandoQr] = useState(false);

  const consultarServidor = useCallback(async (filtrosActivos, pagina) => {
    const parametrosBase = construirParametrosFiltroServidor(filtrosActivos);
    const desplazamiento = (pagina - 1) * LIMITE_POR_PAGINA;

    const [respuestaVisitas, respuestaEstadisticas] = await Promise.all([
      obtenerVisitas({
        ...parametrosBase,
        limite: LIMITE_POR_PAGINA,
        desplazamiento,
        incluirTotal: 'true',
      }),
      obtenerEstadisticasVisitas(parametrosBase),
    ]);

    const listaRegistros = Array.isArray(respuestaVisitas)
      ? respuestaVisitas
      : Array.isArray(respuestaVisitas?.registros)
        ? respuestaVisitas.registros
        : [];

    const total =
      typeof respuestaVisitas?.total === 'number'
        ? respuestaVisitas.total
        : listaRegistros.length;

    return {
      registros: listaRegistros,
      total,
      estadisticas: respuestaEstadisticas,
    };
  }, []);

  const cargarVisitas = useCallback(async () => {
    setCargando(true);
    setErrorCarga('');
    try {
      const resultado = await consultarServidor(filtrosAplicados, paginaActual);
      setVisitasPagina(resultado.registros);
      setTotalRegistros(resultado.total);
      setEstadisticasServidor(resultado.estadisticas);
      setUltimaActualizacion(new Date());
    } catch (error) {
      console.error('Error al cargar visitas:', error);
      setErrorCarga('No se pudieron cargar las visitas. Verifica que el servidor esté activo.');
    } finally {
      setCargando(false);
    }
  }, [consultarServidor, filtrosAplicados, paginaActual]);

  useEffect(() => {
    let cancelado = false;

    const ejecutarConsulta = async () => {
      setCargando(true);
      try {
        const resultado = await consultarServidor(filtrosAplicados, paginaActual);
        if (!cancelado) {
          setVisitasPagina(resultado.registros);
          setTotalRegistros(resultado.total);
          setEstadisticasServidor(resultado.estadisticas);
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

    ejecutarConsulta();
    const intervalo = setInterval(() => {
      ejecutarConsulta();
    }, INTERVALO_ACTUALIZACION_MS);

    return () => {
      cancelado = true;
      clearInterval(intervalo);
    };
  }, [consultarServidor, filtrosAplicados, paginaActual]);

  const aplicarFiltros = (evento) => {
    if (evento) evento.preventDefault();
    setPaginaActual(1);
    setFiltrosAplicados({
      textoBusqueda: textoBusqueda.trim(),
      filtroRol,
      periodo,
      fechaInicioPersonalizada,
      fechaFinPersonalizada,
    });
  };

  const limpiarFiltros = () => {
    setTextoBusqueda(FILTROS_INICIALES.textoBusqueda);
    setFiltroRol(FILTROS_INICIALES.filtroRol);
    setPeriodo(FILTROS_INICIALES.periodo);
    setFechaInicioPersonalizada(FILTROS_INICIALES.fechaInicioPersonalizada);
    setFechaFinPersonalizada(FILTROS_INICIALES.fechaFinPersonalizada);
    setPaginaActual(1);
    setFiltrosAplicados(FILTROS_INICIALES);
  };

  const totalPaginas = Math.max(1, Math.ceil(totalRegistros / LIMITE_POR_PAGINA));
  const indicePrimerRegistro =
    totalRegistros === 0 ? 0 : (paginaActual - 1) * LIMITE_POR_PAGINA + 1;
  const indiceUltimoRegistro = Math.min(paginaActual * LIMITE_POR_PAGINA, totalRegistros);

  const irAPaginaAnterior = () => {
    setPaginaActual((paginaPrevia) => Math.max(1, paginaPrevia - 1));
  };

  const irAPaginaSiguiente = () => {
    setPaginaActual((paginaPrevia) => Math.min(totalPaginas, paginaPrevia + 1));
  };

  const manejarSincronizarEmpleados = async () => {
    setSincronizandoEmpleados(true);
    setErrorCarga('');
    setMensajeSincronizacion('');
    try {
      const respuesta = await sincronizarEmpleadosUnifi();
      setMensajeSincronizacion(
        respuesta.mensaje || 'Empleados sincronizados desde UniFi Access correctamente.'
      );
      await cargarVisitas();
    } catch (errorSync) {
      setErrorCarga(
        errorSync?.response?.data?.error ||
          'No se pudo sincronizar con UniFi Access (/api/v1/developer/users/search).'
      );
    } finally {
      setSincronizandoEmpleados(false);
    }
  };

  const manejarCancelarInvitacionModal = async () => {
    if (!visitaDetalleModal?.id_registro || revocandoQr) return;
    setRevocandoQr(true);
    setErrorCarga('');
    setMensajeSincronizacion('');
    try {
      const respuesta = await revocarQrVisita(visitaDetalleModal.id_registro);
      setVisitaDetalleModal((prev) =>
        prev ? { ...prev, estado_qr: 'REVOCADO' } : null
      );
      setMensajeSincronizacion(
        respuesta.mensaje || 'Invitación QR cancelada y revocada en UniFi Access.'
      );
      await cargarVisitas();
    } catch (errorRevocar) {
      setErrorCarga(
        errorRevocar?.response?.data?.error ||
          'No se pudo cancelar la invitación QR.'
      );
    } finally {
      setRevocandoQr(false);
    }
  };

  const formatearTiempoVidaVisita = (visita) => {
    if (!visita) return '1 hora (Estándar)';

    const inicioSeg = Number(visita.inicio_timestamp);
    const finSeg = Number(visita.fin_timestamp);

    if (inicioSeg > 0 && finSeg > inicioSeg) {
      const duracionMinutos = Math.round((finSeg - inicioSeg) / 60);
      const horaInicio = new Date(inicioSeg * 1000).toLocaleTimeString('es-CO', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const horaFin = new Date(finSeg * 1000).toLocaleTimeString('es-CO', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const ahoraSeg = ultimaActualizacion
        ? Math.floor(ultimaActualizacion.getTime() / 1000)
        : 0;
      const restanteMin = ahoraSeg > 0 ? Math.max(0, Math.ceil((finSeg - ahoraSeg) / 60)) : 0;

      if (visita.estado_qr === 'ACTIVO' && restanteMin > 0) {
        return `${formatearDuracionLegible(duracionMinutos)} (${horaInicio} - ${horaFin} · Quedan ${restanteMin} min)`;
      }
      return `${formatearDuracionLegible(duracionMinutos)} (${horaInicio} - ${horaFin})`;
    }

    return '1 hora (Ventana estándar desde el registro)';
  };

  const formatearAccesosVisita = (visita) => {
    if (!visita) return '0 de 2 accesos (1 ingreso + 1 salida)';

    if (visita.id_qr) {
      const usados = Number(visita.usos_actuales) || 0;
      const maximos = Number(visita.max_usos) || 0;
      const estado = visita.estado_qr || 'ACTIVO';
      if (maximos === 0) {
        return `Controlado solo por Tiempo de vida (${usados} lecturas registradas) · Estado: ${estado}`;
      }
      if (usados === 0) {
        return `0 de ${maximos} usos configurados (Esperando lectura del QR en cámara UniFi) · Estado: ${estado}`;
      }
      return `${usados} de ${maximos} usos configurados · Estado: ${estado}`;
    }

    const tieneEntrada = Boolean(visita.hora_ingreso);
    const tieneSalida = Boolean(
      visita.hora_salida && String(visita.hora_salida).trim() !== ''
    );
    const accesosRegistrados = (tieneEntrada ? 1 : 0) + (tieneSalida ? 1 : 0);
    return `${accesosRegistrados} de 2 accesos (${tieneSalida ? 'Ingreso y salida completados' : '1 ingreso registrado, salida pendiente'})`;
  };

  // Métricas y gráficas para la pestaña "Estadísticas" basadas en la respuesta agregada del servidor
  const {
    totalEntradasPeriodo,
    visitantesUnicosPeriodo,
    personasEnEdificioHoy,
    detalleEnEdificio,
    tiempoPromedioVisita,
    detalleTiempoPromedio,
    datosPorRol,
    datosPorHora,
    datosPorDia,
  } = useMemo(() => {
    const porRol = estadisticasServidor?.porRol || [];
    const porHora = estadisticasServidor?.porHora || [];
    const porDia = estadisticasServidor?.porDia || [];

    if (porRol.length === 0 && porHora.length === 0 && porDia.length === 0) {
      return {
        totalEntradasPeriodo: 0,
        visitantesUnicosPeriodo: 0,
        personasEnEdificioHoy: 0,
        detalleEnEdificio: 'Sin registros en el filtro actual',
        tiempoPromedioVisita: '--',
        detalleTiempoPromedio: 'Sin salidas registradas',
        datosPorRol: [],
        datosPorHora: [],
        datosPorDia: [],
      };
    }

    let conteoEntradas = 0;
    let conteoVisitantesUnicos = 0;
    let conteoEnEdificioHoy = 0;
    let salidasPendientesAnteriores = 0;
    let sumaMinutosPermanencia = 0;
    let conteoVisitasCerradas = 0;

    const resumenRolesDentro = [];
    const promediosPorRolTexto = [];
    const listaRoles = [];

    for (const itemRol of porRol) {
      const nombreRol = itemRol.rol || 'Sin rol';
      conteoEntradas += itemRol.totalEntradas;
      conteoVisitantesUnicos += itemRol.visitantesUnicos;
      conteoEnEdificioHoy += itemRol.enEdificioHoy;
      salidasPendientesAnteriores += itemRol.sinSalidaAnteriores;
      sumaMinutosPermanencia += itemRol.sumaMinutos;
      conteoVisitasCerradas += itemRol.visitasCerradas;

      if (itemRol.enEdificioHoy > 0) {
        resumenRolesDentro.push(`${itemRol.enEdificioHoy} ${nombreRol}`);
      }

      if (
        (nombreRol === 'Visitante' || nombreRol === 'Proveedor') &&
        itemRol.visitasCerradas > 0
      ) {
        promediosPorRolTexto.push(
          `${nombreRol}: ${formatearDuracionLegible(itemRol.sumaMinutos / itemRol.visitasCerradas)}`
        );
      }

      if (itemRol.totalEntradas > 0) {
        listaRoles.push({
          nombre: nombreRol,
          valor: itemRol.totalEntradas,
        });
      }
    }

    let textoDetalleEdificio =
      resumenRolesDentro.join(' · ') || 'Nadie dentro actualmente';
    if (salidasPendientesAnteriores > 0) {
      textoDetalleEdificio += ` (${salidasPendientesAnteriores} sin salida de días previos)`;
    }

    const promedioGeneralMinutos =
      conteoVisitasCerradas > 0 ? sumaMinutosPermanencia / conteoVisitasCerradas : null;

    const textoDetallePromedio =
      conteoVisitasCerradas === 0
        ? 'Sin salidas registradas aún'
        : promediosPorRolTexto.join(' · ') ||
          `Basado en ${conteoVisitasCerradas} salidas registradas`;

    const listaDias = porDia.map((itemDia) => ({
      dia: formatearFechaLegible(itemDia.fecha),
      cantidad: itemDia.cantidad,
    }));

    return {
      totalEntradasPeriodo: conteoEntradas,
      visitantesUnicosPeriodo: conteoVisitantesUnicos,
      personasEnEdificioHoy: conteoEnEdificioHoy,
      detalleEnEdificio: textoDetalleEdificio,
      tiempoPromedioVisita: formatearDuracionLegible(promedioGeneralMinutos),
      detalleTiempoPromedio: textoDetallePromedio,
      datosPorRol: listaRoles,
      datosPorHora: porHora,
      datosPorDia: listaDias,
    };
  }, [estadisticasServidor]);

  const esFiltroHoy = filtrosAplicados.periodo === 'hoy';
  const tituloEstadisticas = useMemo(() => {
    switch (filtrosAplicados.filtroRol) {
      case 'Empleado':
        return 'Estadísticas de empleados';
      case 'Proveedor':
        return 'Estadísticas de proveedores';
      case 'Visitante':
        return 'Estadísticas de visitantes';
      default:
        return 'Estadísticas de ingresos';
    }
  }, [filtrosAplicados.filtroRol]);

  const etiquetaPersonasUnicas = useMemo(() => {
    switch (filtrosAplicados.filtroRol) {
      case 'Empleado':
        return esFiltroHoy ? 'Empleados únicos hoy' : 'Empleados únicos';
      case 'Proveedor':
        return esFiltroHoy ? 'Proveedores únicos hoy' : 'Proveedores únicos';
      case 'Visitante':
        return esFiltroHoy ? 'Visitantes únicos hoy' : 'Visitantes únicos';
      default:
        return esFiltroHoy ? 'Personas únicas hoy' : 'Personas únicas';
    }
  }, [filtrosAplicados.filtroRol, esFiltroHoy]);

  const descripcionFiltroActivo = useMemo(() => {
    return ETIQUETAS_PERIODO[filtrosAplicados.periodo] || 'Hoy';
  }, [filtrosAplicados.periodo]);

  const manejarDescargarReportePdf = () => {
    const tituloAnterior = document.title;
    const rolSufijo =
      filtrosAplicados.filtroRol && filtrosAplicados.filtroRol !== 'todos'
        ? filtrosAplicados.filtroRol
        : 'General';
    document.title = `Reporte_Estadisticas_Lira_${rolSufijo}_${descripcionFiltroActivo.replace(/\s+/g, '_')}`;
    window.print();
    setTimeout(() => {
      document.title = tituloAnterior;
    }, 500);
  };

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <h1>Dashboard - Lira Seguridad</h1>
        <div className="header-actions">
          <span>Bienvenido, {usuario?.nombreUsuario}</span>
          <button
            type="button"
            onClick={() => navegar('/invitacion')}
            className="new-invitation-button"
          >
            + Nueva Invitación / QR
          </button>
          <button
            type="button"
            onClick={manejarSincronizarEmpleados}
            disabled={sincronizandoEmpleados}
            className="refresh-button"
            title="Traer empleados cargados con rostro en UniFi Access (/api/v1/developer/users/search)"
          >
            {sincronizandoEmpleados ? 'Sincronizando...' : 'Sincronizar Empleados UniFi'}
          </button>
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
          <button type="submit" className="apply-filters-button" disabled={cargando}>
            Aplicar Filtros
          </button>
          <button
            type="button"
            onClick={limpiarFiltros}
            className="clear-filters-button"
            disabled={cargando}
          >
            Limpiar
          </button>
        </div>
      </form>

      {pestanaActiva === 'listado' && (
        <main className="dashboard-content">
          {errorCarga && <div className="error-banner">{errorCarga}</div>}
          {mensajeSincronizacion && (
            <div className="success-banner">{mensajeSincronizacion}</div>
          )}

          {cargando && visitasPagina.length === 0 ? (
            <p>Cargando...</p>
          ) : (
            <>
              <div className="table-container">
                <table className="visits-table">
                  <thead>
                    <tr>
                      <th>Nombre completo</th>
                      <th>Cédula</th>
                      <th>EPS</th>
                      <th>ARL</th>
                      <th>Teléfono</th>
                      <th>Rol</th>
                      <th>Fecha</th>
                      <th>Entrada</th>
                      <th>Salida</th>
                      <th>Ver movimiento</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visitasPagina.length === 0 ? (
                      <tr>
                        <td colSpan="10" className="empty-cell">
                          No hay visitas para mostrar en el periodo seleccionado
                        </td>
                      </tr>
                    ) : (
                      visitasPagina.map((visita) => {
                        const esQrSinLlegada =
                          Boolean(visita.id_qr) && Number(visita.usos_actuales) === 0;
                        const haIngresado =
                          !esQrSinLlegada &&
                          Boolean(
                            visita.hora_ingreso && String(visita.hora_ingreso).trim() !== ''
                          );
                        const tieneSalida = Boolean(
                          visita.hora_salida && String(visita.hora_salida).trim() !== ''
                        );
                        const sigueEnEdificioHoy =
                          haIngresado &&
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
                            <td>
                              {String(visita.cedula || '').startsWith('UNIFI-')
                                ? 'N/A'
                                : visita.cedula}
                            </td>
                            <td>{visita.eps || 'N/A'}</td>
                            <td>{visita.arl || 'N/A'}</td>
                            <td>{visita.telefono || '-'}</td>
                            <td>{visita.rol}</td>
                            <td>{formatearFechaLegible(visita.fecha_ingreso)}</td>
                            <td>
                              {haIngresado ? (
                                <>
                                  {visita.hora_ingreso}
                                  {Number(visita.total_entradas) > 1 && (
                                    <span className="texto-pendiente" style={{ marginLeft: '0.35rem', fontWeight: 600 }}>
                                      ({visita.total_entradas} ent.)
                                    </span>
                                  )}
                                </>
                              ) : (
                                <span className="texto-pendiente">Sin ingresar aún</span>
                              )}
                            </td>
                            <td>
                              {tieneSalida ? (
                                <>
                                  {visita.hora_salida}
                                  {Number(visita.total_salidas) >= 1 && (
                                    <span className="texto-pendiente" style={{ marginLeft: '0.35rem', fontWeight: 600 }}>
                                      ({visita.total_salidas} sal.)
                                    </span>
                                  )}
                                  {Number(visita.total_entradas) > Number(visita.total_salidas) && (
                                    <span className="badge-en-edificio" style={{ marginLeft: '0.45rem' }}>
                                      Reingresó
                                    </span>
                                  )}
                                </>
                              ) : esQrSinLlegada ? (
                                visita.estado_qr === 'EXPIRADO' ? (
                                  <span className="badge-qr-expirado">QR Expirado (No llegó)</span>
                                ) : visita.estado_qr === 'REVOCADO' ? (
                                  <span className="badge-qr-expirado">QR Cancelado</span>
                                ) : (
                                  <span className="badge-esperando-llegada">
                                    Esperando llegada (QR)
                                  </span>
                                )
                              ) : sigueEnEdificioHoy ? (
                                <span className="badge-en-edificio">
                                  En el edificio
                                  {(Number(visita.total_entradas) > 1 ||
                                    Number(visita.total_salidas) > 0) &&
                                    ` (${visita.total_entradas || 1} ent. / ${visita.total_salidas || 0} sal.)`}
                                </span>
                              ) : (
                                <span className="texto-pendiente">Sin registrar</span>
                              )}
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <button
                                type="button"
                                className="eye-action-button"
                                title="Ver movimientos y detalle del registro"
                                aria-label="Ver movimientos"
                                onClick={() => setVisitaDetalleModal(visita)}
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  width="20"
                                  height="20"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                                  <circle cx="12" cy="12" r="3" />
                                </svg>
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              <div className="pagination-bar" aria-label="Paginación de ingresos">
                <span className="pagination-info">
                  {totalRegistros === 0
                    ? 'Mostrando 0 ingresos'
                    : `Mostrando ${indicePrimerRegistro}–${indiceUltimoRegistro} de ${totalRegistros} ingresos (${LIMITE_POR_PAGINA} por página)`}
                </span>

                <div className="pagination-controls">
                  <button
                    type="button"
                    onClick={irAPaginaAnterior}
                    disabled={paginaActual <= 1 || cargando}
                    className="pagination-button"
                  >
                    Anterior
                  </button>
                  <span className="pagination-page-indicator">
                    Página {paginaActual} de {totalPaginas}
                  </span>
                  <button
                    type="button"
                    onClick={irAPaginaSiguiente}
                    disabled={paginaActual >= totalPaginas || cargando}
                    className="pagination-button"
                  >
                    Siguiente
                  </button>
                </div>
              </div>
            </>
          )}

          {visitaDetalleModal && (
            <div
              className="modal-overlay"
              role="dialog"
              aria-modal="true"
              aria-labelledby="modal-detalle-titulo"
              onClick={() => setVisitaDetalleModal(null)}
            >
              <div
                className="modal-card"
                onClick={(evento) => evento.stopPropagation()}
              >
                <div className="modal-header">
                  <div>
                    <h3 id="modal-detalle-titulo" className="modal-title">
                      {visitaDetalleModal.rol === 'Empleado' ||
                      String(visitaDetalleModal.cedula || '').startsWith('UNIFI-')
                        ? 'Detalle de Movimientos'
                        : `Detalle de Ingreso — C.C. ${visitaDetalleModal.cedula}`}
                    </h3>
                    <p className="modal-subtitle">
                      {visitaDetalleModal.nombre_completo} ({visitaDetalleModal.rol})
                    </p>
                  </div>
                </div>

                <div className="modal-body">
                  <div className="modal-detail-item">
                    <span className="modal-detail-label">Motivo de la visita</span>
                    <p className="modal-detail-value">
                      {visitaDetalleModal.motivo || 'Sin motivo registrado'}
                    </p>
                  </div>

                  <div className="modal-detail-item">
                    <span className="modal-detail-label">
                      Veces de Entrada y Salida en este registro
                    </span>
                    <p className="modal-detail-value">
                      <strong>
                        {Boolean(visitaDetalleModal.id_qr) &&
                        Number(visitaDetalleModal.usos_actuales) === 0
                          ? 0
                          : Number(visitaDetalleModal.total_entradas) ||
                            (visitaDetalleModal.hora_ingreso ? 1 : 0)}{' '}
                        entrada(s)
                      </strong>{' '}
                      ·{' '}
                      <strong>
                        {Number(visitaDetalleModal.total_salidas) ||
                          (visitaDetalleModal.hora_salida ? 1 : 0)}{' '}
                        salida(s)
                      </strong>
                    </p>
                    {(() => {
                      try {
                        const listaMovs = JSON.parse(
                          visitaDetalleModal.movimientos_json || '[]'
                        );
                        if (Array.isArray(listaMovs) && listaMovs.length > 0) {
                          return (
                            <ul
                              style={{
                                margin: '0.5rem 0 0 0',
                                paddingLeft: '1.1rem',
                                fontSize: '0.84rem',
                                color: '#4a5568',
                              }}
                            >
                              {listaMovs.map((m, idx) => (
                                <li key={`${m.tipo}-${m.hora}-${idx}`}>
                                  <strong>{m.tipo}:</strong> {m.hora}
                                  {m.puerta ? ` (${m.puerta})` : ''}
                                  {m.detalle ? ` — ${m.detalle}` : ''}
                                </li>
                              ))}
                            </ul>
                          );
                        }
                      } catch {
                        // Sin movimientos JSON
                      }
                      return null;
                    })()}
                  </div>

                  {visitaDetalleModal.rol !== 'Empleado' && Boolean(visitaDetalleModal.id_qr) && (
                    <>
                      <div className="modal-detail-item">
                        <span className="modal-detail-label">Accesos del QR</span>
                        <p className="modal-detail-value">
                          {formatearAccesosVisita(visitaDetalleModal)}
                        </p>
                      </div>

                      <div className="modal-detail-item">
                        <span className="modal-detail-label">Tiempo de vida del QR</span>
                        <p className="modal-detail-value">
                          {formatearTiempoVidaVisita(visitaDetalleModal)}
                        </p>
                      </div>
                    </>
                  )}

                  <div className="modal-detail-grid">
                    <div>
                      <span className="modal-detail-label">Fecha de ingreso</span>
                      <p className="modal-detail-value">
                        {formatearFechaLegible(visitaDetalleModal.fecha_ingreso)}
                      </p>
                    </div>
                    <div>
                      <span className="modal-detail-label">Hora entrada / salida</span>
                      <p className="modal-detail-value">
                        {Boolean(visitaDetalleModal.id_qr) &&
                        Number(visitaDetalleModal.usos_actuales) === 0
                          ? 'Pendiente de lectura del QR en cámara UniFi'
                          : `${visitaDetalleModal.hora_ingreso || '--'} — ${
                              visitaDetalleModal.hora_salida || 'En el edificio / Sin salida'
                            }`}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="modal-footer" style={{ gap: '0.75rem' }}>
                  {Boolean(visitaDetalleModal.id_qr) &&
                    visitaDetalleModal.estado_qr === 'ACTIVO' && (
                      <button
                        type="button"
                        className="logout-button"
                        disabled={revocandoQr}
                        onClick={manejarCancelarInvitacionModal}
                      >
                        {revocandoQr ? 'Cancelando QR...' : 'Cancelar Invitación QR'}
                      </button>
                    )}
                  <button
                    type="button"
                    className="apply-filters-button"
                    onClick={() => setVisitaDetalleModal(null)}
                  >
                    Cerrar
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>
      )}

      {pestanaActiva === 'estadisticas' && (
        <main className="dashboard-content">
          {errorCarga && <div className="error-banner">{errorCarga}</div>}

          <div className="print-report-header">
            <img src={logoLira} alt="Lira Seguridad" className="print-report-logo" />
            <div className="print-report-meta">
              <h1>
                {tituloEstadisticas} ({descripcionFiltroActivo})
              </h1>
              <p>
                <strong>Lira Seguridad</strong> · Generado por:{' '}
                {usuario?.nombreUsuario || 'Administrador'} · Fecha:{' '}
                {ultimaActualizacion
                  ? `${ultimaActualizacion.toLocaleDateString('es-CO')} ${ultimaActualizacion.toLocaleTimeString('es-CO')}`
                  : ''}
              </p>
            </div>
          </div>

          <div className="stats-header">
            <div>
              <h2 className="stats-title">
                {tituloEstadisticas} ({descripcionFiltroActivo})
              </h2>
              <p className="stats-subtitle">
                {ultimaActualizacion
                  ? `Última actualización: ${ultimaActualizacion.toLocaleTimeString('es-CO')} — Se actualiza automáticamente cada 5 minutos`
                  : 'Cargando datos...'}
              </p>
            </div>
            <button
              type="button"
              onClick={manejarDescargarReportePdf}
              className="apply-filters-button no-print"
            >
              Descargar Reporte PDF
            </button>
          </div>

          <div className="kpi-grid">
            <div className="kpi-card">
              <p className="kpi-label">{esFiltroHoy ? 'Entradas hoy' : 'Entradas en el periodo'}</p>
              <p className="kpi-value">{totalEntradasPeriodo}</p>
            </div>
            <div className="kpi-card kpi-card--green">
              <p className="kpi-label">{etiquetaPersonasUnicas}</p>
              <p className="kpi-value">{visitantesUnicosPeriodo}</p>
            </div>
            <div className="kpi-card kpi-card--orange">
              <p className="kpi-label">Actualmente en el edificio</p>
              <p className="kpi-value">{personasEnEdificioHoy}</p>
              <p className="kpi-detail">{detalleEnEdificio}</p>
            </div>
            <div className="kpi-card kpi-card--purple">
              <p className="kpi-label">
                {filtrosAplicados.filtroRol === 'Empleado'
                  ? 'Tiempo promedio de permanencia'
                  : 'Tiempo promedio de visita'}
              </p>
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
