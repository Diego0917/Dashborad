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
  return fechaValida ? fechaValida.toISOString() : '';
};
