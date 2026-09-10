// Building exports often look like "MC - Mathematics & Computer 4020" or
// "SJ1 - Classroom & Library Bldg" — keep just the building code, plus the
// room number when there is one ("MC 4020", "SJ1"), so it reads at a glance
// and leaves more room for larger text in the calendar blocks.
export function shortenLocation(loc) {
  var s = String(loc || "").trim();
  if (!s) return s;
  var m = /^(\S+)\s*-\s*(.+)$/.exec(s);
  if (!m) return s;
  var code = m[1];
  var words = m[2].trim().split(/\s+/);
  var last = words[words.length - 1];
  return /\d/.test(last) ? code + " " + last : code;
}
