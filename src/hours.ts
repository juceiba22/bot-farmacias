import { DAYS } from './config.ts';
import type { DayKey, Interval, PharmacyConfig } from './config.ts';

const WEEKDAY: Record<string, DayKey> = {
  Mon: 'lun', Tue: 'mar', Wed: 'mie', Thu: 'jue', Fri: 'vie', Sat: 'sab', Sun: 'dom',
};
const LABEL: Record<DayKey, string> = {
  lun: 'Lun', mar: 'Mar', mie: 'Mié', jue: 'Jue', vie: 'Vie', sab: 'Sáb', dom: 'Dom',
};

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour'));
  return { day: WEEKDAY[get('weekday')], hour, minutes: hour * 60 + Number(get('minute')) };
}

export function isOpenNow(cfg: PharmacyConfig, date: Date): boolean {
  const { day, minutes } = localParts(date, cfg.timezone);
  return (cfg.hours[day] ?? []).some(([from, to]) => minutes >= toMinutes(from) && minutes < toMinutes(to));
}

/** Agrupa días consecutivos con el mismo horario: "Lun a Vie: 08:30 a 13:00 y 16:30 a 21:00". */
export function formatHours(cfg: PharmacyConfig): string {
  const groups: { days: DayKey[]; key: string }[] = [];
  for (const day of DAYS) {
    const key = JSON.stringify(cfg.hours[day] ?? []);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.days.push(day);
    else groups.push({ days: [day], key });
  }
  return groups
    .map(({ days, key }) => {
      const slots = JSON.parse(key) as Interval[];
      const label = days.length > 1 ? `${LABEL[days[0]]} a ${LABEL[days[days.length - 1]]}` : LABEL[days[0]];
      const when = slots.length ? slots.map(([a, b]) => `${a} a ${b}`).join(' y ') + ' hs' : 'Cerrado';
      return `• ${label}: ${when}`;
    })
    .join('\n');
}
