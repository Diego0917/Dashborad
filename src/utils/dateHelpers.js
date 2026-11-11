import {
  startOfDay,
  endOfDay,
  subDays,
  startOfWeek,
  endOfWeek,
  subWeeks,
  startOfMonth,
  endOfMonth,
  parseISO,
  isValid,
  format,
  isSameDay,
} from 'date-fns';

/**
 * Parsea de forma segura una fecha (Date, 'YYYY-MM-DD' o ISO string)
 * respetando la zona horaria local y evitando el desfase UTC en cadenas 'YYYY-MM-DD'.
 */
export const parsearFechaLocal = (valorFecha) => {
  if (!valorFecha) return null;

  if (valorFecha instanceof Date) {
    return isValid(valorFecha) ? valorFecha : null;
  }

  if (typeof valorFecha === 'string') {
    const fechaParseada = parseISO(valorFecha.trim());
    return isValid(fechaParseada) ? fechaParseada : null;
  }

  const fechaGenerica = new Date(valorFecha);
  return isValid(fechaGenerica) ? fechaGenerica : null;
};

/**
 * Formatea una fecha a 'dd/MM/yyyy' para mostrar en tablas y gráficas.
 */
export const formatearFechaLegible = (valorFecha) => {
  const fecha = parsearFechaLocal(valorFecha);
  return fecha ? format(fecha, 'dd/MM/yyyy') : '-';
};

/**
 * Formatea una fecha a 'yyyy-MM-dd' para ordenar cronológicamente por día.
 */
export const obtenerClaveDia = (valorFecha) => {
  const fecha = parsearFechaLocal(valorFecha);
  return fecha ? format(fecha, 'yyyy-MM-dd') : null;
};

/**
 * Comprueba si una fecha corresponde al mismo día local que la fecha de referencia.
 */
export const esMismoDia = (valorFecha, fechaReferencia) => {
  const fecha = parsearFechaLocal(valorFecha);
  const referencia = parsearFechaLocal(fechaReferencia);
  if (!fecha || !referencia) return false;
  return isSameDay(fecha, referencia);
};

export const obtenerRangoFechas = (
  periodo,
  fechaInicioPersonalizada = null,
  fechaFinPersonalizada = null,
  fechaBase = null
) => {
  const hoy = parsearFechaLocal(fechaBase) || new Date();

  switch (periodo) {
    case 'hoy':
      return {
        inicio: startOfDay(hoy),
        fin: endOfDay(hoy),
      };
    case 'ayer': {
      const ayer = subDays(hoy, 1);
      return {
        inicio: startOfDay(ayer),
        fin: endOfDay(ayer),
      };
    }
    case 'anteayer': {
      const anteayer = subDays(hoy, 2);
      return {
        inicio: startOfDay(anteayer),
        fin: endOfDay(anteayer),
      };
    }
    case '7dias': {
      const haceSieteDias = subDays(hoy, 6);
      return {
        inicio: startOfDay(haceSieteDias),
        fin: endOfDay(hoy),
      };
    }
    case 'semana': {
      return {
        inicio: startOfWeek(hoy, { weekStartsOn: 1 }),
        fin: endOfWeek(hoy, { weekStartsOn: 1 }),
      };
    }
    case 'semanapasada': {
      const semanaPasada = subWeeks(hoy, 1);
      return {
        inicio: startOfWeek(semanaPasada, { weekStartsOn: 1 }),
        fin: endOfWeek(semanaPasada, { weekStartsOn: 1 }),
      };
    }
    case '30dias': {
      const haceTreintaDias = subDays(hoy, 29);
      return {
        inicio: startOfDay(haceTreintaDias),
        fin: endOfDay(hoy),
      };
    }
    case 'mes': {
      return {
        inicio: startOfMonth(hoy),
        fin: endOfMonth(hoy),
      };
    }
    case 'personalizado': {
      const inicioParseado = parsearFechaLocal(fechaInicioPersonalizada);
      const finParseado = parsearFechaLocal(fechaFinPersonalizada);

      if (inicioParseado && finParseado) {
        const [fechaMenor, fechaMayor] =
          inicioParseado <= finParseado
            ? [inicioParseado, finParseado]
            : [finParseado, inicioParseado];

        return {
          inicio: startOfDay(fechaMenor),
          fin: endOfDay(fechaMayor),
        };
      }
      if (inicioParseado) {
        return {
          inicio: startOfDay(inicioParseado),
          fin: endOfDay(hoy),
        };
      }
      return {
        inicio: startOfDay(hoy),
        fin: endOfDay(hoy),
      };
    }
    default:
      return {
        inicio: startOfDay(hoy),
        fin: endOfDay(hoy),
      };
  }
};

export const formatearFechaParaAPI = (fecha) => {
  const fechaValida = parsearFechaLocal(fecha);
  return fechaValida ? format(fechaValida, 'yyyy-MM-dd') : '';
};

/**
 * Convierte una cadena de hora ('HH:MM' o 'HH:MM:SS') al total de segundos desde medianoche.
 */
export const convertirHoraASegundos = (cadenaHora) => {
  if (!cadenaHora || typeof cadenaHora !== 'string') return null;
  const partes = cadenaHora.trim().split(':');
  if (partes.length < 2) return null;

  const horas = Number(partes[0]);
  const minutos = Number(partes[1]);
  const segundos = partes[2] ? Number(partes[2]) : 0;

  if (
    Number.isNaN(horas) ||
    Number.isNaN(minutos) ||
    Number.isNaN(segundos) ||
    horas < 0 ||
    horas > 23 ||
    minutos < 0 ||
    minutos > 59 ||
    segundos < 0 ||
    segundos > 59
  ) {
    return null;
  }

  return horas * 3600 + minutos * 60 + segundos;
};

/**
 * Calcula la duración en minutos entre hora_ingreso y hora_salida.
 * Devuelve null si falta alguna hora o si la salida es anterior al ingreso.
 */
export const calcularDuracionMinutos = (horaIngreso, horaSalida) => {
  const segundosIngreso = convertirHoraASegundos(horaIngreso);
  const segundosSalida = convertirHoraASegundos(horaSalida);

  if (segundosIngreso === null || segundosSalida === null) return null;
  if (segundosSalida < segundosIngreso) return null;

  return (segundosSalida - segundosIngreso) / 60;
};

/**
 * Formatea una cantidad de minutos a un texto legible (ej. '45 min' o '1h 25m').
 */
export const formatearDuracionLegible = (minutosTotales) => {
  if (minutosTotales === null || minutosTotales === undefined || Number.isNaN(minutosTotales)) {
    return '--';
  }

  const minutosRedondeados = Math.round(minutosTotales);
  if (minutosRedondeados < 1) {
    return '< 1 min';
  }
  if (minutosRedondeados < 60) {
    return `${minutosRedondeados} min`;
  }

  const horas = Math.floor(minutosRedondeados / 60);
  const minutosRestantes = minutosRedondeados % 60;
  return minutosRestantes > 0 ? `${horas}h ${minutosRestantes}m` : `${horas}h`;
};
