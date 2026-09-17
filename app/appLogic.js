import { auth, db, firebaseReady, normalize, syntheticEmail } from "@/lib/firebaseClient";
import { shortenLocation } from "@/lib/shortenLocation";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updatePassword,
} from "firebase/auth";
import {
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  runTransaction,
  deleteField,
} from "firebase/firestore";

var DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var DOW_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
var BYDAY_TO_NUM = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

var UNIVERSITIES = [
  "University of Waterloo", "University of Toronto", "McMaster University", "Queen's University",
  "Western University", "York University", "University of Ottawa", "Carleton University",
  "University of Guelph", "Wilfrid Laurier University", "Toronto Metropolitan University",
  "McGill University", "Concordia University", "Université de Montréal",
  "University of British Columbia", "Simon Fraser University", "University of Victoria",
  "University of Alberta", "University of Calgary", "University of Manitoba",
  "University of Saskatchewan", "Dalhousie University", "Memorial University of Newfoundland",
  "University of Windsor", "Brock University", "Trent University", "Lakehead University",
  "Ontario Tech University", "Laurentian University", "Nipissing University",
  "University of Winnipeg", "University of Regina", "University of New Brunswick",
  "Mount Allison University", "Acadia University", "St. Francis Xavier University",
  "Saint Mary's University", "Cape Breton University", "University of Prince Edward Island",
  "Athabasca University", "Royal Military College of Canada", "OCAD University",
  "Université Laval", "Université du Québec à Montréal", "HEC Montréal",
  "École Polytechnique de Montréal", "Bishop's University", "Thompson Rivers University",
  "University of Northern British Columbia", "Vancouver Island University",
  "Kwantlen Polytechnic University", "MacEwan University", "Mount Royal University",
  "University of Lethbridge",
];

var SHELL_HTML = `
  <!-- AUTH -->
  <div id="auth">
    <div class="brand">
      <div class="brand-left">
        <div class="mark">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="18" height="18" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M8 2v4M16 2v4M3 10h18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><rect x="7" y="13" width="4.5" height="3.5" rx="1" fill="currentColor"/></svg>
        </div>
        <div class="brand-text">
          <h1>Schedule Share</h1>
        </div>
      </div>
      <div id="auth-theme-slot"></div>
    </div>
    <div id="auth-body"></div>
  </div>

  <!-- APP -->
  <div id="app">
    <header class="top" id="app-header"></header>
    <div id="notifs"></div>
    <main>
      <div class="tabpanel" id="tab-schedule">
        <section id="sec-upload"></section>
        <section id="sec-today"></section>
      </div>
      <div class="tabpanel" id="tab-friends">
        <section id="sec-mutual"></section>
        <section id="sec-directory"></section>
        <section id="sec-classmates"></section>
      </div>
    </main>
    <nav class="bottomnav" id="bottomnav">
      <button data-tab="schedule">My Schedule</button>
      <button data-tab="friends">Friends</button>
    </nav>
  </div>

  <!-- COMPARE -->
  <div id="compare">
    <header class="top" id="compare-header"></header>
    <div id="legend" class="legend"></div>
    <div id="compare-body" style="flex:1; overflow-y:auto;"></div>
  </div>

  <div id="toast"></div>
  <div id="modal-layer"><div id="modal-backdrop"></div><div id="modal-sheet"></div></div>
`;

export function mountApp(root) {
  root.id = "shell";
  root.innerHTML = SHELL_HTML;

  // ---------------- state ----------------
  var S = {
    me: null, // {id, displayName}
    profile: null, // {nicknames:{}}
    accounts: [], // [{id, displayName}]
    sharesFrom: new Set(),
    sharesTo: new Set(),
    notifications: [],
    mySchedule: null, // {events, source, updatedAt}
    activeTab: "friends",
    compare: null, // {targetId, mode:'day'|'week', schedule:null}
    authMode: "signup",
    authError: "",
    pickMode: false,
    pickSelected: [],
    freeNowExpanded: false,
  };
  var unsubs = [];
  var compareUnsubs = [];
  var nowLineTimer = null;
  function startNowLineTimer() {
    stopNowLineTimer();
    nowLineTimer = setInterval(function () { if (S.compare) renderCompareBody(); }, 60000);
  }
  function stopNowLineTimer() {
    if (nowLineTimer) { clearInterval(nowLineTimer); nowLineTimer = null; }
  }
  var freeNowTimer = null;
  function startFreeNowTimer() {
    stopFreeNowTimer();
    freeNowTimer = setInterval(function () { renderScheduleTab(); }, 60000);
  }
  function stopFreeNowTimer() {
    if (freeNowTimer) { clearInterval(freeNowTimer); freeNowTimer = null; }
  }
  var freeNowCache = {}; // id -> { events, fetchedAt }
  var FREE_NOW_TTL = 30000;
  var MULTI_COLORS = ["cat-blue", "cat-pink", "cat-purple", "cat-green"];
  var authUnsub = null;

  // ---------------- Firestore adapter ----------------
  function docApi(path) {
    var ref = doc(db, path);
    return {
      path: path,
      get: function () {
        return getDoc(ref).then(function (snap) {
          return { exists: snap.exists(), data: function () { return snap.data(); }, id: snap.id };
        });
      },
      set: function (data) { return setDoc(ref, data); },
      update: function (data) { return updateDoc(ref, data); },
      delete: function () { return deleteDoc(ref); },
      onSnapshot: function (next, err) {
        return onSnapshot(
          ref,
          function (snap) {
            next({ exists: snap.exists(), data: function () { return snap.data(); }, id: snap.id });
          },
          err
        );
      },
    };
  }
  function collectionApi(path) {
    var base = collection(db, path);
    var constraints = [];
    var api = {
      where: function (f, op, v) { constraints.push(where(f, op, v)); return api; },
      orderBy: function (f, dir) { constraints.push(orderBy(f, dir || "asc")); return api; },
      limit: function (n) { constraints.push(limit(n)); return api; },
      get: function () {
        var q = constraints.length ? query.apply(null, [base].concat(constraints)) : base;
        return getDocs(q).then(function (snap) {
          return { docs: snap.docs.map(function (d) { return { id: d.id, data: function () { return d.data(); } }; }) };
        });
      },
      onSnapshot: function (next, err) {
        var q = constraints.length ? query.apply(null, [base].concat(constraints)) : base;
        return onSnapshot(
          q,
          function (snap) {
            next({ docs: snap.docs.map(function (d) { return { id: d.id, data: function () { return d.data(); } }; }) });
          },
          err
        );
      },
      add: function (data) {
        return addDoc(base, data).then(function (ref) { return docApi(path + "/" + ref.id); });
      },
    };
    return api;
  }
  var Db = {
    doc: docApi,
    collection: collectionApi,
  };

  // ---------------- helpers ----------------
  function $(sel) { return root.querySelector(sel); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function initials(name) {
    var parts = (name || "?").trim().split(/\s+/);
    return ((parts[0] || "")[0] || "?").toUpperCase() + ((parts[1] || "")[0] || "").toUpperCase();
  }
  function shareDocId(a, b) { return a + "__" + b; }
  function toMin(hhmm) { var p = hhmm.split(":"); return (+p[0]) * 60 + (+p[1]); }
  function addDays(date, n) { var d = new Date(date); d.setDate(d.getDate() + n); return d; }
  function sameDate(a, b) { return a.toDateString() === b.toDateString(); }
  function fmtDateLabel(date) { return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); }
  function fmtTime(hhmm) {
    var p = hhmm.split(":"); var h = +p[0]; var m = p[1];
    var ap = h >= 12 ? "pm" : "am"; var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + (m === "00" ? "" : ":" + m) + ap;
  }
  function toast(msg) {
    var t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove("show"); }, 2400);
  }

  var SUBJECT_CATEGORY = {
    CS: "blue", COMP: "blue", CPSC: "blue", CSC: "blue", SE: "blue", ECE: "blue", CE: "blue", IT: "blue",
    MATH: "purple", STAT: "purple", STATS: "purple", AMATH: "purple", PMATH: "purple", CO: "purple", CALC: "purple",
    ENGL: "pink", ENG: "pink", HIST: "pink", PHIL: "pink", COMMST: "pink", COMM: "pink", SOC: "pink",
    PSYCH: "pink", PSY: "pink", ANTH: "pink", ARTS: "pink", FINE: "pink", MUSIC: "pink", LING: "pink", LANG: "pink",
    PHYS: "green", CHEM: "green", BIO: "green", SCI: "green", KIN: "green", ENVS: "green", GEOG: "green",
    ECON: "green", BUS: "green", ACC: "green", MSCI: "green", MGMT: "green", FIN: "green",
  };
  function subjectCategory(title) {
    var m = /^[A-Za-z]+/.exec(String(title || ""));
    var prefix = m ? m[0].toUpperCase() : "";
    return SUBJECT_CATEGORY[prefix] || "gray";
  }
  function subjectColorVar(title) {
    return "var(--cat-" + subjectCategory(title) + ")";
  }
  function displayNameOf(id) {
    var a = S.accounts.find(function (x) { return x.id === id; });
    return a ? a.displayName : id;
  }
  function nicknameOf(id) {
    var nick = S.profile && S.profile.nicknames && S.profile.nicknames[id];
    return nick || displayNameOf(id);
  }
  function userIdOf(id) {
    var a = S.accounts.find(function (x) { return x.id === id; });
    return a && a.userId;
  }
  function universityOf(id) {
    var a = S.accounts.find(function (x) { return x.id === id; });
    return a && a.university;
  }
  function getMutualIds() {
    return S.accounts.map(function (a) { return a.id; })
      .filter(function (id) { return id !== S.me.id && S.sharesFrom.has(id) && S.sharesTo.has(id); });
  }

  var PROFILE_COLORS = ["blue", "purple", "pink", "green", "amber", "red"];
  function colorOf(id, fallback) {
    var a = S.accounts.find(function (x) { return x.id === id; });
    return (a && a.color) || fallback;
  }
  function paintAvatar(node, id, fallback) {
    var c = colorOf(id, fallback);
    node.style.background = "var(--cat-" + c + "-soft)";
    node.style.color = "var(--cat-" + c + ")";
    return node;
  }

  // ---------------- theme ----------------
  var THEME_KEY = "scheduleShareTheme";
  function effectiveTheme() {
    var stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (e) {}
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function applyStoredThemeIfAny() {
    var stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (e) {}
    if (stored === "light" || stored === "dark") document.documentElement.setAttribute("data-theme", stored);
    // else: leave unstamped so prefers-color-scheme keeps driving it live.
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  }
  function themeIcon(theme) {
    return theme === "dark"
      ? '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4.5" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v2.5M12 19v2.5M4.5 12H2M22 12h-2.5M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none"><path d="M20 14.3A8.4 8.4 0 019.7 4a8.4 8.4 0 1010.3 10.3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
  }
  function buildThemeToggle() {
    var btn = el("button", "iconbtn theme-toggle", themeIcon(effectiveTheme()));
    btn.title = "Toggle light / dark theme";
    btn.onclick = function () {
      var next = effectiveTheme() === "dark" ? "light" : "dark";
      applyTheme(next);
      root.querySelectorAll(".theme-toggle").forEach(function (b) { b.innerHTML = themeIcon(next); });
    };
    return btn;
  }

  // ---------------- ICS parsing ----------------
  function parseICS(text) {
    var rawLines = text.split(/\r\n|\n|\r/);
    var lines = [];
    for (var i = 0; i < rawLines.length; i++) {
      var line = rawLines[i];
      if ((line[0] === " " || line[0] === "\t") && lines.length) {
        lines[lines.length - 1] += line.slice(1);
      } else {
        lines.push(line);
      }
    }
    var events = []; var cur = null;
    for (var j = 0; j < lines.length; j++) {
      var l = lines[j];
      if (l === "BEGIN:VEVENT") { cur = {}; continue; }
      if (l === "END:VEVENT") { if (cur) events.push(cur); cur = null; continue; }
      if (!cur) continue;
      var idx = l.indexOf(":");
      if (idx === -1) continue;
      var key = l.slice(0, idx);
      var value = l.slice(idx + 1);
      var semi = key.indexOf(";");
      if (semi !== -1) key = key.slice(0, semi);
      cur[key] = value;
    }
    function extractTime(v) {
      var m = /T(\d{2})(\d{2})(\d{2})/.exec(v);
      return m ? (m[1] + ":" + m[2]) : "09:00";
    }
    function extractDate(v) {
      var m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
      return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
    }
    function addMin(hhmm, mins) {
      var p = hhmm.split(":"); var d = new Date(2000, 0, 1, +p[0], +p[1] + mins);
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    }
    var WEEKDAYS = [1, 2, 3, 4, 5];
    var out = [];
    events.forEach(function (ev) {
      if (!ev.DTSTART || !ev.RRULE) return; // one-off events (appointments, holidays, etc.) aren't classes
      var freqMatch = /FREQ=([A-Z]+)/.exec(ev.RRULE);
      var freq = freqMatch ? freqMatch[1] : null;
      if (freq !== "WEEKLY" && freq !== "DAILY") return; // only recurring weekly/daily patterns are classes
      if (!/^[A-Za-z]{2,10}\s*-?\s*\d{2,4}/.test(ev.SUMMARY || "")) return; // must look like a course code (e.g. "CS 145")

      var title = ev.SUMMARY || "Class";
      var location = shortenLocation(ev.LOCATION || "");
      var start = extractTime(ev.DTSTART);
      var end = ev.DTEND ? extractTime(ev.DTEND) : addMin(start, 50);
      var days = [];
      var byday = /BYDAY=([^;]+)/.exec(ev.RRULE);
      if (byday) {
        days = byday[1].split(",").map(function (d) { return BYDAY_TO_NUM[d]; }).filter(function (d) { return d !== undefined; });
      } else if (freq === "DAILY") {
        days = WEEKDAYS; // a plain daily repeat on a class calendar means "every weekday", never weekends
      }
      if (!days.length) {
        var d0 = extractDate(ev.DTSTART);
        if (d0) days = [d0.getDay()];
      }
      days.filter(function (d) { return d !== 0 && d !== 6; }) // no classes on Saturday/Sunday
        .forEach(function (day) { out.push({ day: day, start: start, end: end, title: title, location: location }); });
    });
    return out;
  }

  // ---------------- init ----------------
  function init() {
    applyStoredThemeIfAny();
    $("#auth-theme-slot").appendChild(buildThemeToggle());
    if (!firebaseReady) { renderUnavailable(); return; }
    authUnsub = onAuthStateChanged(auth, async function (user) {
      if (!user) {
        if (S.me) teardownSession();
        S.me = null;
        showAuthScreen();
        return;
      }
      if (S.me && S.me.id === user.uid) return;
      try {
        var snap = await getDoc(doc(db, "accounts/" + user.uid));
        var displayName = snap.exists() ? snap.data().displayName : (user.email || "").split("@")[0];
        loginAs(user.uid, displayName);
      } catch (e) { /* will retry on next auth state event */ }
    });
    renderAuth();
  }

  function renderUnavailable() {
    $("#auth-body").innerHTML =
      '<div class="unavailable">Firebase isn’t configured yet. Add your Firebase project keys to .env.local (see .env.local.example) and reload.</div>';
  }

  var UNIVERSITY_OTHER = "__other__";

  function universityFieldHtml(idPrefix, current) {
    var isOther = !!current && UNIVERSITIES.indexOf(current) === -1;
    var options = '<option value="">— Select —</option>' +
      UNIVERSITIES.map(function (u) {
        return '<option value="' + esc(u) + '"' + (u === current ? " selected" : "") + ">" + esc(u) + "</option>";
      }).join("") +
      '<option value="' + UNIVERSITY_OTHER + '"' + (isOther ? " selected" : "") + ">Other</option>";
    return '<div class="field"><label>University</label><select id="' + idPrefix + '-select">' + options + "</select></div>" +
      '<div class="field" id="' + idPrefix + '-other-wrap"' + (isOther ? "" : ' style="display:none"') + ">" +
      '<label>Your university</label><input id="' + idPrefix + '-other" type="text" placeholder="Type your university" value="' + esc(isOther ? current : "") + '"></div>';
  }

  function wireUniversityField(idPrefix) {
    var select = $("#" + idPrefix + "-select");
    var wrap = $("#" + idPrefix + "-other-wrap");
    if (!select || !wrap) return;
    select.addEventListener("change", function () {
      wrap.style.display = select.value === UNIVERSITY_OTHER ? "" : "none";
      if (select.value === UNIVERSITY_OTHER) $("#" + idPrefix + "-other").focus();
    });
  }

  function readUniversityField(idPrefix) {
    var select = $("#" + idPrefix + "-select");
    if (!select || !select.value) return "";
    if (select.value === UNIVERSITY_OTHER) return $("#" + idPrefix + "-other").value.trim();
    return select.value;
  }

  // ================= AUTH =================
  function renderAuth() {
    var body = $("#auth-body");
    var frag = document.createElement("div");
    frag.style.display = "flex"; frag.style.flexDirection = "column"; frag.style.gap = "18px";

    var tabs = el("div", "tabs", '<button data-m="signup">Sign up</button><button data-m="login">Log in</button>');
    tabs.querySelector('[data-m="' + S.authMode + '"]').classList.add("active");
    tabs.querySelectorAll("button").forEach(function (b) {
      b.onclick = function () { S.authMode = b.dataset.m; S.authError = ""; renderAuth(); };
    });
    frag.appendChild(tabs);

    if (S.authMode === "signup") {
      var f = el("div", "field-row",
        '<div class="field"><label>First name</label><input id="signup-first" type="text" placeholder="e.g. Fei" autocomplete="given-name"></div>' +
        '<div class="field"><label>Last name</label><input id="signup-last" type="text" placeholder="e.g. Wang" autocomplete="family-name"></div>');
      var fp = el("div", "field", '<label>Password</label><input id="signup-pass" type="password" placeholder="At least 6 characters" autocomplete="new-password">');
      var fu = el("div", "uni-fields", universityFieldHtml("signup-university", ""));
      frag.appendChild(f);
      frag.appendChild(fp);
      frag.appendChild(fu);
      var errS = el("p", "error", esc(S.authError));
      var btnS = el("button", "btn btn-primary", "Create account");
      btnS.onclick = doSignup;
      frag.appendChild(btnS);
      frag.appendChild(errS);
    } else {
      var f2 = el("div", "field", '<label>Your name</label><input id="login-name" type="text" placeholder="Your name" autocomplete="name">');
      var f2p = el("div", "field", '<label>Password</label><input id="login-pass" type="password" placeholder="Your password" autocomplete="current-password">');
      frag.appendChild(f2);
      frag.appendChild(f2p);
      var errL = el("p", "error", esc(S.authError));
      var btnL = el("button", "btn btn-primary", "Log in");
      btnL.onclick = doLogin;
      frag.appendChild(btnL);
      frag.appendChild(errL);
    }

    body.innerHTML = "";
    body.appendChild(frag);
    if (S.authMode === "signup") wireUniversityField("signup-university");
    var submit = function () { (S.authMode === "signup" ? doSignup : doLogin)(); };
    frag.querySelectorAll("input").forEach(function (inp) {
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    });
    var inputToFocus = S.authMode === "signup" ? $("#signup-first") : $("#login-name");
    if (inputToFocus) inputToFocus.focus();
  }

  function showAuthScreen() {
    $("#auth").style.display = "flex";
    $("#app").style.display = "none";
    $("#compare").style.display = "none";
  }

  async function doSignup() {
    var firstName = $("#signup-first").value.trim();
    var lastName = $("#signup-last").value.trim();
    var password = $("#signup-pass").value;
    var university = readUniversityField("signup-university");
    S.authError = "";
    if (!firstName || !lastName) { S.authError = "Enter your first and last name to continue."; renderAuth(); return; }
    var name = firstName + " " + lastName;
    if (password.length < 6) { S.authError = "Password must be at least 6 characters."; renderAuth(); return; }
    var id = normalize(name);
    var btn = $("#auth-body .btn-primary"); btn.disabled = true; btn.textContent = "Creating…";
    try {
      var cred = await createUserWithEmailAndPassword(auth, syntheticEmail(id), password);
      var uid = cred.user.uid;
      await runTransaction(db, async function (tx) {
        var counterRef = doc(db, "meta/counters");
        var counterSnap = await tx.get(counterRef);
        var next = (counterSnap.exists() && counterSnap.data().nextUserId) || 0;
        tx.set(counterRef, { nextUserId: next + 1 }, { merge: true });
        var accountData = {
          displayName: name,
          userId: String(next).padStart(4, "0"),
          createdAt: new Date().toISOString(),
        };
        if (university) accountData.university = university;
        tx.set(doc(db, "accounts/" + uid), accountData);
      });
      await setDoc(doc(db, "profiles/" + uid), { nicknames: {}, createdAt: new Date().toISOString() });
      loginAs(uid, name);
    } catch (e) {
      if (e && e.code === "auth/email-already-in-use") {
        S.authError = "That name is already taken — try logging in, or use a different name (e.g. add your last initial).";
      } else if (e && e.code === "auth/weak-password") {
        S.authError = "Password must be at least 6 characters.";
      } else {
        S.authError = "Couldn't create that account. Please try again.";
      }
      renderAuth();
    }
  }

  async function doLogin() {
    var name = $("#login-name").value.trim();
    var password = $("#login-pass").value;
    S.authError = "";
    if (!name) { S.authError = "Enter your name."; renderAuth(); return; }
    if (!password) { S.authError = "Enter your password."; renderAuth(); return; }
    var id = normalize(name);
    try {
      // onAuthStateChanged picks this up, fetches the display name, and enters the app.
      await signInWithEmailAndPassword(auth, syntheticEmail(id), password);
    } catch (e) {
      if (e && (e.code === "auth/invalid-credential" || e.code === "auth/user-not-found" || e.code === "auth/wrong-password")) {
        S.authError = "No account found with that name and password.";
      } else if (e && e.code === "auth/too-many-requests") {
        S.authError = "Too many attempts — please wait a bit and try again.";
      } else {
        S.authError = "Something went wrong. Please try again.";
      }
      renderAuth();
    }
  }

  function loginAs(id, displayName) {
    if (S.me && S.me.id === id) {
      // Already entered (e.g. the auth-state listener beat the explicit
      // post-signup/login call here) — just refresh the name, don't re-subscribe.
      S.me.displayName = displayName;
      renderHeader();
      return;
    }
    S.me = { id: id, displayName: displayName };
    enterApp();
  }

  function teardownSession() {
    unsubs.forEach(function (u) { try { u(); } catch (e) {} });
    unsubs = [];
    compareUnsubs.forEach(function (u) { try { u(); } catch (e) {} }); compareUnsubs = [];
    S.profile = null; S.accounts = []; S.sharesFrom = new Set(); S.sharesTo = new Set();
    S.notifications = []; S.mySchedule = null; S.compare = null; S.activeTab = "friends";
    S.authMode = "login";
  }

  function logout() { signOut(auth); }

  // ================= APP =================
  async function enterApp() {
    $("#auth").style.display = "none";
    $("#app").style.display = "flex";
    $("#compare").style.display = "none";

    try {
      var pref = doc(db, "profiles/" + S.me.id);
      var psnap = await getDoc(pref);
      if (!psnap.exists()) await setDoc(pref, { nicknames: {}, createdAt: new Date().toISOString() });
    } catch (e) {}

    subscribe();
    renderHeader();
    renderNav();
    switchTab("friends");
  }

  function subscribe() {
    // Both tabs render unconditionally (not gated on S.activeTab): on mobile the
    // CSS hides the inactive one, but on desktop both panels show at once, so
    // both need real content regardless of which tab is "active".
    unsubs.push(Db.collection("accounts").orderBy("displayName").limit(300).onSnapshot(function (snap) {
      S.accounts = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      renderHeader();
      // The account list changing is exactly when classmate matches can
      // change too (a new signup, someone adding their university), so the
      // TTL-based cache needs invalidating here rather than waiting it out.
      classmatesCache = { ids: null, fetchedAt: 0 };
      renderFriendsTab();
    }));
    unsubs.push(Db.collection("shares").where("from", "==", S.me.id).onSnapshot(function (snap) {
      S.sharesFrom = new Set(snap.docs.map(function (d) { return d.data().to; }));
      renderFriendsTab();
    }));
    unsubs.push(Db.collection("shares").where("to", "==", S.me.id).onSnapshot(function (snap) {
      S.sharesTo = new Set(snap.docs.map(function (d) { return d.data().from; }));
      renderFriendsTab();
    }));
    unsubs.push(Db.collection("notifications").where("to", "==", S.me.id).where("dismissed", "==", false).onSnapshot(function (snap) {
      S.notifications = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .sort(function (a, b) { return (b.createdAt || "").localeCompare(a.createdAt || ""); });
      renderNotifs();
    }));
    unsubs.push(Db.doc("schedules/" + S.me.id).onSnapshot(function (snap) {
      S.mySchedule = snap.exists ? snap.data() : null;
      renderScheduleTab();
      // My own schedule changing is exactly when classmate matches can change,
      // and the classmates section otherwise only refreshes on account/share
      // updates — without this it can go stale forever if the schedule
      // listener resolves after the Friends tab already rendered once.
      classmatesCache = { ids: null, fetchedAt: 0 };
      renderClassmatesSection();
    }));
    unsubs.push(Db.doc("profiles/" + S.me.id).onSnapshot(function (snap) {
      S.profile = snap.exists ? snap.data() : { nicknames: {} };
      renderFriendsTab();
    }));
    startFreeNowTimer();
  }

  function renderHeader() {
    var h = $("#app-header");
    h.innerHTML = "";
    var left = el("div", "left");
    var av = paintAvatar(el("div", "avatar", esc(initials(S.me.displayName))), S.me.id, "blue");
    var myId = userIdOf(S.me.id);
    var tw = el("div", "titlewrap", "<h2>Schedule Share</h2><p class=\"sub\">" + esc(S.me.displayName) +
      (myId ? ' <span class="id-badge">#' + esc(myId) + "</span>" : "") + "</p>");
    left.appendChild(av); left.appendChild(tw);
    av.style.cursor = "pointer";
    av.onclick = openAccountMenu;
    h.appendChild(left);

    var right = el("div", "right");
    right.appendChild(buildThemeToggle());
    h.appendChild(right);
  }

  function openAccountMenu() {
    openModal(
      "Signed in as " + esc(S.me.displayName),
      '<p class="hint" style="margin:0;">Your login is remembered on this device.</p>',
      [
        { label: "Profile color", cls: "btn-outline", onClick: function () { closeModal(); openColorPickerModal(); } },
        { label: "University", cls: "btn-outline", onClick: function () { closeModal(); openUniversityModal(); } },
        { label: "Set password", cls: "btn-outline", onClick: function () { closeModal(); openSetPasswordModal(); } },
        { label: "Log out", cls: "btn-outline", onClick: function () { closeModal(); logout(); } },
        { label: "Close", cls: "btn-ghost", onClick: closeModal },
      ]
    );
  }

  function openColorPickerModal() {
    var current = colorOf(S.me.id, "blue");
    var swatchesHtml = PROFILE_COLORS.map(function (c) {
      return '<button class="color-swatch' + (c === current ? " active" : "") + '" data-color="' + c +
        '" style="background:var(--cat-' + c + ')" aria-label="' + c + '"></button>';
    }).join("");
    openModal("Choose your profile color", '<div class="color-grid">' + swatchesHtml + "</div>", [
      { label: "Close", cls: "btn-ghost", onClick: closeModal },
    ]);
    $("#modal-sheet").querySelectorAll(".color-swatch").forEach(function (btn) {
      btn.onclick = async function () {
        var c = btn.dataset.color;
        try { await Db.doc("accounts/" + S.me.id).update({ color: c }); } catch (e) {}
        closeModal();
      };
    });
  }

  function openUniversityModal() {
    var current = universityOf(S.me.id) || "";
    openModal("Your university", universityFieldHtml("account-university", current),
      [
        { label: "Save", cls: "btn-primary", onClick: async function () {
            var v = readUniversityField("account-university");
            try {
              if (v) await Db.doc("accounts/" + S.me.id).update({ university: v });
              else await Db.doc("accounts/" + S.me.id).update({ university: deleteField() });
            } catch (e) {}
            closeModal();
          } },
        { label: "Cancel", cls: "btn-ghost", onClick: closeModal },
      ]);
    wireUniversityField("account-university");
  }

  function openSetPasswordModal() {
    openModal(
      "Set your password",
      '<div class="field"><label>New password</label><input id="setpw-input" type="password" placeholder="At least 6 characters" autocomplete="new-password"></div>',
      [
        { label: "Save", cls: "btn-primary", onClick: async function () {
            var v = $("#setpw-input").value;
            if (v.length < 6) { toast("Password must be at least 6 characters."); return; }
            try {
              await updatePassword(auth.currentUser, v);
              toast("Password set.");
              closeModal();
            } catch (e) {
              if (e && e.code === "auth/requires-recent-login") {
                toast("Please log out and back in, then try again.");
              } else {
                toast("Couldn't save password — try again.");
              }
            }
          } },
        { label: "Cancel", cls: "btn-ghost", onClick: closeModal },
      ]
    );
  }

  function renderNav() {
    var nav = $("#bottomnav");
    nav.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tab === S.activeTab);
      b.onclick = function () { switchTab(b.dataset.tab); };
    });
  }

  function switchTab(tab) {
    S.activeTab = tab;
    $("#tab-schedule").classList.toggle("active", tab === "schedule");
    $("#tab-friends").classList.toggle("active", tab === "friends");
    renderNav();
    renderScheduleTab();
    renderFriendsTab();
  }

  // ---------- Notifications ----------
  function renderNotifs() {
    var box = $("#notifs");
    box.innerHTML = "";
    S.notifications.forEach(function (n) {
      var name = displayNameOf(n.from);
      var card = el("div", "notif-card");
      card.innerHTML = "<p><b>" + esc(name) + "</b> shared their class schedule with you.</p>";
      var actions = el("div", "notif-actions");
      var shareBack = el("button", "btn btn-primary btn-sm", "Share back");
      shareBack.onclick = function () { doShareBack(n); };
      var dismiss = el("button", "btn btn-ghost btn-sm", "Dismiss");
      dismiss.onclick = function () { dismissNotif(n.id); };
      actions.appendChild(shareBack); actions.appendChild(dismiss);
      card.appendChild(actions);
      box.appendChild(card);
    });
  }

  async function dismissNotif(id) {
    try { await Db.doc("notifications/" + id).update({ dismissed: true }); } catch (e) {}
  }

  async function doShareBack(n) {
    try {
      await Db.doc("shares/" + shareDocId(S.me.id, n.from)).set({ from: S.me.id, to: n.from, createdAt: new Date().toISOString() });
      await Db.collection("notifications").add({ to: n.from, from: S.me.id, kind: "share", dismissed: false, createdAt: new Date().toISOString() });
      await dismissNotif(n.id);
      toast("Shared back with " + displayNameOf(n.from));
    } catch (e) { toast("Couldn't share back — try again."); }
  }

  // ---------- Schedule tab ----------
  function renderScheduleTab() {
    var uploadSec = $("#sec-upload");
    uploadSec.innerHTML = '<div class="sec-head"><h3>Your schedule</h3></div>';
    var card = el("div", "card");

    if (S.mySchedule && S.mySchedule.events && S.mySchedule.events.length) {
      var row = el("div", "status-row");
      row.innerHTML = '<div style="flex:1;min-width:0"><p class="loaded-text">Schedule loaded <span class="muted">· from ' +
        (S.mySchedule.source === "ics" ? "Google Calendar file" : "screenshot") + '</span></p></div>';
      var replaceIcon = el("button", "pencil", '<svg viewBox="0 0 24 24" fill="none"><path d="M17.5 3.5a2.12 2.12 0 013 3L9 18 4 19l1-5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>');
      replaceIcon.title = "Replace schedule";
      replaceIcon.onclick = openUploadModal;
      row.appendChild(replaceIcon);
      card.appendChild(row);
      var viewFullBtn = el("button", "btn btn-primary btn-sm", "View full schedule");
      viewFullBtn.style.marginTop = "12px";
      viewFullBtn.style.width = "100%";
      viewFullBtn.onclick = openMySchedule;
      card.appendChild(viewFullBtn);
    } else {
      var grid = el("div", "upload-grid");
      var t1 = el("div", "upload-tile",
        '<div class="chip"><svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.7"/><circle cx="8.5" cy="9" r="1.3" fill="currentColor" stroke="none"/><path d="M3 15.5l4.5-4.5 3 3L15.5 9l5.5 5.5" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/></svg></div>' +
        "<span>Upload screenshot</span><small>Upload screenshot of schedule</small>");
      var t2 = el("div", "upload-tile",
        '<div class="chip"><svg viewBox="0 0 24 24" fill="none"><rect x="4" y="5" width="16" height="15" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M4 9.5H20" stroke="currentColor" stroke-width="1.7"/><path d="M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></div>' +
        "<span>Upload .ics file</span><small>From Google Calendar</small>");
      t1.onclick = function () { $("#file-shot").click(); };
      t2.onclick = function () { $("#file-ics").click(); };
      grid.appendChild(t1); grid.appendChild(t2);
      card.appendChild(grid);
    }
    uploadSec.appendChild(card);
    ensureHiddenFileInputs();

    var officeHoursBtn = el("button", "btn btn-outline btn-sm", "+ Add office hours");
    officeHoursBtn.style.marginTop = "10px";
    officeHoursBtn.style.width = "100%";
    officeHoursBtn.onclick = openAddOfficeHoursModal;
    uploadSec.appendChild(officeHoursBtn);

    var todaySec = $("#sec-today");
    todaySec.innerHTML = "";
    if (S.mySchedule && S.mySchedule.events && S.mySchedule.events.length) {
      var head = el("div", "sec-head");
      head.innerHTML = "<h3>Today</h3><span>" + new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) + "</span>";
      todaySec.appendChild(head);
      var freeNowSlot = el("div", "free-now-slot");
      todaySec.appendChild(freeNowSlot);
      renderFreeNowWidget(freeNowSlot);
      var today = new Date().getDay();
      var todays = S.mySchedule.events.filter(function (e) { return e.day === today; }).sort(function (a, b) { return toMin(a.start) - toMin(b.start); });
      if (!todays.length) {
        var emptyCard = el("div", "card");
        emptyCard.appendChild(el("p", "empty-note", "No classes today!"));
        todaySec.appendChild(emptyCard);
      } else {
        var list = el("div", "tile-list");
        todays.forEach(function (e) {
          var r = el("div", "status-row today-tile");
          r.innerHTML = '<span class="swatch" style="background:' + subjectColorVar(e.title) + '"></span><div><p>' + esc(e.title) +
            '</p><p class="muted">' + fmtTime(e.start) + ' – ' + fmtTime(e.end) + (e.location ? " · " + esc(e.location) : "") + '</p></div>';
          r.onclick = function () { showClassMutuals(e); };
          list.appendChild(r);
        });
        todaySec.appendChild(list);
      }
    }
  }

  async function getScheduleCached(id) {
    var c = freeNowCache[id];
    if (c && Date.now() - c.fetchedAt < FREE_NOW_TTL) return c.events;
    try {
      var snap = await Db.doc("schedules/" + id).get();
      var events = (snap.exists && snap.data().events) || [];
      freeNowCache[id] = { events: events, fetchedAt: Date.now() };
      return events;
    } catch (e) { return []; }
  }

  function isFreeNow(events) {
    var now = new Date();
    var day = now.getDay();
    var mins = now.getHours() * 60 + now.getMinutes();
    return !events.some(function (e) { return e.day === day && toMin(e.start) <= mins && mins < toMin(e.end); });
  }

  async function renderFreeNowWidget(container) {
    var mutualIds = getMutualIds();
    if (!mutualIds.length) { container.innerHTML = ""; return; }
    var results = await Promise.all(mutualIds.map(function (id) {
      return getScheduleCached(id).then(function (events) { return { id: id, free: isFreeNow(events) }; });
    }));
    if (!container.isConnected) return;
    var freeIds = results.filter(function (r) { return r.free; }).map(function (r) { return r.id; });
    paintFreeNowWidget(container, freeIds);
  }

  function paintFreeNowWidget(container, freeIds) {
    container.innerHTML = "";
    if (!freeIds.length) return;
    var MAX_SHOWN = 6;
    var wrap = el("div", "free-now");
    var head = el("div", "free-now-head", freeIds.length + " friend" + (freeIds.length === 1 ? "" : "s") + " free right now");
    wrap.appendChild(head);

    if (!S.freeNowExpanded) {
      var row = el("div", "free-now-row");
      row.style.cursor = "pointer";
      row.onclick = function () { S.freeNowExpanded = true; paintFreeNowWidget(container, freeIds); };
      freeIds.slice(0, MAX_SHOWN).forEach(function (id) {
        var av = paintAvatar(el("div", "avatar sm", esc(initials(displayNameOf(id)))), id, "pink");
        av.title = nicknameOf(id);
        row.appendChild(av);
      });
      var extra = freeIds.length - MAX_SHOWN;
      if (extra > 0) row.appendChild(el("div", "avatar sm free-now-extra", "+" + extra));
      wrap.appendChild(row);
    } else {
      var list = el("div", "free-now-list");
      freeIds.forEach(function (id) {
        var r = el("div", "free-now-name");
        var c = colorOf(id, "pink");
        r.innerHTML = '<div class="avatar sm" style="background:var(--cat-' + c + '-soft);color:var(--cat-' + c + ')">' + esc(initials(displayNameOf(id))) + '</div><span>' + esc(nicknameOf(id)) + "</span>";
        list.appendChild(r);
      });
      wrap.appendChild(list);
      var less = el("button", "free-now-toggle", "Show less");
      less.onclick = function () { S.freeNowExpanded = false; paintFreeNowWidget(container, freeIds); };
      wrap.appendChild(less);
    }
    container.appendChild(wrap);
  }

  function ensureHiddenFileInputs() {
    if (!$("#file-shot")) {
      var f1 = el("input", ""); f1.type = "file"; f1.id = "file-shot"; f1.accept = "image/*"; f1.hidden = true;
      f1.onchange = function () { if (f1.files[0]) handleScreenshot(f1.files[0]); f1.value = ""; };
      root.appendChild(f1);
    }
    if (!$("#file-ics")) {
      var f2 = el("input", ""); f2.type = "file"; f2.id = "file-ics"; f2.accept = ".ics,text/calendar"; f2.hidden = true;
      f2.onchange = function () { if (f2.files[0]) handleIcs(f2.files[0]); f2.value = ""; };
      root.appendChild(f2);
    }
  }

  function openUploadModal() {
    openModal("Replace your schedule", '<p class="hint" style="margin:0;">Choose a new screenshot or .ics file to overwrite your current schedule.</p>', [
      { label: "Screenshot", cls: "btn-primary", onClick: function () { closeModal(); $("#file-shot").click(); } },
      { label: ".ics file", cls: "btn-outline", onClick: function () { closeModal(); $("#file-ics").click(); } },
      { label: "Cancel", cls: "btn-ghost", onClick: closeModal },
    ]);
  }

  var OH_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function openAddOfficeHoursModal() {
    var dayOptions = [1, 2, 3, 4, 5].map(function (d) {
      return '<option value="' + d + '"' + (d === 1 ? " selected" : "") + ">" + OH_DAY_NAMES[d] + "</option>";
    }).join("");
    openModal("Add office hours",
      '<div class="field"><label>Title</label><input id="oh-title" type="text" value="Office Hours" maxlength="60"></div>' +
      '<div class="field"><label>Day</label><select id="oh-day">' + dayOptions + "</select></div>" +
      '<div class="field-row">' +
        '<div class="field"><label>Start</label><input id="oh-start" type="time" value="10:00"></div>' +
        '<div class="field"><label>End</label><input id="oh-end" type="time" value="11:00"></div>' +
      "</div>" +
      '<div class="field"><label>Location</label><input id="oh-location" type="text" placeholder="Optional" maxlength="80"></div>',
      [
        { label: "Add", cls: "btn-primary", onClick: async function () {
            var title = $("#oh-title").value.trim();
            var day = Number($("#oh-day").value);
            var start = $("#oh-start").value;
            var end = $("#oh-end").value;
            var location = $("#oh-location").value.trim();
            if (!title) { toast("Give it a title."); return; }
            if (!start || !end || toMin(end) <= toMin(start)) { toast("End time must be after start time."); return; }
            var event = { day: day, start: start, end: end, title: title };
            if (location) event.location = location;
            var events = ((S.mySchedule && S.mySchedule.events) || []).concat([event]);
            var source = (S.mySchedule && S.mySchedule.source) || "manual";
            try {
              await Db.doc("schedules/" + S.me.id).set({ events: events, source: source, updatedAt: new Date().toISOString() });
              toast("Office hours added.");
              closeModal();
            } catch (e) { toast("Couldn't save — try again."); }
          } },
        { label: "Cancel", cls: "btn-ghost", onClick: closeModal },
      ]);
  }

  async function handleIcs(file) {
    setBusy(true, "Reading calendar file…");
    try {
      var text = await file.text();
      var events = parseICS(text);
      if (!events.length) { toast("Couldn't find any events in that file."); setBusy(false); return; }
      await Db.doc("schedules/" + S.me.id).set({ events: events, source: "ics", updatedAt: new Date().toISOString() });
      toast("Schedule updated — " + events.length + " classes loaded.");
    } catch (e) {
      toast("Couldn't read that file. Make sure it's a valid .ics export.");
    }
    setBusy(false);
  }

  async function handleScreenshot(file) {
    setBusy(true, "Reading your schedule from the image…");
    try {
      var idToken = await auth.currentUser.getIdToken();
      var form = new FormData();
      form.append("image", file);
      var res = await fetch("/api/parse-schedule", {
        method: "POST",
        headers: { Authorization: "Bearer " + idToken },
        body: form,
      });
      var body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to read image.");
      var events = body.events || [];
      if (!events.length) { toast("Couldn't read any classes from that image — try a clearer screenshot."); setBusy(false); return; }
      await Db.doc("schedules/" + S.me.id).set({ events: events, source: "screenshot", updatedAt: new Date().toISOString() });
      toast("Schedule updated — " + events.length + " classes loaded.");
    } catch (e) {
      toast((e && e.message) || "Couldn't read that screenshot. Try again or use a .ics file instead.");
    }
    setBusy(false);
  }

  function setBusy(on, label) {
    var sec = $("#sec-upload");
    var existing = $("#busy-row");
    if (existing) existing.remove();
    if (on) {
      var row = el("div", "busy"); row.id = "busy-row";
      row.innerHTML = '<span class="spinner"></span><span>' + esc(label || "Working…") + "</span>";
      sec.appendChild(row);
    }
  }

  // ---------- Friends tab ----------
  function renderFriendsTab() {
    var mutualIds = getMutualIds();

    if (!S.pickMode) S.pickSelected = S.pickSelected.filter(function (id) { return mutualIds.indexOf(id) !== -1; });

    var mutualSec = $("#sec-mutual");
    mutualSec.innerHTML = "";
    var head = el("div", "sec-head");
    head.appendChild(el("div", "sec-head-left", '<h3>Mutual shares</h3><span class="count-badge">' + mutualIds.length + "</span>"));
    if (mutualIds.length) {
      var pickRow = el("div", "pick-row");
      var multiBtn = el("button", "btn btn-outline btn-xs", S.pickMode ? "Cancel" : "Compare multiple");
      multiBtn.onclick = function () {
        S.pickMode = !S.pickMode;
        if (!S.pickMode) S.pickSelected = [];
        renderFriendsTab();
      };
      pickRow.appendChild(multiBtn);
      if (S.pickMode) {
        var goBtn = el("button", "btn btn-primary btn-xs", "Compare (" + S.pickSelected.length + ")");
        goBtn.disabled = !S.pickSelected.length;
        goBtn.onclick = function () {
          var picked = S.pickSelected.slice();
          S.pickMode = false; S.pickSelected = [];
          openMultiCompare(picked);
        };
        pickRow.appendChild(goBtn);
      }
      head.appendChild(pickRow);
    }
    mutualSec.appendChild(head);
    if (!mutualIds.length) {
      var emptyCard = el("div", "card");
      emptyCard.appendChild(el("p", "empty-note", "No mutual shares yet. Share your schedule with someone below, and once they share back, they'll show up here."));
      mutualSec.appendChild(emptyCard);
    } else {
      var list = el("div", "tile-list");
      mutualIds.forEach(function (id) {
        var picked = S.pickSelected.indexOf(id) !== -1;
        var row = el("div", "person-row mutual-tile" + (picked ? " picked" : ""));
        var avRing = el("div", "avatar-ring");
        avRing.style.background = "linear-gradient(135deg, var(--cat-" + colorOf(S.me.id, "blue") + "), var(--cat-" + colorOf(id, "pink") + "))";
        var av = paintAvatar(el("div", "avatar a2", esc(initials(displayNameOf(id)))), id, "pink");
        avRing.appendChild(av);
        var uni = universityOf(id);
        var name = el("div", "name", '<div class="n1">' + esc(nicknameOf(id)) + "</div>" +
          (nicknameOf(id) !== displayNameOf(id) ? '<div class="n2">' + esc(displayNameOf(id)) + "</div>" : "") +
          (uni ? '<div class="n2">' + esc(uni) + "</div>" : ""));
        row.appendChild(avRing); row.appendChild(name);
        if (S.pickMode) {
          row.onclick = function () {
            var i = S.pickSelected.indexOf(id);
            if (i !== -1) { S.pickSelected.splice(i, 1); }
            else if (S.pickSelected.length >= 3) { toast("You can compare up to 3 friends at once."); return; }
            else { S.pickSelected.push(id); }
            renderFriendsTab();
          };
        } else {
          var pencil = el("button", "pencil", '<svg viewBox="0 0 24 24" fill="none"><path d="M17.5 3.5a2.12 2.12 0 013 3L9 18 4 19l1-5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>');
          pencil.onclick = function (ev) { ev.stopPropagation(); openNicknameModal(id); };
          var chev = el("div", "chevron", '<svg viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>');
          row.appendChild(pencil); row.appendChild(chev);
          row.onclick = function () { openCompare(id); };
        }
        list.appendChild(row);
      });
      mutualSec.appendChild(list);
    }

    var dirSec = $("#sec-directory");
    dirSec.innerHTML = '<div class="sec-head"><h3>Search for friends</h3></div>';
    var searchRow = el("div", "search-row",
      '<svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.7"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>' +
      '<input type="text" id="friend-search" placeholder="Search by name or User ID">');
    dirSec.appendChild(searchRow);
    var dCard = el("div", "card");
    dCard.appendChild(el("p", "empty-note", "Type a name or User ID to find someone."));
    dirSec.appendChild(dCard);

    $("#friend-search").addEventListener("input", function (e) { renderSearchResults(dCard, e.target.value); });

    renderClassmatesSection();
  }

  function buildPersonRow(a) {
    var row = el("div", "person-row");
    var av = paintAvatar(el("div", "avatar sm", esc(initials(a.displayName))), a.id, "pink");
    var name = el("div", "name", '<div class="n1">' + esc(a.displayName) +
      (a.userId ? ' <span class="id-badge">#' + esc(a.userId) + "</span>" : "") + "</div>" +
      (a.university ? '<div class="n2">' + esc(a.university) + "</div>" : ""));
    row.appendChild(av); row.appendChild(name);
    if (S.sharesFrom.has(a.id)) {
      var badge = el("button", "btn btn-shared btn-sm", "Shared ✓");
      badge.onclick = function () { unshareWith(a.id); };
      row.appendChild(badge);
    } else {
      var shareBtn = el("button", "btn btn-primary btn-sm", "Share");
      shareBtn.onclick = function () { shareWith(a.id); };
      row.appendChild(shareBtn);
    }
    return row;
  }

  function renderSearchResults(dCard, qRaw) {
    var q = qRaw.trim().toLowerCase();
    dCard.innerHTML = "";
    if (!q) {
      dCard.appendChild(el("p", "empty-note", "Type a name or User ID to find someone."));
      return;
    }
    var matches = S.accounts.filter(function (a) {
      if (a.id === S.me.id) return false;
      var nameMatch = a.displayName.toLowerCase().indexOf(q) !== -1;
      var idMatch = a.userId && a.userId.indexOf(q) !== -1;
      return nameMatch || idMatch;
    }).slice(0, 25);
    if (!matches.length) {
      dCard.appendChild(el("p", "empty-note", "No one found. Double-check the name or User ID."));
      return;
    }
    matches.forEach(function (a) { dCard.appendChild(buildPersonRow(a)); });
  }

  var classmatesCache = { ids: null, fetchedAt: 0 };
  var CLASSMATES_TTL = 30000;

  async function computeClassmateIds() {
    var mine = (S.mySchedule && S.mySchedule.events) || [];
    var myUni = universityOf(S.me.id);
    if (!mine.length && !myUni) return [];
    if (classmatesCache.ids && Date.now() - classmatesCache.fetchedAt < CLASSMATES_TTL) return classmatesCache.ids;
    var others = S.accounts.filter(function (a) { return a.id !== S.me.id; });
    var results = [];
    for (var i = 0; i < others.length; i++) {
      var a = others[i];
      // Same school is a cheap, no-read match — check it before spending a
      // schedule fetch on the exact-class check.
      if (myUni && a.university === myUni) { results.push(a.id); continue; }
      if (!mine.length) continue;
      try {
        var snap = await Db.doc("schedules/" + a.id).get();
        var evs = (snap.exists && snap.data().events) || [];
        if (evs.some(function (e) { return mine.some(function (m) { return sameClass(e, m); }); })) results.push(a.id);
      } catch (e) { /* skip on error */ }
    }
    classmatesCache = { ids: results, fetchedAt: Date.now() };
    return results;
  }

  async function renderClassmatesSection() {
    var sec = $("#sec-classmates");
    if (!sec) return;
    var ids = await computeClassmateIds();
    if (!sec.isConnected) return;
    sec.innerHTML = '<div class="sec-head"><h3>Classmates</h3>' +
      (ids.length ? '<span class="count-badge">' + ids.length + "</span>" : "") + "</div>";
    var card = el("div", "card");
    var haveSchedule = S.mySchedule && S.mySchedule.events && S.mySchedule.events.length;
    var haveUni = !!universityOf(S.me.id);
    if (!haveSchedule && !haveUni) {
      card.appendChild(el("p", "empty-note", "Upload your schedule or add your university (in your profile) to see who else on Schedule Share shares a class or school with you."));
    } else if (!ids.length) {
      card.appendChild(el("p", "empty-note", "No classmates found yet — this updates automatically as more people sign up."));
    } else {
      ids.forEach(function (id) {
        var a = S.accounts.find(function (x) { return x.id === id; });
        if (a) card.appendChild(buildPersonRow(a));
      });
    }
    sec.appendChild(card);
  }

  async function shareWith(targetId) {
    try {
      await Db.doc("shares/" + shareDocId(S.me.id, targetId)).set({ from: S.me.id, to: targetId, createdAt: new Date().toISOString() });
      await Db.collection("notifications").add({ to: targetId, from: S.me.id, kind: "share", dismissed: false, createdAt: new Date().toISOString() });
      toast("Shared with " + displayNameOf(targetId));
    } catch (e) { toast("Couldn't share — try again."); }
  }
  async function unshareWith(targetId) {
    try {
      await Db.doc("shares/" + shareDocId(S.me.id, targetId)).delete();
      toast("Stopped sharing with " + displayNameOf(targetId));
    } catch (e) {}
  }

  function openNicknameModal(id) {
    var current = (S.profile && S.profile.nicknames && S.profile.nicknames[id]) || "";
    openModal("Nickname for " + esc(displayNameOf(id)),
      '<div class="field"><label>Nickname</label><input id="nick-input" type="text" value="' + esc(current) + '" placeholder="' + esc(displayNameOf(id)) + '"></div>',
      [
        { label: "Save", cls: "btn-primary", onClick: async function () {
            var v = $("#nick-input").value.trim();
            try { await Db.doc("profiles/" + S.me.id).update({ ["nicknames." + id]: v }); } catch (e) {}
            closeModal();
          } },
        { label: "Cancel", cls: "btn-ghost", onClick: closeModal },
      ]);
  }

  function sameClass(a, b) {
    var norm = function (s) { return String(s || "").trim().toLowerCase(); };
    var normLoc = function (s) { return norm(shortenLocation(s)); };
    return a.day === b.day && a.start === b.start && a.end === b.end &&
      norm(a.title) === norm(b.title) && normLoc(a.location) === normLoc(b.location);
  }

  function classDetailHtml(classEvent) {
    return '<div class="class-detail">' +
      '<p class="class-detail-time">' + esc(fmtTime(classEvent.start)) + "–" + esc(fmtTime(classEvent.end)) + "</p>" +
      '<p class="class-detail-sub">' + esc(DOW_FULL[classEvent.day]) +
      (classEvent.location ? " · " + esc(classEvent.location) : "") + "</p>" +
      "</div>";
  }

  async function showClassMutuals(classEvent) {
    var mutualIds = getMutualIds();
    var detail = classDetailHtml(classEvent);
    openModal(esc(classEvent.title), detail + '<div class="busy"><span class="spinner"></span><span>Checking your mutual friends…</span></div>', [
      { label: "Close", cls: "btn-ghost", onClick: closeModal },
    ]);
    var matches = [];
    for (var i = 0; i < mutualIds.length; i++) {
      var id = mutualIds[i];
      try {
        var snap = await Db.doc("schedules/" + id).get();
        var evs = (snap.exists && snap.data().events) || [];
        if (evs.some(function (e) { return sameClass(e, classEvent); })) matches.push(id);
      } catch (e) { /* skip on error */ }
    }
    var myColor = colorOf(S.me.id, "blue");
    var body = detail + (matches.length
      ? matches.map(function (id) {
          var c = colorOf(id, "pink");
          return '<div class="person-row"><div class="avatar-ring" style="background:linear-gradient(135deg, var(--cat-' + myColor + '), var(--cat-' + c + '))">' +
            '<div class="avatar a2" style="background:var(--cat-' + c + '-soft);color:var(--cat-' + c + ')">' + esc(initials(displayNameOf(id))) +
            '</div></div><div class="name"><div class="n1">' + esc(nicknameOf(id)) + "</div></div></div>";
        }).join("")
      : '<p class="empty-note" style="padding:0;">None of your mutual friends share this class.</p>');
    openModal(esc(classEvent.title), body, [{ label: "Close", cls: "btn-ghost", onClick: closeModal }]);
  }

  // ---------- Compare view ----------
  function computeAxis(events) {
    var startMin = 7 * 60, endMin = 21 * 60;
    events.forEach(function (e) {
      var s = toMin(e.start), en = toMin(e.end);
      if (s < startMin) startMin = Math.floor(s / 60) * 60;
      if (en > endMin) endMin = Math.ceil(en / 60) * 60;
    });
    return { startMin: startMin, endMin: endMin };
  }

  function openMySchedule() {
    S.compare = { kind: "solo", targetIds: [], mode: "week", viewDate: new Date() };
    $("#app").style.display = "none";
    $("#compare").style.display = "flex";
    root.classList.add("comparing");
    renderCompareHeader();
    renderCompareBody();
    startNowLineTimer();
  }

  function openCompare(targetId) {
    S.compare = { kind: "pair", targetIds: [targetId], mode: "day", schedules: {}, viewDate: new Date() };
    $("#app").style.display = "none";
    $("#compare").style.display = "flex";
    root.classList.add("comparing");
    renderCompareHeader();
    renderCompareLegend();
    subscribeCompareTargets();
    startNowLineTimer();
  }

  function openMultiCompare(targetIds) {
    S.compare = { kind: "multi", targetIds: targetIds.slice(0, 3), mode: "day", schedules: {}, viewDate: new Date() };
    $("#app").style.display = "none";
    $("#compare").style.display = "flex";
    root.classList.add("comparing");
    renderCompareHeader();
    renderCompareLegend();
    subscribeCompareTargets();
    startNowLineTimer();
  }

  function subscribeCompareTargets() {
    compareUnsubs.forEach(function (u) { try { u(); } catch (e) {} }); compareUnsubs = [];
    $("#compare-body").innerHTML = '<div class="busy" style="padding:20px;"><span class="spinner"></span><span>Loading schedule…</span></div>';
    S.compare.targetIds.forEach(function (id) {
      compareUnsubs.push(Db.doc("schedules/" + id).onSnapshot(function (snap) {
        S.compare.schedules[id] = snap.exists ? snap.data() : null;
        renderCompareBody();
      }));
    });
  }

  function closeCompare() {
    compareUnsubs.forEach(function (u) { try { u(); } catch (e) {} }); compareUnsubs = [];
    stopNowLineTimer();
    S.compare = null;
    $("#compare").style.display = "none";
    $("#app").style.display = "flex";
    root.classList.remove("comparing");
  }

  function compareTitle() {
    if (S.compare.kind === "solo") return "Your Schedule";
    if (S.compare.kind === "pair") return nicknameOf(S.compare.targetIds[0]);
    return "Group Compare";
  }

  function renderCompareHeader() {
    var h = $("#compare-header");
    h.innerHTML = "";
    var left = el("div", "left");
    var back = el("button", "backbtn", '<svg viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>');
    back.onclick = closeCompare;
    var tw = S.compare.kind === "pair"
      ? el("div", "titlewrap", "<h2>" + esc(compareTitle()) + '</h2><p class="sub">vs. you</p>')
      : el("div", "titlewrap", "<h2>" + esc(compareTitle()) + "</h2>");
    left.appendChild(back); left.appendChild(tw);
    h.appendChild(left);

    var right = el("div", "right");
    var toggle = el("div", "modewtoggle", '<button data-mode="day">Day</button><button data-mode="week">Week</button>');
    toggle.querySelector('[data-mode="' + S.compare.mode + '"]').classList.add("active");
    toggle.querySelectorAll("button").forEach(function (b) {
      b.onclick = function () { S.compare.mode = b.dataset.mode; renderCompareHeader(); renderCompareBody(); };
    });
    right.appendChild(toggle);
    right.appendChild(buildThemeToggle());
    h.appendChild(right);
  }

  function dotColorFor(cls) {
    if (cls === "you") return "var(--accent)";
    if (cls === "them") return "var(--accent2)";
    return "var(--" + cls + ")"; // e.g. cat-blue -> var(--cat-blue)
  }

  function buildCompareSeries() {
    var mine = (S.mySchedule && S.mySchedule.events) || [];
    if (S.compare.kind === "solo") return [{ events: mine, cls: "you", label: "You" }];
    if (S.compare.kind === "pair") {
      var theirs = (S.compare.schedules[S.compare.targetIds[0]] && S.compare.schedules[S.compare.targetIds[0]].events) || [];
      return [
        { events: mine, cls: "cat-" + colorOf(S.me.id, "blue"), label: "You" },
        { events: theirs, cls: "cat-" + colorOf(S.compare.targetIds[0], "pink"), label: nicknameOf(S.compare.targetIds[0]) },
      ];
    }
    var out = [{ events: mine, cls: MULTI_COLORS[0], label: "You" }];
    S.compare.targetIds.forEach(function (id, i) {
      var evs = (S.compare.schedules[id] && S.compare.schedules[id].events) || [];
      out.push({ events: evs, cls: MULTI_COLORS[i + 1] || "cat-gray", label: nicknameOf(id) });
    });
    return out;
  }

  function renderCompareLegend() {
    var l = $("#legend");
    if (S.compare.kind === "solo") { l.innerHTML = ""; return; }
    var series = buildCompareSeries();
    l.innerHTML = series.map(function (s) {
      return '<div class="item"><span class="dot" style="background:' + dotColorFor(s.cls) + '"></span>' + esc(s.label) + "</div>";
    }).join("");
  }

  function renderCompareBody() {
    renderCompareLegend();
    var body = $("#compare-body");
    body.innerHTML = "";
    var series = buildCompareSeries();
    var bySubject = S.compare.kind === "solo";
    var allEvents = series.reduce(function (acc, s) { return acc.concat(s.events); }, []);
    if (!allEvents.length) {
      var msg = S.compare.kind === "solo" ? "You haven't uploaded a schedule yet." : "Nobody in this comparison has uploaded a schedule yet.";
      body.innerHTML = '<p class="empty-note" style="padding:20px 16px;">' + msg + "</p>";
      return;
    }
    var axis = computeAxis(allEvents);
    if (S.compare.mode === "day") {
      renderDayView(body, axis, series, S.compare.viewDate, bySubject);
    } else {
      renderWeekView(body, axis, series, bySubject);
    }
  }

  function buildHourLabels(axis, pxPerMin) {
    var col = el("div", "hourcol");
    var totalH = (axis.endMin - axis.startMin) * pxPerMin;
    col.style.height = totalH + "px";
    col.style.position = "relative";
    for (var m = axis.startMin; m <= axis.endMin; m += 60) {
      var lbl = el("div", "hourlabel");
      var h = Math.floor(m / 60); var ap = h >= 12 ? "pm" : "am"; var h12 = h % 12; if (h12 === 0) h12 = 12;
      lbl.textContent = h12 + ap;
      lbl.style.position = "absolute";
      lbl.style.top = ((m - axis.startMin) * pxPerMin) + "px";
      lbl.style.right = "0";
      col.appendChild(lbl);
    }
    return col;
  }

  function buildGridlines(axis, pxPerMin) {
    var gl = el("div", "gridlines");
    for (var m = axis.startMin; m <= axis.endMin; m += 60) {
      var ln = el("div", "line");
      ln.style.top = ((m - axis.startMin) * pxPerMin) + "px";
      gl.appendChild(ln);
    }
    return gl;
  }

  function buildPersonCol(events, day, axis, pxPerMin, cls, bySubject) {
    var col = el("div", "personcol " + cls);
    events.filter(function (e) { return e.day === day; }).forEach(function (e) {
      var s = toMin(e.start), en = Math.max(toMin(e.end), s + 15);
      var top = (s - axis.startMin) * pxPerMin;
      var minHeight = 16;
      var height = Math.max((en - s) * pxPerMin, minHeight);
      var evtClass = bySubject ? ("evt cat-" + subjectCategory(e.title)) : ("evt " + cls);
      evtClass += " " + (height < 26 ? "evt-xs" : height < 40 ? "evt-sm" : "evt-md");
      var box = el("div", evtClass);
      box.style.top = top + "px"; box.style.height = height + "px";
      box.innerHTML = '<span class="t">' + esc(e.title) + '</span>' +
        (e.location ? '<span class="l">' + esc(shortenLocation(e.location)) + "</span>" : "") +
        '<span class="time">' + fmtTime(e.start) + "–" + fmtTime(e.end) + "</span>";
      box.onclick = function () { showClassMutuals(e); };
      col.appendChild(box);
    });
    return col;
  }

  function buildNowLine(axis, pxPerMin) {
    var now = new Date();
    var mins = now.getHours() * 60 + now.getMinutes();
    if (mins < axis.startMin || mins > axis.endMin) return null;
    var line = el("div", "now-line");
    line.style.top = ((mins - axis.startMin) * pxPerMin) + "px";
    var myColor = colorOf(S.me.id, "blue");
    line.style.setProperty("--nowline-c1", "var(--cat-" + myColor + "-soft)");
    line.style.setProperty("--nowline-c2", "var(--cat-" + myColor + ")");
    return line;
  }

  function renderDayView(container, axis, series, viewDate, bySubject) {
    var pxPerMin = 0.85;
    var day = viewDate.getDay();
    var isToday = sameDate(viewDate, new Date());
    var wrap = el("div", "daywrap");
    wrap.appendChild(buildDayNav(viewDate, isToday));

    var grid = el("div", "daygrid");
    grid.appendChild(buildHourLabels(axis, pxPerMin));
    var planes = el("div", "planecols");
    planes.style.height = ((axis.endMin - axis.startMin) * pxPerMin) + "px";
    planes.appendChild(buildGridlines(axis, pxPerMin));
    series.forEach(function (s) { planes.appendChild(buildPersonCol(s.events, day, axis, pxPerMin, s.cls, bySubject)); });
    if (isToday) {
      var nowLine = buildNowLine(axis, pxPerMin);
      if (nowLine) planes.appendChild(nowLine);
    }
    grid.appendChild(planes);
    wrap.appendChild(grid);
    container.appendChild(wrap);
    fitEventSubText(planes);
  }

  function buildDayNav(viewDate, isToday) {
    var nav = el("div", "daynav");
    var prevBtn = el("button", "daynav-arrow", '<svg viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>');
    var nextBtn = el("button", "daynav-arrow", '<svg viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>');
    prevBtn.onclick = function () { S.compare.viewDate = addDays(S.compare.viewDate, -1); renderCompareBody(); };
    nextBtn.onclick = function () { S.compare.viewDate = addDays(S.compare.viewDate, 1); renderCompareBody(); };
    var label = el("button", "daynav-label", fmtDateLabel(viewDate) + (isToday ? " · Today" : ""));
    label.onclick = openDateJumpModal;
    nav.appendChild(prevBtn); nav.appendChild(label); nav.appendChild(nextBtn);
    return nav;
  }

  function openDateJumpModal() {
    var iso = new Date(S.compare.viewDate.getTime() - S.compare.viewDate.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    openModal("Jump to a date",
      '<div class="field"><label>Date</label><input id="datejump-input" type="date" value="' + iso + '"></div>',
      [
        { label: "Today", cls: "btn-outline", onClick: function () { S.compare.viewDate = new Date(); closeModal(); renderCompareBody(); } },
        { label: "Go", cls: "btn-primary", onClick: function () {
            var v = $("#datejump-input").value;
            if (!v) { closeModal(); return; }
            var p = v.split("-");
            S.compare.viewDate = new Date(+p[0], +p[1] - 1, +p[2]);
            closeModal();
            renderCompareBody();
          } },
        { label: "Cancel", cls: "btn-ghost", onClick: closeModal },
      ]);
  }

  // Grows the location/time sub-text in each event box as large as the box's
  // actual measured height allows, capped at the title's own font size.
  function fitEventSubText(container) {
    container.querySelectorAll(".evt").forEach(function (box) {
      var lEl = box.querySelector(".l");
      var timeEl = box.querySelector(".time");
      if (!lEl && !timeEl) return;
      var titleEl = box.querySelector(".t");
      var maxPx = titleEl ? parseFloat(getComputedStyle(titleEl).fontSize) : 20;
      var avail = box.clientHeight;
      if (!avail) return;
      var refEl = lEl || timeEl;
      var size = parseFloat(getComputedStyle(refEl).fontSize);
      var apply = function (px) {
        if (lEl) lEl.style.fontSize = px + "px";
        if (timeEl) timeEl.style.fontSize = Math.max(px * 0.92, 8) + "px";
      };
      if (box.scrollHeight > avail) {
        // already overflowing at the default size (rare, tight tier boundary) — shrink to fit
        for (var j = 0; j < 40 && size > 6; j++) {
          size -= 0.5;
          apply(size);
          if (box.scrollHeight <= avail) return;
        }
        if (lEl) lEl.style.display = "none"; // last resort, matches the evt-sm tier's behavior
        return;
      }
      for (var i = 0; i < 40 && size + 0.5 <= maxPx; i++) {
        var next = size + 0.5;
        apply(next);
        if (box.scrollHeight > avail) { apply(size); break; }
        size = next;
      }
    });
  }

  function renderWeekView(container, axis, series, bySubject) {
    var pxPerMin = 0.85; // same scale as the day view — full-size, not a thumbnail
    var totalH = (axis.endMin - axis.startMin) * pxPerMin;
    var today = new Date();
    var mondayOffset = (today.getDay() + 6) % 7;
    var monday = new Date(today); monday.setDate(today.getDate() - mondayOffset);
    var order = [1, 2, 3, 4, 5];

    var wrap = el("div", "weekgrid");
    var hourColWrap = el("div", "week-hourcol-wrap");
    hourColWrap.appendChild(buildHourLabels(axis, pxPerMin));
    wrap.appendChild(hourColWrap);

    var scroller = el("div", "weekscroll");
    order.forEach(function (day, idx) {
      var date = new Date(monday); date.setDate(monday.getDate() + idx);
      var card = el("div", "daycard" + (series.length > 2 ? " wide" : ""));
      var isToday = date.toDateString() === today.toDateString();
      var dh = el("div", "dh", '<div class="dow' + (isToday ? " today" : "") + '">' + DOW_SHORT[day] + '</div><div class="dnum">' + date.getDate() + "</div>");
      card.appendChild(dh);
      var miniEl = el("div", "mini" + (series.length > 1 ? " dual" : ""));
      miniEl.style.height = totalH + "px";
      miniEl.appendChild(buildGridlines(axis, pxPerMin));
      series.forEach(function (s) { miniEl.appendChild(buildPersonCol(s.events, day, axis, pxPerMin, s.cls, bySubject)); });
      card.appendChild(miniEl);
      scroller.appendChild(card);
    });
    wrap.appendChild(scroller);
    container.appendChild(wrap);
  }

  // ---------- modal ----------
  function openModal(title, bodyHtml, buttons) {
    var layer = $("#modal-layer");
    var sheet = $("#modal-sheet");
    sheet.innerHTML = "<h3>" + title + "</h3><div>" + bodyHtml + "</div>";
    var row = el("div", "row");
    buttons.forEach(function (b) {
      var btn = el("button", "btn " + b.cls, b.label);
      btn.onclick = b.onClick;
      row.appendChild(btn);
    });
    sheet.appendChild(row);
    layer.classList.add("show");
    $("#modal-backdrop").onclick = closeModal;
    var firstInput = sheet.querySelector("input");
    if (firstInput) setTimeout(function () { firstInput.focus(); firstInput.select && firstInput.select(); }, 30);
  }
  function closeModal() { $("#modal-layer").classList.remove("show"); }

  init();

  return function cleanup() {
    if (authUnsub) { try { authUnsub(); } catch (e) {} }
    unsubs.forEach(function (u) { try { u(); } catch (e) {} });
    compareUnsubs.forEach(function (u) { try { u(); } catch (e) {} });
    stopNowLineTimer();
    stopFreeNowTimer();
    root.innerHTML = "";
  };
}
