// Hello World - a template extension. Adds a player-bar button that, when clicked,
// shows a little toast with whatever's playing. It's here to show the shape of an
// extension: build some UI, wire it up, and return a cleanup that undoes all of it.
//
// index.js is the body of function(Qobuzify, vendor). Alias the API as Q and go.
var Q = Qobuzify;
var CSS_ID = "hello-css";

// styles live in one <style> we own by id, so cleanup is a single remove()
Q.css(CSS_ID, [
  "#hello-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%) translateY(12px);",
  "z-index:2147483600;padding:10px 18px;border-radius:22px;font-size:13px;font-weight:600;",
  "color:#06090a;background:var(--qz-accent,#3DA8FE);opacity:0;pointer-events:none;",
  "transition:opacity .18s,transform .18s;white-space:nowrap;}",
  "#hello-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}"
].join(""));

var toastT = null;
function toast(msg) {
  var t = document.getElementById("hello-toast");
  if (!t) { t = document.createElement("div"); t.id = "hello-toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(function () { t.classList.remove("show"); }, 1800);
}

// the button. .qz-pbtn is the runtime's native-sized icon-button style.
var btn = Q.el('<button class="qz-pbtn" title="What\'s playing?"><span class="icon-magic-stars"></span></button>');
btn.addEventListener("click", function (e) {
  e.preventDefault(); e.stopPropagation();
  var t = Q.player.getTrack();
  toast(t && t.title ? t.artist + " - " + t.title : "Nothing playing");
});

// drop it into the player bar. the runtime places it and keeps it alive across re-renders.
var slot = Q.playerSlot({ id: "hello-world", zone: "right", order: 50, el: btn });

// undo everything: the slot, the toast node, the timer, the styles.
return function cleanup() {
  if (slot) slot.remove();
  clearTimeout(toastT);
  var t = document.getElementById("hello-toast"); if (t) t.remove();
  var st = document.getElementById(CSS_ID); if (st) st.remove();
};
