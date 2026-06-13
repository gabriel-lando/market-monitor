const currencyFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 2,
});

const compactDateFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'short',
});

const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function toDate(value: string | null) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

export function formatCurrency(value: number | null, fallback = 'No price yet') {
  if (value === null) {
    return fallback;
  }

  return currencyFormatter.format(value / 100);
}

export function formatPriceDelta(value: number | null, fallback = 'No spread yet') {
  if (value === null) {
    return fallback;
  }

  const signal = value > 0 ? '+' : '';
  return `${signal}${currencyFormatter.format(value / 100)}`;
}

export function formatCompactDate(value: string | null, fallback = 'No date') {
  const parsed = toDate(value);
  if (!parsed) {
    return fallback;
  }

  return compactDateFormatter.format(parsed);
}

export function formatDateLabel(value: string | null, fallback = 'No date') {
  const parsed = toDate(value);
  if (!parsed) {
    return fallback;
  }

  return dateFormatter.format(parsed);
}

export function formatDateTime(value: string | null, fallback = 'Pending capture') {
  const parsed = toDate(value);
  if (!parsed) {
    return fallback;
  }

  return dateTimeFormatter.format(parsed);
}

export function formatAvailabilityStatus(value: string | null, fallback = 'Status unavailable') {
  if (!value) {
    return fallback;
  }

  return value
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`)
    .join(' ');
}
