// Minimal 5-field cron matcher (minute hour day-of-month month day-of-week).
// Times are evaluated in UTC, which is what Cloudflare cron triggers use.
//
// Supported per field: "*", "*/n", "a", "a-b", "a-b/n", and comma lists of those.

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function expandPart(part: string, min: number, max: number): number[] | null {
  const [rangeRaw, stepRaw] = part.split("/");
  let step = 1;
  if (stepRaw !== undefined) {
    step = Number(stepRaw);
    if (!Number.isInteger(step) || step <= 0) return null;
  }

  let start: number;
  let end: number;
  if (rangeRaw === "*" || rangeRaw === "") {
    start = min;
    end = max;
  } else if (rangeRaw.includes("-")) {
    const [a, b] = rangeRaw.split("-");
    start = Number(a);
    end = Number(b);
  } else {
    start = Number(rangeRaw);
    end = stepRaw === undefined ? start : max;
  }

  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < min || end > max || start > end) return null;

  const out: number[] = [];
  for (let v = start; v <= end; v += step) out.push(v);
  return out;
}

function parseField(field: string, min: number, max: number): Set<number> | null {
  const set = new Set<number>();
  for (const part of field.split(",")) {
    const values = expandPart(part.trim(), min, max);
    if (!values) return null;
    for (const v of values) set.add(v);
  }
  return set.size ? set : null;
}

export function parseCron(expr: string): CronFields | null {
  const fields = String(expr || "").trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dom = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  // 0 and 7 both mean Sunday.
  const dowRaw = parseField(fields[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;

  const dow = new Set<number>();
  for (const v of dowRaw) dow.add(v === 7 ? 0 : v);

  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

export function cronMatches(expr: string, at: Date): boolean {
  const parsed = parseCron(expr);
  if (!parsed) return false;

  if (!parsed.minute.has(at.getUTCMinutes())) return false;
  if (!parsed.hour.has(at.getUTCHours())) return false;
  if (!parsed.month.has(at.getUTCMonth() + 1)) return false;

  const domOk = parsed.dom.has(at.getUTCDate());
  const dowOk = parsed.dow.has(at.getUTCDay());

  // Classic cron behaviour: when both day fields are restricted, either may match.
  if (parsed.domRestricted && parsed.dowRestricted) return domOk || dowOk;
  if (parsed.domRestricted) return domOk;
  if (parsed.dowRestricted) return dowOk;
  return true;
}

/** Identifies the minute an instant belongs to, so a schedule fires only once per minute. */
export function minuteKey(at: Date): string {
  return at.toISOString().slice(0, 16);
}
