// Building exports often look like "MC - Mathematics & Computer 4020" or
// "SJ1 - Classroom & Library Bldg 3016" — keep just the building code and
// room number ("MC 4020", "SJ1 3016") so it reads at a glance and leaves
// more room for larger text in the calendar blocks.
export function shortenLocation(loc) {
  var s = String(loc || "").trim();
  if (!s) return s;
  var m = /^(\S+)\s*-\s*.+?\s(\S+)$/.exec(s);
  if (m) return m[1] + " " + m[2];
  return s;
}
