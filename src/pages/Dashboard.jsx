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

// Bandera para mostrar u ocultar temporalmente el botón "+ Nueva Invitación / QR"
// Para reactivarlo: definir VITE_MOSTRAR_INVITACION_QR=true o cambiar 'false' por 'true'
const MOSTRAR_NUEVA_INVITACION_QR =
  String(import.meta.env.VITE_MOSTRAR_INVITACION_QR || 'false').toLowerCase() === 'true';

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

/**
 * Determina si la persona se encuentra actualmente dentro del edificio:
 * 1) Si el registro tiene `movimientos_json`, el estado real lo define el ÚLTIMO movimiento:
 *    - 'ENTRADA' o 'ACCESO_INTERNO' -> En el edificio
 *    - 'SALIDA' -> Por fuera
 * 2) Si no hay `movimientos_json`, usa como respaldo los contadores y `hora_salida`.
 */
const determinarEstaEnEdificio = (visita) => {
  if (!visita) return false;
  const esQrSinLlegada = Boolean(visita.id_qr) && Number(visita.usos_actuales) === 0;
  if (esQrSinLlegada) return false;

  try {
    const movs = JSON.parse(visita.movimientos_json || '[]');
    if (Array.isArray(movs) && movs.length > 0) {
      const ultimo = movs[movs.length - 1];
      if (ultimo && ultimo.tipo) {
        return ultimo.tipo === 'ENTRADA' || ultimo.tipo === 'ACCESO_INTERNO';
      }
    }
  } catch {
    // Respaldo a columnas si movimientos_json no es válido
  }

  const haIngresado = Boolean(
    visita.hora_ingreso && String(visita.hora_ingreso).trim() !== ''
  );
  if (!haIngresado) return false;

  const tieneSalida = Boolean(
    visita.hora_salida && String(visita.hora_salida).trim() !== ''
  );
  const entradasContadas = Number(visita.total_entradas) || 1;
  const salidasContadas = Number(visita.total_salidas) || (tieneSalida ? 1 : 0);

  return entradasContadas > salidasContadas || !tieneSalida;
};

const horaTextoAMinutos = (horaTexto) => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(horaTexto || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const seg = Number(m[3] || 0);
  if (h < 0 || h > 23 || min < 0 || min > 59 || seg < 0 || seg > 59) return null;
  return h * 60 + min + seg / 60;
};

const esRegistroConIngresoEfectivo = (visita) => {
  if (!visita) return false;
  const esQrSinLlegada = Boolean(visita.id_qr) && Number(visita.usos_actuales) === 0;
  if (esQrSinLlegada) return false;
  return Boolean(visita.hora_ingreso && String(visita.hora_ingreso).trim() !== '');
};

/**
 * Devuelve el badge de estado que corresponde mostrar según el último movimiento
 * y si el registro pertenece al día de hoy o a un día anterior:
 * - Hoy + abierto -> "En el edificio" (verde)
 * - Día anterior + abierto -> "Sin salida" (amarillo/naranja)
 * - Cerrado con salida (o sin ingreso) -> "Por fuera" (gris)
 */
const obtenerEstadoVisita = (visita, hoyClave) => {
  const abierto = determinarEstaEnEdificio(visita);
  if (!abierto) {
    return { tipo: 'fuera', texto: 'Por fuera', clase: 'badge-estado-fuera' };
  }

  const fechaRegistro = String(visita?.fecha_ingreso || '').slice(0, 10);
  if (hoyClave && fechaRegistro && fechaRegistro < hoyClave) {
    return { tipo: 'sin_salida', texto: 'Sin salida', clase: 'badge-estado-sin-salida' };
  }

  return { tipo: 'edificio', texto: 'En el edificio', clase: 'badge-estado-edificio' };
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
  const [kpiModalActivo, setKpiModalActivo] = useState(null);
  const [registrosKpiModal, setRegistrosKpiModal] = useState([]);
  const [cargandoKpiModal, setCargandoKpiModal] = useState(false);
  const [busquedaKpiModal, setBusquedaKpiModal] = useState('');
  const [fechaReferenciaKpi, setFechaReferenciaKpi] = useState(null);
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

  const abrirModalKpi = async (tipoKpi) => {
    setKpiModalActivo(tipoKpi);
    setBusquedaKpiModal('');
    setFechaReferenciaKpi(new Date());

    // Si todos los registros del filtro ya están en la página 1, los reutilizamos sin otra petición
    if (paginaActual === 1 && totalRegistros <= visitasPagina.length) {
      setRegistrosKpiModal(visitasPagina);
      setCargandoKpiModal(false);
      return;
    }

    setCargandoKpiModal(true);
    try {
      const parametrosBase = construirParametrosFiltroServidor(filtrosAplicados);
      const respuesta = await obtenerVisitas({
        ...parametrosBase,
        limite: 1000,
        desplazamiento: 0,
      });
      const lista = Array.isArray(respuesta)
        ? respuesta
        : Array.isArray(respuesta?.registros)
          ? respuesta.registros
          : [];
      setRegistrosKpiModal(lista);
    } catch (errorModalKpi) {
      console.error('Error al cargar detalle de KPI:', errorModalKpi);
      setRegistrosKpiModal(visitasPagina);
    } finally {
      setCargandoKpiModal(false);
    }
  };

  const datosModalKpi = useMemo(() => {
    if (!kpiModalActivo) return { titulo: '', subtitulo: '', filas: [] };

    const termino = busquedaKpiModal.trim().toLowerCase();
    const coincideBusqueda = (nombre, cedula, rol) => {
      if (!termino) return true;
      return (
        String(nombre || '').toLowerCase().includes(termino) ||
        String(cedula || '').toLowerCase().includes(termino) ||
        String(rol || '').toLowerCase().includes(termino)
      );
    };

    const conIngreso = registrosKpiModal.filter(esRegistroConIngresoEfectivo);
    const referenciaFecha = fechaReferenciaKpi || ultimaActualizacion;
    const hoyClaveModal = referenciaFecha ? obtenerClaveDia(referenciaFecha) : '';

    if (kpiModalActivo === 'entradas') {
      const filas = conIngreso
        .filter((v) => coincideBusqueda(v.nombre_completo, v.cedula, v.rol))
        .map((v) => ({
          clave: v.id_registro ?? `${v.cedula}-${v.fecha_ingreso}-${v.hora_ingreso}`,
          visita: v,
          estadoBadge: obtenerEstadoVisita(v, hoyClaveModal),
        }));

      return {
        titulo: filtrosAplicados.periodo === 'hoy' ? 'Entradas de hoy' : 'Entradas en el periodo',
        subtitulo: `${filas.length} registro(s) con ingreso efectivo`,
        filas,
      };
    }

    if (kpiModalActivo === 'unicas') {
      const mapaPersonas = new Map();
      for (const v of conIngreso) {
        const clavePersona = String(v.cedula || v.nombre_completo);
        const entradasReg = Number(v.total_entradas) || 1;
        const salidasReg = Number(v.total_salidas) || (v.hora_salida ? 1 : 0);

        if (!mapaPersonas.has(clavePersona)) {
          mapaPersonas.set(clavePersona, {
            clave: clavePersona,
            nombre_completo: v.nombre_completo,
            cedula: v.cedula,
            rol: v.rol,
            dias: 1,
            totalEntradas: entradasReg,
            totalSalidas: salidasReg,
            visitaMasReciente: v,
            estadoBadge: obtenerEstadoVisita(v, hoyClaveModal),
          });
        } else {
          const actual = mapaPersonas.get(clavePersona);
          actual.dias += 1;
          actual.totalEntradas += entradasReg;
          actual.totalSalidas += salidasReg;
        }
      }

      const filas = Array.from(mapaPersonas.values())
        .filter((p) => coincideBusqueda(p.nombre_completo, p.cedula, p.rol))
        .sort((a, b) => b.totalEntradas - a.totalEntradas);

      return {
        titulo:
          filtrosAplicados.filtroRol === 'Empleado'
            ? 'Empleados únicos en el periodo'
            : 'Personas únicas en el periodo',
        subtitulo: `${filas.length} persona(s) diferente(s)`,
        filas,
      };
    }

    if (kpiModalActivo === 'enEdificio') {
      const referencia = fechaReferenciaKpi || ultimaActualizacion;
      const hoyClave = referencia ? obtenerClaveDia(referencia) : '';
      const minutosAhora = referencia
        ? referencia.getHours() * 60 + referencia.getMinutes()
        : null;

      const filas = conIngreso
        .filter((v) => {
          const fechaClave = String(v.fecha_ingreso || '').slice(0, 10);
          return (!hoyClave || fechaClave === hoyClave) && determinarEstaEnEdificio(v);
        })
        .filter((v) => coincideBusqueda(v.nombre_completo, v.cedula, v.rol))
        .map((v) => {
          const minIngreso = horaTextoAMinutos(v.hora_ingreso);
          const minutosDentro =
            minutosAhora !== null && minIngreso !== null && minutosAhora >= minIngreso
              ? Math.round(minutosAhora - minIngreso)
              : null;
          return {
            clave: v.id_registro ?? `${v.cedula}-${v.hora_ingreso}`,
            visita: v,
            minutosDentro,
          };
        });

      return {
        titulo: 'Actualmente en el edificio',
        subtitulo: `${filas.length} persona(s) dentro en este momento (hoy)`,
        filas,
      };
    }

    if (kpiModalActivo === 'porFuera') {
      const referencia = fechaReferenciaKpi || ultimaActualizacion;
      const hoyClave = referencia ? obtenerClaveDia(referencia) : '';

      const filas = conIngreso
        .filter((v) => {
          const fechaClave = String(v.fecha_ingreso || '').slice(0, 10);
          return (!hoyClave || fechaClave === hoyClave) && !determinarEstaEnEdificio(v);
        })
        .filter((v) => coincideBusqueda(v.nombre_completo, v.cedula, v.rol))
        .map((v) => ({
          clave: v.id_registro ?? `${v.cedula}-${v.hora_ingreso}`,
          visita: v,
        }));

      return {
        titulo: 'Por fuera hoy',
        subtitulo: `${filas.length} persona(s) que ingresaron hoy y ya salieron`,
        filas,
      };
    }

    // 'tiempoPromedio'
    const filas = conIngreso
      .map((v) => {
        const minIn = horaTextoAMinutos(v.hora_ingreso);
        const minOut = horaTextoAMinutos(v.hora_salida);
        if (minIn === null || minOut === null || minOut < minIn) return null;
        return {
          clave: v.id_registro ?? `${v.cedula}-${v.fecha_ingreso}-${v.hora_ingreso}`,
          visita: v,
          duracionMinutos: Math.round(minOut - minIn),
        };
      })
      .filter(Boolean)
      .filter((item) =>
        coincideBusqueda(item.visita.nombre_completo, item.visita.cedula, item.visita.rol)
      )
      .sort((a, b) => b.duracionMinutos - a.duracionMinutos);

    return {
      titulo:
        filtrosAplicados.filtroRol === 'Empleado'
          ? 'Permanencia por persona (mayor a menor)'
          : 'Duración de visitas cerradas (mayor a menor)',
      subtitulo: `${filas.length} registro(s) con entrada y salida`,
      filas,
    };
  }, [
    kpiModalActivo,
    registrosKpiModal,
    busquedaKpiModal,
    filtrosAplicados,
    fechaReferenciaKpi,
    ultimaActualizacion,
  ]);

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
    personasPorFueraHoy,
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
        personasPorFueraHoy: 0,
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
    let conteoPorFueraHoy = 0;
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
      conteoPorFueraHoy += Number(itemRol.porFueraHoy) || 0;
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
      personasPorFueraHoy: conteoPorFueraHoy,
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
          {MOSTRAR_NUEVA_INVITACION_QR && (
            <button
              type="button"
              onClick={() => navegar('/invitacion')}
              className="new-invitation-button"
            >
              + Nueva Invitación / QR
            </button>
          )}
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
                      {filtrosAplicados.filtroRol !== 'Empleado' && (
                        <>
                          <th>Cédula</th>
                          <th>EPS</th>
                          <th>ARL</th>
                        </>
                      )}
                      <th>Teléfono</th>
                      <th>Rol</th>
                      <th>Estado</th>
                      <th>Ver movimiento</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visitasPagina.length === 0 ? (
                      <tr>
                        <td
                          colSpan={filtrosAplicados.filtroRol !== 'Empleado' ? 8 : 5}
                          className="empty-cell"
                        >
                          No hay visitas para mostrar en el periodo seleccionado
                        </td>
                      </tr>
                    ) : (
                      visitasPagina.map((visita) => {
                        const hoyClave = ultimaActualizacion
                          ? obtenerClaveDia(ultimaActualizacion)
                          : '';
                        const estadoBadge = obtenerEstadoVisita(visita, hoyClave);
                        const mostrarColumnasVisitante =
                          filtrosAplicados.filtroRol !== 'Empleado';

                        return (
                          <tr
                            key={
                              visita.id_registro ??
                              `${visita.cedula}-${visita.fecha_ingreso}-${visita.hora_ingreso}`
                            }
                          >
                            <td>{visita.nombre_completo}</td>
                            {mostrarColumnasVisitante && (
                              <>
                                <td>
                                  {String(visita.cedula || '').startsWith('UNIFI-')
                                    ? 'N/A'
                                    : visita.cedula}
                                </td>
                                <td>{visita.eps || 'N/A'}</td>
                                <td>{visita.arl || 'N/A'}</td>
                              </>
                            )}
                            <td>{visita.telefono || '-'}</td>
                            <td>{visita.rol}</td>
                            <td>
                              <span className={estadoBadge.clase}>{estadoBadge.texto}</span>
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
        </main>
      )}

      {visitaDetalleModal && (
        <div
          className="modal-overlay"
          style={{ zIndex: 1100 }}
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
                  {(() => {
                    const esQrSinLlegadaModal =
                      Boolean(visitaDetalleModal.id_qr) &&
                      Number(visitaDetalleModal.usos_actuales) === 0;
                    const tieneSalidaModal = Boolean(
                      visitaDetalleModal.hora_salida &&
                        String(visitaDetalleModal.hora_salida).trim() !== ''
                    );
                    const hoyClaveDetalle = ultimaActualizacion
                      ? obtenerClaveDia(ultimaActualizacion)
                      : '';
                    const estadoModal = obtenerEstadoVisita(visitaDetalleModal, hoyClaveDetalle);

                    return (
                      <div className="modal-detail-grid">
                        <div>
                          <span className="modal-detail-label">Estado actual</span>
                          <p className="modal-detail-value" style={{ marginTop: '0.25rem' }}>
                            <span className={estadoModal.clase}>{estadoModal.texto}</span>
                          </p>
                        </div>
                        <div>
                          <span className="modal-detail-label">Fecha del registro</span>
                          <p className="modal-detail-value">
                            {formatearFechaLegible(visitaDetalleModal.fecha_ingreso)}
                          </p>
                        </div>
                        <div>
                          <span className="modal-detail-label">Primera entrada</span>
                          <p className="modal-detail-value">
                            {esQrSinLlegadaModal
                              ? 'Sin ingresar aún'
                              : visitaDetalleModal.hora_ingreso || 'Sin registrar'}
                          </p>
                        </div>
                        <div>
                          <span className="modal-detail-label">Última salida</span>
                          <p className="modal-detail-value">
                            {tieneSalidaModal
                              ? visitaDetalleModal.hora_salida
                              : estadoModal.tipo === 'edificio'
                                ? 'En el edificio (sin salida)'
                                : 'Sin salida registrada'}
                          </p>
                        </div>
                      </div>
                    );
                  })()}

                  <div className="modal-detail-item">
                    <span className="modal-detail-label">Motivo de la visita</span>
                    <p className="modal-detail-value">
                      {visitaDetalleModal.motivo || 'Sin motivo registrado'}
                    </p>
                  </div>

                  <div className="modal-detail-item">
                    <span className="modal-detail-label">
                      Historial de Movimientos ({formatearFechaLegible(visitaDetalleModal.fecha_ingreso)})
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
                                  <strong>{m.tipo}:</strong>{' '}
                                  {formatearFechaLegible(visitaDetalleModal.fecha_ingreso)} a las{' '}
                                  {m.hora}
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
            <button
              type="button"
              className="kpi-card kpi-card--clickable"
              onClick={() => abrirModalKpi('entradas')}
            >
              <p className="kpi-label">{esFiltroHoy ? 'Ingresos hoy' : 'Entradas en el periodo'}</p>
              <p className="kpi-value">{totalEntradasPeriodo}</p>
              <span className="kpi-cta no-print">Ver detalle →</span>
            </button>
            {esFiltroHoy ? (
              <button
                type="button"
                className="kpi-card kpi-card--green kpi-card--clickable"
                onClick={() => abrirModalKpi('porFuera')}
              >
                <p className="kpi-label">Por fuera hoy</p>
                <p className="kpi-value">{personasPorFueraHoy}</p>
                <p className="kpi-detail">Ingresaron hoy y ya salieron</p>
                <span className="kpi-cta no-print">Ver quién salió →</span>
              </button>
            ) : (
              <button
                type="button"
                className="kpi-card kpi-card--green kpi-card--clickable"
                onClick={() => abrirModalKpi('unicas')}
              >
                <p className="kpi-label">{etiquetaPersonasUnicas}</p>
                <p className="kpi-value">{visitantesUnicosPeriodo}</p>
                <span className="kpi-cta no-print">Ver detalle →</span>
              </button>
            )}
            <button
              type="button"
              className="kpi-card kpi-card--orange kpi-card--clickable"
              onClick={() => abrirModalKpi('enEdificio')}
            >
              <p className="kpi-label">Actualmente en el edificio</p>
              <p className="kpi-value">{personasEnEdificioHoy}</p>
              <p className="kpi-detail">{detalleEnEdificio}</p>
              <span className="kpi-cta no-print">Ver quién está adentro →</span>
            </button>
            <button
              type="button"
              className="kpi-card kpi-card--purple kpi-card--clickable"
              onClick={() => abrirModalKpi('tiempoPromedio')}
            >
              <p className="kpi-label">
                {filtrosAplicados.filtroRol === 'Empleado'
                  ? 'Tiempo promedio de permanencia'
                  : 'Tiempo promedio de visita'}
              </p>
              <p className="kpi-value">{tiempoPromedioVisita}</p>
              <p className="kpi-detail">{detalleTiempoPromedio}</p>
              <span className="kpi-cta no-print">Ver desglose →</span>
            </button>
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

      {kpiModalActivo && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-kpi-titulo"
          onClick={() => setKpiModalActivo(null)}
        >
          <div
            className="modal-card modal-card--wide"
            onClick={(evento) => evento.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <h3 id="modal-kpi-titulo" className="modal-title">
                  {datosModalKpi.titulo}
                </h3>
                <p className="modal-subtitle">
                  {datosModalKpi.subtitulo} · {descripcionFiltroActivo}
                </p>
              </div>
            </div>

            <div className="modal-body">
              <input
                type="text"
                className="kpi-modal-search"
                placeholder="Buscar por nombre, cédula o rol dentro de esta lista..."
                value={busquedaKpiModal}
                onChange={(e) => setBusquedaKpiModal(e.target.value)}
              />

              {cargandoKpiModal ? (
                <p className="chart-empty">Cargando registros del periodo...</p>
              ) : datosModalKpi.filas.length === 0 ? (
                <p className="chart-empty">No hay registros para mostrar en este detalle.</p>
              ) : (
                <div className="kpi-modal-table-wrapper">
                  <table className="kpi-modal-table">
                    <thead>
                      {kpiModalActivo === 'entradas' && (
                        <tr>
                          <th>Nombre</th>
                          <th>Rol</th>
                          <th>Fecha / Entrada</th>
                          <th>Estado</th>
                          <th style={{ textAlign: 'center' }}>Ver</th>
                        </tr>
                      )}
                      {kpiModalActivo === 'unicas' && (
                        <tr>
                          <th>Nombre</th>
                          <th>Rol</th>
                          <th>Días</th>
                          <th>Ent. / Sal.</th>
                          <th>Estado</th>
                          <th style={{ textAlign: 'center' }}>Ver</th>
                        </tr>
                      )}
                      {kpiModalActivo === 'enEdificio' && (
                        <tr>
                          <th>Nombre</th>
                          <th>Rol</th>
                          <th>Hora entrada</th>
                          <th>Tiempo adentro</th>
                          <th style={{ textAlign: 'center' }}>Ver</th>
                        </tr>
                      )}
                      {kpiModalActivo === 'porFuera' && (
                        <tr>
                          <th>Nombre</th>
                          <th>Rol</th>
                          <th>Primera entrada</th>
                          <th>Última salida</th>
                          <th style={{ textAlign: 'center' }}>Ver</th>
                        </tr>
                      )}
                      {kpiModalActivo === 'tiempoPromedio' && (
                        <tr>
                          <th>Nombre</th>
                          <th>Rol</th>
                          <th>Fecha</th>
                          <th>Entrada → Salida</th>
                          <th>Duración</th>
                          <th style={{ textAlign: 'center' }}>Ver</th>
                        </tr>
                      )}
                    </thead>
                    <tbody>
                      {kpiModalActivo === 'entradas' &&
                        datosModalKpi.filas.map((item) => (
                          <tr key={item.clave}>
                            <td>{item.visita.nombre_completo}</td>
                            <td>{item.visita.rol}</td>
                            <td>
                              {formatearFechaLegible(item.visita.fecha_ingreso)} ·{' '}
                              {item.visita.hora_ingreso}
                            </td>
                            <td>
                              <span className={item.estadoBadge.clase}>
                                {item.estadoBadge.texto}
                              </span>
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <button
                                type="button"
                                className="eye-action-button"
                                title="Ver movimientos"
                                aria-label="Ver movimientos"
                                onClick={() => setVisitaDetalleModal(item.visita)}
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  width="18"
                                  height="18"
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
                        ))}

                      {kpiModalActivo === 'unicas' &&
                        datosModalKpi.filas.map((item) => (
                          <tr key={item.clave}>
                            <td>{item.nombre_completo}</td>
                            <td>{item.rol}</td>
                            <td>{item.dias}</td>
                            <td>
                              {item.totalEntradas} ent. / {item.totalSalidas} sal.
                            </td>
                            <td>
                              <span className={item.estadoBadge.clase}>
                                {item.estadoBadge.texto}
                              </span>
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <button
                                type="button"
                                className="eye-action-button"
                                title="Ver último movimiento"
                                aria-label="Ver último movimiento"
                                onClick={() => setVisitaDetalleModal(item.visitaMasReciente)}
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  width="18"
                                  height="18"
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
                        ))}

                      {kpiModalActivo === 'enEdificio' &&
                        datosModalKpi.filas.map((item) => (
                          <tr key={item.clave}>
                            <td>{item.visita.nombre_completo}</td>
                            <td>{item.visita.rol}</td>
                            <td>{item.visita.hora_ingreso}</td>
                            <td>
                              {item.minutosDentro !== null
                                ? formatearDuracionLegible(item.minutosDentro)
                                : '-'}
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <button
                                type="button"
                                className="eye-action-button"
                                title="Ver movimientos"
                                aria-label="Ver movimientos"
                                onClick={() => setVisitaDetalleModal(item.visita)}
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  width="18"
                                  height="18"
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
                        ))}

                      {kpiModalActivo === 'porFuera' &&
                        datosModalKpi.filas.map((item) => (
                          <tr key={item.clave}>
                            <td>{item.visita.nombre_completo}</td>
                            <td>{item.visita.rol}</td>
                            <td>{item.visita.hora_ingreso || '-'}</td>
                            <td>{item.visita.hora_salida || '-'}</td>
                            <td style={{ textAlign: 'center' }}>
                              <button
                                type="button"
                                className="eye-action-button"
                                title="Ver movimientos"
                                aria-label="Ver movimientos"
                                onClick={() => setVisitaDetalleModal(item.visita)}
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  width="18"
                                  height="18"
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
                        ))}

                      {kpiModalActivo === 'tiempoPromedio' &&
                        datosModalKpi.filas.map((item) => (
                          <tr key={item.clave}>
                            <td>{item.visita.nombre_completo}</td>
                            <td>{item.visita.rol}</td>
                            <td>{formatearFechaLegible(item.visita.fecha_ingreso)}</td>
                            <td>
                              {item.visita.hora_ingreso} → {item.visita.hora_salida}
                            </td>
                            <td>
                              <strong>{formatearDuracionLegible(item.duracionMinutos)}</strong>
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <button
                                type="button"
                                className="eye-action-button"
                                title="Ver movimientos"
                                aria-label="Ver movimientos"
                                onClick={() => setVisitaDetalleModal(item.visita)}
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  width="18"
                                  height="18"
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
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="apply-filters-button"
                onClick={() => setKpiModalActivo(null)}
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
