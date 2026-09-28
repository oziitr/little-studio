import { config } from './config.mjs';

const HOUR = 3600000;

export function defaultAccountSchedule() {
  return { enabled: false, intervalHours: 2, maxRuns: 0, runsDone: 0, nextAt: null };
}

export function normalizePublishSchedule(raw = {}) {
  const n = Number(raw.intervalHours);
  const intervalHours = Math.min(720, Math.max(1, Number.isFinite(n) && n > 0 ? Math.round(n) : 2));
  const maxRuns = Math.max(0, Math.min(10000, Math.round(Number(raw.maxRuns) || 0)));
  const mode = raw.mode === 'per_account' ? 'per_account' : 'global';
  return {
    enabled: raw.enabled === true,
    mode,
    intervalHours,
    maxRuns,
    runsDone: Math.max(0, Math.round(Number(raw.runsDone) || 0)),
    nextAt: raw.nextAt && Number.isFinite(new Date(raw.nextAt).getTime()) ? new Date(raw.nextAt).toISOString() : null,
    privacy: raw.privacy === 'public' || raw.privacy === 'unlisted' ? raw.privacy : 'private'
  };
}

export function normalizeAccountSchedule(raw = {}) {
  const base = defaultAccountSchedule();
  const n = Number(raw.intervalHours);
  const intervalHours = Math.min(720, Math.max(1, Number.isFinite(n) && n > 0 ? Math.round(n) : base.intervalHours));
  const maxRuns = Math.max(0, Math.min(10000, Math.round(Number(raw.maxRuns) || 0)));
  return {
    enabled: raw.enabled === true,
    intervalHours,
    maxRuns,
    runsDone: Math.max(0, Math.round(Number(raw.runsDone) || 0)),
    nextAt: raw.nextAt && Number.isFinite(new Date(raw.nextAt).getTime()) ? new Date(raw.nextAt).toISOString() : null
  };
}

export function readyPoolProjects(store) {
  return store.db.prepare('SELECT id FROM projects ORDER BY updated ASC').all()
    .map(r => store.project(r.id))
    .filter(p => {
      if (!p?.output || p.youtube) return false;
      const st = p.pool?.status;
      // takılı publishing (youtube id yok) tekrar paylaşılabilir
      return !st || st === 'ready' || st === 'draft' || st === 'publishing';
    });
}

function bumpNext(isoOrNull, intervalHours) {
  const base = isoOrNull && new Date(isoOrNull).getTime() > Date.now() - intervalHours * HOUR
    ? new Date(isoOrNull).getTime()
    : Date.now();
  return new Date(base + intervalHours * HOUR).toISOString();
}

function canRun(schedule) {
  if (!schedule?.enabled) return false;
  if (schedule.maxRuns > 0 && schedule.runsDone >= schedule.maxRuns) return false;
  if (schedule.nextAt && new Date(schedule.nextAt).getTime() > Date.now()) return false;
  return true;
}

/**
 * Havuzdaki hazır videoları zaman çizelgesine göre yükleme kuyruğuna alır.
 * mode=global: tüm hesaplara ortak aralık + round-robin
 * mode=per_account: her hesabın kendi aralığı
 */
export async function publishTick(store, youtube, enqueue) {
  const c = config(store);
  const schedule = normalizePublishSchedule(c.publishSchedule || {});
  const ready = readyPoolProjects(store);
  if (!ready.length) return { queued: 0 };

  let queued = 0;
  const busy = id => store.db.prepare("SELECT id FROM jobs WHERE project=? AND status IN ('queued','running')").get(id);

  if (schedule.enabled && schedule.mode === 'global' && canRun(schedule)) {
    const project = ready.find(p => !busy(p.id));
    if (project) {
      try {
        enqueue(project, 'upload', { publish: { privacy: schedule.privacy }, autoUpload: true });
        queued++;
        schedule.runsDone += 1;
        schedule.nextAt = bumpNext(schedule.nextAt, schedule.intervalHours);
        if (schedule.maxRuns > 0 && schedule.runsDone >= schedule.maxRuns) schedule.enabled = false;
        store.setSetting('config', { ...c, publishSchedule: schedule });
      } catch {}
    }
    return { queued };
  }

  if (schedule.enabled && schedule.mode === 'per_account') {
    const list = youtube._all();
    const accounts = list.filter(a => a.active !== false);
    let changed = false;
    for (const acc of accounts) {
      const as = normalizeAccountSchedule(acc.schedule || {});
      if (!canRun(as)) continue;
      const project = ready.find(p => !busy(p.id) && !p.youtube);
      if (!project) break;
      try {
        enqueue(project, 'upload', { publish: { privacy: schedule.privacy }, account: acc.id, autoUpload: true });
        queued++;
        as.runsDone += 1;
        as.nextAt = bumpNext(as.nextAt, as.intervalHours);
        if (as.maxRuns > 0 && as.runsDone >= as.maxRuns) as.enabled = false;
        acc.schedule = as;
        changed = true;
        ready.splice(ready.indexOf(project), 1);
      } catch {}
    }
    if (changed) youtube._saveAll(list);
  }

  return { queued };
}
