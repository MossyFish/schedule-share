import { auth, db, firebaseReady, normalize, syntheticEmail } from "@/lib/firebaseClient";
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
} from "firebase/firestore";

var DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var BYDAY_TO_NUM = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

var SHELL_HTML = `
  <!-- AUTH -->
  <div id="auth">
    <div class="brand">
      <div class="mark">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="18" height="18" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M8 2v4M16 2v4M3 10h18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><rect x="7" y="13" width="4.5" height="3.5" rx="1" fill="currentColor"/></svg>
      </div>
      <div class="brand-text">
        <h1>Schedule Share</h1>
        <p>Easy schedule comparison with friends</p>
      </div>
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
      </div>
    </main>
    <nav class="bottomnav" id="bottomnav">
      <button data-tab="schedule">
        <svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M8 2v4M16 2v4M3 10h18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        My Schedule
      </button>
      <button data-tab="friends">
        <svg viewBox="0 0 24 24" fill="none"><circle cx="9.5" cy="8.5" r="3.25" stroke="currentColor" stroke-width="1.8"/><path d="M4 20.5v-1a4 4 0 014-4h3a4 4 0 014 4v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.7 8a2.7 2.7 0 010 5.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M20 20.5v-1a3.7 3.7 0 00-2.5-3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        Friends
      </button>
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
  };
  var unsubs = [];
  var compareUnsub = null;
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
  function fmtTime(hhmm) {
    var p = hhmm.split(":"); var h = +p[0]; var m = p[1];
    var ap = h >= 12 ? "pm" : "am"; var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + (m === "00" ? "" : ":" + m) + ap;
  }
  function toast(msg) {
    var t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove("show"); }, 2400);
  }
  function displayNameOf(id) {
    var a = S.accounts.find(function (x) { return x.id === id; });
    return a ? a.displayName : id;
  }
  function nicknameOf(id) {
    var nick = S.profile && S.profile.nicknames && S.profile.nicknames[id];
    return nick || displayNameOf(id);
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
    var out = [];
    events.forEach(function (ev) {
      if (!ev.DTSTART) return;
      var title = ev.SUMMARY || "Class";
      var location = ev.LOCATION || "";
      var start = extractTime(ev.DTSTART);
      var end = ev.DTEND ? extractTime(ev.DTEND) : addMin(start, 50);
      var days = [];
      if (ev.RRULE && /FREQ=WEEKLY/.test(ev.RRULE)) {
        var m = /BYDAY=([^;]+)/.exec(ev.RRULE);
        if (m) days = m[1].split(",").map(function (d) { return BYDAY_TO_NUM[d]; }).filter(function (d) { return d !== undefined; });
      }
      if (!days.length) {
        var d0 = extractDate(ev.DTSTART);
        if (d0) days = [d0.getDay()];
      }
      days.forEach(function (day) { out.push({ day: day, start: start, end: end, title: title, location: location }); });
    });
    return out;
  }

  // ---------------- init ----------------
  function init() {
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
      var f = el("div", "field", '<label>Your name</label><input id="signup-name" type="text" placeholder="e.g. Fei Wang" autocomplete="name">');
      var fp = el("div", "field", '<label>Password</label><input id="signup-pass" type="password" placeholder="At least 6 characters" autocomplete="new-password">');
      frag.appendChild(f);
      frag.appendChild(fp);
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
    var submit = function () { (S.authMode === "signup" ? doSignup : doLogin)(); };
    frag.querySelectorAll("input").forEach(function (inp) {
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    });
    var inputToFocus = S.authMode === "signup" ? $("#signup-name") : $("#login-name");
    if (inputToFocus) inputToFocus.focus();
  }

  function showAuthScreen() {
    $("#auth").style.display = "flex";
    $("#app").style.display = "none";
    $("#compare").style.display = "none";
  }

  async function doSignup() {
    var name = $("#signup-name").value.trim();
    var password = $("#signup-pass").value;
    S.authError = "";
    if (!name) { S.authError = "Enter your name to continue."; renderAuth(); return; }
    if (password.length < 6) { S.authError = "Password must be at least 6 characters."; renderAuth(); return; }
    var id = normalize(name);
    var btn = $("#auth-body .btn-primary"); btn.disabled = true; btn.textContent = "Creating…";
    try {
      var cred = await createUserWithEmailAndPassword(auth, syntheticEmail(id), password);
      var uid = cred.user.uid;
      await setDoc(doc(db, "accounts/" + uid), { displayName: name, createdAt: new Date().toISOString() });
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
    if (compareUnsub) { try { compareUnsub(); } catch (e) {} compareUnsub = null; }
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
    unsubs.push(Db.collection("accounts").orderBy("displayName").limit(300).onSnapshot(function (snap) {
      S.accounts = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      if (S.activeTab === "friends") renderFriendsTab();
    }));
    unsubs.push(Db.collection("shares").where("from", "==", S.me.id).onSnapshot(function (snap) {
      S.sharesFrom = new Set(snap.docs.map(function (d) { return d.data().to; }));
      if (S.activeTab === "friends") renderFriendsTab();
    }));
    unsubs.push(Db.collection("shares").where("to", "==", S.me.id).onSnapshot(function (snap) {
      S.sharesTo = new Set(snap.docs.map(function (d) { return d.data().from; }));
      if (S.activeTab === "friends") renderFriendsTab();
    }));
    unsubs.push(Db.collection("notifications").where("to", "==", S.me.id).where("dismissed", "==", false).onSnapshot(function (snap) {
      S.notifications = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .sort(function (a, b) { return (b.createdAt || "").localeCompare(a.createdAt || ""); });
      renderNotifs();
    }));
    unsubs.push(Db.doc("schedules/" + S.me.id).onSnapshot(function (snap) {
      S.mySchedule = snap.exists ? snap.data() : null;
      if (S.activeTab === "schedule") renderScheduleTab();
    }));
    unsubs.push(Db.doc("profiles/" + S.me.id).onSnapshot(function (snap) {
      S.profile = snap.exists ? snap.data() : { nicknames: {} };
      if (S.activeTab === "friends") renderFriendsTab();
    }));
  }

  function renderHeader() {
    var h = $("#app-header");
    h.innerHTML = "";
    var left = el("div", "left");
    var av = el("div", "avatar", esc(initials(S.me.displayName)));
    var tw = el("div", "titlewrap", "<h2>Schedule Share</h2><p class=\"sub\">" + esc(S.me.displayName) + "</p>");
    left.appendChild(av); left.appendChild(tw);
    av.style.cursor = "pointer";
    av.onclick = openAccountMenu;
    h.appendChild(left);

    var bell = el("button", "iconbtn");
    bell.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M6 9a6 6 0 1112 0c0 4 1.5 5.5 1.5 5.5H4.5S6 13 6 9z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9.5 17.5a2.5 2.5 0 005 0" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
    if (S.notifications.length) bell.appendChild(el("span", "dot"));
    bell.onclick = function () { $("#notifs").scrollIntoView({ behavior: "smooth", block: "start" }); };
    h.appendChild(bell);
  }

  function openAccountMenu() {
    openModal(
      "Signed in as " + esc(S.me.displayName),
      '<p class="hint" style="margin:0;">Your login is remembered on this device.</p>',
      [
        { label: "Set password", cls: "btn-outline", onClick: function () { closeModal(); openSetPasswordModal(); } },
        { label: "Log out", cls: "btn-outline", onClick: function () { closeModal(); logout(); } },
        { label: "Close", cls: "btn-ghost", onClick: closeModal },
      ]
    );
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
    if (tab === "schedule") renderScheduleTab(); else renderFriendsTab();
  }

  // ---------- Notifications ----------
  function renderNotifs() {
    renderHeader();
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
      row.innerHTML = '<span class="swatch"></span><div><p>' + S.mySchedule.events.length + ' classes loaded <span class="muted">· from ' +
        (S.mySchedule.source === "ics" ? "Google Calendar file" : "screenshot") + '</span></p></div>';
      card.appendChild(row);
      var replaceBtn = el("button", "btn btn-outline btn-sm", "Replace schedule");
      replaceBtn.style.marginTop = "12px";
      replaceBtn.onclick = openUploadModal;
      card.appendChild(replaceBtn);
    } else {
      var grid = el("div", "upload-grid");
      var t1 = el("div", "upload-tile",
        '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M3 15l4.5-4.5 3 3L16 8l5 5" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/></svg>' +
        "<span>Upload screenshot</span><small>Upload screenshot of schedule</small>");
      var t2 = el("div", "upload-tile",
        '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="5" width="16" height="15" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M4 9.5H20" stroke="currentColor" stroke-width="1.7"/><path d="M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>' +
        "<span>Upload .ics file</span><small>From Google Calendar</small>");
      t1.onclick = function () { $("#file-shot").click(); };
      t2.onclick = function () { $("#file-ics").click(); };
      grid.appendChild(t1); grid.appendChild(t2);
      card.appendChild(grid);
    }
    uploadSec.appendChild(card);
    ensureHiddenFileInputs();

    var todaySec = $("#sec-today");
    todaySec.innerHTML = "";
    if (S.mySchedule && S.mySchedule.events && S.mySchedule.events.length) {
      var head = el("div", "sec-head");
      head.innerHTML = "<h3>Today</h3><span>" + new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) + "</span>";
      todaySec.appendChild(head);
      var todayCard = el("div", "card");
      var today = new Date().getDay();
      var todays = S.mySchedule.events.filter(function (e) { return e.day === today; }).sort(function (a, b) { return toMin(a.start) - toMin(b.start); });
      if (!todays.length) {
        todayCard.appendChild(el("p", "empty-note", "No classes today — enjoy the day off."));
      } else {
        todays.forEach(function (e, i) {
          var r = el("div", "status-row");
          r.style.borderBottom = i < todays.length - 1 ? "1px solid var(--line)" : "none";
          r.style.paddingBottom = "8px"; r.style.marginBottom = "8px";
          r.innerHTML = '<span class="swatch" style="background:var(--accent)"></span><div><p>' + esc(e.title) +
            '</p><p class="muted">' + fmtTime(e.start) + ' – ' + fmtTime(e.end) + (e.location ? " · " + esc(e.location) : "") + '</p></div>';
          todayCard.appendChild(r);
        });
      }
      todaySec.appendChild(todayCard);
    }
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
    var mutualIds = S.accounts.map(function (a) { return a.id; })
      .filter(function (id) { return id !== S.me.id && S.sharesFrom.has(id) && S.sharesTo.has(id); });

    var mutualSec = $("#sec-mutual");
    mutualSec.innerHTML = '<div class="sec-head"><h3>Mutual shares</h3><span>' + mutualIds.length + "</span></div>";
    var mCard = el("div", "card");
    if (!mutualIds.length) {
      mCard.appendChild(el("p", "empty-note", "No mutual shares yet. Share your schedule with someone below, and once they share back, they'll show up here."));
    } else {
      mutualIds.forEach(function (id) {
        var row = el("div", "person-row mutual-row");
        var av = el("div", "avatar a2", esc(initials(displayNameOf(id))));
        var name = el("div", "name", '<div class="n1">' + esc(nicknameOf(id)) + "</div>" +
          (nicknameOf(id) !== displayNameOf(id) ? '<div class="n2">' + esc(displayNameOf(id)) + "</div>" : ""));
        var pencil = el("button", "pencil", '<svg viewBox="0 0 24 24" fill="none"><path d="M4 20l.9-3.6L15.6 5.7a1.5 1.5 0 012.1 0l1.6 1.6a1.5 1.5 0 010 2.1L8.6 20.1 4 20z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>');
        pencil.onclick = function (ev) { ev.stopPropagation(); openNicknameModal(id); };
        var chev = el("div", "chevron", '<svg viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>');
        row.appendChild(av); row.appendChild(name); row.appendChild(pencil); row.appendChild(chev);
        row.onclick = function () { openCompare(id); };
        mCard.appendChild(row);
      });
    }
    mutualSec.appendChild(mCard);

    var dirSec = $("#sec-directory");
    dirSec.innerHTML = '<div class="sec-head"><h3>Share with classmates</h3></div>';
    var others = S.accounts.filter(function (a) { return a.id !== S.me.id; });
    var searchRow = el("div", "search-row",
      '<svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.7"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>' +
      '<input type="text" id="friend-search" placeholder="Search by name">');
    dirSec.appendChild(searchRow);
    var dCard = el("div", "card");
    if (!others.length) {
      dCard.appendChild(el("p", "empty-note", "No other classmates have signed up yet."));
    } else {
      others.forEach(function (a) {
        var row = el("div", "person-row");
        row.dataset.name = a.displayName.toLowerCase();
        var av = el("div", "avatar", esc(initials(a.displayName)));
        var name = el("div", "name", '<div class="n1">' + esc(a.displayName) + "</div>");
        row.appendChild(av); row.appendChild(name);
        if (S.sharesFrom.has(a.id)) {
          var badge = el("button", "btn btn-ghost btn-sm", "Shared ✓");
          badge.onclick = function () { unshareWith(a.id); };
          row.appendChild(badge);
        } else {
          var shareBtn = el("button", "btn btn-primary btn-sm", "Share");
          shareBtn.onclick = function () { shareWith(a.id); };
          row.appendChild(shareBtn);
        }
        dCard.appendChild(row);
      });
    }
    dirSec.appendChild(dCard);

    $("#friend-search").addEventListener("input", function (e) {
      var q = e.target.value.trim().toLowerCase();
      dCard.querySelectorAll(".person-row").forEach(function (r) {
        r.style.display = !q || r.dataset.name.indexOf(q) !== -1 ? "flex" : "none";
      });
    });
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

  // ---------- Compare view ----------
  function computeAxis(events) {
    var startMin = 7 * 60, endMin = 22 * 60;
    events.forEach(function (e) {
      var s = toMin(e.start), en = toMin(e.end);
      if (s < startMin) startMin = Math.floor(s / 60) * 60;
      if (en > endMin) endMin = Math.ceil(en / 60) * 60;
    });
    return { startMin: startMin, endMin: endMin };
  }

  async function openCompare(targetId) {
    S.compare = { targetId: targetId, mode: "day", schedule: null };
    $("#app").style.display = "none";
    $("#compare").style.display = "flex";
    renderCompareHeader();
    renderCompareLegend();
    $("#compare-body").innerHTML = '<div class="busy" style="padding:20px;"><span class="spinner"></span><span>Loading schedule…</span></div>';
    if (compareUnsub) { try { compareUnsub(); } catch (e) {} }
    compareUnsub = Db.doc("schedules/" + targetId).onSnapshot(function (snap) {
      S.compare.schedule = snap.exists ? snap.data() : null;
      renderCompareBody();
    });
  }

  function closeCompare() {
    if (compareUnsub) { try { compareUnsub(); } catch (e) {} compareUnsub = null; }
    S.compare = null;
    $("#compare").style.display = "none";
    $("#app").style.display = "flex";
  }

  function renderCompareHeader() {
    var h = $("#compare-header");
    h.innerHTML = "";
    var left = el("div", "left");
    var back = el("button", "backbtn", '<svg viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>');
    back.onclick = closeCompare;
    var tw = el("div", "titlewrap", "<h2>" + esc(nicknameOf(S.compare.targetId)) + '</h2><p class="sub">vs. you</p>');
    left.appendChild(back); left.appendChild(tw);
    h.appendChild(left);

    var toggle = el("div", "modewtoggle", '<button data-mode="day">Day</button><button data-mode="week">Week</button>');
    toggle.querySelector('[data-mode="' + S.compare.mode + '"]').classList.add("active");
    toggle.querySelectorAll("button").forEach(function (b) {
      b.onclick = function () { S.compare.mode = b.dataset.mode; renderCompareHeader(); renderCompareBody(); };
    });
    h.appendChild(toggle);
  }

  function renderCompareLegend() {
    var l = $("#legend");
    l.innerHTML = '<div class="item"><span class="dot" style="background:var(--accent)"></span>You</div>' +
      '<div class="item"><span class="dot" style="background:var(--accent2)"></span>' + esc(nicknameOf(S.compare.targetId)) + "</div>";
  }

  function renderCompareBody() {
    renderCompareLegend();
    var body = $("#compare-body");
    body.innerHTML = "";
    var mine = (S.mySchedule && S.mySchedule.events) || [];
    var theirs = (S.compare.schedule && S.compare.schedule.events) || [];
    if (!mine.length && !theirs.length) {
      body.innerHTML = '<p class="empty-note" style="padding:20px 16px;">Neither of you has uploaded a schedule yet.</p>';
      return;
    }
    var axis = computeAxis(mine.concat(theirs));
    if (S.compare.mode === "day") {
      renderDayView(body, axis, mine, theirs, new Date().getDay());
    } else {
      renderWeekView(body, axis, mine, theirs);
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

  function buildPersonCol(events, day, axis, pxPerMin, cls, mini) {
    var col = el("div", "personcol " + cls);
    events.filter(function (e) { return e.day === day; }).forEach(function (e) {
      var s = toMin(e.start), en = Math.max(toMin(e.end), s + 15);
      var top = (s - axis.startMin) * pxPerMin;
      var height = Math.max((en - s) * pxPerMin, mini ? 6 : 16);
      var box = el("div", "evt " + (cls === "you" ? "you" : "them"));
      box.style.top = top + "px"; box.style.height = height + "px";
      if (!mini) {
        box.innerHTML = '<span class="t">' + esc(e.title) + '</span>' +
          (e.location ? '<span class="l">' + esc(e.location) + "</span>" : "") +
          '<span class="time">' + fmtTime(e.start) + "–" + fmtTime(e.end) + "</span>";
      }
      col.appendChild(box);
    });
    return col;
  }

  function renderDayView(container, axis, mine, theirs, day) {
    var pxPerMin = 0.85;
    var wrap = el("div", "daywrap");
    var grid = el("div", "daygrid");
    grid.appendChild(buildHourLabels(axis, pxPerMin));
    var planes = el("div", "planecols");
    planes.style.height = ((axis.endMin - axis.startMin) * pxPerMin) + "px";
    planes.appendChild(buildGridlines(axis, pxPerMin));
    planes.appendChild(buildPersonCol(mine, day, axis, pxPerMin, "you", false));
    planes.appendChild(buildPersonCol(theirs, day, axis, pxPerMin, "them", false));
    grid.appendChild(planes);
    wrap.appendChild(grid);
    container.appendChild(wrap);
  }

  function renderWeekView(container, axis, mine, theirs) {
    var pxPerMin = 0.22;
    var scroller = el("div", "weekscroll");
    var today = new Date();
    var mondayOffset = (today.getDay() + 6) % 7;
    var monday = new Date(today); monday.setDate(today.getDate() - mondayOffset);
    var order = [1, 2, 3, 4, 5, 6, 0];
    order.forEach(function (day, idx) {
      var date = new Date(monday); date.setDate(monday.getDate() + idx);
      var card = el("div", "daycard");
      var isToday = date.toDateString() === today.toDateString();
      var dh = el("div", "dh", '<div class="dow' + (isToday ? " today" : "") + '">' + DOW_SHORT[day] + '</div><div class="dnum">' + date.getDate() + "</div>");
      card.appendChild(dh);
      var miniEl = el("div", "mini");
      miniEl.style.height = ((axis.endMin - axis.startMin) * pxPerMin) + "px";
      miniEl.appendChild(buildPersonCol(mine, day, axis, pxPerMin, "you", true));
      miniEl.appendChild(buildPersonCol(theirs, day, axis, pxPerMin, "them", true));
      card.appendChild(miniEl);
      scroller.appendChild(card);
    });
    container.appendChild(scroller);
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
    if (compareUnsub) { try { compareUnsub(); } catch (e) {} }
    root.innerHTML = "";
  };
}
