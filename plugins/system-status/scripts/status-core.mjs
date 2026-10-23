/**
 * Pure helpers for the system-status hook.
 *
 * No I/O lives here on purpose: the host contract (payload in, one JSON envelope
 * out) is exercised by the hook entrypoint, while thresholds and formatting are
 * decided here against synthetic snapshots.
 */

/**
 * Pressure thresholds. They are a deliberate, documented assumption: the user
 * asked for "the PC is already suffocating" without naming numbers, so the
 * snapshot escalates to a warning on these boundaries.
 */
export const THRESHOLDS = Object.freeze({
  ramFreePctBelow: 20,
  swapUsedPctAbove: 60,
  loadPerCoreAbove: 1,
  loadPerCoreElevated: 0.7,
});

const KIB_PER_GIB = 1024 * 1024;

/** Parse /proc/meminfo into kB figures; null when the shape is not understood. */
export function parseMeminfo(text) {
  if (typeof text !== 'string') return null;
  const fields = new Map();
  for (const line of text.split('\n')) {
    const match = /^(\S+):\s+(\d+)\s*kB$/.exec(line.trim());
    if (match) fields.set(match[1], Number(match[2]));
  }
  const totalKb = fields.get('MemTotal');
  const availableKb = fields.get('MemAvailable');
  if (!totalKb || availableKb === undefined) return null;
  return {
    totalKb,
    availableKb,
    swapTotalKb: fields.get('SwapTotal') ?? 0,
    swapFreeKb: fields.get('SwapFree') ?? 0,
  };
}

/** Parse /proc/loadavg into 1/5/15 minute load averages; null when unreadable. */
export function parseLoadavg(text) {
  if (typeof text !== 'string') return null;
  const parts = text.trim().split(/\s+/);
  const one = Number(parts[0]);
  if (!Number.isFinite(one)) return null;
  const five = Number(parts[1]);
  const fifteen = Number(parts[2]);
  return {
    one,
    five: Number.isFinite(five) ? five : one,
    fifteen: Number.isFinite(fifteen) ? fifteen : one,
  };
}

/**
 * Classify a snapshot as ok / elevated / pressure.
 * A missing source never escalates: an unavailable reading is not evidence of
 * pressure, and only real numbers may produce a warning.
 */
export function classify(snapshot, thresholds = THRESHOLDS) {
  const pressure = [];
  const elevated = [];
  const mem = snapshot?.mem;
  const swap = snapshot?.swap;
  const load = snapshot?.load;

  if (mem && mem.totalKb > 0) {
    const freePct = (mem.availableKb / mem.totalKb) * 100;
    if (freePct < thresholds.ramFreePctBelow) {
      pressure.push(`свободно только ${freePct.toFixed(0)}% RAM`);
    }
  }
  if (swap && swap.totalKb > 0) {
    const usedPct = ((swap.totalKb - swap.freeKb) / swap.totalKb) * 100;
    if (usedPct > thresholds.swapUsedPctAbove) {
      pressure.push(`swap израсходован на ${usedPct.toFixed(0)}%`);
    }
  }
  if (load && load.cores > 0) {
    const ratio = load.one / load.cores;
    if (ratio > thresholds.loadPerCoreAbove) {
      pressure.push(`load ${load.one.toFixed(2)} при ${load.cores} cpu`);
    } else if (ratio > thresholds.loadPerCoreElevated) {
      elevated.push(`load ${load.one.toFixed(2)} при ${load.cores} cpu`);
    }
  }

  if (pressure.length > 0) return { level: 'pressure', reasons: pressure };
  if (elevated.length > 0) return { level: 'elevated', reasons: elevated };
  return { level: 'ok', reasons: [] };
}

function size(kb) {
  if (!Number.isFinite(kb) || kb < 0) return 'н/д';
  if (kb >= KIB_PER_GIB) return `${(kb / KIB_PER_GIB).toFixed(1)} ГиБ`;
  return `${Math.round(kb / 1024)} МиБ`;
}

/**
 * Render the snapshot as the compact context block.
 * `includeCleanup` adds the one-line teardown reminder that keeps test
 * containers and dev servers from outliving the test that started them.
 */
export function formatStatus(snapshot, classification, options = {}) {
  const mem = snapshot?.mem;
  const swap = snapshot?.swap;
  const load = snapshot?.load;
  const docker = snapshot?.docker;

  const facts = [
    mem ? `RAM свободно ${size(mem.availableKb)}/${size(mem.totalKb)}` : 'RAM н/д',
    swap ? `swap свободно ${size(swap.freeKb)}/${size(swap.totalKb)}` : 'swap н/д',
    load ? `load ${load.one.toFixed(2)} (${load.cores} cpu)` : 'load н/д',
    docker ? `docker: ${docker.running} активных / ${docker.total} всего` : 'docker: н/д',
  ];
  const lines = [`[system-status] ${facts.join(' · ')}`];

  if (classification.level === 'pressure') {
    lines.push(`⚠ ДАВЛЕНИЕ (${classification.reasons.join('; ')}) — отложи тяжёлые сборки, большие прогоны и массовые установки.`);
  } else if (classification.level === 'elevated') {
    lines.push(`заметная нагрузка (${classification.reasons.join('; ')}) — тяжёлое лучше отложить.`);
  }
  if (options.includeCleanup) {
    lines.push('уборка: после тестов удали тестовые контейнеры и останови dev-серверы, которые ты запускал.');
  }
  return lines.join('\n');
}
