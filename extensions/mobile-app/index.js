// Qobuzify Mobile App. Runs as function(Qobuzify){ ... return cleanup }.
//
// Qobuz's web player ships zero mobile layout - its chrome is desktop position:fixed with hardcoded
// coordinates, so every attempt to *skin* it into a phone UI leaves things cut off. This stops fighting
// that: on a narrow screen it HIDES Qobuz's entire UI and renders our own full-screen mobile app in a
// container we fully own, so nothing can be cut off - it's our DOM. Qobuz stays mounted underneath as
// the engine only: auth + the JSON API (Q.api) + the audio player + the native album pages we
// navigate-invisibly-and-click to start playback (the same proven path better-search uses). The whole
// thing is inert on desktop / wide windows and self-cleans on cleanup.
var Q = Qobuzify;

var MOBILE_MAX = 1023;               // <= this (CSS px) counts as mobile; matches Qobuz's own breakpoint
var APP_CLASS = "qz-app";            // on <html> while our UI owns the screen
var ROOT_ID = "qz-app-root";
var CSS_ID = "qz-app-css";
var ACCENT = "#3DA8FE";              // Qobuzify Electric-Blue

// ------------------------------------------------------------------ tiny utils
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
function h(html) { var t = document.createElement("template"); t.innerHTML = (html || "").trim(); return t.content.firstElementChild; }
function fmtDur(sec) { sec = Math.max(0, Math.round(sec || 0)); var m = Math.floor(sec / 60), s = sec % 60; return m + ":" + (s < 10 ? "0" : "") + s; }
// image url off any Qobuz object (album/track/playlist/artist), same field order better-search uses
function cover(o) {
  if (!o) return "";
  var im = o.image || o.picture || o.cover || (o.images300 && o.images300[0]) || (o.images && o.images[0]);
  if (!im && o.album) return cover(o.album);
  if (typeof im === "string") return im;
  return (im && (im.large || im.medium || im.small || im.thumbnail)) || "";
}
// Qobuz covers are static.qobuz.com/.../{id}_{size}.jpg. The player bar (and thus getTrack().cover) is only
// 230px, which looks soft blown up to the full-screen Now-Playing art. Swap the size suffix for a bigger one.
function hiCover(url, size) {
  if (!url || typeof url !== "string") return url || "";
  return url.replace(/_(\d+|org|max)(\.[a-z0-9]+)(\?.*)?$/i, "_" + size + "$2$3");
}
// Build a hi-res <img> for large art: request the original, stepping down to _600 then the source thumbnail
// if a size isn't served (Qobuz always has _600; _org is the crisp original when present).
function bigArtImg(url) {
  var steps = [], seen = {};
  [hiCover(url, "org"), hiCover(url, 600), url].forEach(function (u) { if (u && !seen[u]) { seen[u] = 1; steps.push(u); } });
  var img = new Image(), i = 0;
  img.decoding = "async";
  img.onerror = function () { i++; if (i < steps.length) img.src = steps[i]; else img.onerror = null; };
  img.src = steps[0];
  return img;
}
function albumOf(t) { return (t && t.album) || null; }
function artistName(o) { return (o && ((o.performer && o.performer.name) || (o.artist && o.artist.name) || o.name || (o.artists && o.artists[0] && o.artists[0].name))) || ""; }

// ------------------------------------------------------------------ icons (Qobuz 9.11 beta vector set,
// decoded from the APK VectorDrawables; monochrome, tinted via CSS currentColor)
var IC = {
  home: '<svg viewBox="0 0 24 24" fill="none"><path d="M6,18.755H9.346V12.812H14.654V18.755H18V9.755L12,5.235L6,9.755V18.755ZM6,20.255C5.591,20.255 5.239,20.107 4.943,19.811C4.648,19.516 4.5,19.164 4.5,18.755V9.755C4.5,9.518 4.553,9.294 4.659,9.082C4.765,8.87 4.911,8.696 5.098,8.559L11.098,4.039C11.236,3.938 11.381,3.864 11.531,3.816C11.681,3.769 11.837,3.745 12,3.745C12.163,3.745 12.319,3.769 12.469,3.816C12.619,3.864 12.763,3.938 12.902,4.039L18.902,8.559C19.089,8.696 19.235,8.87 19.341,9.082C19.447,9.294 19.5,9.518 19.5,9.755V18.755C19.5,19.164 19.352,19.516 19.057,19.811C18.761,20.107 18.409,20.255 18,20.255H13.154V14.312H10.846V20.255H6Z" fill="currentColor"/></svg>',
  search: '<svg viewBox="0 0 31 30" fill="none"><path d="M12.35 19.74c-2.14 0-3.95-0.74-5.43-2.22-1.48-1.49-2.22-3.3-2.22-5.43s0.74-3.94 2.22-5.42c1.48-1.48 3.3-2.22 5.43-2.22s3.94 0.74 5.42 2.22c1.48 1.48 2.22 3.29 2.22 5.42 0 0.9-0.15 1.75-0.45 2.56-0.3 0.81-0.7 1.52-1.2 2.12l7.2 7.2c0.17 0.17 0.25 0.38 0.26 0.65 0 0.26-0.09 0.48-0.27 0.66-0.18 0.18-0.4 0.27-0.66 0.27-0.25 0-0.47-0.09-0.65-0.27l-7.2-7.2c-0.62 0.52-1.34 0.93-2.15 1.22-0.82 0.3-1.66 0.44-2.52 0.44Zm0-1.88c1.6 0 2.97-0.56 4.09-1.68 1.12-1.11 1.67-2.48 1.67-4.09 0-1.6-0.55-2.97-1.67-4.09-1.12-1.12-2.48-1.68-4.1-1.68-1.6 0-2.97 0.56-4.09 1.68-1.11 1.12-1.67 2.48-1.67 4.1 0 1.6 0.56 2.97 1.67 4.08 1.12 1.12 2.48 1.68 4.1 1.68Z" fill="currentColor"/></svg>',
  library: '<svg viewBox="0 0 24 25" fill="none"><path d="M10.83 19.61c0.53 0 0.97-0.18 1.33-0.54 0.37-0.37 0.55-0.81 0.55-1.33v-4.6h1.6c0.2 0 0.38-0.06 0.52-0.2 0.14-0.15 0.22-0.32 0.22-0.53 0-0.2-0.08-0.38-0.22-0.52s-0.32-0.22-0.52-0.22h-1.6c-0.2 0-0.38 0.08-0.52 0.22s-0.21 0.32-0.21 0.52v3.84c-0.16-0.12-0.34-0.22-0.53-0.29-0.2-0.07-0.4-0.1-0.62-0.1-0.52 0-0.97 0.18-1.33 0.54-0.36 0.37-0.55 0.81-0.55 1.34 0 0.52 0.19 0.96 0.55 1.33 0.36 0.36 0.8 0.54 1.33 0.54Z" fill="currentColor"/><path d="M3.03 21.63c0.35 0.35 0.77 0.52 1.28 0.52h15.38c0.5 0 0.93-0.17 1.29-0.52 0.34-0.35 0.52-0.78 0.52-1.28v-9.39c0-0.5-0.18-0.93-0.52-1.28-0.36-0.35-0.78-0.53-1.29-0.53H4.31c-0.5 0-0.93 0.18-1.28 0.53-0.35 0.35-0.53 0.78-0.53 1.28v9.39c0 0.5 0.18 0.93 0.53 1.28Zm16.66-0.98H4.31c-0.08 0-0.15-0.03-0.21-0.1C4.03 20.5 4 20.43 4 20.36v-9.39c0-0.08 0.03-0.15 0.1-0.21 0.06-0.06 0.13-0.1 0.2-0.1h15.4c0.07 0 0.14 0.04 0.2 0.1 0.07 0.06 0.1 0.13 0.1 0.21v9.39c0 0.07-0.03 0.14-0.1 0.2-0.06 0.07-0.13 0.1-0.2 0.1Z" fill="currentColor"/><path d="M4.47 7.55C4.6 7.7 4.79 7.77 5 7.77h14c0.21 0 0.4-0.07 0.53-0.22 0.15-0.14 0.22-0.32 0.22-0.53 0-0.21-0.07-0.4-0.22-0.54C19.4 6.34 19.21 6.27 19 6.27H5c-0.21 0-0.4 0.07-0.53 0.21-0.15 0.15-0.22 0.33-0.22 0.54 0 0.21 0.07 0.39 0.22 0.53Z" fill="currentColor"/><path d="M7.47 4.67C7.6 4.8 7.79 4.88 8 4.88h8c0.21 0 0.4-0.07 0.53-0.21 0.15-0.14 0.22-0.32 0.22-0.54 0-0.2-0.07-0.39-0.22-0.53C16.4 3.46 16.21 3.38 16 3.38H8c-0.21 0-0.4 0.08-0.53 0.22-0.15 0.14-0.22 0.32-0.22 0.53 0 0.22 0.07 0.4 0.22 0.54Z" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none"><path d="M9.88 17.22c-0.3 0.2-0.6 0.2-0.92 0.03-0.3-0.18-0.46-0.44-0.46-0.8v-8.9c0-0.36 0.15-0.62 0.46-0.8 0.31-0.18 0.62-0.16 0.92 0.03l7 4.46c0.27 0.18 0.4 0.43 0.4 0.76s-0.13 0.58-0.4 0.76l-7 4.46Z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none"><path d="M15.5 18.5c-0.4 0-0.76-0.15-1.06-0.44C14.14 17.76 14 17.4 14 17V7c0-0.4 0.15-0.76 0.44-1.06 0.3-0.3 0.65-0.44 1.06-0.44h0.75c0.4 0 0.76 0.15 1.06 0.44 0.3 0.3 0.44 0.65 0.44 1.06v10c0 0.4-0.15 0.76-0.44 1.06-0.3 0.3-0.65 0.44-1.06 0.44H15.5Zm-7.75 0c-0.4 0-0.76-0.15-1.06-0.44-0.3-0.3-0.44-0.65-0.44-1.06V7c0-0.4 0.15-0.76 0.44-1.06C7 5.64 7.34 5.5 7.75 5.5H8.5c0.4 0 0.76 0.15 1.06 0.44C9.86 6.24 10 6.6 10 7v10c0 0.4-0.15 0.76-0.44 1.06-0.3 0.3-0.65 0.44-1.06 0.44H7.75Z" fill="currentColor"/></svg>',
  next: '<svg viewBox="0 0 48 48" fill="none"><path d="M34.269,34.615C33.843,34.615 33.487,34.472 33.2,34.184C32.913,33.897 32.769,33.54 32.769,33.115V14.885C32.769,14.46 32.913,14.104 33.201,13.816C33.488,13.528 33.845,13.385 34.27,13.385C34.695,13.385 35.051,13.528 35.338,13.816C35.626,14.104 35.769,14.46 35.769,14.885V33.115C35.769,33.54 35.625,33.897 35.338,34.184C35.05,34.472 34.694,34.615 34.269,34.615ZM15.042,32.758C14.44,33.186 13.821,33.219 13.185,32.858C12.549,32.496 12.231,31.954 12.231,31.231V16.769C12.231,16.041 12.549,15.503 13.185,15.154C13.821,14.805 14.44,14.835 15.042,15.243L25.904,22.504C26.44,22.867 26.708,23.366 26.708,24.001C26.708,24.636 26.44,25.135 25.904,25.496L15.042,32.758Z" fill="currentColor"/></svg>',
  prev: '<svg viewBox="0 0 48 48" fill="none"><path d="M13.73,34.615C13.305,34.615 12.949,34.472 12.662,34.184C12.374,33.897 12.231,33.54 12.231,33.115V14.885C12.231,14.46 12.375,14.104 12.662,13.816C12.95,13.528 13.306,13.385 13.731,13.385C14.157,13.385 14.513,13.528 14.8,13.816C15.087,14.104 15.231,14.46 15.231,14.885V33.115C15.231,33.54 15.087,33.897 14.799,34.184C14.512,34.472 14.155,34.615 13.73,34.615ZM32.958,32.758L22.096,25.496C21.56,25.133 21.292,24.634 21.292,23.999C21.292,23.364 21.56,22.865 22.096,22.504L32.958,15.243C33.56,14.835 34.179,14.805 34.815,15.154C35.451,15.503 35.769,16.041 35.769,16.769V31.231C35.769,31.954 35.451,32.496 34.815,32.858C34.179,33.219 33.56,33.186 32.958,32.758Z" fill="currentColor"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24" fill="none"><path d="M17.254,9.431V8.018C17.002,8.08 16.749,8.161 16.478,8.266C15.394,8.688 14.597,9.439 13.87,10.406C13.505,10.891 13.166,11.421 12.816,11.985C12.739,12.11 12.66,12.237 12.581,12.366C12.309,12.808 12.026,13.267 11.729,13.714C10.567,15.461 8.48,17.279 4.593,18.402C4.195,18.517 3.779,18.288 3.664,17.89C3.549,17.492 3.779,17.076 4.177,16.961C7.761,15.925 9.536,14.303 10.48,12.883C10.761,12.46 11.026,12.031 11.295,11.593C11.377,11.461 11.459,11.328 11.542,11.194C11.895,10.625 12.264,10.047 12.671,9.505C13.49,8.415 14.493,7.429 15.934,6.868C16.401,6.687 16.831,6.565 17.254,6.482V4.726C17.254,4.356 17.708,4.163 17.969,4.432L20.309,6.78C20.469,6.948 20.469,7.209 20.309,7.378L17.969,9.726C17.708,9.995 17.254,9.81 17.254,9.431Z" fill="currentColor"/><path d="M3.58,6.69C3.646,6.281 4.03,6.002 4.439,6.067C5.508,6.237 6.414,6.437 7.31,6.948C8.201,7.457 9.024,8.238 10.016,9.465C10.276,9.787 10.226,10.259 9.904,10.52C9.582,10.78 9.11,10.73 8.849,10.408C7.908,9.243 7.223,8.626 6.567,8.251C5.915,7.88 5.232,7.712 4.203,7.548C3.794,7.483 3.515,7.099 3.58,6.69Z" fill="currentColor"/><path d="M13.287,14.124C13.59,13.841 14.064,13.857 14.347,14.16C15.054,14.916 15.722,15.398 16.417,15.703C16.684,15.821 16.961,15.915 17.254,15.989V14.569C17.254,14.19 17.708,14.005 17.969,14.274L20.309,16.622C20.469,16.791 20.469,17.052 20.309,17.22L17.969,19.568C17.708,19.837 17.254,19.644 17.254,19.274V17.526C16.757,17.427 16.278,17.281 15.812,17.076C14.896,16.673 14.068,16.057 13.251,15.184C12.969,14.882 12.984,14.407 13.287,14.124Z" fill="currentColor"/></svg>',
  repeat: '<svg viewBox="0 0 24 24" fill="none"><path d="M16.454,9.175V7.598C16.445,7.598 16.437,7.597 16.428,7.597C13.581,7.499 11.502,7.537 9.978,7.703C8.443,7.871 7.549,8.162 7.012,8.511C6.519,8.832 6.277,9.234 6.133,9.809C6,10.336 5.962,10.948 5.913,11.741C5.903,11.901 5.892,12.069 5.881,12.245C5.853,12.659 5.495,12.971 5.082,12.944C4.669,12.916 4.356,12.558 4.384,12.145C4.394,11.993 4.403,11.841 4.413,11.69C4.461,10.899 4.509,10.118 4.678,9.444C4.894,8.583 5.32,7.823 6.195,7.254C7.025,6.714 8.197,6.389 9.815,6.212C11.44,6.035 13.594,5.999 16.454,6.097V4.47C16.454,4.1 16.908,3.906 17.169,4.175L19.509,6.524C19.669,6.692 19.669,6.953 19.509,7.121L17.169,9.469C16.908,9.739 16.454,9.553 16.454,9.175Z" fill="currentColor"/><path d="M7.546,14.825V16.407C10.325,16.5 12.363,16.461 13.863,16.297C15.398,16.129 16.292,15.838 16.829,15.488C17.322,15.168 17.564,14.766 17.708,14.191C17.841,13.664 17.879,13.052 17.928,12.259C17.938,12.099 17.949,11.931 17.96,11.755C17.988,11.341 18.346,11.029 18.759,11.056C19.172,11.084 19.485,11.442 19.457,11.855C19.447,12.006 19.438,12.158 19.428,12.31C19.38,13.1 19.332,13.882 19.163,14.556C18.947,15.417 18.521,16.177 17.646,16.746C16.816,17.286 15.644,17.611 14.026,17.788C12.431,17.962 10.327,17.999 7.546,17.908V19.53C7.546,19.9 7.092,20.094 6.831,19.825L4.491,17.476C4.331,17.308 4.331,17.047 4.491,16.879L6.831,14.531C7.092,14.261 7.546,14.446 7.546,14.825Z" fill="currentColor"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none"><path d="M20,11H7.83l5.59,-5.59L12,4l-8,8 8,8 1.41,-1.41L7.83,13H20v-2z" fill="currentColor"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none"><path d="M11.06 16.8V5.44c0-0.22 0.07-0.4 0.21-0.54 0.15-0.14 0.33-0.21 0.54-0.21 0.21 0 0.39 0.07 0.53 0.21 0.15 0.14 0.22 0.32 0.22 0.54V16.8l3.3-3.3c0.14-0.14 0.31-0.22 0.51-0.22s0.38 0.08 0.54 0.22c0.15 0.16 0.23 0.34 0.24 0.54 0 0.2-0.07 0.38-0.23 0.53l-4.48 4.48c-0.1 0.1-0.2 0.16-0.3 0.2-0.1 0.04-0.21 0.06-0.33 0.06-0.12 0-0.23-0.02-0.34-0.06-0.1-0.04-0.2-0.1-0.3-0.2L6.7 14.57c-0.15-0.14-0.22-0.32-0.22-0.53 0-0.2 0.08-0.38 0.23-0.54 0.16-0.14 0.33-0.22 0.53-0.22s0.37 0.07 0.53 0.22l3.29 3.3Z" fill="currentColor"/></svg>',
  disc: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 11.7c-0.96 0-1.79-0.35-2.47-1.04C8.84 9.98 8.5 9.16 8.5 8.2c0-0.96 0.34-1.78 1.03-2.47C10.2 5.04 11.03 4.7 12 4.7c0.96 0 1.79 0.35 2.47 1.03 0.69 0.69 1.03 1.51 1.03 2.47 0 0.96-0.34 1.79-1.03 2.47-0.68 0.69-1.5 1.03-2.47 1.03Zm5.98 7.6H6.02c-0.42 0-0.78-0.14-1.08-0.44-0.3-0.3-0.44-0.65-0.44-1.07v-0.7c0-0.5 0.13-0.95 0.4-1.37 0.27-0.41 0.62-0.73 1.07-0.96 0.98-0.48 1.98-0.85 2.99-1.09 1-0.24 2.02-0.36 3.04-0.36s2.04 0.12 3.04 0.36 2 0.6 3 1.1c0.44 0.22 0.8 0.54 1.06 0.95 0.27 0.42 0.4 0.87 0.4 1.36v0.7c0 0.43-0.15 0.79-0.44 1.08-0.3 0.3-0.66 0.45-1.08 0.45ZM6 17.8h12v-0.72c0-0.2-0.06-0.39-0.18-0.56-0.11-0.17-0.27-0.31-0.47-0.42-0.87-0.42-1.74-0.75-2.64-0.96-0.9-0.22-1.8-0.33-2.71-0.33-0.91 0-1.82 0.1-2.71 0.33-0.9 0.21-1.77 0.54-2.64 0.96-0.2 0.1-0.36 0.25-0.47 0.42C6.06 16.7 6 16.88 6 17.08v0.73Zm6-7.6c0.55 0 1.02-0.2 1.41-0.6C13.81 9.21 14 8.74 14 8.2c0-0.56-0.2-1.03-0.59-1.42-0.39-0.4-0.86-0.59-1.41-0.59-0.55 0-1.02 0.2-1.41 0.59C10.19 7.18 10 7.64 10 8.19c0 0.55 0.2 1.02 0.59 1.41 0.39 0.4 0.86 0.6 1.41 0.6Z" fill="currentColor"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none"><path d="M10.03 20.4c-0.96 0-1.79-0.34-2.47-1.02-0.69-0.69-1.03-1.51-1.03-2.48 0-0.96 0.34-1.78 1.03-2.47 0.68-0.68 1.5-1.03 2.47-1.03 0.38 0 0.74 0.06 1.08 0.17 0.33 0.12 0.64 0.29 0.92 0.52V5.4c0-0.5 0.18-0.92 0.53-1.27 0.35-0.36 0.78-0.53 1.28-0.53h2c0.45 0 0.83 0.16 1.15 0.48 0.32 0.32 0.48 0.7 0.48 1.15 0 0.45-0.16 0.83-0.48 1.15-0.32 0.32-0.7 0.49-1.15 0.49h-2.31V16.9c0 0.97-0.34 1.79-1.03 2.48-0.68 0.68-1.5 1.02-2.47 1.02Z" fill="currentColor"/></svg>',
  lyrics: '<svg viewBox="0 0 20 20" fill="none"><path d="M3.12 5.82C3.47 5.76 3.8 5.99 3.85 6.34 3.9 6.67 3.67 6.99 3.34 7.05L3.1 7.1C3.03 7.1 2.98 7.14 2.94 7.2 2.9 7.25 2.88 7.31 2.9 7.4l1.5 8.71c0.02 0.08 0.05 0.13 0.1 0.17 0.06 0.04 0.13 0.06 0.2 0.04l4.57-0.79c0.34-0.05 0.66 0.17 0.72 0.51 0.06 0.34-0.17 0.67-0.51 0.73L4.9 17.55c-0.41 0.07-0.79-0.02-1.13-0.25-0.33-0.24-0.54-0.57-0.6-0.98L1.66 7.6c-0.08-0.41 0-0.8 0.24-1.13 0.24-0.33 0.57-0.54 0.98-0.61l0.23-0.04Z" fill="currentColor"/><path d="M9.81 5.5c0.94 0 1.7 0.76 1.7 1.7 0 0.36-0.12 0.69-0.31 0.96l-1.46 2.52c-0.22 0.4-0.73 0.54-1.13 0.3-0.4-0.22-0.54-0.73-0.3-1.13l0.68-1.18C8.47 8.38 8.12 7.83 8.12 7.2c0-0.94 0.76-1.7 1.7-1.7Z" fill="currentColor"/><path d="M13.7 5.64c0.93 0 1.7 0.76 1.7 1.7 0 0.4-0.15 0.76-0.38 1.05l-1.32 2.3c-0.23 0.4-0.74 0.53-1.14 0.3-0.4-0.23-0.53-0.74-0.3-1.14l0.6-1.04c-0.5-0.3-0.85-0.84-0.85-1.47 0-0.94 0.76-1.7 1.69-1.7Z" fill="currentColor"/><path d="M16.85 2.43c0.42 0 0.78 0.15 1.07 0.44 0.3 0.29 0.44 0.65 0.44 1.07v8.84c0 0.42-0.15 0.78-0.44 1.07-0.29 0.3-0.65 0.44-1.07 0.44H6.33c-0.42 0-0.77-0.15-1.07-0.44-0.29-0.29-0.43-0.65-0.43-1.07V3.94c0-0.42 0.14-0.78 0.43-1.07 0.3-0.3 0.65-0.44 1.07-0.44h10.52ZM6.33 3.68c-0.07 0-0.13 0.02-0.18 0.07C6.1 3.8 6.08 3.86 6.08 3.94v8.84c0 0.08 0.02 0.14 0.07 0.19 0.05 0.04 0.1 0.07 0.18 0.07h10.52c0.08 0 0.14-0.03 0.19-0.07 0.05-0.05 0.07-0.11 0.07-0.19V3.94c0-0.08-0.02-0.14-0.07-0.19-0.05-0.05-0.11-0.07-0.19-0.07H6.33Z" fill="currentColor"/></svg>',
  laptop: '<svg viewBox="0 0 24 24" fill="none"><path d="M2.5,18.192V6.115C2.5,5.618 2.677,5.193 3.031,4.839C3.385,4.485 3.811,4.308 4.308,4.308H19.692C20.189,4.308 20.615,4.485 20.969,4.839C21.323,5.193 21.5,5.618 21.5,6.115V18.192H22.75C22.962,18.192 23.141,18.264 23.284,18.408C23.428,18.552 23.5,18.73 23.5,18.942C23.5,19.155 23.428,19.333 23.284,19.477C23.141,19.62 22.962,19.692 22.75,19.692H1.25C1.038,19.692 0.859,19.62 0.716,19.476C0.572,19.333 0.5,19.154 0.5,18.942C0.5,18.729 0.572,18.551 0.716,18.407C0.859,18.264 1.038,18.192 1.25,18.192H2.5ZM10.442,18.192H13.558C13.676,18.192 13.779,18.148 13.867,18.059C13.956,17.971 14,17.868 14,17.75C14,17.632 13.956,17.529 13.867,17.44C13.779,17.352 13.676,17.308 13.558,17.308H10.442C10.324,17.308 10.221,17.352 10.133,17.44C10.044,17.529 10,17.632 10,17.75C10,17.868 10.044,17.971 10.133,18.059C10.221,18.148 10.324,18.192 10.442,18.192ZM4,15.808H20V6.115C20,6.026 19.971,5.952 19.913,5.894C19.856,5.836 19.782,5.808 19.692,5.808H4.308C4.218,5.808 4.144,5.836 4.087,5.894C4.029,5.952 4,6.026 4,6.115V15.808Z" fill="currentColor"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none"><path d="M11.99 20.28c-0.21 0-0.43-0.04-0.64-0.12-0.22-0.07-0.41-0.2-0.57-0.36l-1.44-1.3c-1.77-1.62-3.36-3.2-4.75-4.77-1.4-1.56-2.09-3.23-2.09-5.01 0-1.42 0.48-2.6 1.44-3.56C4.89 4.2 6.08 3.72 7.5 3.72c0.8 0 1.6 0.19 2.39 0.56 0.79 0.37 1.49 0.97 2.11 1.8 0.62-0.83 1.32-1.43 2.11-1.8 0.79-0.37 1.58-0.56 2.39-0.56 1.42 0 2.6 0.48 3.56 1.44 0.96 0.95 1.44 2.14 1.44 3.56 0 1.8-0.7 3.5-2.13 5.07-1.41 1.58-3 3.15-4.73 4.72l-1.42 1.3c-0.17 0.16-0.36 0.28-0.58 0.35-0.22 0.08-0.44 0.12-0.65 0.12Zm-0.7-12.67c-0.55-0.83-1.12-1.43-1.72-1.81C8.97 5.4 8.28 5.22 7.5 5.22c-1 0-1.83 0.33-2.5 1-0.67 0.67-1 1.5-1 2.5 0 0.8 0.26 1.64 0.78 2.52 0.51 0.87 1.16 1.74 1.94 2.6 0.79 0.87 1.63 1.72 2.54 2.55l2.54 2.3c0.06 0.05 0.12 0.07 0.2 0.07 0.08 0 0.14-0.02 0.2-0.07l2.54-2.3c0.9-0.83 1.75-1.68 2.54-2.54 0.78-0.87 1.43-1.74 1.94-2.61C19.74 10.36 20 9.52 20 8.72c0-1-0.33-1.83-1-2.5-0.67-0.67-1.5-1-2.5-1-0.78 0-1.47 0.2-2.07 0.58-0.6 0.38-1.17 0.98-1.71 1.8-0.09 0.14-0.2 0.23-0.32 0.3C12.27 7.96 12.14 8 12 8s-0.27-0.04-0.4-0.1c-0.13-0.07-0.23-0.16-0.32-0.3Z" fill="currentColor"/></svg>',
  heartFilled: '<svg viewBox="0 0 24 24" fill="none"><path d="M11.99 20.28c-0.21 0-0.43-0.04-0.64-0.12-0.22-0.07-0.41-0.2-0.57-0.36l-1.44-1.3c-1.77-1.62-3.36-3.2-4.75-4.77-1.4-1.56-2.09-3.23-2.09-5.01 0-1.42 0.48-2.6 1.44-3.56C4.89 4.2 6.08 3.72 7.5 3.72c0.8 0 1.6 0.19 2.39 0.56 0.79 0.37 1.49 0.97 2.11 1.8 0.62-0.83 1.32-1.43 2.11-1.8 0.79-0.37 1.58-0.56 2.39-0.56 1.42 0 2.6 0.48 3.56 1.44 0.96 0.95 1.44 2.14 1.44 3.56 0 1.8-0.7 3.5-2.13 5.07-1.41 1.58-3 3.15-4.73 4.72l-1.42 1.3c-0.17 0.16-0.36 0.28-0.58 0.35-0.22 0.08-0.44 0.12-0.65 0.12Z" fill="currentColor"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 19.27c-0.41 0-0.77-0.15-1.06-0.44-0.3-0.3-0.44-0.65-0.44-1.06 0-0.41 0.15-0.77 0.44-1.06 0.3-0.3 0.65-0.44 1.06-0.44 0.41 0 0.77 0.15 1.06 0.44 0.3 0.3 0.44 0.65 0.44 1.06 0 0.41-0.15 0.77-0.44 1.06-0.3 0.3-0.65 0.44-1.06 0.44Zm0-5.77c-0.41 0-0.77-0.15-1.06-0.44-0.3-0.3-0.44-0.65-0.44-1.06 0-0.41 0.15-0.77 0.44-1.06 0.3-0.3 0.65-0.44 1.06-0.44 0.41 0 0.77 0.15 1.06 0.44 0.3 0.3 0.44 0.65 0.44 1.06 0 0.41-0.15 0.77-0.44 1.06-0.3 0.3-0.65 0.44-1.06 0.44Zm0-5.77c-0.41 0-0.77-0.15-1.06-0.44-0.3-0.3-0.44-0.65-0.44-1.06 0-0.41 0.15-0.76 0.44-1.06 0.3-0.3 0.65-0.44 1.06-0.44 0.41 0 0.77 0.15 1.06 0.44 0.3 0.3 0.44 0.65 0.44 1.06 0 0.41-0.15 0.77-0.44 1.06-0.3 0.3-0.65 0.44-1.06 0.44Z" fill="currentColor"/></svg>',
  sparkle: '<svg viewBox="0 0 24 25" fill="none"><path d="M19.455,8.511C19.278,8.902 18.722,8.902 18.545,8.511L17.828,6.933C17.778,6.823 17.689,6.735 17.579,6.685L16.001,5.968C15.611,5.79 15.611,5.235 16.001,5.058L17.579,4.34C17.689,4.29 17.778,4.202 17.828,4.092L18.545,2.514C18.722,2.123 19.278,2.123 19.455,2.514L20.172,4.092C20.222,4.202 20.311,4.29 20.421,4.34L21.999,5.058C22.389,5.235 22.389,5.79 21.999,5.968L20.421,6.685C20.311,6.735 20.222,6.823 20.172,6.933L19.455,8.511ZM19.455,22.511C19.278,22.902 18.722,22.902 18.545,22.511L17.828,20.933C17.778,20.823 17.689,20.735 17.579,20.685L16.001,19.968C15.611,19.79 15.611,19.235 16.001,19.058L17.579,18.34C17.689,18.29 17.778,18.202 17.828,18.092L18.545,16.514C18.722,16.123 19.278,16.123 19.455,16.514L20.172,18.092C20.222,18.202 20.311,18.29 20.421,18.34L21.999,19.058C22.389,19.235 22.389,19.79 21.999,19.968L20.421,20.685C20.311,20.735 20.222,20.823 20.172,20.933L19.455,22.511ZM9.455,19.511C9.278,19.902 8.722,19.902 8.545,19.511L6.578,15.183C6.528,15.073 6.439,14.985 6.329,14.935L2.001,12.968C1.611,12.79 1.611,12.235 2.001,12.057L6.329,10.09C6.439,10.04 6.528,9.952 6.578,9.842L8.545,5.514C8.722,5.123 9.278,5.123 9.455,5.514L11.422,9.842C11.472,9.952 11.561,10.04 11.671,10.09L15.999,12.057C16.389,12.235 16.389,12.79 15.999,12.968L11.671,14.935C11.561,14.985 11.472,15.073 11.422,15.183L9.455,19.511ZM9,15.663L9.923,13.678C9.973,13.571 10.059,13.485 10.165,13.436L12.15,12.513L10.165,11.59C10.059,11.54 9.973,11.454 9.923,11.347L9,9.363L8.077,11.347C8.027,11.454 7.941,11.54 7.834,11.59L5.85,12.513L7.834,13.436C7.941,13.485 8.027,13.571 8.077,13.678L9,15.663Z" fill="currentColor"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none"><path d="M12,16.75C12.213,16.75 12.391,16.678 12.535,16.534C12.678,16.391 12.75,16.212 12.75,16V11.75C12.75,11.538 12.678,11.359 12.534,11.216C12.39,11.072 12.212,11 12,11C11.787,11 11.609,11.072 11.465,11.216C11.322,11.359 11.25,11.538 11.25,11.75V16C11.25,16.212 11.322,16.391 11.466,16.534C11.609,16.678 11.788,16.75 12,16.75ZM12,9.288C12.229,9.288 12.421,9.211 12.575,9.056C12.73,8.901 12.808,8.71 12.808,8.481C12.808,8.252 12.73,8.06 12.575,7.905C12.421,7.751 12.229,7.673 12,7.673C11.771,7.673 11.579,7.751 11.425,7.905C11.27,8.06 11.192,8.252 11.192,8.481C11.192,8.71 11.27,8.901 11.425,9.056C11.579,9.211 11.771,9.288 12,9.288ZM12.002,21.5C10.688,21.5 9.453,21.251 8.297,20.752C7.14,20.253 6.135,19.576 5.28,18.722C4.424,17.867 3.747,16.862 3.248,15.706C2.749,14.55 2.5,13.316 2.5,12.002C2.5,10.688 2.749,9.453 3.248,8.297C3.747,7.14 4.423,6.135 5.278,5.28C6.133,4.424 7.138,3.747 8.294,3.248C9.45,2.749 10.684,2.5 11.998,2.5C13.312,2.5 14.547,2.749 15.703,3.248C16.86,3.747 17.865,4.423 18.721,5.278C19.576,6.133 20.253,7.138 20.752,8.294C21.25,9.45 21.5,10.684 21.5,11.998C21.5,13.312 21.251,14.547 20.752,15.703C20.253,16.86 19.576,17.865 18.722,18.721C17.867,19.576 16.862,20.253 15.706,20.752C14.55,21.25 13.316,21.5 12.002,21.5ZM12,20C14.233,20 16.125,19.225 17.675,17.675C19.225,16.125 20,14.233 20,12C20,9.767 19.225,7.875 17.675,6.325C16.125,4.775 14.233,4 12,4C9.767,4 7.875,4.775 6.325,6.325C4.775,7.875 4,9.767 4,12C4,14.233 4.775,16.125 6.325,17.675C7.875,19.225 9.767,20 12,20Z" fill="currentColor"/></svg>',
  queue: '<svg viewBox="0 0 26 26" fill="none"><path d="M22.62 20.04c0.45 0 0.81 0.37 0.81 0.81 0 0.45-0.36 0.82-0.8 0.82H3.65c-0.45 0-0.81-0.37-0.81-0.82 0-0.44 0.36-0.8 0.81-0.8h18.96Z" fill="currentColor"/><path d="M20.98 9.2c1.2 0 2.17 0.98 2.17 2.18v3.25c0 1.2-0.97 2.16-2.17 2.16H4.73c-1.2 0-2.16-0.97-2.16-2.16v-3.25c0-1.2 0.97-2.17 2.16-2.17h16.25Zm-15.7 1.63c-0.6 0-1.09 0.49-1.09 1.09v2.16c0 0.6 0.49 1.09 1.08 1.09h15.17c0.6 0 1.08-0.49 1.08-1.09v-2.16c0-0.6-0.48-1.09-1.08-1.09H5.27Z" fill="currentColor"/><path d="M22.34 4.33c0.45 0 0.81 0.37 0.81 0.82 0 0.44-0.36 0.8-0.81 0.8H3.38c-0.45 0-0.81-0.36-0.81-0.8 0-0.45 0.36-0.82 0.8-0.82h18.97Z" fill="currentColor"/></svg>',
  hires: '<svg viewBox="0 0 24 25" fill="none"><path d="M11.358,16.409V13.222C11.352,13.113 11.404,13.061 11.513,13.067C11.606,13.069 11.698,13.069 11.79,13.069C11.974,13.069 12.159,13.069 12.343,13.084C12.683,13.107 12.931,13.286 13.057,13.608C13.115,13.758 13.167,13.908 13.202,14.064C13.276,14.415 13.349,14.767 13.42,15.118C13.493,15.469 13.565,15.821 13.639,16.173C13.657,16.247 13.674,16.322 13.697,16.409H14.832C14.828,16.382 14.824,16.357 14.821,16.334C14.815,16.296 14.811,16.262 14.803,16.23C14.761,16.044 14.719,15.858 14.678,15.671C14.595,15.299 14.511,14.926 14.423,14.553C14.325,14.127 14.221,13.706 14.106,13.286C14.014,12.963 13.841,12.692 13.519,12.537C13.513,12.531 13.513,12.514 13.513,12.496C13.519,12.493 13.524,12.488 13.529,12.484C13.539,12.475 13.549,12.466 13.565,12.462C14.106,12.214 14.389,11.77 14.504,11.206C14.59,10.779 14.573,10.353 14.463,9.932C14.308,9.327 13.956,8.89 13.351,8.699C13.121,8.624 12.867,8.584 12.625,8.578C12.063,8.565 11.504,8.565 10.946,8.566C10.807,8.567 10.667,8.567 10.528,8.567C10.484,8.567 10.44,8.572 10.398,8.578C10.379,8.58 10.361,8.582 10.344,8.584C10.28,8.838 10.292,16.242 10.355,16.409H11.358ZM11.372,9.631C11.377,9.62 11.384,9.606 11.392,9.587C11.529,9.59 11.666,9.587 11.803,9.584C12.1,9.577 12.397,9.57 12.689,9.633C13.063,9.713 13.305,9.944 13.409,10.313C13.49,10.606 13.495,10.9 13.426,11.194C13.317,11.667 12.983,11.972 12.499,12.007C12.273,12.027 12.044,12.027 11.814,12.028C11.716,12.028 11.618,12.028 11.519,12.03C11.415,12.03 11.352,11.995 11.352,11.88C11.358,11.148 11.358,10.411 11.358,9.667C11.358,9.66 11.362,9.65 11.372,9.631Z" fill="currentColor"/><path d="M1.303,12.946C1.574,12.882 3.62,12.9 3.798,12.969V16.403H4.858V8.584H3.81L3.808,8.615C3.803,8.7 3.798,8.778 3.798,8.855C3.798,9.794 3.798,10.727 3.792,11.667C3.792,11.88 3.781,11.891 3.573,11.891H1.505C1.456,11.891 1.406,11.884 1.346,11.876L1.292,11.868V8.584H0.226V16.409H1.303V12.946Z" fill="currentColor"/><path d="M18.975,16.293C18.076,16.53 17.195,16.564 16.371,16.046C15.956,15.786 15.662,15.418 15.489,14.968C15.017,13.701 15.028,12.433 15.639,11.212C16.117,10.249 17.028,9.921 18.042,10.146C18.566,10.261 18.923,10.595 19.165,11.062C19.367,11.442 19.465,11.851 19.505,12.272C19.532,12.545 19.538,12.82 19.545,13.097C19.548,13.234 19.551,13.372 19.557,13.51C19.557,13.539 19.551,13.568 19.54,13.62C19.508,13.622 19.477,13.625 19.447,13.627C19.388,13.632 19.33,13.637 19.269,13.637H16.567C16.48,13.637 16.394,13.643 16.313,13.649C16.307,14.703 16.901,15.441 17.84,15.446C18.097,15.446 18.35,15.415 18.613,15.382C18.722,15.368 18.833,15.355 18.946,15.343C18.946,15.343 18.975,15.377 18.981,15.418L18.993,15.497C19.024,15.694 19.053,15.888 19.079,16.086C19.09,16.178 19.09,16.265 18.975,16.293ZM18.278,11.569C17.961,10.889 17.137,10.802 16.688,11.402C16.417,11.77 16.342,12.203 16.29,12.681L16.375,12.685C16.446,12.689 16.502,12.692 16.561,12.692H18.278C18.445,12.681 18.462,12.663 18.462,12.496C18.462,12.174 18.416,11.863 18.278,11.569Z" fill="currentColor"/><path d="M22.029,15.417C21.931,15.441 21.827,15.452 21.729,15.452C21.297,15.464 20.882,15.366 20.468,15.239C20.393,15.216 20.318,15.193 20.22,15.164C20.145,15.504 20.076,15.815 20.001,16.143C20.324,16.282 20.64,16.351 20.963,16.397C21.516,16.483 22.064,16.501 22.6,16.316C23.21,16.109 23.619,15.705 23.735,15.054C23.856,14.357 23.712,13.729 23.107,13.291C22.89,13.136 22.655,13.009 22.42,12.883C22.341,12.841 22.263,12.799 22.185,12.755C22.088,12.7 21.989,12.648 21.889,12.597C21.762,12.532 21.636,12.467 21.516,12.392C21.246,12.22 21.176,11.949 21.228,11.649C21.28,11.361 21.47,11.194 21.741,11.113C21.851,11.085 21.972,11.067 22.081,11.061C22.427,11.056 22.755,11.131 23.083,11.234C23.121,11.248 23.161,11.258 23.204,11.268C23.233,11.275 23.264,11.283 23.297,11.292C23.327,11.158 23.358,11.029 23.388,10.902L23.388,10.901C23.432,10.716 23.475,10.534 23.516,10.347C23.479,10.333 23.445,10.317 23.413,10.303C23.379,10.287 23.346,10.272 23.314,10.261C22.813,10.094 22.294,10.03 21.77,10.088C21.551,10.111 21.32,10.163 21.119,10.249C20.537,10.485 20.168,10.917 20.082,11.545C19.984,12.22 20.162,12.802 20.744,13.211C20.924,13.334 21.118,13.444 21.309,13.552L21.378,13.591C21.475,13.644 21.573,13.694 21.671,13.744C21.831,13.826 21.991,13.907 22.144,14C22.26,14.069 22.369,14.167 22.45,14.277C22.795,14.72 22.576,15.296 22.029,15.417Z" fill="currentColor"/><path d="M7.117,10.791C7.175,10.97 7.192,16.155 7.135,16.403H6.126C6.075,16.247 6.063,11.096 6.121,10.791H7.117Z" fill="currentColor"/><path d="M9.324,11.909H8.148V13.044H9.324V11.909Z" fill="currentColor"/><path d="M7.152,8.584V9.662H6.086L6.086,9.649C6.08,9.291 6.075,8.949 6.092,8.584H7.152Z" fill="currentColor"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3.1" stroke="currentColor" stroke-width="1.6"/><path d="M19.4 12.9a7.7 7.7 0 0 0 .06-.9 7.7 7.7 0 0 0-.06-.9l1.62-1.26a.4.4 0 0 0 .1-.5l-1.54-2.66a.4.4 0 0 0-.48-.18l-1.9.77a7.5 7.5 0 0 0-1.56-.9l-.29-2.02a.4.4 0 0 0-.39-.33h-3.08a.4.4 0 0 0-.39.33l-.29 2.02a7.5 7.5 0 0 0-1.56.9l-1.9-.77a.4.4 0 0 0-.48.18L3.72 8.34a.4.4 0 0 0 .1.5l1.62 1.26a7.7 7.7 0 0 0 0 1.8L3.82 13.16a.4.4 0 0 0-.1.5l1.54 2.66a.4.4 0 0 0 .48.18l1.9-.77a7.5 7.5 0 0 0 1.56.9l.29 2.02a.4.4 0 0 0 .39.33h3.08a.4.4 0 0 0 .39-.33l.29-2.02a7.5 7.5 0 0 0 1.56-.9l1.9.77a.4.4 0 0 0 .48-.18l1.54-2.66a.4.4 0 0 0-.1-.5L19.4 12.9Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'
};

// ------------------------------------------------------------------ Qobuz API (cached read calls)
var apiCache = {};
function api(path) {
  if (!apiCache[path]) apiCache[path] = Q.api(path).catch(function (e) { delete apiCache[path]; throw e; });
  return apiCache[path];
}
function search(term, limit) { return api("catalog/search?query=" + encodeURIComponent(term) + "&limit=" + (limit || 20)); }
function featuredAlbums(type, limit) { return api("album/getFeatured?type=" + type + "&limit=" + (limit || 24)).then(function (j) { return (j.albums && j.albums.items) || []; }).catch(function () { return []; }); }
function featuredPlaylists(type, limit) { return api("playlist/getFeatured?type=" + type + "&limit=" + (limit || 18)).then(function (j) { return (j.playlists && j.playlists.items) || []; }).catch(function () { return []; }); }
// [Discover v2] genre-scoped featured + the genre taxonomy — all from the API (nothing hardcoded).
// NOTE the deliberately DIFFERENT param spellings: album=genre_ids, playlist=genres_id (both confirmed from the bundle). Do NOT normalize.
function featuredAlbumsG(type, gid, limit) { return api("album/getFeatured?type=" + type + "&genre_ids=" + gid + "&limit=" + (limit || 24)).then(function (j) { return (j.albums && j.albums.items) || []; }).catch(function () { return []; }); }
function featuredPlaylistsG(type, gid, limit) { return api("playlist/getFeatured?type=" + type + "&genres_id=" + gid + "&limit=" + (limit || 18)).then(function (j) { return (j.playlists && j.playlists.items) || []; }).catch(function () { return []; }); }
function genreList() { return api("genre/list").then(function (j) { return (j.genres && j.genres.items) || j.items || []; }).catch(function () { return []; }); }
function favorites(type, limit) { return api("favorite/getUserFavorites?type=" + type + "&limit=" + (limit || 100)).then(function (j) { return (j[type] && j[type].items) || []; }).catch(function () { return []; }); }
function userPlaylists() { return api("playlist/getUserPlaylists?limit=200").then(function (j) { return (j.playlists && j.playlists.items) || []; }).catch(function () { return []; }); }
function albumGet(id) { return api("album/get?album_id=" + id); }   // album/get returns its tracks by default; &extra=tracks 400s
function playlistGet(id) { return api("playlist/get?playlist_id=" + id + "&extra=tracks&limit=500"); }
function artistGet(id) { return api("artist/get?artist_id=" + id + "&extra=albums,playlists,tracks&limit=40"); }

// ------------------------------------------------------------------ Discover data helpers + utils [M4]
// All via the cached api(); personalized rails are favorites-seeded (same building blocks recommended.js uses).
function similarArtistsD(id) { return api("artist/getSimilarArtists?artist_id=" + id + "&limit=12").then(function (j) { return (j.artists && j.artists.items) || []; }).catch(function () { return []; }); }
function artistAlbumsD(id)   { return api("artist/get?artist_id=" + id + "&extra=albums&limit=6").then(function (j) { return (j.albums && j.albums.items) || []; }).catch(function () { return []; }); }
function relTs(a) { return (a && (a.released_at || (a.release_date_original && Date.parse(a.release_date_original) / 1000))) || 0; }
function byNewestD(a, b) { return relTs(b) - relTs(a); }
function dedupeById(list) { var seen = {}, out = []; (list || []).forEach(function (x) { if (!x || x.id == null) return; var k = String(x.id); if (seen[k]) return; seen[k] = 1; out.push(x); }); return out; }
// concurrency-limited map (n in flight); resolves with results array (nulls on error) - copy of recommended.js pool()
function poolMap(items, n, fn) {
  return new Promise(function (resolve) {
    var out = new Array(items.length), i = 0, done = 0, running = 0;
    if (!items.length) return resolve(out);
    function next() {
      while (running < n && i < items.length) {
        (function (idx) {
          running++;
          Promise.resolve(fn(items[idx], idx)).then(function (r) { out[idx] = r; }, function () { out[idx] = null; })
            .then(function () { running--; if (++done === items.length) resolve(out); else next(); });
        })(i++);
      }
    }
    next();
  });
}

// ------------------------------------------------------------------ favorites + follow (album/track/artist) [M2]
// Writes go through favorite/create | favorite/delete (GET via Q.api), keyed by kind: album_ids|track_ids|artist_ids.
// "Follow artist" == favourite an artist (same call). We seed a local Set of already-favorited ids ONCE from
// favorite/getUserFavoriteIds so hearts render filled without a per-item request, and keep it in sync optimistically
// on every toggle. Writes use Q.api directly (NOT the cached api()) so a re-toggle actually re-hits the endpoint.
var FAV_KINDS = {
  album:  { type: "albums",  param: "album_ids"  },
  track:  { type: "tracks",  param: "track_ids"  },
  artist: { type: "artists", param: "artist_ids" }
};
var favSet = { album: {}, track: {}, artist: {}, playlist: {} };   // kind -> { idString: 1 } (plain map = Set)
var favIdsPromise = null, subsPromise = null;
function favKey(id) { return String(id); }
function isFav(kind, id) { var m = favSet[kind]; return !!(m && id != null && m[favKey(id)]); }
function markFav(kind, id, on) { var m = favSet[kind]; if (!m || id == null) return; if (on) m[favKey(id)] = 1; else delete m[favKey(id)]; }
// pull ids out of a getUserFavoriteIds node, tolerant of shape: [id,…] | [{id},…] | {items:[…]}
function favIdList(node) {
  if (!node) return [];
  var arr = node.items || node; if (!arr || !arr.length) return [];
  return [].map.call(arr, function (x) { return favKey(x && x.id != null ? x.id : x); });
}
function loadFavIds() {
  if (favIdsPromise) return favIdsPromise;
  favIdsPromise = Q.api("favorite/getUserFavoriteIds").then(function (j) {
    j = j || {};
    favIdList(j.albums).forEach(function (id) { favSet.album[id] = 1; });
    favIdList(j.tracks).forEach(function (id) { favSet.track[id] = 1; });
    favIdList(j.artists).forEach(function (id) { favSet.artist[id] = 1; });
  }).catch(function () {});   // leave empty; hearts just render hollow
  return favIdsPromise;
}
// heart affordance shared by rows + detail headers. role=button SPAN (never a <button>) so it can live inside an
// interactive row without nesting buttons; delegated onContentTap resolves closest("[data-act]") to it first.
function favBtnHTML(kind, id, cls) {
  if (id == null || id === "") return "";
  var on = isFav(kind, id);
  return '<span class="qz-fav' + (cls ? " " + cls : "") + (on ? " is-on" : "") + '" role="button" tabindex="0"' +
    ' data-act="fav" data-kind="' + kind + '" data-id="' + esc(id) + '"' +
    ' aria-label="Favorite" aria-pressed="' + (on ? "true" : "false") + '">' + (on ? IC.heartFilled : IC.heart) + '</span>';
}
// repaint every heart currently in the DOM for one kind+id (called on toggle)
function paintFav(kind, id) {
  if (!root) return;
  var on = isFav(kind, id), key = favKey(id);
  [].forEach.call(root.querySelectorAll('[data-act="fav"][data-kind="' + kind + '"]'), function (b) {
    if (favKey(b.getAttribute("data-id")) !== key) return;
    b.classList.toggle("is-on", on);
    b.innerHTML = on ? IC.heartFilled : IC.heart;
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
}
// repaint ALL hearts from the Set (called once id-sets finish loading, so early-rendered hollow hearts fill)
function repaintFavAll() {
  if (!root) return;
  [].forEach.call(root.querySelectorAll('[data-act="fav"]'), function (b) {
    var on = isFav(b.getAttribute("data-kind"), b.getAttribute("data-id"));
    b.classList.toggle("is-on", on);
    b.innerHTML = on ? IC.heartFilled : IC.heart;
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
}
// flip a favourite and update every matching heart on screen. Optimistic: Set + UI first, revert on failure.
function toggleFavorite(kind, id) {
  var spec = FAV_KINDS[kind]; if (!spec || id == null) return Promise.resolve();
  var want = !isFav(kind, id);
  markFav(kind, id, want); paintFav(kind, id);
  var route = (want ? "favorite/create" : "favorite/delete") + "?type=" + spec.type + "&" + spec.param + "=" + encodeURIComponent(id);
  return Q.api(route).then(function () {
    qToast(kind === "artist" ? (want ? "Following" : "Unfollowed") : (want ? "Added to favourites" : "Removed from favourites"));
  }).catch(function () {
    markFav(kind, id, !want); paintFav(kind, id);   // revert
    qToast("Couldn't update, try again");
  });
}
// playlist "favourite" == subscribe (distinct route). Playlists aren't in getUserFavoriteIds, so subscribed state
// is seeded from getUserPlaylists (own + subscribed) filtered to not-owned.
var cachedMe = null, mePromise = null;
function me() {
  if (mePromise) return mePromise;
  mePromise = Q.api("user/get").then(function (u) { cachedMe = (u && (u.id || (u.user && u.user.id))) || 0; return cachedMe; })
    .catch(function () { cachedMe = 0; return 0; });
  return mePromise;
}
function loadPlaylistSubs() {
  if (subsPromise) return subsPromise;
  subsPromise = Promise.all([userPlaylists(), me()]).then(function (r) {
    var pls = r[0] || [], uid = r[1];
    pls.forEach(function (p) { if (uid && p.owner && String(p.owner.id) !== String(uid)) favSet.playlist[favKey(p.id)] = 1; });
  }).catch(function () {});
  return subsPromise;
}
function togglePlaylistSub(id) {
  if (id == null) return Promise.resolve();
  var want = !isFav("playlist", id);
  markFav("playlist", id, want); paintFav("playlist", id);
  var route = (want ? "playlist/subscribe" : "playlist/unsubscribe") + "?playlist_id=" + encodeURIComponent(id);
  return Q.api(route).then(function () {
    qToast(want ? "Added to library" : "Removed from library");
  }).catch(function () { markFav("playlist", id, !want); paintFav("playlist", id); qToast("Couldn't update, try again"); });
}

// ------------------------------------------------------------------ quality (display-only; not settable)
// player.quality is unreliable (discord-rpc learned this), so the NOW-PLAYING chip fetches track/get once
// per id for the real bit-depth/rate. Per-item badges read the fields already on the JSON object (no fetch).
var qualCache = {}; // trackId -> { str, tier } | ""  ("" = fetched, none)
function qFmt(bd, sr) { bd = bd || 0; sr = sr || 0; if (sr > 1000) sr = sr / 1000; return (bd && sr) ? Math.round(bd) + "-bit / " + (Math.round(sr * 10) / 10) + " kHz" : ""; }
function qTier(bd, hires) { bd = bd || (hires ? 24 : 0); if (hires || bd >= 24) return "Hi-Res"; if (bd >= 16) return "Lossless"; return ""; }
function qBadge(o) {
  var bd = o && o.maximum_bit_depth, hr = o && (o.hires || o.hires_streamable);
  if (bd == null && o && o.album) { bd = o.album.maximum_bit_depth; hr = hr || o.album.hires; }
  var t = qTier(bd, hr);
  return t === "Hi-Res" ? '<span class="qz-q qz-q--hr">Hi-Res</span>' : "";   // only flag hi-res, matches quality-badges intent
}
function ensureQuality(id, cb) {
  if (id == null) return;
  if (qualCache[id] !== undefined) { cb(qualCache[id]); return; }
  api("track/get?track_id=" + id).then(function (tr) {
    qualCache[id] = { str: qFmt(tr && tr.maximum_bit_depth, tr && tr.maximum_sampling_rate), tier: qTier(tr && tr.maximum_bit_depth, !!(tr && (tr.hires || tr.hires_streamable))) };
    cb(qualCache[id]);
  }).catch(function () { qualCache[id] = ""; cb(""); });
}

// ------------------------------------------------------------------ capability + explicit gating [M2]
// parental_warning marks explicit content; capability flag streamable===false = not playable. These fields already
// live on the JSON objects favorites/album/get/search return - no extra fetch.
function isExplicit(o) {
  if (!o) return false;
  if (o.parental_warning) return true;
  if (o.album && o.album.parental_warning) return true;   // a track inherits its album's flag when its own is absent
  return false;
}
function explicitBadge(o) { return isExplicit(o) ? '<span class="qz-exp" aria-label="Explicit" title="Explicit">E</span>' : ""; }
function rowDisabled(o) { return !!(o && o.streamable === false); }   // only an explicit false is unplayable

// ------------------------------------------------------------------ playback (reuse the proven path)
// Start playback of a specific track by driving Qobuz's own album page underneath our UI: navigate the
// (invisible) native app to the album, wait for its tracklist to render, then fire a real click on the
// matching row - exactly what better-search does. Our root covers the native page so the user never
// sees the navigation. queue becomes the album (v1); good enough to actually hear the right track.
function fireClick(el) { ["mousedown", "mouseup", "click"].forEach(function (t) { el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); }); }
function clickEl(sel) { var el = document.querySelector(sel); if (!el) return false; el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); return true; }
function nrm(s) { return String(s || "").toLowerCase().replace(/\(.*?\)|\[.*?\]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
function nrmFull(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); } // keeps (feat)/(remix) so variants don't collide
function nativeRows() { return [].slice.call(document.querySelectorAll(".ListItem")).filter(function (r) { return r.querySelector(".ListItem__title") && r.querySelector(".ListItem__player"); }); }
function nativePath() { try { return Q.getState().router.location.pathname || ""; } catch (e) { return ""; } }

var playBusy = false;
function playFromAlbum(albumId, title, num, tid, done) {
  if (!albumId) return;
  playBusy = true;
  Q.navigate("/album/" + albumId);
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    if (nativePath().indexOf(String(albumId)) >= 0) {
      var rows = nativeRows();
      if (rows.length) {
        var target = matchRow(rows, title, num, tid) || rows[0];
        var hit = target.querySelector(".ListItem__player") || target.querySelector(".ListItem__number");
        if (hit) { fireClick(hit); clearInterval(iv); playBusy = false; if (done) done(); return; }
      }
    }
    if (tries > 45) { clearInterval(iv); playBusy = false; if (done) done(); }
  }, 130);
}
// Does this native Qobuz row render OUR target track id? Read it off the React fiber props (the row is a
// React component; its track object carries the numeric id). An exact id match is unambiguous where the
// title isn't - e.g. "Lonely Road" vs "Lonely Road (feat. ...)" on the same album. Best-effort: if the
// fiber shape doesn't yield an id, we fall back to title+number scoring, so there is no regression.
function rowMatchesId(row, tid) {
  if (!tid) return false;
  try {
    var fk = Object.keys(row).find(function (k) { return k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0; });
    if (!fk) return false;
    var f = row[fk], d = 0;
    while (f && d++ < 30) {
      var p = f.memoizedProps;
      if (p) {
        var cands = [p.track, p.item, p.data, p.row, p];
        for (var i = 0; i < cands.length; i++) {
          var c = cands[i];
          if (c && (String(c.id) === tid || String(c.trackId) === tid || (c.track && String(c.track.id) === tid))) return true;
        }
      }
      f = f.return;
    }
  } catch (e) {}
  return false;
}
function matchRow(rows, title, num, tid) {
  // 1) exact track-id match wins outright (disambiguates same-title variants)
  if (tid) { for (var i = 0; i < rows.length; i++) if (rowMatchesId(rows[i], tid)) return rows[i]; }
  // 2) fall back to title (exact-incl-parens > normalized) + track number
  var wt = nrm(title), wtFull = nrmFull(title), best = null, bestScore = -1, n = num ? parseInt(num, 10) : NaN;
  rows.forEach(function (r) {
    var te = r.querySelector(".ListItem__title"), rt = te ? nrm(te.textContent) : "", rtFull = te ? nrmFull(te.textContent) : "", s = 0;
    if (wtFull && rtFull === wtFull) s += 100; else if (wt && rt === wt) s += 45; else if (wt && rt.indexOf(wt) >= 0) s += 18;
    if (!isNaN(n)) { var ne = r.querySelector(".ListItem__number"); var rn = ne ? parseInt(ne.textContent, 10) : NaN; if (rn === n) s += 45; }
    if (s > bestScore) { bestScore = s; best = r; }
  });
  return bestScore >= 18 ? best : null; // scoring (full-title 100 > base 45, +45 number) picks the right variant; threshold only gates null->rows[0]
}
// transport off the native player bar (invisible but fully functional)
function togglePlay() { clickEl(".player__action-pause, .player__action-play"); }
function playNext() { clickEl(".pct-player-next, .player__action-next"); }
function playPrev() { clickEl(".pct-player-prev, .player__action-previous"); }

// ---- seek: drive the native .player__progressbar. Path B (React-fiber props.seek) is primary because it's
// geometry-independent and works under visibility:hidden; Path A (seek-controls' synthetic drag) is the fallback.
var _seekInst = null;
function seekInput() { return document.querySelector(".player__progressbar input[type=range]") || document.querySelector(".player__progressbar input"); }
function findSeekInstance() {
  try {
    if (_seekInst && _seekInst.props && typeof _seekInst.props.seek === "function") return _seekInst;
    var input = seekInput(); if (!input) return null;
    var fk = Object.keys(input).find(function (k) { return k.indexOf("__reactInternalInstance$") === 0; });
    if (!fk) return null;
    var f = input[fk], d = 0;
    while (f && d++ < 40) { var sn = f.stateNode; if (sn && sn.props && typeof sn.props.seek === "function") { _seekInst = sn; return sn; } f = f.return; }
  } catch (e) {}
  return null;
}
function seekToMs(ms) {
  var dur = curDurMs();
  if (dur) ms = Math.max(0, Math.min(ms, dur));
  ms = Math.round(ms);
  var inst = findSeekInstance();
  if (inst) { try { inst.props.seek({ position: ms }); return true; } catch (e) {} }
  var bar = document.querySelector(".player__progressbar"), input = seekInput();   // fallback: synthetic drag
  if (!bar || !input) return false;
  var d = parseInt(input.max, 10) || dur || 0; if (!d) return false;
  var rect = bar.getBoundingClientRect(); if (!rect.width) return false;
  var clientX = Math.max(rect.left + 1, Math.min(rect.left + rect.width - 1, rect.left + 7.5 + ms * (rect.width - 15) / d));
  var clientY = input.getBoundingClientRect().top + 6;
  var o = { bubbles: true, cancelable: true, view: window, clientX: clientX, clientY: clientY, button: 0 };
  bar.dispatchEvent(new MouseEvent("mousemove", o));
  input.dispatchEvent(new MouseEvent("mouseup", o));
  return true;
}
function seekToFraction(f) { var dur = curDurMs(); if (!dur) return false; return seekToMs(Math.max(0, Math.min(1, f)) * dur); }
var seeking = false, seekingUntil = 0;
function bindSeek(barEl) {
  if (!barEl) return;
  var fill = barEl.querySelector("i");
  function frac(e) { var r = barEl.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1))); }
  function preview(fr) {
    if (fill) fill.style.width = (fr * 100) + "%";
    var dur = curDurMs(), cur = npEl && npEl.querySelector(".qz-np__cur");
    if (cur && dur) cur.textContent = fmtDur(fr * dur / 1000);
  }
  barEl.addEventListener("pointerdown", function (e) {
    if (!hasTrack()) return;
    seeking = true; barEl.classList.add("is-seeking");
    try { barEl.setPointerCapture(e.pointerId); } catch (_) {}
    preview(frac(e)); e.preventDefault();
  });
  barEl.addEventListener("pointermove", function (e) { if (seeking) { preview(frac(e)); e.preventDefault(); } });
  function end(e) {
    if (!seeking) return;
    seeking = false; barEl.classList.remove("is-seeking");
    var fr = frac(e); preview(fr); seekToFraction(fr);
    seekingUntil = Date.now() + 700;   // let the sealed engine + 500ms poll settle before the poll repaints the fill
  }
  barEl.addEventListener("pointerup", end);
  barEl.addEventListener("pointercancel", function () { seeking = false; barEl.classList.remove("is-seeking"); });
}

// ---- play a track in the CONTEXT it was tapped in. Raw store dispatch does NOT start audio (the engine is a
// thunk on an unreachable singleton), so we navigate the invisible native CONTEXT page (playlist vs album) and
// click the matching row: on /playlist/ID the queue becomes the playlist, on /album/ID it becomes the album.
function matchRowByPos(rows, pos, title) {
  var wt = nrm(title), best = null, bestScore = -1;
  rows.forEach(function (r) {
    var ne = r.querySelector(".ListItem__number, .ListItem__numberText");
    var rn = ne ? parseInt(ne.textContent, 10) : NaN, s = 0;
    if (pos && rn === +pos) s += 60;                                   // position is the strong key on a playlist
    var te = r.querySelector(".ListItem__title"), rt = te ? nrm(te.textContent) : "";
    if (wt && rt === wt) s += 30; else if (wt && rt.indexOf(wt) >= 0) s += 12;
    if (s > bestScore) { bestScore = s; best = r; }
  });
  return bestScore >= 30 ? best : null;
}
// navigate the invisible native page, poll for the target row (scrolling the virtualized list if needed),
// click its .ListItem__player. Never hangs (header-Play last resort so the queue is at least the right context).
function navClickRow(path, pick) {
  playBusy = true;
  Q.navigate(path);
  var scroller = null, tries = 0, id = path.split("/").pop();
  var iv = setInterval(function () {
    tries++;
    if (nativePath().indexOf(id) < 0) { if (tries > 45) done(); return; }
    if (!scroller) scroller = document.querySelector(".ui-layout--root--scroll-main, .ReactVirtualized__Grid, .ReactVirtualized__List");
    var rows = nativeRows(), target = rows.length ? pick(rows) : null;
    if (target) {
      var hit = target.querySelector(".ListItem__player") || target.querySelector(".ListItem__number");
      if (hit) { fireClick(hit); return done(); }
    }
    if (scroller && tries % 3 === 0) scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + scroller.clientHeight * 0.85);
    if (tries > 60) { var hb = document.querySelector("[class*='PageHeader'] button[aria-label='Play']"); if (hb) fireClick(hb); return done(); }
  }, 130);
  function done() { clearInterval(iv); playBusy = false; }
}
function playInContext(el) {
  var kind = el.getAttribute("data-ctx-kind"), cid = el.getAttribute("data-ctx-id"),
      pos = +el.getAttribute("data-pos") || 0, album = el.getAttribute("data-album"),
      title = el.getAttribute("data-title"), num = el.getAttribute("data-num"), tid = el.getAttribute("data-id");
  if (kind === "playlist" && cid) navClickRow("/playlist/" + cid, function (rows) { if (tid) { for (var i = 0; i < rows.length; i++) if (rowMatchesId(rows[i], tid)) return rows[i]; } return matchRowByPos(rows, pos, title); });
  else if (kind === "album" && cid) navClickRow("/album/" + cid, function (rows) { return matchRow(rows, title, num, tid) || rows[0]; });
  else playFromAlbum(album, title, num, tid);   // search / favorites / top-tracks: no native list-as-queue, album is the honest fallback
}

// ================= ADD TO QUEUE / PLAY NEXT / RADIO ==========================
// Grounded in @qobuz/qobuz-dwp-ui bundle.js: the track kebab (.track-action.pct-more.popover-track)
// opens a .menu-list whose <a> for "Play next" (span.pct-play-after) dispatches insertTracks ->
// insertIntoPlayqueue + playerService.sendPlayqueueReload, and "Add to queue" (span.pct-add-playqueue)
// dispatches addTracks. sendPlayqueueReload lives on the sealed controller, so we CLICK the native item
// rather than dispatch. Synthetic clicks fire React onClick even while the native page is visibility:hidden.
var RADIO_IC = '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="14" r="2.4" fill="currentColor"/><path d="M6.2 9.8a8 8 0 0 1 11.6 0M8.8 12.4a4.3 4.3 0 0 1 6.4 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

// ---- tiny toast (self-contained; body-level so it survives app mount/unmount) ----
var _qzToastEl = null, _qzToastT = null;
function qToast(msg) {
  if (!_qzToastEl) { _qzToastEl = document.createElement("div"); _qzToastEl.className = "qz-mtoast"; document.body.appendChild(_qzToastEl); }
  _qzToastEl.textContent = msg; _qzToastEl.classList.add("is-on");
  clearTimeout(_qzToastT); _qzToastT = setTimeout(function () { if (_qzToastEl) _qzToastEl.classList.remove("is-on"); }, 1900);
}
function chunk(a, n) { var o = []; for (var i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
function dedupe(a) { var s = {}, o = []; for (var i = 0; i < a.length; i++) { var k = String(a[i]); if (a[i] && !s[k]) { s[k] = 1; o.push(a[i]); } } return o; }
function shuffleIds(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

// Poll the opened native track menu for the queue/next item and click it.
function clickQueueMenuItem(mode, done) {
  var sel = mode === "next"
    ? ".pct-play-after, .track-track-playNext a, [class*='playNext'] a, [class*='qobuz-icon-playAfter']"
    : ".pct-add-playqueue, .track-addToQueue a, [class*='addToQueue'] a, [class*='qobuz-icon-addToQueue']";
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    var nodes = document.querySelectorAll(sel), item = null;
    for (var i = 0; i < nodes.length; i++) {
      var li = nodes[i].closest ? nodes[i].closest("li") : null;
      if (li && li.className && /disabled/.test(li.className)) continue;   // skip non-streamable
      item = nodes[i]; break;
    }
    if (item) { fireClick(item.closest("a") || item); clearInterval(iv); if (done) done(true); return; }
    if (tries > 25) { clearInterval(iv); if (done) done(false); }   // ~1.5s
  }, 60);
}

// Navigate the invisible native page, find the row, open its kebab, click the menu item.
function queueViaMenu(path, pick, mode, done) {
  playBusy = true;
  Q.navigate(path);
  var scroller = null, tries = 0, id = path.split("/").pop();
  var iv = setInterval(function () {
    tries++;
    if (nativePath().indexOf(id) < 0) { if (tries > 45) finish(false); return; }
    if (!scroller) scroller = document.querySelector(".ui-layout--root--scroll-main, .ReactVirtualized__Grid, .ReactVirtualized__List");
    var rows = nativeRows(), target = rows.length ? pick(rows) : null;
    if (target) {
      var keb = target.querySelector(".track-action.pct-more, .pct-more, .ListItem__menu, [class*='pct-more']");
      if (keb) { clearInterval(iv); fireClick(keb); clickQueueMenuItem(mode, finish); return; }
    }
    if (scroller && tries % 3 === 0) scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + scroller.clientHeight * 0.85);
    if (tries > 60) finish(false);
  }, 120);
  function finish(ok) { playBusy = false; if (done) done(ok); }
}

// Public: queue/play-next an arbitrary track described by {albumId,title,num}. mode = "queue" | "next".
function queueTrackData(d, mode) {
  var aid = d.albumId, title = d.title || "", num = d.num || "";
  if (!aid) { qToast("Can't queue this track"); return; }
  if (!hasTrack()) { playFromAlbum(aid, title, num); qToast("Playing"); return; }
  queueViaMenu("/album/" + aid, function (rows) { return matchRow(rows, title, num) || rows[0]; }, mode, function (ok) {
    qToast(ok ? (mode === "next" ? "Playing next" : "Added to queue") : "Couldn't queue that");
  });
}
function queueAdd(d) { queueTrackData(d, "queue"); }       // Add to queue
function queueNext(d) { queueTrackData(d, "next"); }       // Play next

// OPTIONAL best-effort append (playqueue/set, same primitive dropUpcoming uses). Append-only.
function queueAppendViaStore(trackId) {
  try {
    var pq = Q.getState().playqueue; if (!pq) return false;
    var mk = function () { return { queueItemId: "qzm-" + Date.now() + "-" + Math.floor(Math.random() * 1e6), trackId: String(trackId), trackOrigin: { from: "qobuzify-mobile" } }; };
    var payload = { index: pq.currentIndex || 0, dirty: true };
    if (pq.shuffled && Array.isArray(pq.shuffledItems)) payload.shuffledItems = pq.shuffledItems.concat(mk());
    else if (Array.isArray(pq.items)) payload.items = pq.items.concat(mk());
    else return false;
    Q.store.dispatch({ type: "playqueue/set", payload: payload });
    return true;
  } catch (e) { return false; }
}

// ---- RADIO (built queue -> temp playlist -> proven native play) ----
function addTracksBatched(pid, ids) { return chunk(ids, 50).reduce(function (p, c) { return p.then(function () { return Q.api("playlist/addTracks?playlist_id=" + pid + "&track_ids=" + c.join(",")); }); }, Promise.resolve()); }
function radioPool(artistId) {
  return artistGet(artistId).then(function (a) {
    var ids = ((a.tracks && a.tracks.items) || []).map(function (t) { return t.id; }).filter(Boolean);
    return api("artist/getSimilarArtists?artist_id=" + artistId + "&limit=6").then(function (s) {
      var sim = ((s.artists && s.artists.items) || []).map(function (x) { return x.id; }).filter(Boolean).slice(0, 6);
      if (!sim.length) return ids;
      return Promise.all(sim.map(function (sid) {
        return api("artist/get?artist_id=" + sid + "&extra=tracks&limit=10")
          .then(function (sa) { return ((sa.tracks && sa.tracks.items) || []).slice(0, 6).map(function (t) { return t.id; }); })
          .catch(function () { return []; });
      })).then(function (lists) { lists.forEach(function (l) { ids = ids.concat(l); }); return ids; });
    }).catch(function () { return ids; });   // similar-artists endpoint missing -> seed-artist radio
  });
}
function createRadioPlaylist(name, ids) {
  return Q.api("playlist/create?name=" + encodeURIComponent(name) + "&is_public=false").then(function (c) {
    var pid = String(c.id);
    return addTracksBatched(pid, ids).then(function () {
      var old = Q.storage.get("mob:radio", null); Q.storage.set("mob:radio", pid);   // keep one radio playlist
      if (old && old !== pid) setTimeout(function () { Q.api("playlist/delete?playlist_id=" + old).catch(function () {}); }, 8000);
      qToast("Radio started");
      navClickRow("/playlist/" + pid, function (rows) { return rows[0]; });           // proven native play
    });
  });
}
function startRadioFromArtist(artistId, artistNm) {
  if (!artistId) { qToast("No artist to seed a radio"); return; }
  qToast("Building radio…");
  radioPool(artistId).then(function (ids) {
    ids = shuffleIds(dedupe(ids)).slice(0, 100);
    if (!ids.length) { qToast("Couldn't build a radio"); return; }
    return createRadioPlaylist("Radio · " + (artistNm || "Artist"), ids);
  }).catch(function () { qToast("Couldn't build a radio"); });
}
function startRadioFromData(d) {
  var arId = (d.performer && d.performer.id) || (d.artist && d.artist.id) || (d.album && d.album.artist && d.album.artist.id);
  var arName = (d.performer && d.performer.name) || (d.artist && d.artist.name) || d.artistName || "";
  if (arId) { startRadioFromArtist(arId, arName); return; }
  var aid = (d.album && d.album.id) || d.albumId;
  if (!aid) { qToast("No artist to seed a radio"); return; }
  qToast("Building radio…");
  albumGet(aid).then(function (al) { startRadioFromArtist(al.artist && al.artist.id, (al.artist && al.artist.name) || arName); })
    .catch(function () { qToast("Couldn't build a radio"); });
}
function startRadioCurrent() {
  var t = Q.player.getTrack() || {};
  if (!t.albumId && !t.artist) { qToast("Nothing playing"); return; }
  startRadioFromData({ albumId: t.albumId, artistName: t.artist });
}

// ---- per-track bottom sheet (Play next / Add to queue / Radio / Go to album / artist) ----
var _sheet = null;
function closeSheet() { if (_sheet) { _sheet.classList.remove("is-on"); var s = _sheet; _sheet = null; setTimeout(function () { s.remove(); }, 200); } }
// sheet-only glyphs (share + add-to-playlist); the rest come from the shared IC set
var IC_SHARE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.3 10.7l7.4-4.3M8.3 13.3l7.4 4.3"/></svg>';
var IC_PLADD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h11M4 12h7M4 17h6"/><path d="M17 14.5v6M14 17.5h6"/></svg>';
var IC_LOGOUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 12H4M8 8l-4 4 4 4"/><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/></svg>';
// M3: the real Add-to-Playlist picker lives below (addToPlaylist); the sheet routes "Add to playlist" to it.
function sheetDataFromEl(el) {
  return {
    albumId: el.getAttribute("data-album") || "",
    id: el.getAttribute("data-id") || "",
    title: el.getAttribute("data-title") || "",
    artist: el.getAttribute("data-artist") || "",
    artistId: el.getAttribute("data-artist-id") || "",        // M2: track performer id (VA/featured-safe) -> direct artist nav
    num: el.getAttribute("data-num") || "",
    ctxKind: el.getAttribute("data-ctx-kind") || "",
    ctxId: el.getAttribute("data-ctx-id") || "",
    ptid: el.getAttribute("data-ptid") || "",                 // M3: playlist_track_id (owned-playlist rows only)
    owned: el.getAttribute("data-owned") === "1"              // M3: viewing a playlist the user owns
  };
}
function openTrackSheet(el) { openSheetForData(sheetDataFromEl(el)); }
function openCurrentTrackSheet() {
  if (!hasTrack()) return;
  var tk = Q.player.getTrack() || {};
  openSheetForData({ albumId: tk.albumId || "", id: tk.id || "", title: tk.title || "", artist: tk.artist || "", num: "", ctxKind: "", ctxId: "" });
}
// ONE sheet mechanism (M1's) extended with the M2 actions: favourites / add-to-playlist(stub) / share.
function openSheetForData(d) {
  closeSheet();
  var favOn = d.id ? isFav("track", d.id) : false;
  _sheet = h('<div class="qz-sheet"><div class="qz-sheet__card">' +
    '<div class="qz-sheet__t">' + esc(d.title || "Track") + '</div>' +
    '<button class="qz-sheet__it" data-s="next">' + IC.next + '<span>Play next</span></button>' +
    '<button class="qz-sheet__it" data-s="queue">' + IC.queue + '<span>Add to queue</span></button>' +
    (d.id ? '<button class="qz-sheet__it" data-s="fav">' + (favOn ? IC.heartFilled : IC.heart) + '<span>' + (favOn ? "Remove from favourites" : "Add to favourites") + '</span></button>' : "") +
    (d.id ? '<button class="qz-sheet__it" data-s="playlist">' + IC_PLADD + '<span>Add to playlist</span></button>' : "") +
    (d.ctxKind === "playlist" && d.owned && d.ptid ? '<button class="qz-sheet__it qz-sheet__it--danger" data-s="rmpl">' + PL_TRASH + '<span>Remove from playlist</span></button>' : "") +
    '<button class="qz-sheet__it" data-s="radio">' + RADIO_IC + '<span>Start radio</span></button>' +
    (d.albumId ? '<button class="qz-sheet__it" data-s="album">' + IC.disc + '<span>Go to album</span></button>' : "") +
    '<button class="qz-sheet__it" data-s="artist">' + IC.sparkle + '<span>Go to artist</span></button>' +
    (d.id ? '<button class="qz-sheet__it" data-s="share">' + IC_SHARE + '<span>Share</span></button>' : "") +
    '<button class="qz-sheet__cancel" data-s="cancel">Cancel</button>' +
    '</div></div>');
  _sheet.addEventListener("click", function (e) {
    if (e.target === _sheet) { closeSheet(); return; }
    var b = e.target.closest("[data-s]"); if (!b) return;
    var s = b.getAttribute("data-s"); closeSheet();
    if (s === "next") queueNext(d);
    else if (s === "queue") queueAdd(d);
    else if (s === "fav") { if (d.id) toggleFavorite("track", d.id); }
    else if (s === "playlist") { if (d.id) addToPlaylist({ id: d.id, title: d.title }); }
    else if (s === "rmpl") removeFromPlaylistViaSheet(d);
    else if (s === "radio") startRadioFromData(d);
    else if (s === "album" && d.albumId) goToAlbum({ albumId: d.albumId });
    else if (s === "artist") { if (d.artistId) { closeNP(); go(artistScreen(d.artistId)); } else goToArtist({ albumId: d.albumId }); }   // M2: performer id wins; albumId->album.artist fallback
    else if (s === "share") { if (d.id) share("track", { id: d.id, title: d.title, artist: d.artist }); }
  });
  document.body.appendChild(_sheet);
  requestAnimationFrame(function () { if (_sheet) _sheet.classList.add("is-on"); });
}
// ============================================================================

// ============================================================================
// M3: PLAYLIST MANAGEMENT (create/edit/delete · add/remove/reorder · featured browser)
// Reconciled onto M1+M2: reuses the existing me()/cachedMe user-id helper (NO second id helper), the single
// _sheet/closeSheet/.qz-sheet chrome (NO parallel sheet system), qToast, api()/userPlaylists() cache, and the
// M2 playlist-subscribe favBtnHTML affordance. Ownership gate = playlist.owner.id === me() (same test
// playlist-tools uses). Writes always go through Q.api directly (uncached); reads that follow a write clear
// the api()/userPlaylists()/playlistGet cache via invalidatePlaylistCache().
// ----------------------------------------------------------------------------
var PL_PLUS   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
var PL_PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
var PL_TRASH  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>';
var PL_CHECK  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.2 4.2L19 7"/></svg>';
var PL_GRIP   = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.55"/><circle cx="15" cy="6" r="1.55"/><circle cx="9" cy="12" r="1.55"/><circle cx="15" cy="12" r="1.55"/><circle cx="9" cy="18" r="1.55"/><circle cx="15" cy="18" r="1.55"/></svg>';
var PL_CHEV   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>';   // up-chevron (flipped via CSS for "down")

// read calls are cached by api()/userPlaylists()/playlistGet() -> drop stale playlist entries after a write
function invalidatePlaylistCache() {
  try {
    for (var k in apiCache) {
      if (!apiCache.hasOwnProperty(k)) continue;
      if (k.indexOf("playlist/getUserPlaylists") === 0 || k.indexOf("playlist/get?playlist_id=") === 0) delete apiCache[k];
    }
  } catch (e) {}
}
// Qobuz blanks a whole name if it contains an emoji (gotchas.md) -> strip pictographs/symbols/VS/ZWJ.
function plainName(s) {
  s = String(s == null ? "" : s)
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")                                                     // astral emoji
    .replace(/[←-⇿⌀-➿⬀-⯿☀-⛿︀-️‍]/g, "");        // BMP symbols/VS/ZWJ
  return s.replace(/\s+/g, " ").trim();
}

// ---- CRUD + track-op primitives (writes use Q.api directly, never the cached api()) ----
function createPlaylist(name, opts) {                 // -> Promise<newIdString|null>
  opts = opts || {};
  var q = "playlist/create?name=" + encodeURIComponent(name || "New Playlist") +
          "&is_public=" + (opts.isPublic ? "true" : "false") +
          "&is_collaborative=" + (opts.isCollaborative ? "true" : "false");
  if (opts.description) q += "&description=" + encodeURIComponent(opts.description);
  return Q.api(q).then(function (c) { return c && c.id != null ? String(c.id) : null; });
}
// NOTE: playlist/update param names are INFERRED from the create param set (teardown documents only the route
// name; no live capture exists in-repo). Kept as-is per spec; UNVERIFIED against live. If it 400s the likely
// fix is name/description only (drop the two booleans).
function editPlaylist(id, patch) {
  patch = patch || {};
  var q = "playlist/update?playlist_id=" + encodeURIComponent(id);
  if (patch.name != null)            q += "&name=" + encodeURIComponent(patch.name);
  if (patch.description != null)     q += "&description=" + encodeURIComponent(patch.description);
  if (patch.isPublic != null)        q += "&is_public=" + (patch.isPublic ? "true" : "false");
  if (patch.isCollaborative != null) q += "&is_collaborative=" + (patch.isCollaborative ? "true" : "false");
  return Q.api(q);
}
function deletePlaylist(id)                { return Q.api("playlist/delete?playlist_id=" + encodeURIComponent(id)); }
function addTrackIdToPlaylist(pid, trackId){ return Q.api("playlist/addTracks?playlist_id=" + pid + "&track_ids=" + encodeURIComponent(trackId)); }
function deletePlaylistTrack(pid, ptid)    { return Q.api("playlist/deleteTracks?playlist_id=" + pid + "&playlist_track_ids=" + encodeURIComponent(ptid)); }   // ptid = playlist_track_id, NOT track id
// M3 FIX: within-playlist track reorder is playlist/updateTracksPosition with insert_before = a 1-BASED POSITION
// INDEX (NOT a ptid). updatePlaylistsPosition is the library playlist-LIST reorder (wants playlist_ids) - wrong route.
// destIndex = the moved track's NEW 0-based index; insert_before = destIndex + 1. A wrong call is non-destructive
// (server 400s -> we reload).
function reorderTracks(pid, movedPtid, destIndex) {
  var pos = (destIndex | 0) + 1;   // 0-based index -> 1-based position
  return Q.api("playlist/updateTracksPosition?playlist_id=" + pid + "&playlist_track_ids=" + movedPtid + "&insert_before=" + pos);
}
// user's OWN playlists, FRESH (uncached so a just-created one shows). owner.id === me() gate.
function ownedPlaylists() {
  return Promise.all([me(), Q.api("playlist/getUserPlaylists?limit=200")]).then(function (r) {
    var uid = r[0], items = (r[1].playlists && r[1].playlists.items) || [];
    if (!uid) return [];   // M3 FIX: user/get failed -> can't prove ownership, so offer nothing (never list un-addable targets)
    return items.filter(function (p) { return p.owner && String(p.owner.id) === String(uid); });
  }).catch(function () { return []; });
}
// track-id set of a playlist for duplicate-awareness (one uncached fetch on demand). null = couldn't check.
function playlistTrackIdSet(pid) {
  return Q.api("playlist/get?playlist_id=" + pid + "&extra=tracks&limit=500").then(function (j) {
    var s = {}; ((j.tracks && j.tracks.items) || []).forEach(function (t) { s[String(t.id)] = 1; }); return s;
  }).catch(function () { return null; });
}

// ---- create/edit form sheet (reuses the shared _sheet + .qz-sheet chrome) ----
function formToggleHTML(f, title, sub, on) {
  return '<button class="qz-pf__tog' + (on ? " is-on" : "") + '" data-f="' + f + '" type="button">' +
    '<span class="qz-pf__togl"><span class="qz-pf__togt">' + esc(title) + '</span>' +
    '<span class="qz-pf__togs">' + esc(sub) + '</span></span><span class="qz-pf__sw"></span></button>';
}
function openPlaylistFormSheet(mode, opts) {
  opts = opts || {};
  closeSheet();
  var isEdit = mode === "edit";
  var pub = !!opts.isPublic, collab = !!opts.isCollaborative;
  _sheet = h('<div class="qz-sheet"><div class="qz-sheet__card qz-pf">' +
    '<div class="qz-pf__h">' + (isEdit ? "Edit playlist" : "New playlist") + '</div>' +
    '<input class="qz-pf__in" data-f="name" type="text" placeholder="Playlist name" maxlength="100" autocapitalize="sentences" autocorrect="off" spellcheck="false">' +
    '<textarea class="qz-pf__ta" data-f="desc" placeholder="Description (optional)" maxlength="500" rows="2"></textarea>' +
    formToggleHTML("public", "Public", "Anyone with the link can listen", pub) +
    formToggleHTML("collab", "Collaborative", "Let others add tracks", collab) +
    '<div class="qz-pf__row">' +
      '<button class="qz-pf__btn qz-pf__btn--ghost" data-s="cancel" type="button">Cancel</button>' +
      '<button class="qz-pf__btn qz-pf__btn--go" data-s="save" type="button">' + (isEdit ? "Save" : "Create") + '</button>' +
    '</div></div></div>');
  var card = _sheet.querySelector(".qz-pf");
  var nameIn = card.querySelector('[data-f="name"]');
  var descIn = card.querySelector('[data-f="desc"]');
  nameIn.value = opts.name || "";
  descIn.value = opts.description || "";
  _sheet.addEventListener("click", function (e) {
    if (e.target === _sheet) { closeSheet(); return; }
    var tog = e.target.closest(".qz-pf__tog");
    if (tog) {
      if (tog.getAttribute("data-f") === "public") { pub = !pub; tog.classList.toggle("is-on", pub); }
      else { collab = !collab; tog.classList.toggle("is-on", collab); }
      return;
    }
    var b = e.target.closest("[data-s]"); if (!b) return;
    var s = b.getAttribute("data-s");
    if (s === "cancel") { closeSheet(); return; }
    if (s === "save") {
      var nm = plainName((nameIn.value || "").trim());
      if (!nm) { nameIn.classList.add("is-err"); try { nameIn.focus(); } catch (e2) {} return; }
      var desc = (descIn.value || "").trim();
      b.disabled = true; b.textContent = isEdit ? "Saving…" : "Creating…";
      var p = isEdit
        ? editPlaylist(opts.id, { name: nm, description: desc, isPublic: pub, isCollaborative: collab })
        : createPlaylist(nm, { description: desc, isPublic: pub, isCollaborative: collab });
      p.then(function (res) {
        invalidatePlaylistCache();
        closeSheet();
        if (isEdit) { qToast("Playlist updated"); if (opts.onSaved) opts.onSaved(); else render(); }
        else { qToast('Created "' + nm + '"'); if (opts.onCreated) opts.onCreated(res, nm); else if (res) go(playlistDetailScreen(res)); }
      }).catch(function () {
        b.disabled = false; b.textContent = isEdit ? "Save" : "Create";
        qToast(isEdit ? "Couldn't update playlist" : "Couldn't create playlist");
      });
    }
  });
  document.body.appendChild(_sheet);
  requestAnimationFrame(function () { if (_sheet) _sheet.classList.add("is-on"); });
  setTimeout(function () { try { nameIn.focus(); } catch (e) {} }, 80);
}
function openCreatePlaylistSheet(opts) { openPlaylistFormSheet("create", opts || {}); }
function openEditPlaylistSheet(id) {
  Q.api("playlist/get?playlist_id=" + encodeURIComponent(id) + "&limit=0").then(function (j) {
    openPlaylistFormSheet("edit", { id: id, name: (j && j.name) || "", description: (j && j.description) || "",
      isPublic: !!(j && j.is_public), isCollaborative: !!(j && j.is_collaborative) });
  }).catch(function () { openPlaylistFormSheet("edit", { id: id, name: "", description: "", isPublic: false, isCollaborative: false }); });
}

// ---- owner-only options sheet: Edit details / Delete (reuses _sheet chrome; two-step delete confirm) ----
function openPlaylistSheet(id) {
  closeSheet();
  _sheet = h('<div class="qz-sheet"><div class="qz-sheet__card"></div></div>');
  var card = _sheet.querySelector(".qz-sheet__card");
  function menu() {
    card.innerHTML =
      '<div class="qz-sheet__t">Playlist options</div>' +
      '<button class="qz-sheet__it" data-s="edit" type="button">' + PL_PENCIL + '<span>Edit details</span></button>' +
      '<button class="qz-sheet__it qz-sheet__it--danger" data-s="delete" type="button">' + PL_TRASH + '<span>Delete playlist</span></button>' +
      '<button class="qz-sheet__cancel" data-s="cancel" type="button">Cancel</button>';
  }
  function confirm() {
    card.innerHTML =
      '<div class="qz-sheet__t">Delete this playlist? This can\'t be undone.</div>' +
      '<button class="qz-sheet__it qz-sheet__it--danger" data-s="confirm" type="button">' + PL_TRASH + '<span>Yes, delete playlist</span></button>' +
      '<button class="qz-sheet__cancel" data-s="back" type="button">Cancel</button>';
  }
  menu();
  _sheet.addEventListener("click", function (e) {
    if (e.target === _sheet) { closeSheet(); return; }
    var b = e.target.closest("[data-s]"); if (!b) return;
    var s = b.getAttribute("data-s");
    if (s === "cancel") closeSheet();
    else if (s === "edit") { closeSheet(); openEditPlaylistSheet(id); }
    else if (s === "delete") confirm();
    else if (s === "back") menu();
    else if (s === "confirm") {
      b.disabled = true; var lbl = b.querySelector("span"); if (lbl) lbl.textContent = "Deleting…";
      deletePlaylist(id).then(function () {
        invalidatePlaylistCache(); closeSheet(); qToast("Playlist deleted"); popToLibraryPlaylists();
      }).catch(function () { b.disabled = false; if (lbl) lbl.textContent = "Yes, delete playlist"; qToast("Couldn't delete playlist"); });
    }
  });
  document.body.appendChild(_sheet);
  requestAnimationFrame(function () { if (_sheet) _sheet.classList.add("is-on"); });
}
function newPlaylistBtnHTML() { return '<button class="qz-newpl" data-act="pl-new" type="button">' + PL_PLUS + '<span>New playlist</span></button>'; }
function popToLibraryPlaylists() {   // "pop back to Library and refresh" — fresh libraryScreen -> refetches (cache invalidated)
  setTab("library");
  setTimeout(function () { var seg = contentEl && contentEl.querySelector('.qz-seg[data-lib="playlists"]'); if (seg) seg.click(); }, 0);
}

// ---- Add-to-playlist sheet (replaces the M2 "coming soon" stub). Reuses _sheet/.qz-sheet chrome. ----
// Accepts a track object ({id,title}) or a bare id. Lists the user's OWN playlists + a New-playlist row.
function addToPlaylist(track) {
  closeSheet();                                   // dismiss the track-options sheet if it's open
  var tid = track && (typeof track === "object" ? track.id : track);
  var ttl = (track && typeof track === "object" && track.title) || "";
  if (tid == null || tid === "") { qToast("Can't add this track"); return; }
  tid = String(tid);
  _sheet = h('<div class="qz-sheet"><div class="qz-sheet__card">' +
      '<div class="qz-sheet__t">Add ' + (ttl ? "“" + esc(ttl) + "”" : "track") + ' to…</div>' +
      '<button class="qz-sheet__it qz-plnew" data-s="new" type="button">' + PL_PLUS + '<span>New playlist</span></button>' +
      '<div class="qz-pllist"><div class="qz-load"><span class="qz-spin"></span></div></div>' +
      '<button class="qz-sheet__cancel" data-s="cancel" type="button">Cancel</button>' +
    '</div></div>');
  _sheet.addEventListener("click", function (e) {
    if (e.target === _sheet) { closeSheet(); return; }
    var row = e.target.closest("[data-pl]");
    if (row) { pickPlaylist(row, tid); return; }
    var b = e.target.closest("[data-s]"); if (!b) return;
    var s = b.getAttribute("data-s");
    if (s === "cancel") closeSheet();
    else if (s === "new") promptNewPlaylist(tid);
  });
  document.body.appendChild(_sheet);
  requestAnimationFrame(function () { if (_sheet) _sheet.classList.add("is-on"); });
  var host = _sheet.querySelector(".qz-pllist");
  ownedPlaylists().then(function (pls) {
    if (!host || !host.parentNode) return;         // sheet dismissed before the fetch resolved
    if (!pls.length) { host.innerHTML = '<div class="qz-plempty">No playlists yet. Tap “New playlist”.</div>'; return; }
    host.innerHTML = pls.map(function (p) {
      return '<button class="qz-plrow" data-pl="' + esc(p.id) + '" data-name="' + esc(p.name) + '" type="button">' +
          '<span class="qz-plrow__ic">' + IC.note + '</span>' +
          '<span class="qz-plrow__meta"><span class="qz-plrow__n">' + esc(p.name) + '</span>' +
            '<span class="qz-plrow__c">' + (p.tracks_count || 0) + ' tracks</span></span>' +
          '<span class="qz-plrow__go">' + PL_PLUS + '</span></button>';
    }).join("");
  });
}
function pickPlaylist(row, tid) {
  if (row.classList.contains("is-busy")) return;
  var pid = row.getAttribute("data-pl"), name = row.getAttribute("data-name") || "playlist";
  if (row.getAttribute("data-confirm") === "1") { commitAdd(row, pid, name, tid); return; }   // "add anyway"
  row.classList.add("is-busy");
  playlistTrackIdSet(pid).then(function (set) {
    row.classList.remove("is-busy");
    if (set && set[tid]) {                        // dedupe-aware
      row.setAttribute("data-confirm", "1"); row.classList.add("is-dup");
      var c = row.querySelector(".qz-plrow__c"); if (c) c.textContent = "Already added, tap again to add anyway";
    } else { commitAdd(row, pid, name, tid); }
  });
}
function commitAdd(row, pid, name, tid) {
  row.classList.add("is-busy"); row.removeAttribute("data-confirm");
  addTrackIdToPlaylist(pid, tid).then(function () { invalidatePlaylistCache(); qToast("Added to “" + name + "”"); closeSheet(); })
    .catch(function () { row.classList.remove("is-busy"); qToast("Couldn't add, try again"); });
}
function promptNewPlaylist(tid) {
  if (!_sheet) return;
  var btn = _sheet.querySelector(".qz-plnew"); if (!btn) return;
  var wrap = h('<div class="qz-plcreate">' +
      '<input class="qz-plcreate__in" type="text" placeholder="Playlist name" maxlength="100" autocapitalize="sentences">' +
      '<button class="qz-plcreate__go" type="button">Create</button></div>');
  btn.parentNode.replaceChild(wrap, btn);
  var input = wrap.querySelector(".qz-plcreate__in"), goBtn = wrap.querySelector(".qz-plcreate__go");
  function submit() {
    var nm = plainName((input.value || "").trim()); if (!nm) { try { input.focus(); } catch (e) {} return; }
    goBtn.disabled = true; goBtn.textContent = "…";
    createPlaylist(nm).then(function (pid) {
      return addTrackIdToPlaylist(pid, tid).then(function () { invalidatePlaylistCache(); qToast("Created “" + nm + "” · added"); closeSheet(); });
    }).catch(function () { goBtn.disabled = false; goBtn.textContent = "Create"; qToast("Couldn't create, try again"); });
  }
  goBtn.addEventListener("click", submit);
  input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
  setTimeout(function () { try { input.focus(); } catch (e) {} }, 60);
}
// remove a track from an OWNED playlist via the context sheet (uses playlist_track_id, NOT track id)
function removeFromPlaylistViaSheet(d) {
  if (!d || !d.ctxId || !d.ptid) { qToast("Can't remove this track"); return; }
  deletePlaylistTrack(d.ctxId, d.ptid).then(function () {
    invalidatePlaylistCache();
    qToast("Removed from playlist");
    render();                                     // re-mount the owned playlist detail so list + edit state stay in sync
  }).catch(function () { qToast("Couldn't remove, try again"); });
}

// ---- featured / editorial playlists browser (M3) ----
function fmtTotal(sec) { sec = Math.round(sec || 0); var hh = Math.floor(sec / 3600), mm = Math.round((sec % 3600) / 60); return hh ? (hh + " hr " + mm + " min") : (mm + " min"); }
// playlist/getFeatured?type=<slug> — "editor-picks" is CONFIRMED (Home shelf already uses it). The rest are
// best-effort per teardown; featuredPlaylists() catches to [] so a type that 400s/returns [] is silently
// dropped and its chip stays hidden -> the bar self-heals to whatever this account actually serves.
var FEAT_TYPES = [
  { type: "editor-picks", label: "Editor's Picks" },
  { type: "new-releases", label: "New" },
  { type: "mood",         label: "Moods" },
  { type: "focus",        label: "Focus" },
  { type: "label",        label: "Labels" },
  { type: "event",        label: "Events" },
  { type: "last-created", label: "Fresh" }
];
function featIdx(type) { for (var i = 0; i < FEAT_TYPES.length; i++) if (FEAT_TYPES[i].type === type) return i; return 99; }
function featScreen() {
  return { title: "Playlists", mount: function (el) {
    el.innerHTML =
      '<div class="qz-fh"><h2 class="qz-fh__title">Qobuz Playlists</h2>' +
      '<div class="qz-fh__sub">Editorial picks, curated by Qobuz</div></div>' +
      '<div class="qz-chips">' +
      FEAT_TYPES.map(function (c) { return '<button class="qz-chip" data-ftype="' + esc(c.type) + '" hidden type="button">' + esc(c.label) + '</button>'; }).join("") +
      '</div><div class="qz-fbody"><div class="qz-load"><span class="qz-spin"></span></div></div>';
    var chips = el.querySelector(".qz-chips"), body = el.querySelector(".qz-fbody");
    var store = {}, cur = null, touched = false, pending = FEAT_TYPES.length, live = 0;
    function select(type) {
      cur = type;
      [].forEach.call(chips.querySelectorAll(".qz-chip"), function (b) { b.classList.toggle("is-on", b.getAttribute("data-ftype") === type); });
      body.innerHTML = gridHTML(store[type], "playlist");   // cards carry data-act="playlist" -> onContentTap -> playlistDetailScreen
    }
    chips.addEventListener("click", function (e) {
      var b = e.target.closest("[data-ftype]"); if (b && !b.hidden) { touched = true; select(b.getAttribute("data-ftype")); }
    });
    FEAT_TYPES.forEach(function (c) {
      featuredPlaylists(c.type, 18).then(function (items) {
        pending--;
        if (items && items.length) {
          store[c.type] = items; live++;
          var chip = chips.querySelector('[data-ftype="' + c.type + '"]'); if (chip) chip.hidden = false;
          if (!touched && (cur === null || featIdx(c.type) < featIdx(cur))) select(c.type);   // default to lowest-index live type
        }
        if (!pending && !live) body.innerHTML = '<p class="qz-empty">No featured playlists right now.</p>';
      });
    });
  } };
}
function featEntryHTML() {
  return '<button class="qz-featentry" data-act="featured" type="button">' +
    '<span class="qz-featentry__ic">' + IC.sparkle + '</span>' +
    '<span class="qz-featentry__tx"><span class="qz-featentry__t">Browse Qobuz Playlists</span>' +
    '<span class="qz-featentry__s">Editorial picks by mood, label &amp; more</span></span>' +
    '<span class="qz-featentry__chev"><svg viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></button>';
}

// ---- owned-aware playlist detail: subscribe (non-owned) OR edit affordances (owned: reorder + remove) ----
// Single entry point for every playlist tap. Non-owned renders like the old detail (header + trackListHTML +
// M2 subscribe). Owned adds an owner kebab (Edit details / Delete) + an Edit toggle (up/down + drag reorder,
// per-row remove). The context sheet on an owned-playlist track also gains "Remove from playlist".
function playlistDetailScreen(id) {
  return { title: "", mount: function (el) {
    loading(el);
    var host = null, editing = false, TR = [], owned = false, meta = {}, pendingMoves = {};   // M3 FIX: per-ptid reorder debounce timers

    Promise.all([ playlistGet(id), me() ]).then(function (r) {
      var o = r[0] || {}, uid = r[1];
      TR = (o.tracks && o.tracks.items) || [];
      owned = !!(o.owner && uid && String(o.owner.id) === String(uid));
      var count = o.tracks_count || TR.length;
      var durSec = o.duration || TR.reduce(function (s, t) { return s + (t.duration || 0); }, 0);
      meta = { title: o.title || o.name || "", img: cover(o),
        sub: [ (o.owner && o.owner.name) || "", count ? count + " tracks" : "", durSec ? fmtTotal(durSec) : "" ].filter(Boolean).join(" · ") };
      el.innerHTML = "";
      host = h('<div class="qz-plhost"></div>');
      el.appendChild(host);
      host.addEventListener("click", onEditTap);   // scoped to host (dies with the screen on next render -> no leak)
      redraw();
    }).catch(function () { el.innerHTML = '<p class="qz-empty">Couldn\'t load this playlist.</p>'; });

    function headerHTML() {
      var actions =
        '<button class="qz-dhead__play" data-act="playtop" data-kind="playlist" data-id="' + esc(id) + '" data-first="' + esc(TR[0] ? (TR[0].title || "") : "") + '">' + IC.play + ' Play</button>' +
        (owned
          ? '<button class="qz-editbtn" data-role="pledit" type="button">' + (editing ? PL_CHECK + '<span>Done</span>' : PL_GRIP + '<span>Edit</span>') + '</button>'
          : favBtnHTML("playlist", id, "qz-dhead__fav"));
      return '<div class="qz-dhead">' +
        (owned ? '<button class="qz-dhead__more" data-act="pl-menu" data-id="' + esc(id) + '" aria-label="Playlist options" type="button">' + IC.more + '</button>' : "") +
        '<div class="qz-dhead__art">' + (meta.img ? '<img src="' + esc(meta.img) + '">' : ph("playlist")) + '</div>' +
        '<div class="qz-dhead__t">' + esc(meta.title) + '</div>' +
        '<div class="qz-dhead__s">' + esc(meta.sub) + '</div>' +
        '<div class="qz-dhead__actions">' + actions + '</div></div>';
    }
    function editListHTML() {
      if (!TR.length) return '<p class="qz-empty">No tracks yet. Add some from any album or search.</p>';
      return '<div class="qz-tlist qz-pltlist">' + TR.map(function (t) {
        var img = cover(t);
        return '<div class="qz-plrow-e" data-ptid="' + esc(t.playlist_track_id) + '">' +
            '<button class="qz-plgrip" aria-label="Drag to reorder" type="button">' + PL_GRIP + '</button>' +
            '<span class="qz-plrow-e__art">' + (img ? '<img loading="lazy" src="' + esc(img) + '">' : ph("track")) + '</span>' +
            '<span class="qz-plrow-e__meta"><span class="qz-trow__t">' + esc(t.title) + '</span>' +
              '<span class="qz-trow__s">' + esc(artistName(t)) + '</span></span>' +
            '<span class="qz-plmoves"><button class="qz-plmv qz-plmv--up" data-e="up" aria-label="Move up" type="button">' + PL_CHEV + '</button>' +
              '<button class="qz-plmv qz-plmv--down" data-e="down" aria-label="Move down" type="button">' + PL_CHEV + '</button></span>' +
            '<button class="qz-plrm" data-e="rm" aria-label="Remove from playlist" type="button">' + PL_TRASH + '</button>' +
          '</div>';
      }).join("") + '</div>';
    }
    function redraw() {
      if (!host) return;
      var y = contentEl ? contentEl.scrollTop : 0;
      host.innerHTML = headerHTML() + (editing ? editListHTML() : trackListHTML(TR, { kind: "playlist", id: id, owned: owned }));
      if (contentEl) contentEl.scrollTop = y;
      if (editing) attachDrag(host.querySelector(".qz-pltlist"));
    }
    function idxOf(ptid) { for (var i = 0; i < TR.length; i++) if (String(TR[i].playlist_track_id) === String(ptid)) return i; return -1; }

    function onEditTap(e) {
      var toggle = e.target.closest('[data-role="pledit"]');
      if (toggle) { editing = !editing; redraw(); return; }
      var ed = e.target.closest("[data-e]"); if (!ed) return;
      var row = ed.closest("[data-ptid]"); if (!row) return;
      var ptid = row.getAttribute("data-ptid"), a = ed.getAttribute("data-e");
      if (a === "rm") removeRow(ptid);
      else if (a === "up") moveRow(ptid, -1);
      else if (a === "down") moveRow(ptid, 1);
    }
    function removeRow(ptid) {
      var i = idxOf(ptid); if (i < 0) return;
      var removed = TR[i]; TR.splice(i, 1); redraw();                 // optimistic
      deletePlaylistTrack(id, ptid).then(function () { invalidatePlaylistCache(); qToast("Removed"); })
        .catch(function () { TR.splice(i, 0, removed); redraw(); qToast("Couldn't remove, try again"); });
    }
    function moveRow(ptid, dir) {
      var i = idxOf(ptid); if (i < 0) return;
      var j = i + dir; if (j < 0 || j >= TR.length) return;
      var t = TR[i]; TR[i] = TR[j]; TR[j] = t; redraw();
      commitMove(ptid);
    }
    // M3 FIX: per-ptid debounce (pendingMoves map) so moving track A then B within 450ms doesn't cancel A's write;
    // same-ptid repeats still coalesce to the final position (index recomputed at fire time). reorderTracks wants the
    // moved track's NEW 0-based index (it maps to a 1-based insert_before position), so recompute it when the timer fires.
    function commitMove(movedPtid) {
      var key = String(movedPtid);
      clearTimeout(pendingMoves[key]);
      pendingMoves[key] = setTimeout(function () {
        delete pendingMoves[key];
        var destIndex = TR.map(function (t) { return String(t.playlist_track_id); }).indexOf(key);   // NEW 0-based index
        if (destIndex < 0) return;
        reorderTracks(id, movedPtid, destIndex).then(function () { invalidatePlaylistCache(); })
          .catch(function () { qToast("Reorder didn't save, reloading"); reload(); });
      }, 450);
    }
    function reload() {
      invalidatePlaylistCache();
      playlistGet(id).then(function (o) { TR = (o.tracks && o.tracks.items) || []; redraw(); }).catch(function () {});
    }
    // pointer-drag reorder (touch + mouse). Live-moves the row; commits the single move on drop.
    function attachDrag(listEl) {
      if (!listEl) return;
      var dragging = null, capEl = null, pid2 = 0;
      listEl.addEventListener("pointerdown", function (e) {
        var handle = e.target.closest(".qz-plgrip"); if (!handle) return;
        dragging = handle.closest(".qz-plrow-e"); if (!dragging) return;
        e.preventDefault();
        dragging.classList.add("is-dragging"); capEl = handle; pid2 = e.pointerId;
        try { handle.setPointerCapture(pid2); } catch (_) {}
        document.addEventListener("pointermove", onMove, true);
        document.addEventListener("pointerup", onUp, true);
        document.addEventListener("pointercancel", onUp, true);
      });
      function onMove(e) {
        if (!dragging) return; e.preventDefault();
        var y = e.clientY, kids = [].slice.call(listEl.querySelectorAll(".qz-plrow-e")), before = null;
        for (var k = 0; k < kids.length; k++) {
          if (kids[k] === dragging) continue;
          var rc = kids[k].getBoundingClientRect();
          if (y < rc.top + rc.height / 2) { before = kids[k]; break; }
        }
        if (before) { if (dragging.nextSibling !== before) listEl.insertBefore(dragging, before); }
        else if (dragging !== listEl.lastElementChild) listEl.appendChild(dragging);
        if (contentEl) {                                    // edge auto-scroll
          var cr = contentEl.getBoundingClientRect();
          if (y < cr.top + 64) contentEl.scrollTop -= 9;
          else if (y > cr.bottom - 64) contentEl.scrollTop += 9;
        }
      }
      function onUp() {
        if (!dragging) return;
        try { capEl.releasePointerCapture(pid2); } catch (_) {}
        dragging.classList.remove("is-dragging");
        document.removeEventListener("pointermove", onMove, true);
        document.removeEventListener("pointerup", onUp, true);
        document.removeEventListener("pointercancel", onUp, true);
        var movedPtid = dragging.getAttribute("data-ptid"); dragging = null;
        var ptids = [].slice.call(listEl.querySelectorAll(".qz-plrow-e")).map(function (r) { return r.getAttribute("data-ptid"); });
        var map = {}; TR.forEach(function (t) { map[String(t.playlist_track_id)] = t; });
        TR = ptids.map(function (p) { return map[String(p)]; }).filter(Boolean);   // sync model to DOM
        commitMove(movedPtid);
      }
    }
  } };
}
// ============================================================================

// ------------------------------------------------------------------ card / row / shelf renderers
function ph(kind) { return '<span class="qz-ph">' + (kind === "artist" ? IC.disc : IC.note) + "</span>"; }
function cardHTML(o, kind) {
  var img = cover(o), id = o.id, name = o.name || o.title || "";
  var sub = kind === "playlist" ? (o.owner && o.owner.name ? "by " + o.owner.name : ((o.tracks_count || 0) + " tracks"))
          : kind === "artist"   ? ""                          // name is already the title; artistName() would duplicate it
          : artistName(o);                                    // albums
  var off = (kind === "album") && rowDisabled(o);             // unplayable album -> dimmed (still tappable to view)
  return '<button class="qz-card' + (kind === "artist" ? " qz-card--round" : "") + (off ? " qz-card--off" : "") + '" data-act="' + kind + '" data-id="' + esc(id) + '">' +
    '<span class="qz-card__art">' + (img ? '<img loading="lazy" src="' + esc(img) + '" alt="">' : ph(kind)) + "</span>" +
    '<span class="qz-card__name">' + esc(name) + (kind === "album" ? explicitBadge(o) + qBadge(o) : "") + "</span>" +
    (sub ? '<span class="qz-card__sub">' + esc(sub) + "</span>" : "") + "</button>";
}
function shelfHTML(title, items, kind) {
  if (!items || !items.length) return "";
  return '<section class="qz-shelf"><h3 class="qz-shelf__h">' + esc(title) + '</h3><div class="qz-shelf__row">' +
    items.map(function (o) { return cardHTML(o, kind); }).join("") + "</div></section>";
}
function gridHTML(items, kind) {
  if (!items || !items.length) return '<p class="qz-empty">Nothing here yet.</p>';
  return '<div class="qz-grid">' + items.map(function (o) { return cardHTML(o, kind); }).join("") + "</div>";
}
// track row: tap plays it IN CONTEXT. ctx = {kind:"album"|"playlist", id} (the page whose queue we want) or
// null (search/favorites/top-tracks -> album fallback via data-album). pos = 1-based row index for playlist match.
function trackRowHTML(t, ctx, pos) {
  var art = cover(t) || (ctx && ctx.kind === "album" ? (ctx.cover || "") : ""),   // [M2] album-detail rows: raw album/get tracks have no per-track cover -> use the album's
      aid = (albumOf(t) && albumOf(t).id) || (ctx && ctx.kind === "album" ? ctx.id : ""),   // [M2] album-detail rows have no t.album -> fall back to the album context id
      arId = (t.performer && t.performer.id) || (t.artist && t.artist.id) || "",             // [M2] track performer id (correct for VA/featured; albumId is the fallback)
      off = rowDisabled(t);   // not streamable -> greyed + non-playable
  // M3: on an OWNED playlist thread the playlist_track_id + owned flag so the context sheet can offer "Remove from playlist"
  var plOwned = !!(ctx && ctx.kind === "playlist" && ctx.owned);
  var ptid = plOwned && t.playlist_track_id != null ? t.playlist_track_id : "";
  var data = ' data-album="' + esc(aid) + '" data-id="' + esc(t.id || "") + '" data-title="' + esc(t.title) + '" data-artist="' + esc(artistName(t)) +
    '" data-artist-id="' + esc(arId) + '" data-num="' + esc(t.track_number || "") + '" data-ctx-kind="' + esc(ctx ? ctx.kind : "") + '" data-ctx-id="' + esc(ctx ? ctx.id : "") + '" data-pos="' + esc(pos || "") +
    '" data-ptid="' + esc(ptid) + '" data-owned="' + (plOwned ? "1" : "") + '"';
  return '<div class="qz-trow' + (off ? " qz-trow--off" : "") + '"' + (off ? "" : ' data-act="play"') + data + '>' +
    '<span class="qz-trow__art">' + (art ? '<img loading="lazy" src="' + esc(art) + '">' : ph("track")) + '<span class="qz-trow__play">' + IC.play + "</span></span>" +
    '<span class="qz-trow__meta"><span class="qz-trow__t">' + esc(t.title) + explicitBadge(t) + qBadge(t) + "</span><span class=\"qz-trow__s\">" + esc(artistName(t)) + "</span></span>" +
    favBtnHTML("track", t.id, "qz-trow__fav") +
    '<span class="qz-trow__d">' + fmtDur(t.duration) + "</span>" +
    '<button class="qz-trow__more" data-act="more"' + data + ' aria-label="More">' + IC.more + "</button></div>";
}
function trackListHTML(items, ctx) {
  if (!items || !items.length) return '<p class="qz-empty">No tracks.</p>';
  return '<div class="qz-tlist">' + items.map(function (t, i) { return trackRowHTML(t, ctx, i + 1); }).join("") + "</div>";
}

// ------------------------------------------------------------------ screens (each: {title, mount(el)})
function loading(el) { el.innerHTML = '<div class="qz-load"><span class="qz-spin"></span></div>'; }

// homeScreen removed in M4: the Discover feed (discoverScreen) replaces it. The M3 Home-banner entry to the
// featured-playlist browser is dropped with it (redundant — Discover already carries a "Qobuz playlists" rail);
// the Library → Playlists banner to featScreen() is kept. featEntryHTML() is still used there.

// ---- Search: recent-history store (M4) ---------------------------------------
// Persists via Q.storage ("searchHistory" -> runtime prefixes to "qobuzify:x:searchHistory"),
// falling back to raw localStorage under the same real key. Values are JSON string arrays,
// most-recent-first, deduped case-insensitively, capped at HX_CAP.
var HX_KEY = "searchHistory", HX_FULLKEY = "qobuzify:x:searchHistory", HX_CAP = 12;
function hxLoad() {
  var raw = null;
  try { raw = (Q && Q.storage) ? Q.storage.get(HX_KEY, null) : localStorage.getItem(HX_FULLKEY); } catch (e) {}
  if (!raw) return [];
  try { var a = JSON.parse(raw); return (a && a.length) ? a.slice(0, HX_CAP) : []; } catch (e2) { return []; }
}
function hxSave(list) {
  var raw = JSON.stringify(list.slice(0, HX_CAP));
  try { if (Q && Q.storage) Q.storage.set(HX_KEY, raw); else localStorage.setItem(HX_FULLKEY, raw); } catch (e) {}
}
function hxRecord(q) {
  q = String(q == null ? "" : q).trim();
  if (q.length < 2) return;
  var low = q.toLowerCase();
  var list = hxLoad().filter(function (x) { return String(x).toLowerCase() !== low; });  // dedupe
  list.unshift(q);                                                                       // newest first
  hxSave(list);
}
function hxRemove(q) {
  var low = String(q).toLowerCase();
  hxSave(hxLoad().filter(function (x) { return String(x).toLowerCase() !== low; }));
}
function hxClear() { hxSave([]); }

// small inline icons for the history list (self-contained; no dependency on IC.*)
var IC_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.4V12l3 1.8"/></svg>';
var IC_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function searchScreen() {
  var term = "", facet = "all", last = null;   // last = { q, tr, al, ar, pl }

  // "Top result" hero — navigable entities only (artist / album / playlist); tracks stay in the Songs list.
  function bestMatch(r) {
    var q = (r.q || "").toLowerCase();
    function score(s) { s = String(s || "").toLowerCase(); return s === q ? 3 : (s.indexOf(q) === 0 ? 2 : (s.indexOf(q) >= 0 ? 1 : 0)); }
    var c = [];
    if (r.ar[0]) c.push({ kind: "artist",   o: r.ar[0], s: score(r.ar[0].name) + 0.5 });          // artists slightly favored
    if (r.al[0]) c.push({ kind: "album",    o: r.al[0], s: score(r.al[0].title || r.al[0].name) });
    if (r.pl[0]) c.push({ kind: "playlist", o: r.pl[0], s: score(r.pl[0].name) - 0.5 });
    c.sort(function (a, b) { return b.s - a.s; });
    return (c[0] && c[0].s > 0) ? c[0] : null;
  }
  function topResHTML(m) {
    if (!m) return "";
    var o = m.o, kind = m.kind, img = cover(o), name = o.name || o.title || "";
    var sub = kind === "artist"   ? "Artist"
            : kind === "playlist" ? ("Playlist" + (o.owner && o.owner.name ? " · " + o.owner.name : ""))
            :                       ("Album · " + artistName(o));
    return '<section class="qz-sec"><h3 class="qz-shelf__h">Top result</h3>' +
      '<button class="qz-topres' + (kind === "artist" ? " qz-topres--round" : "") + '" data-act="' + kind + '" data-id="' + esc(o.id) + '">' +
      '<span class="qz-topres__art">' + (img ? '<img src="' + esc(img) + '">' : ph(kind === "artist" ? "artist" : "track")) + "</span>" +
      '<span class="qz-topres__meta"><span class="qz-topres__t">' + esc(name) + "</span>" +
      '<span class="qz-topres__s">' + esc(sub) + "</span></span></button></section>";
  }

  // facet tab bar (reuses .qz-segbar/.qz-seg). All + one tab per type, with a live count; empty tabs dim but stay tappable.
  function facetBarHTML(r) {
    var defs = [["all", "All", -1], ["tracks", "Songs", r.tr.length], ["albums", "Albums", r.al.length],
                ["artists", "Artists", r.ar.length], ["playlists", "Playlists", r.pl.length]];
    return defs.map(function (d) {
      var n = d[2], on = d[0] === facet;
      return '<button class="qz-seg' + (on ? " is-on" : "") + (n === 0 ? " qz-seg--empty" : "") + '" data-facet="' + d[0] + '">' +
        d[1] + (n > 0 ? '<span class="qz-seg__n">' + n + "</span>" : "") + "</button>";
    }).join("");
  }

  var EMPTY_NOUN = { tracks: "songs", albums: "albums", artists: "artists", playlists: "playlists" };
  function facetEmptyHTML(kind, q) {   // search_empty_state_{track,album,artist,playlist}
    return '<p class="qz-empty">No ' + EMPTY_NOUN[kind] + ' for “' + esc(q) + '”.</p>';
  }
  function noResultHTML(q) {           // overall search_empty_state
    return '<div class="qz-nores"><span class="qz-nores__ic">' + IC.search + "</span>" +
      '<p class="qz-nores__t">No results for “' + esc(q) + '”</p>' +
      '<p class="qz-nores__s">Check your spelling or try different keywords.</p></div>';
  }
  function historyHTML() {             // search_history_recent_title + deleteBtn + clear
    var list = hxLoad();
    if (!list.length) {
      return '<div class="qz-nores"><span class="qz-nores__ic">' + IC.search + "</span>" +
        '<p class="qz-nores__t">Search Qobuz</p>' +
        '<p class="qz-nores__s">Find songs, albums, artists and playlists.</p></div>';
    }
    return '<section class="qz-sec qz-hx">' +
      '<div class="qz-hx__head"><h3 class="qz-shelf__h">Recent searches</h3>' +
      '<button class="qz-hx__clear" data-hx="clear">Clear</button></div>' +
      '<div class="qz-hx__list">' + list.map(function (q) {
        return '<div class="qz-hx__row" data-hx="pick" data-q="' + esc(q) + '" role="button" tabindex="0">' +
          '<span class="qz-hx__ic">' + IC_CLOCK + "</span>" +
          '<span class="qz-hx__q">' + esc(q) + "</span>" +
          '<button class="qz-hx__del" data-hx="del" data-q="' + esc(q) + '" aria-label="Remove">' + IC_X + "</button></div>";
      }).join("") + "</div></section>";
  }

  return { title: "Search", root: true, mount: function (el) {
    el.innerHTML =
      '<div class="qz-searchbar"><span class="qz-searchbar__ic">' + IC.search + "</span>" +
      '<input class="qz-searchbar__in" type="search" placeholder="Songs, albums, artists, playlists" autocapitalize="none" autocorrect="off" enterkeyhint="search"></div>' +
      '<div class="qz-segbar qz-facets" hidden></div>' +
      '<div class="qz-results"></div>';
    var input = el.querySelector(".qz-searchbar__in"),
        facetBar = el.querySelector(".qz-facets"),
        out = el.querySelector(".qz-results");
    input.value = term;
    var t = null;

    function showFacetBar(on) {
      if (on) { facetBar.innerHTML = facetBarHTML(last); facetBar.hidden = false; }
      else { facetBar.hidden = true; facetBar.innerHTML = ""; }
    }
    function paintResults() {
      var r = last; if (!r) return;
      var q = r.q, html = "";
      if (facet === "all") {
        html += topResHTML(bestMatch(r));
        if (r.tr.length) html += '<section class="qz-sec"><h3 class="qz-shelf__h">Songs</h3>' + trackListHTML(r.tr.slice(0, 6), null) + "</section>";
        if (r.al.length) html += shelfHTML("Albums", r.al.slice(0, 12), "album");
        if (r.ar.length) html += shelfHTML("Artists", r.ar.slice(0, 12), "artist");
        if (r.pl.length) html += shelfHTML("Playlists", r.pl.slice(0, 12), "playlist");
        html = html || noResultHTML(q);
      } else if (facet === "tracks")    { html = r.tr.length ? trackListHTML(r.tr, null)     : facetEmptyHTML("tracks", q); }
      else if (facet === "albums")      { html = r.al.length ? gridHTML(r.al, "album")       : facetEmptyHTML("albums", q); }
      else if (facet === "artists")     { html = r.ar.length ? gridHTML(r.ar, "artist")      : facetEmptyHTML("artists", q); }
      else if (facet === "playlists")   { html = r.pl.length ? gridHTML(r.pl, "playlist")    : facetEmptyHTML("playlists", q); }
      out.innerHTML = html;
    }
    function showHistory() { last = null; showFacetBar(false); out.innerHTML = historyHTML(); }

    function run() {
      var q = input.value.trim(); term = q;
      if (q.length < 2) { showHistory(); return; }
      loading(out); showFacetBar(false);
      search(q, 50).then(function (j) {                 // one catalog/search call carries every type
        if (input.value.trim() !== q) return;           // stale
        last = { q: q,
          tr: (j.tracks && j.tracks.items) || [],
          al: (j.albums && j.albums.items) || [],
          ar: (j.artists && j.artists.items) || [],
          pl: (j.playlists && j.playlists.items) || [] };
        showFacetBar(true);
        paintResults();
      }).catch(function () { showFacetBar(false); out.innerHTML = '<p class="qz-empty">Search failed. Try again.</p>'; });
    }
    function commit(q) {                                 // Enter / history-pick = intentional search -> record + reset to All
      hxRecord(q);
      if (input.value !== q) input.value = q;
      facet = "all";
      run();
    }
    function setFacet(f) {
      if (!last) return;
      facet = f;
      [].forEach.call(facetBar.querySelectorAll(".qz-seg"), function (s) { s.classList.toggle("is-on", s.getAttribute("data-facet") === f); });
      paintResults();
      try { el.scrollTop = 0; } catch (e) {}
    }

    facetBar.addEventListener("click", function (e) {
      var s = e.target.closest("[data-facet]"); if (s) setFacet(s.getAttribute("data-facet"));
    });
    out.addEventListener("click", function (e) {
      var hx = e.target.closest("[data-hx]");
      if (hx) {
        var k = hx.getAttribute("data-hx");
        if (k === "clear") { hxClear(); showHistory(); return; }
        if (k === "del")   { hxRemove(hx.getAttribute("data-q")); showHistory(); return; }
        if (k === "pick")  { var q = hx.getAttribute("data-q"); input.value = q; commit(q); try { input.blur(); } catch (e2) {} return; }
        return;
      }
      // a real result was NAVIGATED to (nav handled by the global onContentTap) -> remember the query that produced it.
      // M4 FIX: scope to navigational acts only; kebab (more) + heart (fav) taps aren't navigations and must not record.
      var a = e.target.closest("[data-act]");
      if (last && last.q && a && /^(album|artist|playlist)$/.test(a.getAttribute("data-act"))) hxRecord(last.q);
    });
    input.addEventListener("input", function () {
      clearTimeout(t);
      if (input.value.trim().length < 2) { term = input.value.trim(); showHistory(); return; }
      t = setTimeout(run, 340);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.keyCode === 13) {
        e.preventDefault(); clearTimeout(t);
        var q = input.value.trim(); if (q.length >= 2) commit(q);
      }
    });

    if (term && term.length >= 2) run();                 // returning from a pushed detail restores the query + facet
    else showHistory();
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 60);
  } };
}

function libraryScreen() {
  var tab = "overview", cache = {}, term = "";  // cache[tab]=loaded items; term=client-side in-scope filter
  var LOADERS = {
    // Overview = a mixed snapshot of everything saved (songs/artists/playlists/albums), so the Library
    // isn't empty-looking when a user favourites tracks but few albums. Default tab.
    overview:  function () {
      return Promise.all([favorites("tracks", 40), favorites("artists", 60), userPlaylists(), favorites("albums", 60)])
        .then(function (r) { return { tracks: r[0] || [], artists: r[1] || [], playlists: r[2] || [], albums: r[3] || [] }; });
    },
    albums:    function () { return favorites("albums", 200); },     // favorite/getUserFavorites?type=albums
    tracks:    function () { return favorites("tracks", 200); },     // ?type=tracks
    artists:   function () { return favorites("artists", 200); },    // favorite/getUserFavorites?type=artists
    playlists: function () { return userPlaylists(); }               // playlist/getUserPlaylists
  };
  // the text a given item is matched against, per kind (title/artist/name contains)
  function hay(o, which) {
    if (which === "playlists") return (o.name || "") + " " + ((o.owner && o.owner.name) || "");
    if (which === "artists")   return (o.name || "");
    return (o.title || o.name || "") + " " + artistName(o);          // albums + tracks
  }
  function filtered(which, items) {
    var q = term.trim().toLowerCase();
    if (!q) return items;
    return items.filter(function (o) { return hay(o, which).toLowerCase().indexOf(q) >= 0; });
  }
  function paint(body, which, items) {
    if (which === "overview") {
      var ov = items || {};
      function sec(label, key, render) {
        var f = filtered(key, ov[key] || []);
        if (!f.length) return "";
        return '<section class="qz-sec"><div class="qz-ovh"><h3 class="qz-shelf__h">' + label + '</h3>' +
          '<button class="qz-ovmore" data-lib="' + key + '" type="button">See all</button></div>' + render(f) + "</section>";
      }
      var out = sec("Songs", "tracks", function (f) { return trackListHTML(f.slice(0, 20), null); })
        + sec("Artists", "artists", function (f) { return gridHTML(f.slice(0, 12), "artist"); })
        + sec("Playlists", "playlists", function (f) { return gridHTML(f.slice(0, 12), "playlist"); })
        + sec("Albums", "albums", function (f) { return gridHTML(f.slice(0, 12), "album"); });
      body.innerHTML = out || '<p class="qz-empty">' + (term ? "No matches in your library." : "Nothing saved yet — heart some songs to see them here.") + "</p>";
      return;
    }
    var list = filtered(which, items);
    if (which === "playlists") {   // M3: "New playlist" + featured-browse entry always lead the Playlists tab
      var head = newPlaylistBtnHTML() + featEntryHTML();
      body.innerHTML = head + (list.length ? gridHTML(list, "playlist")
        : '<p class="qz-empty">' + (term ? "No matches in your library." : "No playlists yet.") + "</p>");
      return;
    }
    if (!list.length) { body.innerHTML = '<p class="qz-empty">' + (term ? "No matches in your library." : "Nothing here yet.") + "</p>"; return; }
    if (which === "tracks") body.innerHTML = trackListHTML(list, null);
    else body.innerHTML = gridHTML(list, which === "artists" ? "artist" : "album");
  }
  return { title: "Library", root: true, mount: function (el) {
    el.innerHTML =
      '<div class="qz-stg-top"><h2 class="qz-stg-toph">Library</h2>' +
      '<button class="qz-stg-gear" data-act="settings" aria-label="Settings" type="button">' + IC.gear + '</button></div>' +
      '<div class="qz-searchbar"><span class="qz-searchbar__ic">' + IC.search + "</span>" +
      '<input class="qz-searchbar__in qz-libsearch" type="search" placeholder="Find in your library" autocapitalize="none" autocorrect="off"></div>' +
      '<div class="qz-segbar qz-libsegs">' +
      '<button class="qz-seg is-on" data-lib="overview">Overview</button>' +
      '<button class="qz-seg" data-lib="albums">Albums</button>' +
      '<button class="qz-seg" data-lib="tracks">Songs</button>' +
      '<button class="qz-seg" data-lib="artists">Artists</button>' +
      '<button class="qz-seg" data-lib="playlists">Playlists</button></div>' +
      '<div class="qz-libbody"></div>';
    var body = el.querySelector(".qz-libbody"), input = el.querySelector(".qz-libsearch");
    input.value = term;
    function load(which) {
      tab = which;
      [].forEach.call(el.querySelectorAll(".qz-seg"), function (s) { s.classList.toggle("is-on", s.getAttribute("data-lib") === which); });
      if (cache[which]) { paint(body, which, cache[which]); return; }   // cached -> instant, no refetch
      loading(body);
      LOADERS[which]().then(function (items) {
        cache[which] = items || [];
        if (tab !== which) return;                                      // user switched away mid-fetch
        paint(body, which, cache[which]);
      });
    }
    el.querySelector(".qz-segbar").addEventListener("click", function (e) { var s = e.target.closest("[data-lib]"); if (s) load(s.getAttribute("data-lib")); });
    body.addEventListener("click", function (e) { var m = e.target.closest(".qz-ovmore"); if (m) { e.preventDefault(); e.stopPropagation(); load(m.getAttribute("data-lib")); } });   // Overview "See all" -> that tab
    input.addEventListener("input", function () { term = input.value; if (cache[tab]) paint(body, tab, cache[tab]); });   // instant, client-side
    load(tab);
  } };
}

function detailScreen(kind, id) {
  return { title: "", mount: function (el) {
    loading(el);
    var getter = kind === "playlist" ? playlistGet(id) : albumGet(id);
    getter.then(function (o) {
      var items = (o.tracks && o.tracks.items) || [];
      var title = o.title || o.name || "", who = kind === "playlist" ? ((o.owner && o.owner.name) || "") : artistName(o);
      var img = cover(o), yr = (o.release_date_original || "").slice(0, 4);
      el.innerHTML =
        '<div class="qz-dhead">' +
        '<div class="qz-dhead__art">' + (img ? '<img src="' + esc(img) + '">' : ph(kind)) + "</div>" +
        '<div class="qz-dhead__t">' + esc(title) + "</div>" +
        '<div class="qz-dhead__s">' + esc(who) + (yr ? " &middot; " + yr : "") + (items.length ? " &middot; " + items.length + " tracks" : "") + "</div>" +
        '<div class="qz-dhead__actions">' +
        '<button class="qz-dhead__play" data-act="playtop" data-kind="' + kind + '" data-id="' + esc(id) + '" data-first="' + esc(items[0] ? (items[0].title || "") : "") + '">' + IC.play + " Play</button>" +
        (kind === "album" ? favBtnHTML("album", id, "qz-dhead__fav")
          : (kind === "playlist" && o.owner && String(o.owner.id) !== String(cachedMe) ? favBtnHTML("playlist", id, "qz-dhead__fav") : "")) +
        "</div>" +
        "</div>" + trackListHTML(items, { kind: kind, id: id, cover: img });   // [M2] ctx.cover lets album-detail rows (no per-track cover) fall back to the album art
    }).catch(function () { el.innerHTML = '<p class="qz-empty">Couldn\'t load this ' + kind + ".</p>"; });
  } };
}

function artistScreen(id) {
  return { title: "", mount: function (el) {
    loading(el);
    artistGet(id).then(function (a) {
      var albums = (a.albums && a.albums.items) || [], tracks = (a.tracks && a.tracks.items) || [];
      var img = cover(a);
      el.innerHTML =
        '<div class="qz-dhead qz-dhead--artist">' +
        '<div class="qz-dhead__art qz-dhead__art--round">' + (img ? '<img src="' + esc(img) + '">' : ph("artist")) + "</div>" +
        '<div class="qz-dhead__t">' + esc(a.name || "") + "</div>" +
        '<div class="qz-dhead__actions">' + favBtnHTML("artist", id, "qz-dhead__fav") + "</div>" +
        "</div>" +
        (tracks.length ? '<section class="qz-sec"><h3 class="qz-shelf__h">Top tracks</h3>' + trackListHTML(tracks.slice(0, 10), null) + "</section>" : "") +
        (albums.length ? '<section class="qz-sec"><h3 class="qz-shelf__h">Albums</h3>' + gridHTML(albums, "album") + "</section>" : "");
    }).catch(function () { el.innerHTML = '<p class="qz-empty">Couldn\'t load this artist.</p>'; });
  } };
}

// ------------------------------------------------------------------ SETTINGS (mobile)
// Pushed screen reached from the gear on the Library header (data-act="settings"). Read-only account header
// + streaming-quality picker (reuses QTIERS/qCurMax/qSetMax) + Qobuzify/version + log out. Own class prefix
// qz-stg-* (the Qobuzify RUNTIME base theme owns qz-set-*, so never reuse it). Row taps route through the
// shared onContentTap (data-act="setq"/"logout"); the quality + logout-confirm sheets reuse the ONE
// _sheet/.qz-sheet chrome. Electric-blue accent literals (the mobile --qz-brand token is Qobuz-gold).

// resolve the logged-in Qobuz profile defensively (many field spellings across store/API shapes)
function stgPlanLabel(i) {
  var cred = i.credential || {}, sub = i.subscription || {};
  var raw = String(sub.offer || sub.offerName || cred.label || cred.description || "").trim();
  if (!raw) return "";
  if (raw.indexOf(" ") < 0 && /^[a-z0-9_-]+$/i.test(raw)) {          // prettify short codes: "streaming-studio" -> "Studio"
    raw = raw.replace(/^streaming[-_]?/i, "").replace(/[-_]+/g, " ").trim();
    raw = raw.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  return raw;
}
function stgResolve(i) {
  i = i || {};
  var name = i.display_name || i.displayName || i.name || i.login ||
    ((i.firstname || i.firstName || "") + " " + (i.lastname || i.lastName || "")).trim();
  return { name: String(name || "").trim(), email: String(i.email || "").trim(), plan: stgPlanLabel(i) };
}
function stgAccountFromStore() { var u = {}; try { u = Q.getState().user || {}; } catch (e) {} return stgResolve(u.infos); }
function stgAvatarInitial(acc) { var s = (acc.name || acc.email || "").trim(); return s ? s.charAt(0).toUpperCase() : "Q"; }
function stgAccountCardHTML(acc) {
  return '<div class="qz-stg-acct">' +
      '<div class="qz-stg-ava">' + esc(stgAvatarInitial(acc)) + '</div>' +
      '<div class="qz-stg-acctx">' +
        '<div class="qz-stg-acctn">' + esc(acc.name || "Your account") + '</div>' +
        (acc.email ? '<div class="qz-stg-accte">' + esc(acc.email) + '</div>' : "") +
      '</div>' +
      (acc.plan ? '<div class="qz-stg-plan">' + esc(acc.plan) + '</div>' : "") +
    '</div>';
}

// current streaming-quality tier label — reuses the SAME code->label map the NP quality chip uses (qCurMax->tier.name)
function settingsQualityLabel() { var t = qTierByCode(qCurMax()); return t ? t.name : ""; }
function updateSettingsQualityLabel() { var v = document.querySelector("#qz-app-root .qz-stg-qval"); if (v) v.textContent = settingsQualityLabel(); }

var STG_CHEV = '<span class="qz-stg-chev"></span>';

// ---- Appearance section (theme picker + mobile feature toggles) ----
// Toggle state lives in Q.storage as the string "1"/"0" (default "1" = on) so it survives relaunch.
function stgTogOn(key) { try { return Q.storage.get(key, "1") !== "0"; } catch (e) { return true; } }
function stgToggleRowHTML(key, title, sub) {
  var on = stgTogOn(key);
  return '<button class="qz-stg-row qz-stg-tog' + (on ? " is-on" : "") + '" data-act="apptoggle" data-tog="' + key + '" type="button">' +
    '<span class="qz-stg-rl"><span class="qz-stg-rt">' + esc(title) + '</span>' +
    '<span class="qz-stg-rs">' + esc(sub) + '</span></span><span class="qz-pf__sw"></span></button>';
}
function stgThemeList() { try { return Q.themes() || []; } catch (e) { return []; } }
function stgActiveTheme() { try { return Q.activeTheme(); } catch (e) { return null; } }
function stgCurTheme() {
  var list = stgThemeList(); if (!list.length) return null;
  var act = stgActiveTheme();
  for (var i = 0; i < list.length; i++) if (list[i].slug === act) return list[i];
  return list[0];
}
// Theme row (hidden when the catalog is empty). Trailing swatch + name + chevron -> opens the picker sheet.
function stgThemeRowHTML() {
  var cur = stgCurTheme(); if (!cur) return "";
  return '<button class="qz-stg-row" data-act="settheme" type="button">' +
    '<span class="qz-stg-rl"><span class="qz-stg-rt">Theme</span></span>' +
    '<span class="qz-stg-tval"><span class="qz-stg-swatch" style="background:' + esc(cur.accent) + '"></span>' +
    '<span class="qz-stg-rv qz-stg-tname">' + esc(cur.name) + '</span></span>' + STG_CHEV + '</button>';
}
function stgAppearanceSectionHTML() {
  // The mobile-app's own features (Q.storage flags, applied LIVE via a doc class - no reload). These are the
  // things that actually run on mobile, so this is where the user turns them on/off. Default ON.
  return '<div class="qz-stg-sec"><div class="qz-stg-sech">Features</div>' +
    stgToggleRowHTML("feat-lyrics", "Lyrics", "Show the lyrics button and synced lyrics view") +
    stgToggleRowHTML("mobile-wbw", "Word-by-word lyrics", "Karaoke-style per-word highlighting") +
    stgToggleRowHTML("feat-sleep", "Sleep timer", "Show the sleep-timer button in the player") +
    stgToggleRowHTML("feat-radio", "Start radio", "Show the start-radio button in the player") +
    stgToggleRowHTML("feat-quality", "Quality badge", "Show the streaming-quality chip in the player") +
    stgToggleRowHTML("mobile-tint", "Album-art tint", "Tint the app with the cover art colours") +
    stgToggleRowHTML("mobile-lockscreen", "Lockscreen and Live Actions", "Show playback controls on the lock screen") +
    '</div>';
}

// ---- Extensions section: the Qobuzify extensions that actually FUNCTION on mobile, toggleable ----
// Determined by reading each extension against the mobile environment (25-way classification), NOT a grep.
// Only two run standalone on Android: last-fm (scrobbles to the api.qobuzify.app worker off Q.player) and
// eq-boost (patches Web Audio AudioNode.connect -> a bass-boost EQ at Qobuz's master output; Qobuz plays
// through an AudioContext, so it colors the sound). Everything else no-ops here: it injects into the HIDDEN
// Qobuz desktop DOM that our #qz-app-root overlay covers, OR mobile-app already reimplements it natively
// (lyrics, sleep timer, full-screen player, seek, quality badge, genre browse, library, search). discord-rpc
// needs the desktop localhost:7673 bridge (absent on Android); stats' only surface is a dashboard opened
// from the hidden desktop nav (unreachable); media-session is infra owned by the Lockscreen toggle above.
// State lives in localStorage "qobuzify:ext:<id>" (default ON, the key boot() reads); live load/unload isn't
// on the public Q surface, so a toggle persists + reloads to apply.
var MOBILE_EXT = { "last-fm": 1, "eq-boost": 1 };
function extTogOn(id) { try { return localStorage.getItem("qobuzify:ext:" + id) !== "0"; } catch (e) { return true; } }
function bakedExtensions() {
  try { return (window.__QOBUZIFY__ && window.__QOBUZIFY__.extensions) || []; } catch (e) { return []; }
}
function stgExtToggleRowHTML(ext) {
  var on = extTogOn(ext.id);
  return '<button class="qz-stg-row qz-stg-tog' + (on ? " is-on" : "") + '" data-act="exttoggle" data-ext="' + esc(ext.id) + '" type="button">' +
    '<span class="qz-stg-rl"><span class="qz-stg-rt">' + esc(ext.name || ext.id) + '</span>' +
    (ext.description ? '<span class="qz-stg-rs">' + esc(ext.description) + '</span>' : "") +
    '</span><span class="qz-pf__sw"></span></button>';
}
function stgExtensionsSectionHTML() {
  var exts = bakedExtensions().filter(function (e) { return e && e.id && MOBILE_EXT[e.id]; })
    .sort(function (a, b) { return (a.name || a.id).localeCompare(b.name || b.id); });
  if (!exts.length) return "";
  return '<div class="qz-stg-sec"><div class="qz-stg-sech">Extensions</div>' +
    exts.map(stgExtToggleRowHTML).join("") +
    '<div class="qz-stg-note">Changes apply on reload.</div>' +
    '</div>';
}
var _extReloadT = null;
function stgExtToggleTap(row) {
  var id = row.getAttribute("data-ext"); if (!id) return;
  var on = extTogOn(id);
  try { localStorage.setItem("qobuzify:ext:" + id, on ? "0" : "1"); } catch (e) {}
  row.classList.toggle("is-on", !on);
  // debounce so toggling several in a row triggers a single reload
  if (_extReloadT) clearTimeout(_extReloadT);
  qToast("Applying…");
  _extReloadT = setTimeout(function () { try { location.reload(); } catch (e) {} }, 1100);
}
// Refresh the Theme row label + swatch after a pick (called by the picker).
function stgUpdateThemeRow() {
  var cur = stgCurTheme(); if (!cur) return;
  var root = document.getElementById(ROOT_ID); if (!root) return;
  var nm = root.querySelector(".qz-stg-tname"); if (nm) nm.textContent = cur.name;
  var sw = root.querySelector(".qz-stg-tval .qz-stg-swatch"); if (sw) sw.style.background = cur.accent;
}
// Apply a toggle's immediate effect for the current track/state. `on` is the new boolean value.
// Player-feature toggles hide their button live via a documentElement class (CSS in the block below), so
// no reload is needed. Called at mount (from the stored flags) and on each toggle.
function applyFeatureFlags() {
  var d = document.documentElement.classList;
  d.toggle("qz-hide-lyrics", !stgTogOn("feat-lyrics"));
  d.toggle("qz-hide-sleep", !stgTogOn("feat-sleep"));
  d.toggle("qz-hide-radio", !stgTogOn("feat-radio"));
  d.toggle("qz-hide-quality", !stgTogOn("feat-quality"));
}
function stgApplyToggleEffect(key, on) {
  if (key === "mobile-tint") {
    // re-run (or clear) the album tint for the current track; applyTint() reads the flag and neutralises when off
    var cover = null; try { if (hasTrack()) cover = (Q.player.getTrack() || {}).cover || null; } catch (e) {}
    applyTint(cover);
  } else if (key === "mobile-wbw") {
    if (lyState.open) lyRender();   // re-render open lyrics in the new (line vs word) mode
  } else if (key === "feat-lyrics") {
    document.documentElement.classList.toggle("qz-hide-lyrics", !on);
    if (!on && lyState.open) closeLyrics();
  } else if (key === "feat-sleep") {
    document.documentElement.classList.toggle("qz-hide-sleep", !on);
  } else if (key === "feat-radio") {
    document.documentElement.classList.toggle("qz-hide-radio", !on);
  } else if (key === "feat-quality") {
    document.documentElement.classList.toggle("qz-hide-quality", !on);
  }
  // mobile-lockscreen: the media-session extension polls Q.storage on its ~1s tick, so no app-side action needed.
}
function stgToggleTap(el) {
  if (!el) return;
  var key = el.getAttribute("data-tog"); if (!key) return;
  var on = !el.classList.contains("is-on");
  el.classList.toggle("is-on", on);
  try { Q.storage.set(key, on ? "1" : "0"); } catch (e) {}
  stgApplyToggleEffect(key, on);
}
function openThemePicker() {
  closeSheet();
  var list = stgThemeList(); if (!list.length) return;
  var act = stgActiveTheme();
  var rows = list.map(function (t) {
    var on = t.slug === act;
    return '<button class="qz-sheet__it qz-stg-throw' + (on ? " is-on" : "") + '" data-th="' + esc(t.slug) + '" type="button">' +
      '<span class="qz-stg-swatch" style="background:' + esc(t.accent) + '"></span>' +
      '<span class="qz-stg-thn">' + esc(t.name) + '</span>' +
      '<span class="qz-stg-thc">' + (on ? "&#10003;" : "") + '</span></button>';
  }).join("");
  _sheet = h('<div class="qz-sheet"><div class="qz-sheet__card">' +
    '<div class="qz-sheet__t">Theme</div>' + rows +
    '<button class="qz-sheet__cancel" data-s="cancel">Cancel</button>' +
    '</div></div>');
  _sheet.addEventListener("click", function (e) {
    if (e.target === _sheet) { closeSheet(); return; }
    if (e.target.closest('[data-s="cancel"]')) { closeSheet(); return; }
    var row = e.target.closest("[data-th]"); if (!row) return;
    var slug = row.getAttribute("data-th"); closeSheet();
    var okp = false; try { okp = Q.applyTheme(slug); } catch (e2) {}
    if (okp) { qToast("Theme applied"); stgUpdateThemeRow(); }
    else qToast("Couldn't apply theme");
  });
  document.body.appendChild(_sheet);
  requestAnimationFrame(function () { if (_sheet) _sheet.classList.add("is-on"); });
}

function settingsScreen() {
  return { title: "Settings", mount: function (el) {
    var ver = ""; try { ver = String(Q.version || ""); } catch (e) {} if (!ver) ver = "0.1";
    var acc = stgAccountFromStore();
    el.innerHTML =
      '<div class="qz-stg">' +
        '<h2 class="qz-stg-hd">Settings</h2>' +
        '<div class="qz-stg-acctwrap">' + stgAccountCardHTML(acc) + '</div>' +
        '<div class="qz-stg-sec"><div class="qz-stg-sech">Playback</div>' +
          '<button class="qz-stg-row" data-act="setq" type="button">' +
            '<span class="qz-stg-rl"><span class="qz-stg-rt">Streaming quality</span></span>' +
            '<span class="qz-stg-rv qz-stg-qval">' + esc(settingsQualityLabel()) + '</span>' + STG_CHEV +
          '</button>' +
        '</div>' +
        stgAppearanceSectionHTML() +
        stgExtensionsSectionHTML() +
        '<div class="qz-stg-sec"><div class="qz-stg-sech">Qobuzify</div>' +
          '<div class="qz-stg-row qz-stg-row--static">' +
            '<span class="qz-stg-rl"><span class="qz-stg-rt">Version</span></span>' +
            '<span class="qz-stg-rv">v' + esc(ver) + '</span>' +
          '</div>' +
          '<div class="qz-stg-row qz-stg-row--static">' +
            '<span class="qz-stg-rl"><span class="qz-stg-rt">Qobuzify</span>' +
              '<span class="qz-stg-rs">Enhancements for Qobuz. Lyrics provided by Qobuzify.</span></span>' +
          '</div>' +
        '</div>' +
        '<div class="qz-stg-sec">' +
          '<button class="qz-stg-row qz-stg-row--danger" data-act="logout" type="button">' +
            '<span class="qz-stg-rl"><span class="qz-stg-rt">Log out</span></span>' +
          '</button>' +
        '</div>' +
        '<div class="qz-stg-foot">Qobuzify &middot; v' + esc(ver) + '</div>' +
      '</div>';
    if (!acc.name && !acc.email) {                                   // store slice empty -> best-effort fetch, repaint card
      api("user/get").then(function (u) {
        var a2 = stgResolve((u && (u.user || u)) || {});
        var wrap = el.querySelector(".qz-stg-acctwrap");
        if (wrap && (a2.name || a2.email)) wrap.innerHTML = stgAccountCardHTML(a2);
      }).catch(function () {});
    }
  } };
}

// streaming-quality picker — settings-local (openQMenu needs a live track + the NP overlay it mounts into).
// Reuses the ONE shared _sheet/.qz-sheet chrome + QTIERS/qCurMax/qCapMax/qCapMin/qSetMax; disables tiers past the plan cap.
function openSettingsQuality() {
  closeSheet();
  var cur = qCurMax(), capX = qCapMax(), capN = qCapMin();
  var rows = QTIERS.map(function (t) {
    var disabled = t.code > capX || t.code < capN, on = t.code === cur;
    return '<button class="qz-sheet__it qz-stg-qrow' + (on ? " is-on" : "") + '"' + (disabled ? " disabled" : ' data-qc="' + t.code + '"') + '>' +
        '<span class="qz-stg-qrl"><span class="qz-stg-qt">' + esc(t.name) + '</span>' +
          '<span class="qz-stg-qs">' + esc(t.spec) + '</span></span>' +
        '<span class="qz-stg-qc">' + (on ? "&#10003;" : "") + '</span></button>';
  }).join("");
  _sheet = h('<div class="qz-sheet"><div class="qz-sheet__card">' +
    '<div class="qz-sheet__t">Streaming quality</div>' + rows +
    '<button class="qz-sheet__cancel" data-s="cancel">Cancel</button>' +
    '</div></div>');
  _sheet.addEventListener("click", function (e) {
    if (e.target === _sheet) { closeSheet(); return; }
    if (e.target.closest('[data-s="cancel"]')) { closeSheet(); return; }
    var row = e.target.closest("[data-qc]"); if (!row) return;
    var code = +row.getAttribute("data-qc"); closeSheet();
    if (qSetMax(code)) { updateSettingsQualityLabel(); var tt = qTierByCode(code); qToast("Quality set to " + (tt ? tt.name : "")); }
    else qToast("Couldn't change quality");
  });
  document.body.appendChild(_sheet);
  requestAnimationFrame(function () { if (_sheet) _sheet.classList.add("is-on"); });
}

// log out — confirm via the ONE shared sheet, then qzLogout(). qzLogout drives the hidden native NavBar: open
// the avatar/user menu, click the logout item (matched by its logout icon class OR localized text), then
// best-effort auto-confirm Qobuz's own confirm modal (it renders BEHIND our full-screen root, so the user
// can't tap it). Guarded throughout; falls back to any logout affordance in the DOM.
function qzConfirmLogout() {
  closeSheet();
  _sheet = h('<div class="qz-sheet"><div class="qz-sheet__card">' +
    '<div class="qz-sheet__t">Log out of Qobuz?</div>' +
    '<button class="qz-sheet__it qz-sheet__it--danger" data-s="logout">' + IC_LOGOUT + '<span>Log out</span></button>' +
    '<button class="qz-sheet__cancel" data-s="cancel">Cancel</button>' +
    '</div></div>');
  _sheet.addEventListener("click", function (e) {
    if (e.target === _sheet) { closeSheet(); return; }
    var b = e.target.closest("[data-s]"); if (!b) return;
    var s = b.getAttribute("data-s"); closeSheet();
    if (s === "logout") qzLogout();
  });
  document.body.appendChild(_sheet);
  requestAnimationFrame(function () { if (_sheet) _sheet.classList.add("is-on"); });
}
var LOGOUT_RE = /log\s?out|sign\s?out|se\s?d[eé]connecter|d[eé]connexion|cerrar sesi|abmelden|ausloggen|disconnetti|esci|sair|log-out/i;
function qzFindLogoutItem() {
  var items = document.querySelectorAll(".NavBarMenu__item, .NavBarMenu__items a, .NavBarMenu__items button, .NavBarMenu a, .NavBarMenu button");
  for (var k = 0; k < items.length; k++) {
    var it = items[k];
    if (it.querySelector && it.querySelector("[class*='logout']")) return it;
    if (String(it.className || "").toLowerCase().indexOf("logout") >= 0) return it;
    if (LOGOUT_RE.test((it.textContent || "").trim())) return it;
  }
  return null;
}
function qzConfirmNativeLogout() {                                   // click Qobuz's confirm-modal validate button (last .bt6)
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    try {
      var btns = document.querySelectorAll(".modal-footer .bt6, .modal-dialog .bt6, .modal .bt6");
      if (btns && btns.length >= 2) { clearInterval(iv); fireClick(btns[btns.length - 1]); qToast("Logged out"); return; }
    } catch (e) {}
    if (tries > 50) clearInterval(iv);                              // no confirm modal (direct logout / other UI) -> leave it
  }, 60);
}
function qzLogoutFallback() {
  try {
    var any = document.querySelector(".NavBarMenu__item [class*='logout'], [class*='logout']");
    if (any) { fireClick((any.closest && (any.closest("a") || any.closest("button") || any.closest(".NavBarMenu__item"))) || any); qzConfirmNativeLogout(); return; }
  } catch (e) {}
  qToast("Couldn't log out automatically");
}
function qzLogout() {
  qToast("Logging out…");
  try {
    var item0 = qzFindLogoutItem();                                 // menu already open?
    if (item0) { fireClick(item0); qzConfirmNativeLogout(); return; }
    var trigger = document.querySelector(".NavBar__avatar") ||
      document.querySelector(".NavBar__rightContainer button") ||
      document.querySelector(".NavBar [class*='avatar']");
    if (!trigger) { qzLogoutFallback(); return; }
    if (!document.querySelector(".NavBarMenu__items")) fireClick(trigger);   // open the user menu (idempotent)
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      var item = qzFindLogoutItem();
      if (item) { clearInterval(iv); fireClick(item); qzConfirmNativeLogout(); return; }
      if (tries === 12 && !document.querySelector(".NavBarMenu__items") && trigger) fireClick(trigger);  // retry opening
      if (tries > 34) { clearInterval(iv); qzLogoutFallback(); }
    }, 60);
  } catch (e) { qzLogoutFallback(); }
}

// ------------------------------------------------------------------ Discover feed [M4]
// Replaces Home (keeps tab id "home" so curTab default still lands here). Two sub-tabs (For You / Editor's
// Picks) via the shared .qz-segbar/.qz-seg component. For You = favorites-seeded personalized rails (same
// building blocks recommended.js runs live) + editorial fillers so a no-favorites account still sees a full
// feed. Progressive per-rail render (skeletons paint instantly; a failing/empty rail removes its slot).
// Session-cached per rail so sub-tab / leave-return is instant.
// railCached: session-cache a rail's assembled result. Never rejects (empty array on failure) so a failing
// rail just omits. Load may resolve to items[] OR {title,items}.
// M4 FIX: only PERSIST successful, non-empty resolves. Empty/failed results bust their key so a transient blip
// doesn't permanently empty a rail (default tab) or freeze For You's personalization for the whole session.
function railCached(key, load) {
  if (discoverRailCache[key]) return discoverRailCache[key];
  var p = Promise.resolve().then(load);
  p.then(function (r) { var it = Array.isArray(r) ? r : (r && r.items) || []; if (!it.length) delete discoverRailCache[key]; },
         function () { delete discoverRailCache[key]; });
  return (discoverRailCache[key] = p.catch(function () { return []; }));
}
function skeletonShelf() {
  var cards = ["", "", "", "", ""].map(function () { return '<span class="qz-card qz-skcard"><span class="qz-card__art qz-sk"></span></span>'; }).join("");
  return '<section class="qz-shelf qz-shelf--skel"><h3 class="qz-shelf__h qz-skln"></h3><div class="qz-shelf__row">' + cards + '</div></section>';
}
// --- PERSONALIZED rail loaders (favorites-seeded; identical logic to recommended.js) ---
function railNewFromArtists() {
  return favorites("artists", 50).then(function (fa) {
    if (!fa || !fa.length) return [];
    return poolMap(fa.slice(0, 16), 5, function (a) { return artistAlbumsD(a.id); }).then(function (lists) {
      var albums = [];
      lists.forEach(function (al) { if (al && al.length) { al.sort(byNewestD); albums.push(al[0]); } });
      return dedupeById(albums.filter(function (a) { return a && a.streamable !== false; })).sort(byNewestD).slice(0, 18);
    });
  });
}
function railBecauseYouLike() {
  return favorites("artists", 50).then(function (fa) {
    var seed = fa && fa[0]; if (!seed) return { title: "", items: [] };
    return similarArtistsD(seed.id).then(function (sims) {
      return poolMap((sims || []).slice(0, 10), 5, function (sa) { return artistAlbumsD(sa.id).then(function (al) { al.sort(byNewestD); return al[0]; }); });
    }).then(function (albums) {
      return { title: "Because you like " + (seed.name || "artists you love"),
               items: dedupeById((albums || []).filter(function (a) { return a && a.streamable !== false; })).slice(0, 16) };
    });
  });
}
function railArtistsYouMightLike() {
  return favorites("artists", 50).then(function (fa) {
    if (!fa || !fa.length) return [];
    var favIds = {}; fa.forEach(function (a) { favIds[a.id] = 1; });
    return poolMap(fa.slice(0, 4), 4, function (s) { return similarArtistsD(s.id); }).then(function (lists) {
      var score = {}, byId = {};
      (lists || []).forEach(function (l) { (l || []).forEach(function (a) { if (!a || favIds[a.id]) return; score[a.id] = (score[a.id] || 0) + 1; byId[a.id] = a; }); });
      return Object.keys(score).sort(function (x, y) { return score[y] - score[x]; }).map(function (id) { return byId[id]; }).slice(0, 16);
    });
  });
}
// [Discover v2] Rediscover: pure client-side — shuffle the user's favorited albums, surface a fresh handful
// each mount. No endpoint (favorites() is already cached), so it costs nothing and never 400s.
function railRediscover() {
  return favorites("albums", 100).then(function (fa) {
    if (!fa || !fa.length) return [];
    var a = fa.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a.slice(0, 18);
  });
}
// [Discover v2] Genre-scoped browse — a clone of featScreen()'s shape (qz-fh + qz-chips + body), except each
// genre paints a set of rails (shelfHTML) rather than a single grid. Rails self-heal: an empty/failed rail
// removes its slot (same railCached + slot.remove() mechanism the Discover feed uses). Reached from the pinned
// genre chips on Discover; its own chip row lets you switch genres in place (railCached per genre = instant).
function browseScreen(genreId, genreName) {
  function railSpecs(gid) {
    return [
      { type: "new-releases-full", title: "New releases",    kind: "album",    load: function () { return featuredAlbumsG("new-releases-full", gid); } },
      { type: "most-streamed",     title: "Top albums",      kind: "album",    load: function () { return featuredAlbumsG("most-streamed", gid); } },
      { type: "qobuzissims",       title: "Qobuzissime",     kind: "album",    load: function () { return featuredAlbumsG("qobuzissims", gid); } },
      { type: "press-awards",      title: "Awards",          kind: "album",    load: function () { return featuredAlbumsG("press-awards", gid); } },
      { type: "editor-picks",      title: "Qobuz playlists", kind: "playlist", load: function () { return featuredPlaylistsG("editor-picks", gid); } }
    ];
  }
  return { title: genreName || "Browse", mount: function (el) {
    var cur = String(genreId), curName = genreName || "Browse";
    el.innerHTML =
      '<div class="qz-fh"><h2 class="qz-fh__title qz-btitle">' + esc(curName) + '</h2>' +
      '<div class="qz-fh__sub">New releases, top albums &amp; more</div></div>' +
      '<div class="qz-chips qz-gchips" style="display:none"></div>' +
      '<div class="qz-drails"></div>';
    var chips = el.querySelector(".qz-gchips"), title = el.querySelector(".qz-btitle"), railsHost = el.querySelector(".qz-drails");
    function renderRails(gid) {
      var specs = railSpecs(gid);
      railsHost.innerHTML = specs.map(function (s, i) { return '<div class="qz-drail" data-rail="' + i + '">' + skeletonShelf() + '</div>'; }).join("");
      var slots = railsHost.querySelectorAll(".qz-drail");
      var anyFilled = false, settled = 0;
      specs.forEach(function (s, i) {
        railCached("browse:" + gid + ":" + s.type, s.load).then(function (res) {
          if (gid !== cur) return;                            // user switched genre mid-fetch
          var items = Array.isArray(res) ? res : (res && res.items) || [];
          var slot = slots[i]; if (!slot) return;
          if (items.length) { slot.innerHTML = shelfHTML(s.title, items, s.kind); anyFilled = true; }
          else slot.remove();
        }, function () { if (slots[i]) slots[i].remove(); })
          .then(function () {
            if (++settled === specs.length && !anyFilled && gid === cur) {
              railsHost.innerHTML = '<p class="qz-empty">Nothing here yet.</p>';
            }
          });
      });
    }
    // genre chip row: switch genres without leaving; hidden gracefully (never occupies space) if genre/list is empty.
    genreList().then(function (gs) {
      if (!gs || !gs.length || !chips) return;
      chips.innerHTML = gs.map(function (g) {
        return '<button class="qz-chip' + (String(g.id) === cur ? " is-on" : "") + '" type="button" data-genre="' + esc(g.id) + '" data-gname="' + esc(g.name || "") + '">' + esc(g.name || "Genre") + '</button>';
      }).join("");
      chips.style.display = "";
      chips.addEventListener("click", function (e) {
        var b = e.target.closest("[data-genre]"); if (!b) return;
        var gid = b.getAttribute("data-genre"); if (gid === cur) return;
        cur = gid; curName = b.getAttribute("data-gname") || "Browse";
        [].forEach.call(chips.querySelectorAll(".qz-chip"), function (c) { c.classList.toggle("is-on", c.getAttribute("data-genre") === gid); });
        if (title) title.textContent = curName;
        renderRails(gid);
      });
    });
    renderRails(cur);
  } };
}
function discoverScreen() {
  // rail spec: {key, title, kind, load}. load -> Promise<items[] | {title,items}>.
  var RAILS = {
    foryou: [
      { key: "fy-new-artists", title: "New from artists you love", kind: "album",    load: railNewFromArtists },
      { key: "fy-because",     title: "Because you like",          kind: "album",    load: railBecauseYouLike },
      { key: "fy-might-like",  title: "Artists you might like",    kind: "artist",   load: railArtistsYouMightLike },
      { key: "fy-rediscover",  title: "From your favorites",       kind: "album",    load: railRediscover },
      { key: "fy-new-rel",     title: "New releases",              kind: "album",    load: function () { return featuredAlbums("new-releases-full", 24); } },
      { key: "fy-qz-pl",       title: "Qobuz playlists",           kind: "playlist", load: function () { return featuredPlaylists("editor-picks", 18); } }
    ],
    picks: [
      { key: "ep-new-rel", title: "New releases",      kind: "album",    load: function () { return featuredAlbums("new-releases-full", 24); } },
      { key: "ep-qz-pl",   title: "Qobuz playlists",   kind: "playlist", load: function () { return featuredPlaylists("editor-picks", 18); } },
      { key: "ep-qzism",   title: "Qobuzissims",       kind: "album",    load: function () { return featuredAlbums("qobuzissims", 24); } },
      { key: "ep-press",   title: "Press awards",      kind: "album",    load: function () { return featuredAlbums("press-awards", 24); } },
      // Probes: unconfirmed getFeatured types; they gracefully omit if the endpoint returns nothing.
      { key: "ep-aotw",    title: "Album of the week", kind: "album",    load: function () { return featuredAlbums("album-of-the-week", 12); } },
      { key: "ep-most",    title: "Most streamed",     kind: "album",    load: function () { return featuredAlbums("most-streamed", 24); } },
      { key: "ep-ideal",   title: "Ideal discography", kind: "album",    load: function () { return featuredAlbums("ideal-discography", 24); } }
    ]
  };
  return { title: "Discover", root: true, mount: function (el) {
    el.innerHTML =
      '<div class="qz-chips qz-gchips" style="display:none"></div>' +
      '<div class="qz-segbar qz-dsegbar">' +
      '<button class="qz-seg' + (discoverTab === "foryou" ? " is-on" : "") + '" data-disc="foryou">For You</button>' +
      '<button class="qz-seg' + (discoverTab === "picks" ? " is-on" : "") + '" data-disc="picks">Editor’s Picks</button>' +
      '</div><div class="qz-drails"></div>';
    var railsHost = el.querySelector(".qz-drails");
    function paintTab(which) {
      discoverTab = which;
      [].forEach.call(el.querySelectorAll(".qz-seg"), function (s) { s.classList.toggle("is-on", s.getAttribute("data-disc") === which); });
      var specs = RAILS[which];
      // stable-order placeholders (skeletons) up front; each rail fills its own slot as it resolves
      railsHost.innerHTML = specs.map(function (s, i) { return '<div class="qz-drail" data-rail="' + i + '">' + skeletonShelf() + '</div>'; }).join("");
      var slots = railsHost.querySelectorAll(".qz-drail");
      var anyFilled = false, settled = 0;
      specs.forEach(function (s, i) {
        railCached(s.key, s.load).then(function (res) {
          if (which !== discoverTab) return;                 // user switched sub-tab mid-fetch
          var items = Array.isArray(res) ? res : (res && res.items) || [];
          var title = (res && res.title) || s.title;
          var slot = slots[i]; if (!slot) return;
          if (items.length) { slot.innerHTML = shelfHTML(title, items, s.kind); anyFilled = true; }
          else slot.remove();
        }, function () { if (slots[i]) slots[i].remove(); })
          .then(function () {
            if (++settled === specs.length && !anyFilled && which === discoverTab) {
              railsHost.innerHTML = '<p class="qz-empty">' +
                (which === "foryou" ? "Follow a few artists to personalize your feed." : "Couldn’t reach Qobuz. Try again in a moment.") + "</p>";
            }
          });
      });
    }
    el.querySelector(".qz-dsegbar").addEventListener("click", function (e) { var s = e.target.closest("[data-disc]"); if (s) paintTab(s.getAttribute("data-disc")); });
    // [Discover v2] pinned genre chips — the net-new browse entry point. Loaded lazily; the row stays hidden
    // (never occupies space) if genre/list returns nothing for this account. Each chip -> browseScreen(genre).
    var gchips = el.querySelector(".qz-gchips");
    genreList().then(function (gs) {
      if (!gs || !gs.length || !gchips) return;
      gchips.innerHTML = gs.map(function (g) {
        return '<button class="qz-chip" type="button" data-genre="' + esc(g.id) + '" data-gname="' + esc(g.name || "") + '">' + esc(g.name || "Genre") + '</button>';
      }).join("");
      gchips.style.display = "";
      gchips.addEventListener("click", function (e) {
        var b = e.target.closest("[data-genre]"); if (!b) return;
        go(browseScreen(b.getAttribute("data-genre"), b.getAttribute("data-gname")));
      });
    });
    paintTab(discoverTab);
  } };
}

// ------------------------------------------------------------------ shell: nav stack + chrome
var TABS = [
  { id: "home", label: "Discover", icon: IC.home, make: discoverScreen },
  { id: "search", label: "Search", icon: IC.search, make: searchScreen },
  { id: "library", label: "Library", icon: IC.library, make: libraryScreen }
];
var mounted = false, curTab = "home", stack = [], offPlay = null, obs = null, rzT = null, poll = null;
var discoverTab = "foryou";   // remembered Discover sub-tab (survives leaving/returning to the tab)
var discoverRailCache = {};   // rail key -> Promise<items[]|{title,items}> (session cache)
var root, headerEl, contentEl, miniEl, navEl, npEl, lyBody;
// Milestone 1 queue-panel state (see the QUEUE PANEL section below)
var qBody = null, qState = { open: false, sig: "" }, queueMetaCache = {};

function render() {
  var top = stack[stack.length - 1]; if (!top || !contentEl || !root) return;
  // The header exists in the DOM ONLY on pushed screens (as a floating back button). On root screens it's
  // fully REMOVED, not just hidden - a permanently-present fixed header layer never gets invalidated, so on
  // some devices the WebView keeps compositing its stale first-frame texture (the "Qobuzify" that briefly
  // showed before the hide-CSS applied). Removing the element destroys that layer/texture entirely.
  var canBack = stack.length > 1;
  if (canBack) { if (!headerEl.parentNode) root.insertBefore(headerEl, contentEl); }
  else if (headerEl.parentNode) { headerEl.parentNode.removeChild(headerEl); }
  headerEl.querySelector(".qz-hd__back").style.display = canBack ? "" : "none";
  headerEl.querySelector(".qz-hd__title").textContent = "";
  contentEl.scrollTop = 0;
  contentEl.innerHTML = "";
  try { top.mount(contentEl); } catch (e) { contentEl.innerHTML = '<p class="qz-empty">Something went wrong rendering this view.</p>'; }
}
function go(screen) { stack.push(screen); render(); }
function back() { if (stack.length > 1) { stack.pop(); render(); } }
// Route the Android hardware/gesture BACK into our overlay + screen stack. On gesture-nav phones the OS
// eats the left-edge swipe (system back) before the WebView sees it, so a JS edge-swipe listener can never
// fire; instead the native onBackPressed consults this and we pop the innermost thing open. Returns true iff
// we consumed the press (native falls through to WebView history / minimize only when this returns false).
function qzHandleBack() {
  try {
    if (_sheet) { closeSheet(); return true; }                                   // bottom sheet (context / add-to-playlist / share)
    if (qMenuEl) { closeQMenu(); return true; }                                  // quality tier picker
    var ss = npEl && npEl.querySelector(".qz-sleepsheet");                       // sleep-timer sheet
    if (ss) { ss.classList.remove("is-in"); setTimeout(function () { if (ss.parentNode) ss.parentNode.removeChild(ss); }, 260); return true; }
    if (lyState.open) { closeLyrics(); return true; }                            // lyrics overlay
    if (qState.open) { closeQueue(); return true; }                             // queue overlay
    if (npEl && npEl.classList.contains("is-open")) { closeNP(); return true; }  // Now Playing sheet
    if (stack.length > 1) { back(); return true; }                              // pushed screen -> pop
  } catch (e) {}
  return false;                                                                  // at root: let native minimize/exit
}
try { window.__qzBack = qzHandleBack; } catch (e) {}
function setTab(id) {
  curTab = id;
  var t = TABS.filter(function (x) { return x.id === id; })[0]; if (!t) return;
  stack = [t.make()];
  [].forEach.call(navEl.querySelectorAll(".qz-nav__tab"), function (b) { b.classList.toggle("is-on", b.getAttribute("data-tab") === id); });
  render();
}

// one delegated tap handler for every card / row / play button in the content area
function onContentTap(e) {
  var t = e.target.closest("[data-act]"); if (!t) return;
  var act = t.getAttribute("data-act"), id = t.getAttribute("data-id");
  if (act === "album") go(detailScreen("album", id));
  else if (act === "playlist") go(playlistDetailScreen(id));       // M3: owned-aware detail (reorder/remove/subscribe)
  else if (act === "artist") go(artistScreen(id));
  else if (act === "featured") go(featScreen());                   // M3: editorial playlists browser
  else if (act === "settings") go(settingsScreen());               // settings screen (gear on Library)
  else if (act === "setq") openSettingsQuality();                  // settings: streaming-quality picker
  else if (act === "settheme") openThemePicker();                  // settings: Appearance theme picker
  else if (act === "apptoggle") stgToggleTap(t);                   // settings: Mobile feature toggle
  else if (act === "exttoggle") stgExtToggleTap(t);                // settings: extension enable/disable (reloads to apply)
  else if (act === "logout") qzConfirmLogout();                    // settings: log out (confirm sheet -> qzLogout)
  else if (act === "pl-menu") openPlaylistSheet(id);               // M3: owner options (Edit details / Delete)
  else if (act === "pl-new") openCreatePlaylistSheet();            // M3: create playlist
  else if (act === "play") { flashTap(t); playInContext(t); }
  else if (act === "more") { openTrackSheet(t); }
  else if (act === "playtop") {
    flashTap(t); var kind = t.getAttribute("data-kind"), pid = t.getAttribute("data-id"), first = t.getAttribute("data-first");
    if (kind === "album") playFromAlbum(pid, first, 1);
    else navClickRow("/playlist/" + pid, function (rows) { return rows[0]; });
  }
  else if (act === "fav") {
    var fkind = t.getAttribute("data-kind");
    if (fkind === "playlist") togglePlaylistSub(id);
    else toggleFavorite(fkind, id);
  }
}
function flashTap(el) { el.classList.add("is-loading"); setTimeout(function () { el.classList.remove("is-loading"); }, 1400); }

// ------------------------------------------------------------------ mini player + now-playing overlay
// Two update paths, kept separate so we never reload artwork on a timer:
//   renderTrack()      - only when the track id actually changes (sets cover/title/artist innerHTML)
//   renderTransport()  - cheap; flips just the play/pause glyph when the state flips
//   tickProgress()     - the 500ms poll; moves the progress fill + time labels only
var lastTrackId = null, lastPlaying = null;
function hasTrack() { try { var ct = Q.getState().player.currentTrack; return !!(ct && ct.id); } catch (e) { return false; } }
function curDurMs() { try { return (Q.getState().player.currentTrack || {}).duration || 0; } catch (e) { return 0; } } // duration is ms here
function isPlaying() { try { return Q.player.isPlaying(); } catch (e) { return false; } }
// The redux currentTrack carries ONLY {id, duration, fileUrl} - all display metadata (title/artist/cover)
// comes from Q.player.getTrack(), which scrapes the Qobuz DOM player-bar. On a cold open or while paused,
// that bar can be empty before it paints, so the mini/NP would show blank even though a track is loaded.
// Cache the good scrapes by id and, on a miss, fetch track/get so the bar always has the current song.
var trackMetaCache = {}, _metaFetching = {};
function metaFromApi(id) {
  if (id == null || _metaFetching[id]) return;
  _metaFetching[id] = 1;
  api("track/get?track_id=" + id).then(function (t) {
    if (t && t.id != null) {
      var img = t.album && t.album.image;
      trackMetaCache[id] = { id: t.id, title: t.title || "",
        artist: (t.performer && t.performer.name) || (t.album && t.album.artist && t.album.artist.name) || "",
        album: (t.album && t.album.title) || "", albumId: (t.album && t.album.id) || null,
        cover: (img && (img.small || img.thumbnail || img.large)) || "", durationMs: (t.duration || 0) * 1000 };
      var cur = null; try { cur = (Q.getState().player.currentTrack || {}).id; } catch (e) {}
      if (mounted && cur == id) renderTrack();   // re-render now that we have the metadata
    }
  }).catch(function () {}).then(function () { _metaFetching[id] = 0; });
}
function renderTrack() {
  if (!mounted) return;
  var on = hasTrack();
  document.documentElement.classList.toggle("qz-has-track", on);
  var cid = null; try { cid = (Q.getState().player.currentTrack || {}).id; } catch (e) {}
  var tk = on ? (Q.player.getTrack() || {}) : {};
  if (on && cid != null) {
    if (tk.title) trackMetaCache[cid] = tk;                 // keep the good DOM scrape as the fallback
    else tk = trackMetaCache[cid] || (metaFromApi(cid), {});  // scrape empty -> cached meta, else fetch async
  }
  var art = tk.cover ? '<img src="' + esc(tk.cover) + '">' : ph("track");
  if (miniEl) {
    miniEl.querySelector(".qz-mini__art").innerHTML = art;
    miniEl.querySelector(".qz-mini__t").textContent = tk.title || "";
    miniEl.querySelector(".qz-mini__s").textContent = tk.artist || "";
  }
  if (npEl) {
    var npArtBox = npEl.querySelector(".qz-np__art");
    npArtBox.innerHTML = "";
    if (tk.cover) npArtBox.appendChild(bigArtImg(tk.cover)); else npArtBox.innerHTML = ph("track");   // full-screen art = hi-res
    npEl.querySelector(".qz-np__t").textContent = tk.title || "";
    npEl.querySelector(".qz-np__s").textContent = tk.artist || "";
  }
  applyTint(on ? tk.cover : null);   // wash the app in the album's dominant color (beta signature)
  paintNpQuality();
  syncQueueControls();               // mirror store shuffle/repeat onto the NP buttons on track change
  if (lyState.open) lyLoad(tk);
  if (!on) closeNP();
}
function paintNpQuality() {
  if (!npEl) return;
  var chip = npEl.querySelector(".qz-np__q"); if (!chip) return;
  var id = null; try { id = (Q.getState().player.currentTrack || {}).id; } catch (e) {}
  if (id == null) { chip.hidden = true; return; }
  var selT = qTierByCode(qCurMax());                          // show the selected ceiling right away
  chip.textContent = selT ? selT.name : "";
  chip.hidden = !chip.textContent;
  ensureQuality(id, function (q) {                            // refine to this track's own readout
    var cur = null; try { cur = (Q.getState().player.currentTrack || {}).id; } catch (e) {}
    if (cur !== id || !npEl) return;
    var label = q ? (q.tier ? q.tier + (q.str ? " · " + q.str : "") : q.str) : "";
    if (label) { chip.textContent = label; chip.hidden = false; }
  });
}

// ------------------------------------------------------------------ quality SELECTION (per-session store write)
// The web player's own picker (.player__settings-quality popover) does exactly ONE thing on pick:
//   setStreamingQuality(code) -> dispatch(setMaxAudioFormat({format:code}))
//   local onMaxAudioFormatSet -> dispatch(audioOutputs/setCurrentSettings({maxAudioFormat:code}))   [bundle]
// The reducer just merges o.settings.maxAudioFormat=code into dictionnary[current] (throws w/o a current
// output) and does NOT reload the current track. So unlike playback START, this is a PURE store write we can
// replicate 1:1. Codes = Qobuz format_id / AudioFormatEnum, numerically tier-ordered: MP3=5,CD=6,96=7,192=27.
var QTIERS = [   // best -> worst (mirrors native playerFormats = [27,7,6,5])
  { code: 27, name: "Hi-Res 192", spec: "24-bit / up to 192 kHz" },
  { code: 7,  name: "Hi-Res 96",  spec: "24-bit / up to 96 kHz"  },
  { code: 6,  name: "CD",         spec: "16-bit / 44.1 kHz"      },
  { code: 5,  name: "MP3 320",    spec: "320 kbps"               }
];
function qTierByCode(c) { for (var i = 0; i < QTIERS.length; i++) if (QTIERS[i].code === c) return QTIERS[i]; return null; }
function audioOut() { try { var ao = Q.getState().audioOutputs; return { ao: ao, cur: (ao && ao.current && ao.dictionnary) ? ao.dictionnary[ao.current] : null }; } catch (e) { return { ao: null, cur: null }; } }
function qCurMax() { var o = audioOut().cur; return (o && o.settings && o.settings.maxAudioFormat != null) ? o.settings.maxAudioFormat : 27; }
function qCapMax() { var o = audioOut().cur; return (o && o.capabilities && o.capabilities.maxAudioFormat != null) ? o.capabilities.maxAudioFormat : 27; }
function qCapMin() { var o = audioOut().cur; return (o && o.capabilities && o.capabilities.minAudioFormat != null) ? o.capabilities.minAudioFormat : 5; }
// live actually-streaming format off player.quality (best-effort; may be absent early in a track)
function qNowStreaming() {
  try {
    var q = Q.getState().player.quality; if (!q || q.formatId == null) return null;
    var t = qTierByCode(q.formatId), bd = q.bitDepth, sr = q.samplingRate; if (sr > 1000) sr = sr / 1000;
    var spec = (bd && sr) ? (Math.round(bd) + "-bit / " + (Math.round(sr * 10) / 10) + " kHz") : ((t && t.spec) || "");
    return { tier: (t && t.name) || "", spec: spec };
  } catch (e) { return null; }
}
// Replicate the native picker exactly: merge the chosen ceiling into the current output's settings. The
// reducer THROWS without a current output, so guard on ao.current. Applies from the next stream resolve.
function qSetMax(code) {
  var s = audioOut(); if (!s.ao || !s.ao.current) return false;
  try { Q.store.dispatch({ type: "audioOutputs/setCurrentSettings", payload: { maxAudioFormat: code } }); return true; }
  catch (e) { return false; }
}
// ---- quality picker sheet: lists the 4 tiers, checks the chosen ceiling, disables tiers past the plan cap
// (mirrors the native popover's `e>S||e<T`); tapping one writes the store.
function qMenuHTML() {
  var cur = qCurMax(), capX = qCapMax(), capN = qCapMin(), now = qNowStreaming();
  var rows = QTIERS.map(function (t) {
    var disabled = t.code > capX || t.code < capN, on = t.code === cur;
    return '<button class="qz-qm__row' + (on ? " is-on" : "") + (disabled ? " is-disabled" : "") + '"' +
      (disabled ? "" : ' data-qcode="' + t.code + '"') + '>' +
      '<span class="qz-qm__rl"><span class="qz-qm__rt">' + esc(t.name) + '</span>' +
      '<span class="qz-qm__rs">' + esc(t.spec) + '</span></span>' +
      '<span class="qz-qm__rc">' + (on ? "&#10003;" : "") + '</span></button>';
  }).join("");
  return '<div class="qz-qm__scrim"></div><div class="qz-qm__sheet">' +
    '<div class="qz-qm__h"><span>Streaming quality</span>' +
    (now ? '<span class="qz-qm__now">Now: ' + esc((now.tier ? now.tier + " · " : "") + now.spec) + "</span>" : "") + "</div>" +
    rows +
    '<div class="qz-qm__note">Sets the maximum. Applies from the next track.</div></div>';
}
var qMenuEl = null;
function openQMenu() {
  if (!npEl || !hasTrack()) return;
  closeQMenu();
  qMenuEl = h('<div class="qz-qm"></div>');
  qMenuEl.innerHTML = qMenuHTML();
  qMenuEl.addEventListener("touchstart", function (e) { e.stopPropagation(); }, { passive: true }); // keep NP swipe-down off it
  qMenuEl.addEventListener("click", function (e) {
    if (e.target.closest(".qz-qm__scrim")) { closeQMenu(); return; }
    var row = e.target.closest("[data-qcode]"); if (!row) return;
    if (qSetMax(+row.getAttribute("data-qcode"))) { qMenuEl.innerHTML = qMenuHTML(); paintNpQuality(); setTimeout(closeQMenu, 480); }
  });
  npEl.appendChild(qMenuEl);
  requestAnimationFrame(function () { if (qMenuEl) qMenuEl.classList.add("is-open"); });
}
function closeQMenu() { if (qMenuEl) { qMenuEl.remove(); qMenuEl = null; } }
function renderTransport(force) {
  if (!mounted) return;
  var p = isPlaying();
  if (!force && p === lastPlaying) return;
  lastPlaying = p; var ic = p ? IC.pause : IC.play;
  if (miniEl) miniEl.querySelector(".qz-mini__pp").innerHTML = ic;
  if (npEl) npEl.querySelector(".qz-np__pp").innerHTML = ic;
}
function tickProgress() {
  if (!mounted) return;
  // detect a track change here too (covers cases onChange might miss), then progress + transport
  var id = null; try { var ct = Q.getState().player.currentTrack; id = ct && ct.id; } catch (e) {}
  if (id !== lastTrackId) { lastTrackId = id; renderTrack(); }
  renderTransport(false);
  syncQueue();                        // refresh shuffle/repeat + queue panel when the store moves
  if (!hasTrack()) return;
  var pos = 0; try { pos = Q.player.getPositionMs(); } catch (e) {}
  if (lyState.open) lyTick(pos);
  var dur = curDurMs(), frac = dur ? Math.max(0, Math.min(1, pos / dur)) : 0;
  if (miniEl) { var mb = miniEl.querySelector(".qz-mini__bar > i"); if (mb) mb.style.width = (frac * 100) + "%"; }
  // skip the NP-bar write while the user is scrubbing it (and briefly after) so the poll doesn't fight the finger
  if (npEl && npEl.classList.contains("is-open") && !seeking && Date.now() >= seekingUntil) {
    var f = npEl.querySelector(".qz-np__bar > i"); if (f) f.style.width = (frac * 100) + "%";
    npEl.querySelector(".qz-np__cur").textContent = fmtDur(pos / 1000);
    npEl.querySelector(".qz-np__dur").textContent = fmtDur(dur / 1000);
  }
}
function openNP() { if (!hasTrack()) return; npEl.classList.add("is-open"); renderTrack(); renderTransport(true); tickProgress(); }
function closeNP() { if (npEl) npEl.classList.remove("is-open"); closeLyrics(); closeQueue(); closeQMenu(); }

// ------------------------------------------------------------------ lyrics (OUR api.qobuzify.app; times are SECONDS)
// Our proxy word-syncs nearly everything (Qobuz's own first-party route only karaokes a handful), so we keep it.
// Client only ever reads hasLyrics/lyrics/source, and `source` is already a codename server-side, so no
// third-party provider name reaches the client. Our own WORD-BY-WORD karaoke renderer: active line brightens,
// each word lights as it's sung, smooth auto-scroll; line-sync + plain are fallbacks. Swappable source via LYRICS_SRC.
var LYRICS_SRC = "https://api.qobuzify.app/v1/lyrics";
var lyState = { id: null, lines: null, plain: null, active: -1, open: false, userHold: 0, selfScrollUntil: 0, hasTr: false, showTr: false };
var lyCache = {}; // trackId -> {lines}|{plain}|{none:true}

// --- M4 lyrics affordances: translate glyph + recenter target (monochrome, currentColor) ---
var LY_TR_IC = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 5h7M7.5 5v1.2c0 3.4-2 6.3-4.5 7.8M5 9.2c.9 2 2.6 3.6 4.8 4.4M13 20l3.5-9 3.5 9M14.2 17h4.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
var LY_RECENTER_IC = '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3.2" fill="currentColor"/><path d="M12 3v3.4M12 17.6V21M3 12h3.4M17.6 12H21" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

// scroll the active line to vertical center; mark a self-scroll window so our OWN smooth scroll doesn't
// get mistaken for a user gesture (that was suppressing auto-scroll on fast, sub-3s line changes).
function lyCenter(el, smooth) {
  if (!el || !lyBody) return;
  // Center the active line in the VIEWPORT, not within the body. The body sits ~58px below the top of the
  // screen (the panel's header padding), so body-relative centering (clientHeight/2) settled every line that
  // far BELOW true center = "renders too far down". Use live rects so the target is the real screen middle.
  var elMid = el.getBoundingClientRect().top + el.offsetHeight / 2;
  var top = lyBody.scrollTop + (elMid - window.innerHeight / 2);
  lyState.selfScrollUntil = Date.now() + (smooth ? 700 : 120);
  try { lyBody.scrollTo({ top: top, behavior: smooth ? "smooth" : "auto" }); }
  catch (e) { lyBody.scrollTop = top; }
}
// a genuine user scroll/drag: hold auto-scroll off for a bit and reveal the recenter pill
function lyHold() {
  lyState.userHold = Date.now() + 3500;
  if (lyBody && lyBody.parentNode && lyState.lines) lyBody.parentNode.classList.add("is-holding");
}
function lyRecenter() {
  lyState.userHold = 0;
  var el = lyBody && (lyBody.querySelector(".qz-ly__line.is-active") || lyBody.querySelector('.qz-ly__line[data-i="' + lyState.active + '"]'));
  if (el) lyCenter(el, true);
  if (lyBody && lyBody.parentNode) lyBody.parentNode.classList.remove("is-holding");
}
// normalize a (future) proxy translation payload to an array index-aligned to lyrics.Content.
// tolerant of ["l0",..] | {lines:[..]} | {Lines:[{Text},..]} | {Content:[{Text},..]}. null if absent.
function trLineArray(tr) {
  if (!tr) return null;
  var a = Array.isArray(tr) ? tr : (tr.lines || tr.Lines || tr.Content || null);
  if (!a || !a.length) return null;
  return a.map(function (x) { return x == null ? null : (typeof x === "string" ? x : (x.Text != null ? x.Text : (x.text != null ? x.text : null))); });
}
// sync the translation toggle button (hidden unless the track has translations) + the body show/hide class
function lyApplyTrClass() {
  if (!lyBody) return;
  lyBody.classList.toggle("qz-ly--tr", !!(lyState.showTr && lyState.hasTr));
  var btn = lyBody.parentNode && lyBody.parentNode.querySelector(".qz-ly__tr-toggle");
  if (!btn) return;
  btn.hidden = !lyState.hasTr;
  btn.classList.toggle("is-on", !!lyState.showTr);
  btn.setAttribute("aria-pressed", lyState.showTr ? "true" : "false");
  var lab = btn.querySelector(".qz-ly__tr-lab"); if (lab) lab.textContent = lyState.showTr ? "Original" : "Translation";
}
function lyToggleTr() { lyState.showTr = !lyState.showTr; lyApplyTrClass(); }  // showTr persists across tracks (session pref)
function lyFetch(tk) {
  if (!tk || !tk.title || !tk.artist) return Promise.resolve(null);
  var u = LYRICS_SRC + "?qz=1&name=" + encodeURIComponent(tk.title) + "&artist=" + encodeURIComponent(tk.artist);
  if (tk.album) u += "&album=" + encodeURIComponent(tk.album);
  if (tk.durationMs) u += "&durationMs=" + tk.durationMs;
  return fetch(u).then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!(j && j.ok && j.hasLyrics && j.lyrics)) return null;
      // NOTE: our proxy does NOT return a translation today (verified). This just future-proofs: read it
      // from wherever the server might add it so the toggle lights up automatically without a client ship.
      var tr = j.translation || j.translations || (j.lyrics && j.lyrics.Translation) || null;
      return { ly: j.lyrics, tr: tr };
    })
    .catch(function () { return null; });
}
// structured ly -> {lines:[{t,text,words,tr}], hasTr} (synced) or {plain:[...]} (untimed). Times in ly are SECONDS.
function lyExtract(ly, tr) {
  if (!ly) return null;
  var trLines = trLineArray(tr);          // index-aligned to ly.Content, or null
  var C = ly.Content, hasTr = false;
  if (C && C.length) {
    var out = [];
    for (var i = 0; i < C.length; i++) {
      var c = C[i], text, st, words = null;
      if (c.Lead && c.Lead.Syllables && c.Lead.Syllables.length) {
        words = c.Lead.Syllables.map(function (s) { return { t: Math.round((s.StartTime || 0) * 1000), text: s.Text || "", glue: !!s.IsPartOfWord }; });
        text = words.map(function (w) { return w.text + (w.glue ? "" : " "); }).join("").replace(/\s+/g, " ").trim();
        st = c.Lead.StartTime;
      } else { text = (c.Text || "").trim(); st = c.StartTime; }
      if (!text) continue;                                     // instrumental/musical line -> natural gap
      var trText = (trLines && trLines[i] != null ? String(trLines[i]) : (c.Translation || (c.Lead && c.Lead.Translation) || "")).trim();
      if (trText) hasTr = true;
      out.push({ t: Math.round((st || 0) * 1000), text: text, words: words, tr: trText || null }); // sec -> ms
    }
    if (out.length) return { lines: out, hasTr: hasTr };
  }
  if (ly.Lines && ly.Lines.length) return { plain: ly.Lines.map(function (l) { return (l.Text || "").trim(); }).filter(Boolean) };
  return null;
}
function lyLoad(tk) {
  if (!tk || !tk.id) { lyState.id = null; lyState.lines = lyState.plain = null; lyState.hasTr = false; lyState.active = -1; lyRender(); return; }
  if (lyState.id === tk.id) return;
  lyState.id = tk.id; lyState.lines = lyState.plain = null; lyState.hasTr = false; lyState.active = -1;
  var cached = lyCache[tk.id];
  if (cached) { lyApply(tk.id, cached); return; }
  if (lyBody) lyBody.innerHTML = '<div class="qz-load"><span class="qz-spin"></span></div>';
  lyFetch(tk).then(function (r) { var ex = lyExtract(r && r.ly, r && r.tr) || { none: true }; lyCache[tk.id] = ex; lyApply(tk.id, ex); });
}
function lyApply(id, ex) {
  if (lyState.id !== id) return;                               // track changed while fetching
  lyState.lines = ex.lines || null; lyState.plain = ex.plain || null; lyState.hasTr = !!ex.hasTr; lyState.active = -1; lyRender();
}
function lyRender() {
  if (!lyBody) return;
  if (lyState.lines) {
    var wbw = stgTogOn("mobile-wbw");   // Settings > Appearance "Word-by-word lyrics" toggle: off -> line-synced only
    lyBody.innerHTML = lyState.lines.map(function (l, i) {
      var tr = l.tr ? '<span class="qz-ly__tr">' + esc(l.tr) + "</span>" : "";
      if (l.words && wbw) {
        var inner = l.words.map(function (w) { return '<span class="qz-ly__w" data-wt="' + w.t + '">' + esc(w.text) + "</span>" + (w.glue ? "" : " "); }).join("");
        return '<p class="qz-ly__line qz-ly__line--w" data-i="' + i + '">' + inner + tr + "</p>";
      }
      return '<p class="qz-ly__line" data-i="' + i + '">' + esc(l.text) + tr + "</p>";
    }).join("");
  } else if (lyState.plain) lyBody.innerHTML = '<div class="qz-ly__plain">' + lyState.plain.map(function (t) { return "<p>" + esc(t) + "</p>"; }).join("") + "</div>";
  else lyBody.innerHTML = '<p class="qz-empty">No lyrics for this track.</p>';
  lyApplyTrClass();
  if (lyBody.parentNode) lyBody.parentNode.classList.remove("is-holding");
}
function lyTick(posMs) {
  if (!lyState.open || !lyState.lines || !lyBody) return;
  var L = lyState.lines, idx = -1;
  for (var i = 0; i < L.length; i++) { if (L[i].t <= posMs) idx = i; else break; }
  if (idx !== lyState.active) {
    lyState.active = idx;
    var els = lyBody.querySelectorAll(".qz-ly__line"), cur = null;
    for (var j = 0; j < els.length; j++) {
      var on = (+els[j].getAttribute("data-i") === idx);
      els[j].classList.toggle("is-active", on);
      if (!on) { var sw = els[j].querySelectorAll(".qz-ly__w.is-sung"); for (var m = 0; m < sw.length; m++) sw[m].classList.remove("is-sung"); }
      if (on) cur = els[j];
    }
    if (cur && Date.now() >= lyState.userHold) lyCenter(cur, true);   // auto-center unless the user is holding
  }
  // karaoke: light each word on the active line as it's sung
  if (idx >= 0 && L[idx].words) {
    var lineEl = lyBody.querySelector('.qz-ly__line[data-i="' + idx + '"]');
    if (lineEl) { var ws = lineEl.querySelectorAll(".qz-ly__w"); for (var k = 0; k < ws.length; k++) { var wt = +ws[k].getAttribute("data-wt"); ws[k].classList.toggle("is-sung", wt <= posMs); } }
  }
  // recenter pill visibility tracks the hold window (auto-hides when the hold lapses)
  if (lyBody.parentNode) lyBody.parentNode.classList.toggle("is-holding", Date.now() < lyState.userHold);
}
function openLyrics() { if (!hasTrack() || !npEl) return; closeQueue(); lyState.open = true; npEl.classList.add("qz-np--lyrics"); lyLoad(Q.player.getTrack() || {}); var p = 0; try { p = Q.player.getPositionMs(); } catch (e) {} lyTick(p); }
function closeLyrics() { lyState.open = false; if (npEl) npEl.classList.remove("qz-np--lyrics"); }

// ------------------------------------------------------------------ QUEUE PANEL + SHUFFLE/REPEAT SYNC
// Reads the live play queue straight from the Redux store (playqueue slice) and shows current + upcoming
// as a Now-Playing overlay (sibling of .qz-ly). Play order + shuffle + repeat come from the store; per-row
// metadata is resolved through the cached Q.api("track/get") the rest of the app already uses.
// Tapping an upcoming row JUMPS to it by firing the native next button (delta) times.
function qPlayqueue() { try { return Q.getState().playqueue || null; } catch (e) { return null; } }
function qOrder(pq) { return (pq.shuffled && pq.shuffledItems && pq.shuffledItems.length) ? pq.shuffledItems : (pq.items || []); }
function qIndex(pq) { var ci = pq.currentIndex; return (typeof ci === "number" && ci >= 0) ? ci : 0; }
function qSig(pq) {
  var order = qOrder(pq), ci = qIndex(pq), cur = order[ci];
  return order.length + "|" + ci + "|" + (cur && cur.trackId) + "|" + (pq.shuffled ? 1 : 0) + "|" + (pq.repeatMode || "noRepeat") +
         "|" + (((pq.autoplay && pq.autoplay.items) || []).length);
}
function resolveQueueMeta(id, cb) {
  if (id == null) return; id = String(id);
  if (queueMetaCache[id] !== undefined) { cb(queueMetaCache[id]); return; }
  api("track/get?track_id=" + id).then(function (tr) {
    var m = { title: (tr && tr.title) || "", artist: artistName(tr), cover: cover(tr) };
    queueMetaCache[id] = m; cb(m);
  }).catch(function () { queueMetaCache[id] = null; cb(null); });
}
function qRowHTML(it, orderIndex, isCurrent, isAuto) {
  var id = it && it.trackId; if (id == null) return "";
  var m = queueMetaCache[String(id)];
  var img = (m && m.cover) ? '<img src="' + esc(m.cover) + '">' : ph("track");
  var tappable = (!isCurrent && !isAuto) ? "1" : "0";
  return '<button class="qz-queue__row' + (isCurrent ? " is-current" : "") + (isAuto ? " is-auto" : "") + '"' +
    ' data-qtap="' + tappable + '" data-qorder="' + esc(orderIndex) + '" data-qid="' + esc(id) + '">' +
    '<span class="qz-queue__art">' + img + (isCurrent ? '<span class="qz-queue__eq"><i></i><i></i><i></i></span>' : "") + '</span>' +
    '<span class="qz-queue__meta"><span class="qz-queue__t">' + esc(m ? (m.title || "") : "…") + '</span>' +
    '<span class="qz-queue__s">' + esc(m ? (m.artist || "") : "") + '</span></span></button>';
}
function qPaintRow(row, m) {
  var art = row.querySelector(".qz-queue__art");
  if (art) { var eq = art.querySelector(".qz-queue__eq"); art.innerHTML = (m && m.cover) ? '<img src="' + esc(m.cover) + '">' : ph("track"); if (eq) art.appendChild(eq); }
  var t = row.querySelector(".qz-queue__t"); if (t) t.textContent = (m && m.title) || "";
  var s = row.querySelector(".qz-queue__s"); if (s) s.textContent = (m && m.artist) || "";
}
function qHydrate() {
  if (!qBody) return;
  var seen = {};
  [].forEach.call(qBody.querySelectorAll(".qz-queue__row"), function (r) {
    var id = r.getAttribute("data-qid"); if (!id || seen[id]) return; seen[id] = 1;
    resolveQueueMeta(id, function (m) {
      if (!qBody) return;
      [].forEach.call(qBody.querySelectorAll('.qz-queue__row[data-qid="' + id + '"]'), function (live) { qPaintRow(live, m); });
    });
  });
}
function qRender() {
  if (!qBody) return;
  var pq = qPlayqueue();
  if (!pq) { qBody.innerHTML = '<p class="qz-empty">No queue.</p>'; return; }
  var order = qOrder(pq), ci = qIndex(pq);
  if (!order.length) { qBody.innerHTML = '<p class="qz-empty">Queue is empty.</p>'; return; }
  var html = "", cur = order[ci];
  if (cur) html += '<div class="qz-queue__sec">Now playing</div>' + qRowHTML(cur, ci, true, false);
  var up = order.slice(ci + 1), i;
  if (up.length) {
    html += '<div class="qz-queue__sec">Next up</div>';
    for (i = 0; i < up.length && i < 80; i++) html += qRowHTML(up[i], ci + 1 + i, false, false);
  }
  var ap = (pq.autoplay && pq.autoplay.items) || [];
  if (ap.length) {
    html += '<div class="qz-queue__sec">Autoplay</div>';
    for (i = 0; i < ap.length && i < 30; i++) html += qRowHTML(ap[i], -1, false, true);
  }
  qBody.innerHTML = html;
  qHydrate();
}
// forward jump: delta computed once; fire next exactly delta times (staggered so each event lands).
function queueJumpTo(targetIndex) {
  var pq = qPlayqueue(); if (!pq) return;
  var delta = targetIndex - qIndex(pq);
  if (delta <= 0) return;                 // list only exposes upcoming rows, so delta is always >= 1
  var n = delta, i = 0;
  (function fire() { if (i++ >= n) return; clickEl(".pct-player-next, .player__action-next"); setTimeout(fire, 70); })();
}
function openQueue() {
  if (!hasTrack() || !npEl) return;
  if (typeof closeLyrics === "function") closeLyrics();   // mutually exclusive with the lyrics overlay
  qState.open = true; npEl.classList.add("qz-np--queue");
  qState.sig = ""; syncQueue();                            // force a first render
}
function closeQueue() { qState.open = false; if (npEl) npEl.classList.remove("qz-np--queue"); }
// state-sync from the store — cheap, stateless (safe to call every poll and after remounts).
function syncQueueControls() {
  if (!npEl) return;
  var pq = qPlayqueue(); if (!pq) return;
  var sh = npEl.querySelector(".qz-np__sh"); if (sh) sh.classList.toggle("is-on", !!pq.shuffled);
  var rp = npEl.querySelector(".qz-np__rp");
  if (rp) { var rep = pq.repeatMode || "noRepeat"; rp.classList.toggle("is-on", rep !== "noRepeat"); rp.classList.toggle("is-one", rep === "repeatOne"); }
}
function syncQueue() {
  syncQueueControls();
  if (!qState.open) return;
  var pq = qPlayqueue(); if (!pq) return;
  var sig = qSig(pq);
  if (sig !== qState.sig) { qState.sig = sig; qRender(); }   // re-render only when the queue actually moved
}
// M1 FIX: queue tap-to-jump is now bound inside buildShell() on each mount (see qBody binding there), so a fresh
// qBody after an unmount->remount always gets the delegated tap handler. (Was a one-shot IIFE that never rebound.)

// ------------------------------------------------------------------ album-art dynamic tint (the beta's globalGradientBackground)
// Sample the cover, take a saturation-weighted dominant color, darken it to the beta's lightness band, and wash
// the whole app + Now Playing with it (via --qz-tint-* CSS vars). CORS-guarded: if the CDN taints the canvas we
// fall back to a neutral near-black so it never breaks.
var _tintCache = {}, _tintCanvas = null;
function applyTint(url) {
  // Settings > Appearance "Album-art tint" toggle (mobile-tint): when off, wash the app in the neutral
  // near-black fallback and skip the canvas colour-sampling entirely.
  if (!stgTogOn("mobile-tint")) { setTintVars(null); return; }
  if (!url) { setTintVars(null); return; }
  if (_tintCache[url]) { setTintVars(_tintCache[url]); return; }
  var img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = function () {
    try {
      var n = 24;
      if (!_tintCanvas) _tintCanvas = document.createElement("canvas");
      _tintCanvas.width = _tintCanvas.height = n;
      var ctx = _tintCanvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, n, n);
      var d = ctx.getImageData(0, 0, n, n).data;   // throws if the canvas is CORS-tainted
      var R = 0, G = 0, B = 0, Wt = 0;
      for (var i = 0; i < d.length; i += 4) {
        var r = d[i], g = d[i + 1], b = d[i + 2];
        var mx = Math.max(r, g, b), mn = Math.min(r, g, b), s = mx ? (mx - mn) / mx : 0;
        var w = s * s * (mx / 255) + 0.004;         // bias toward vivid pixels (a la Palette vibrant swatch)
        R += r * w; G += g * w; B += b * w; Wt += w;
      }
      var stops = tintStops(R / Wt, G / Wt, B / Wt);
      _tintCache[url] = stops; setTintVars(stops);
    } catch (e) { setTintVars(null); }
  };
  img.onerror = function () { setTintVars(null); };
  img.src = url;
}
function tintStops(r, g, b) {
  var avg = (r + g + b) / 3;                          // gentle saturation boost, then darken to L0.085-0.20
  r = clampByte(avg + (r - avg) * 1.35); g = clampByte(avg + (g - avg) * 1.35); b = clampByte(avg + (b - avg) * 1.35);
  function L(t) { var mx = Math.max(r, g, b) / 255 || 1, f = t / mx; return "rgb(" + clampByte(r * f) + "," + clampByte(g * f) + "," + clampByte(b * f) + ")"; }
  return { top: L(0.20), mid: L(0.14), bot: L(0.085) };
}
function clampByte(v) { return Math.max(0, Math.min(255, Math.round(v))); }
function setTintVars(s) {
  var el = document.getElementById(ROOT_ID); if (!el) return;
  if (!s) s = { top: "#17171a", mid: "#101013", bot: "#0a0a0c" };   // neutral fallback
  el.style.setProperty("--qz-tint-top", s.top);
  el.style.setProperty("--qz-tint-mid", s.mid);
  el.style.setProperty("--qz-tint-bot", s.bot);
}

// ------------------------------------------------------------------ gestures + NP actions (beta feel)
// swipe DOWN on Now Playing (art/title area, not controls/seek/lyrics) dismisses it, like the beta.
function bindSwipeDown(el) {
  var y0 = null, x0 = null, ok = false;
  el.addEventListener("touchstart", function (e) {
    if (e.target.closest(".qz-np__bar, .qz-np__ctl, .qz-np__actions, .qz-ly, .qz-queue, .qz-np__like, .qz-np__more, .qz-np__device")) { ok = false; return; }
    var t = e.touches[0]; y0 = t.clientY; x0 = t.clientX; ok = true;
  }, { passive: true });
  el.addEventListener("touchend", function (e) {
    if (!ok || y0 == null) { ok = false; return; }
    var t = e.changedTouches[0], dy = t.clientY - y0, dx = Math.abs(t.clientX - x0);
    ok = false; y0 = null;
    if (dy > 90 && dy > dx * 1.5) closeNP();
  }, { passive: true });
}
// swipe from the LEFT EDGE to go back a screen (only fires when there's somewhere to go back to).
function bindEdgeBack(el) {
  var x0 = null, y0 = null, edge = false;
  el.addEventListener("touchstart", function (e) { var t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; edge = x0 < 30; }, { passive: true });
  el.addEventListener("touchend", function (e) {
    if (!edge || x0 == null) { edge = false; x0 = null; return; }
    var t = e.changedTouches[0], dx = t.clientX - x0, dy = Math.abs(t.clientY - y0);
    edge = false; x0 = null;
    if (dx > 70 && dx > dy * 1.5) back();
  }, { passive: true });
}
function currentTrackAlbumId() { try { return (Q.player.getTrack() || {}).albumId || null; } catch (e) { return null; } }
function openCurrentAlbum() { var aid = currentTrackAlbumId(); if (aid) { closeNP(); go(detailScreen("album", aid)); } }
function openCurrentArtist() {
  var t = null; try { t = Q.player.getTrack(); } catch (e) {}
  var tid = t && t.id, aid = currentTrackAlbumId();
  closeNP();
  function viaAlbum() { if (!aid) { qToast("No artist"); return; } albumGet(aid).then(function (al) { var ar = al.artist && al.artist.id; if (ar) go(artistScreen(ar)); else qToast("No artist page"); }).catch(function () {}); }
  // Prefer the TRACK's performer id: album.artist resolves to "Various Artists" on compilations, which made
  // the sparkle/explore button land on a useless VA page. track/get carries the real performer.
  if (tid) {
    api("track/get?track_id=" + tid).then(function (tr) {
      var pid = tr && tr.performer && tr.performer.id;
      if (pid) go(artistScreen(pid)); else viaAlbum();
    }).catch(viaAlbum);
    return;
  }
  viaAlbum();
}

// ------------------------------------------------------------------ share + go-to (M2 sheet actions)
// clipboard write with an execCommand fallback (WebView origins don't always grant navigator.clipboard).
function copyText(text) {
  return new Promise(function (res, rej) {
    function fallback() { try { var ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); res(); } catch (e) { rej(e); } }
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(res, fallback); return; } } catch (e) {}
    fallback();
  });
}
function copyShareLink(url) { copyText(url).then(function () { qToast("Link copied"); }, function () { qToast("Couldn't copy link"); }); }
// open.qobuz.com App-Links = Qobuz's verified public share deep links (teardown §17). id alone is sufficient.
var SHARE_KINDS = { album: 1, track: 1, artist: 1, playlist: 1, label: 1 };
function shareUrl(kind, id) { if (!id || !SHARE_KINDS[kind]) return ""; return "https://open.qobuz.com/" + kind + "/" + encodeURIComponent(id); }
function shareTitle(kind, obj) {
  var who = artistName(obj) || (typeof obj.artist === "string" ? obj.artist : "");   // player track carries a STRING artist
  if (kind === "track")    return (who ? who + " - " : "") + (obj.title || "");
  if (kind === "album")    return (obj.title || obj.name || "") + (who ? " by " + who : "");
  if (kind === "artist")   return obj.name || who || "";
  if (kind === "playlist") return (obj.name || obj.title || "") + (obj.owner && obj.owner.name ? " by " + obj.owner.name : "");
  return obj.title || obj.name || "";
}
// native Web Share (Android WebView) with a Qobuz open-link; clipboard+toast fallback. Call from a user gesture.
function share(kind, obj) {
  if (!obj) { qToast("Nothing to share"); return; }
  var url = shareUrl(kind, obj.id);
  if (!url) { qToast("Nothing to share"); return; }
  var title = shareTitle(kind, obj);
  if (navigator.share) {
    var p;
    try { p = navigator.share({ title: title || "Qobuz", text: title || "", url: url }); }
    catch (e) { copyShareLink(url); return; }                                        // sync throw (bad payload / no activation)
    if (p && p.catch) p.catch(function (e) {
      if (e && (e.name === "AbortError" || e.name === "NotAllowedError")) return;     // user dismissed the sheet
      copyShareLink(url);
    });
    return;
  }
  copyShareLink(url);
}
// ---- go-to helpers. Resolve ids off the object; fall back to album/get -> artist.id (openCurrentArtist path).
function resolveAlbumId(obj) {
  if (!obj) return null;
  if (obj.album && obj.album.id) return obj.album.id;   // API track object
  if (obj.albumId) return obj.albumId;                  // player track / sheet data
  return obj.id || null;                                // obj is itself an album
}
function resolveArtistId(obj) {
  if (!obj) return null;
  return (obj.performer && obj.performer.id) ||
         (obj.artist && obj.artist.id) ||
         (obj.album && obj.album.artist && obj.album.artist.id) ||
         (obj.artists && obj.artists[0] && obj.artists[0].id) || null;
}
function goToAlbum(obj) {
  var aid = resolveAlbumId(obj);
  if (!aid) { qToast("No album for this"); return; }
  closeNP();
  go(detailScreen("album", aid));
}
function goToArtist(obj) {
  if (!obj) return;
  var direct = resolveArtistId(obj);
  if (direct) { closeNP(); go(artistScreen(direct)); return; }
  if (obj.id != null && obj.name != null && !obj.album && !obj.performer && obj.title == null && obj.duration == null) {
    closeNP(); go(artistScreen(obj.id)); return;   // obj is itself an artist object
  }
  var aid = resolveAlbumId(obj);   // last resort: only an album id is known -> album/get -> main artist
  if (aid) {
    closeNP();
    albumGet(aid).then(function (al) { var ar = al.artist && al.artist.id; if (ar) go(artistScreen(ar)); else qToast("No artist page"); })
                 .catch(function () { qToast("Couldn't open artist"); });
    return;
  }
  qToast("No artist page");
}

// ------------------------------------------------------------------ sleep timer (net-new; NOT in Qobuz)
// Pauses playback after N minutes, or at the end of the current track. Qobuz's audio engine is sealed so
// there's no pause API - we click the native play/pause control, exactly like togglePlay() does.
// Self-contained: sleepTimer.start(min) | .endOfTrack() | .cancel() | .state() | .open() | .paint() | .icon.
var sleepTimer = (function () {
  var MINS = [15, 30, 45, 60, 90];
  var MOON = '<svg viewBox="0 0 24 24" fill="none"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="currentColor"/></svg>';

  var mode = null;          // null | "time" | "track"
  var chosenMin = 0;        // which preset armed (for the sheet highlight)
  var endAt = 0;            // epoch ms the time-mode timer fires
  var toId = null, tickId = null;
  var startTid = null, lastPos = 0;   // end-of-track watch state
  var toastEl = null, toastT = null;

  function nowTrackId() { try { var ct = Q.getState().player.currentTrack; return ct && ct.id != null ? ct.id : null; } catch (e) { return null; } }
  function posMs() { try { return Q.player.getPositionMs() || 0; } catch (e) { return 0; } }
  function playing() { try { return Q.player.isPlaying(); } catch (e) { return false; } }
  function curDur() { try { var t = Q.player.getTrack(); return (t && t.durationMs) || 0; } catch (e) { return 0; } }
  // Re-assert pause for ~2s instead of one shot: at a track boundary playback dips through a brief load gap
  // (playing() momentarily false, then the next track resumes), so a single guarded click gets skipped and
  // audio keeps going. Clicking whenever playing() is true across the window reliably lands the pause.
  function pauseNow() {
    var n = 0;
    (function go() {
      if (playing()) clickEl(".player__action-pause, .player__action-play");
      if (++n < 8) setTimeout(go, 250);
    })();
  }

  function remainMs() { return mode === "time" ? Math.max(0, endAt - Date.now()) : 0; }
  function fmtRemain(ms) { var s = Math.ceil(ms / 1000); return s >= 60 ? Math.ceil(s / 60) + "m" : s + "s"; }
  function label() { return mode === "time" ? fmtRemain(remainMs()) : (mode === "track" ? "track" : ""); }

  function clearAll() {
    if (toId) { clearTimeout(toId); toId = null; }
    if (tickId) { clearInterval(tickId); tickId = null; }
    endAt = 0; mode = null; chosenMin = 0; startTid = null; lastPos = 0;
  }
  function fire() { clearAll(); pauseNow(); paint(); syncSheet(); toast("Sleep timer – paused"); }

  function start(min) {
    min = Math.max(1, Math.min(1440, Math.round(min || 0)));
    clearAll(); mode = "time"; chosenMin = min; endAt = Date.now() + min * 60000;
    toId = setTimeout(fire, min * 60000);
    tickId = setInterval(onTick, 1000);
    paint(); syncSheet(); toast("Sleeping in " + min + " min");
    return state();
  }
  function endOfTrack() {
    clearAll(); mode = "track"; startTid = nowTrackId(); lastPos = posMs();
    tickId = setInterval(function () {
      var id = nowTrackId(), p = posMs(), dur = curDur();
      // Primary: stop JUST BEFORE the current track ends, so it never starts the next one (and we pause while
      // the track is still cleanly playing, avoiding the boundary load-gap that swallowed the click).
      if (id != null && startTid != null && id === startTid && dur > 0 && p >= dur - 700) { fire(); return; }
      if (id != null && startTid != null && id !== startTid) { fire(); return; }        // safety: already advanced
      if (id != null && id === startTid && lastPos - p > 3000) { fire(); return; }       // repeat-one wrap
      lastPos = p;
    }, 400);
    paint(); syncSheet(); toast("Pausing at end of track");
    return state();
  }
  function cancel() { var had = !!mode; clearAll(); paint(); syncSheet(); if (had) toast("Sleep timer off"); return state(); }
  function state() { return { mode: mode, remainMs: remainMs(), label: label() }; }

  function onTick() { if (mode === "time" && remainMs() <= 0) { fire(); return; } paint(); syncSheet(); }

  // ---- moon button in the NP actions row (live countdown pill) ----
  function paint() {
    var b = npEl && npEl.querySelector(".qz-np__sleepbtn"); if (!b) return;
    var lab = b.querySelector(".qz-np__sleeplab");
    b.classList.toggle("is-on", !!mode);
    if (lab) lab.textContent = mode ? label() : "";
  }

  // ---- bottom-sheet picker (lives inside npEl, above the NP content) ----
  function closeSheet() { var s = npEl && npEl.querySelector(".qz-sleepsheet"); if (!s) return; s.classList.remove("is-in"); setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 260); }
  function syncSheet() {
    var s = npEl && npEl.querySelector(".qz-sleepsheet"); if (!s) return;
    [].forEach.call(s.querySelectorAll(".qz-sleepopt"), function (o) { o.classList.toggle("is-on", mode === "time" && +o.getAttribute("data-min") === chosenMin); });
    var eot = s.querySelector('[data-eot="1"]'); if (eot) eot.classList.toggle("is-on", mode === "track");
    var c = s.querySelector(".qz-sleepsheet__cancel");
    if (c) { c.hidden = !mode; var sub = c.querySelector(".qz-sleepsheet__sub"); if (sub) sub.textContent = mode === "time" ? label() + " left" : (mode === "track" ? "at track end" : ""); }
  }
  function openSheet() {
    if (!npEl) return;
    if (npEl.querySelector(".qz-sleepsheet")) { closeSheet(); return; }   // toggle
    var html = '<div class="qz-sleepsheet">' +
      '<div class="qz-sleepsheet__scrim"></div>' +
      '<div class="qz-sleepsheet__panel">' +
      '<div class="qz-sleepsheet__grip"></div>' +
      '<h4 class="qz-sleepsheet__h">Sleep timer</h4>' +
      '<div class="qz-sleepsheet__grid">' +
      MINS.map(function (m) { return '<button class="qz-sleepopt" data-min="' + m + '">' + m + '<span>min</span></button>'; }).join("") +
      '</div>' +
      '<button class="qz-sleepsheet__row" data-eot="1"><span>End of track</span><span class="qz-sleepsheet__chev"></span></button>' +
      '<button class="qz-sleepsheet__row qz-sleepsheet__cancel" hidden><span>Turn off timer</span><span class="qz-sleepsheet__sub"></span></button>' +
      '</div></div>';
    var el = h(html);
    el.querySelector(".qz-sleepsheet__scrim").addEventListener("click", closeSheet);
    [].forEach.call(el.querySelectorAll(".qz-sleepopt"), function (o) { o.addEventListener("click", function () { start(+o.getAttribute("data-min")); closeSheet(); }); });
    el.querySelector('[data-eot="1"]').addEventListener("click", function () { endOfTrack(); closeSheet(); });
    el.querySelector(".qz-sleepsheet__cancel").addEventListener("click", function () { cancel(); });
    // isolate the sheet from NP's swipe-down-dismiss / edge-back gestures
    el.addEventListener("touchstart", function (ev) { ev.stopPropagation(); }, { passive: true });
    el.addEventListener("touchmove", function (ev) { ev.stopPropagation(); }, { passive: true });
    npEl.appendChild(el);
    syncSheet();
    requestAnimationFrame(function () { el.classList.add("is-in"); });
  }

  // ---- tiny self-contained toast; floats above nav/mini, over NP ----
  function toast(msg) {
    var host = document.getElementById(ROOT_ID); if (!host) return;
    if (!toastEl || !toastEl.parentNode) { toastEl = h('<div class="qz-sleeptoast"></div>'); host.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add("is-show");
    clearTimeout(toastT); toastT = setTimeout(function () { if (toastEl) toastEl.classList.remove("is-show"); }, 2200);
  }

  return { icon: MOON, start: start, endOfTrack: endOfTrack, cancel: cancel, state: state, open: openSheet, paint: paint };
})();

// ------------------------------------------------------------------ build DOM
function buildShell() {
  root = h('<div id="' + ROOT_ID + '"></div>');

  headerEl = h(
    '<header class="qz-hd">' +
    '<button class="qz-hd__back" aria-label="Back">' + IC.back + "</button>" +
    '<h1 class="qz-hd__title"></h1></header>');
  headerEl.querySelector(".qz-hd__back").addEventListener("click", back);

  contentEl = h('<main class="qz-content"></main>');
  contentEl.addEventListener("click", onContentTap);
  bindEdgeBack(contentEl);   // left-edge swipe -> back

  miniEl = h(
    '<div class="qz-mini"><div class="qz-mini__bar"><i></i></div>' +
    '<button class="qz-mini__open"><span class="qz-mini__art"></span>' +
    '<span class="qz-mini__meta"><span class="qz-mini__t"></span><span class="qz-mini__s"></span></span></button>' +
    '<button class="qz-mini__pp" aria-label="Play/pause">' + IC.play + "</button>" +
    '<button class="qz-mini__nx" aria-label="Next">' + IC.next + "</button></div>");
  miniEl.querySelector(".qz-mini__open").addEventListener("click", openNP);
  miniEl.querySelector(".qz-mini__pp").addEventListener("click", function (e) { e.stopPropagation(); togglePlay(); setTimeout(function () { renderTransport(true); }, 120); });
  miniEl.querySelector(".qz-mini__nx").addEventListener("click", function (e) { e.stopPropagation(); playNext(); });

  navEl = h('<nav class="qz-nav"></nav>');
  TABS.forEach(function (t) {
    var b = h('<button class="qz-nav__tab" data-tab="' + t.id + '"><span class="qz-nav__ic">' + t.icon + '</span><span class="qz-nav__lbl">' + t.label + "</span></button>");
    b.addEventListener("click", function () { setTab(t.id); });
    navEl.appendChild(b);
  });

  // Beta layout: drag handle, large art, device pill, title+artist row (like/more), quality chip,
  // progress + time, transport (shuffle | prev | BIG play | next | repeat), bottom actions, lyrics panel.
  npEl = h(
    '<div class="qz-np">' +
    '<button class="qz-np__close" aria-label="Close">' + IC.down + "</button>" +
    '<div class="qz-np__art"></div>' +
    '<button class="qz-np__device"><span class="qz-np__device-ic">' + IC.laptop + '</span><span class="qz-np__device-lbl">' + esc(window.__QZ_DEVICE_NAME__ || "Qobuzify Mobile") + '</span></button>' +
    '<div class="qz-np__titlerow">' +
    '<div class="qz-np__titles"><div class="qz-np__t"></div><div class="qz-np__s"></div></div>' +
    '<button class="qz-np__like" aria-label="Favorite">' + IC.heart + "</button>" +
    '<button class="qz-np__more" aria-label="More">' + IC.more + "</button></div>" +
    '<button class="qz-np__q" hidden aria-haspopup="menu"></button>' +
    '<div class="qz-np__bar"><i></i></div>' +
    '<div class="qz-np__time"><span class="qz-np__cur">0:00</span><span class="qz-np__dur">0:00</span></div>' +
    '<div class="qz-np__ctl">' +
    '<button class="qz-np__sh" aria-label="Shuffle">' + IC.shuffle + "</button>" +
    '<button class="qz-np__pv" aria-label="Previous">' + IC.prev + "</button>" +
    '<button class="qz-np__pp qz-np__pp--big" aria-label="Play/pause">' + IC.play + "</button>" +
    '<button class="qz-np__nx" aria-label="Next">' + IC.next + "</button>" +
    '<button class="qz-np__rp" aria-label="Repeat">' + IC.repeat + "</button></div>" +
    '<div class="qz-np__actions">' +
    '<button class="qz-np__act qz-np__sleepbtn" data-np="sleep" aria-label="Sleep timer">' + sleepTimer.icon + '<span class="qz-np__sleeplab"></span></button>' +
    '<button class="qz-np__act qz-np__act--queue" data-np="queue" aria-label="Queue">' + IC.queue + "</button>" +
    '<button class="qz-np__act" data-np="radio" aria-label="Start radio">' + RADIO_IC + "</button>" +
    '<button class="qz-np__act" data-np="sparkle" aria-label="Artist">' + IC.sparkle + "</button>" +
    '<button class="qz-np__act" data-np="info" aria-label="Info">' + IC.info + "</button>" +
    '<button class="qz-np__act qz-np__act--lyrics" data-np="lyrics" aria-label="Lyrics">' + IC.lyrics + "</button></div>" +
    '<div class="qz-ly">' +
      '<button class="qz-ly__tr-toggle" type="button" aria-pressed="false" aria-label="Translation" hidden>' + LY_TR_IC + '<span class="qz-ly__tr-lab">Translation</span></button>' +
      '<div class="qz-ly__body"></div>' +
      '<button class="qz-ly__recenter" type="button" aria-label="Recenter lyrics">' + LY_RECENTER_IC + '<span>Recenter</span></button>' +
    '</div>' +
    '<div class="qz-queue"><div class="qz-queue__head">Queue</div><div class="qz-queue__body"></div></div>' +
    "</div>");
  npEl.querySelector(".qz-np__close").addEventListener("click", function () {
    if (qState.open) closeQueue();
    else if (lyState.open) closeLyrics();
    else closeNP();
  });
  npEl.querySelector(".qz-np__pv").addEventListener("click", function () { playPrev(); setTimeout(function () { renderTransport(true); }, 150); });
  npEl.querySelector(".qz-np__pp").addEventListener("click", function () { togglePlay(); setTimeout(function () { renderTransport(true); }, 120); });
  npEl.querySelector(".qz-np__nx").addEventListener("click", function () { playNext(); setTimeout(function () { renderTransport(true); }, 150); });
  npEl.querySelector(".qz-np__sh").addEventListener("click", function () { clickEl(".pct-shuffle, .player__action-shuffle"); });
  npEl.querySelector(".qz-np__rp").addEventListener("click", function () { clickEl(".pct-repeat, .player__action-repeat"); });
  npEl.querySelector(".qz-np__like").addEventListener("click", function () { clickEl(".player .ButtonFavorite, .player__action-favorite"); });
  npEl.querySelector(".qz-np__more").addEventListener("click", openCurrentTrackSheet);   // NP kebab -> current-track options sheet
  npEl.querySelector(".qz-np__act--lyrics").addEventListener("click", function () { lyState.open ? closeLyrics() : openLyrics(); });
  npEl.querySelector('.qz-np__act[data-np="info"]').addEventListener("click", openCurrentAlbum);      // info -> current album
  npEl.querySelector('.qz-np__act[data-np="sparkle"]').addEventListener("click", openCurrentArtist);  // sparkle -> current artist (explore)
  npEl.querySelector(".qz-np__act--queue").addEventListener("click", function () { qState.open ? closeQueue() : openQueue(); });
  npEl.querySelector('.qz-np__act[data-np="radio"]').addEventListener("click", startRadioCurrent);     // radio -> seeded queue off the current track
  npEl.querySelector(".qz-np__sleepbtn").addEventListener("click", function () { sleepTimer.open(); }); // sleep timer picker
  npEl.querySelector(".qz-np__q").addEventListener("click", openQMenu);                                 // quality chip -> tier picker
  lyBody = npEl.querySelector(".qz-ly__body");
  qBody = npEl.querySelector(".qz-queue__body");
  // M1 FIX: bind queue tap-to-jump here (per mount) so a fresh qBody always rebinds. Only upcoming rows jump;
  // current + autoplay rows are inert (data-qtap !== "1").
  if (qBody && !qBody.__qzBound) {
    qBody.__qzBound = 1;
    qBody.addEventListener("click", function (e) {
      var row = e.target.closest ? e.target.closest(".qz-queue__row") : null; if (!row) return;
      if (row.getAttribute("data-qtap") !== "1") return;
      var idx = parseInt(row.getAttribute("data-qorder"), 10); if (isNaN(idx)) return;
      flashTap(row); queueJumpTo(idx);
    });
  }
  // ignore our OWN smooth-scroll; real gestures (wheel/drag) always count as a manual hold
  lyBody.addEventListener("scroll", function () { if (Date.now() < lyState.selfScrollUntil) return; lyHold(); });
  lyBody.addEventListener("wheel", lyHold, { passive: true });
  lyBody.addEventListener("touchmove", lyHold, { passive: true });
  lyBody.parentNode.querySelector(".qz-ly__tr-toggle").addEventListener("click", lyToggleTr);
  lyBody.parentNode.querySelector(".qz-ly__recenter").addEventListener("click", lyRecenter);
  bindSeek(npEl.querySelector(".qz-np__bar"));
  bindSwipeDown(npEl);   // swipe down to dismiss Now Playing

  // headerEl is NOT appended here - render() inserts it only on pushed screens (see the note there),
  // so root screens have no header layer at all.
  root.appendChild(contentEl);
  root.appendChild(miniEl);
  root.appendChild(navEl);
  root.appendChild(npEl);
  sleepTimer.paint();   // restore the armed countdown label if a timer is already running on (re)build
  return root;
}

// ------------------------------------------------------------------ CSS (dark, Electric-Blue, never white)
var CSS = `
/* Qobuz Sans (extracted from the beta APK, served as same-origin assets by MainActivity) */
@font-face{font-family:"Qobuz Sans";font-weight:400;font-style:normal;font-display:swap;src:url("/__qobuzify__/fonts/QobuzSans-Regular.ttf") format("truetype")}
@font-face{font-family:"Qobuz Sans";font-weight:500;font-style:normal;font-display:swap;src:url("/__qobuzify__/fonts/QobuzSans-Medium.ttf") format("truetype")}
@font-face{font-family:"Qobuz Sans";font-weight:600;font-style:normal;font-display:swap;src:url("/__qobuzify__/fonts/QobuzSans-SemiBold.ttf") format("truetype")}
@font-face{font-family:"Qobuz Sans";font-weight:700;font-style:normal;font-display:swap;src:url("/__qobuzify__/fonts/QobuzSans-Bold.ttf") format("truetype")}

/* ============================================================================
   QOBUZIFY MOBILE — Qobuz 9.11 beta rebuild
   Drop-in replacement for the 'CSS' template literal in extensions/mobile-app/index.js.
   PREPEND the 4 @font-face rules from qobuz-ui/fontface-embedded.css above this block
   (family "Qobuz Sans", weights 400/500/600/700, base64 TTF from the APK).
   Every value below is measured off beta-01.png or read from the APK resource table.
   ============================================================================ */

/* ---- token layer (fill these; they mirror the beta design system) ---- */
#qz-app-root{
  /* type */
  --qz-font:"Qobuz Sans",-apple-system,system-ui,"Segoe UI",Roboto,sans-serif;
  /* neutral base under the tint (Qobuz dark theme ~ near-black) */
  --qz-base:#0a0a0c;
  /* DYNAMIC album tint — JS (tint.js) overwrites these per track; these are the neutral fallback */
  --qz-tint-top:#17171a; --qz-tint-mid:#101013; --qz-tint-bot:#0a0a0c;
  /* content over the tint (APK: primary #fff, secondary #b3ffffff=70%, disabled #4dffffff=30%) */
  --qz-c1:#ffffff;                 /* primary text + active icons     */
  --qz-c2:rgba(255,255,255,.70);   /* secondary text (artist, labels) */
  --qz-c3:rgba(255,255,255,.50);   /* tertiary (time, captions)       */
  --qz-c-dim:rgba(255,255,255,.34);/* inactive icons / disabled       */
  /* translucent surfaces that let the tint show through */
  --qz-fill-1:rgba(255,255,255,.08);   /* chips, cards, fields        */
  --qz-fill-2:rgba(255,255,255,.14);   /* pressed / raised            */
  --qz-track:rgba(255,255,255,.24);    /* progress unfilled (#6e6e5c over tint) */
  --qz-hairline:rgba(255,255,255,.08);
  /* brand (APK colors_all.txt): gold brand_100 #dea442, hi-res #d17e00.
     The beta uses WHITE for player controls and gold only for hi-res/active accents. */
  --qz-brand:#dea442;
  --qz-hires:#d17e00;
  /* radii (measured art ~16px; APK Material large shape = 16dp; chip m3_chip = 8dp) */
  --qz-r-art:16px; --qz-r-card:12px; --qz-r-chip:999px; --qz-r-field:14px; --qz-r-sheet:22px;
  /* transport glyph sizes (measured play 83px, skip 62px, shuffle/repeat 44px -> scaled) */
  --qz-play:34px; --qz-skip:26px; --qz-shuf:22px;
  /* chrome heights */
  --nav-h:60px; --mini-h:62px;
  --safe-t:env(safe-area-inset-top,0px); --safe-b:env(safe-area-inset-bottom,0px);
}

html.qz-app, html.qz-app body{ overflow:hidden !important; }
html.qz-app .NavBar, html.qz-app .container-fluid, html.qz-app .player,
html.qz-app .grid-layout--root > *:not(#qz-app-root){ visibility:hidden !important; }
/* The Qobuzify RUNTIME paints a "Qobuzify" wordmark as a base64-SVG background-image on
   .NavBar__brand.icon-brand-medium. The .NavBar visibility:hidden above hides it by inheritance,
   but that's defeatable (any child visibility:visible, or a separate stacking context, re-shows it) -
   so while WE own the screen, remove the wordmark from layout outright. display:none can't be
   overridden by a descendant the way visibility can. Scoped to html.qz-app; desktop is untouched. */
html.qz-app .NavBar__brand{ display:none !important; }

#qz-app-root{
  position:fixed; inset:0; z-index:2147483000; visibility:visible !important;
  display:flex; flex-direction:column; overflow:hidden;
  color:var(--qz-c1); font-family:var(--qz-font);
  -webkit-tap-highlight-color:transparent;
  /* SIGNATURE: album-tinted global wash (the beta's globalGradientBackground) */
  background:
    linear-gradient(180deg, var(--qz-tint-top) 0%, var(--qz-tint-mid) 42%, var(--qz-tint-bot) 100%),
    var(--qz-base);
  transition:background .6s ease;   /* smooth cross-fade when the cover changes */
}
#qz-app-root *{ box-sizing:border-box; }
#qz-app-root button{ font:inherit; color:inherit; border:0; background:none; cursor:pointer; }
#qz-app-root img{ width:100%; height:100%; object-fit:cover; display:block; }
#qz-app-root .qz-ph{ width:100%; height:100%; display:flex; align-items:center; justify-content:center; color:rgba(255,255,255,.22); }
#qz-app-root .qz-ph svg{ width:38%; height:38%; }

/* header — transparent so the tint reads through; no more solid bar/blur */
.qz-hd{ display:flex; align-items:center; gap:8px; height:calc(52px + var(--safe-t)); padding:var(--safe-t) 12px 0; flex:0 0 auto; background:transparent; }
.qz-hd__back{ width:36px; height:36px; margin-left:-6px; display:flex; align-items:center; justify-content:center; border-radius:50%; color:var(--qz-c1); }
.qz-hd__back svg{ width:24px; height:24px; }
.qz-hd__back:active{ background:var(--qz-fill-1); }
.qz-hd__title{ font-size:20px; font-weight:700; letter-spacing:-.2px; margin:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

/* scroll area */
.qz-content{ flex:1 1 auto; overflow-y:auto; overflow-x:hidden; -webkit-overflow-scrolling:touch;
  padding:8px 0 calc(var(--nav-h) + var(--safe-b) + 12px); }
/* Touch UI: no visible scrollbars anywhere in the app (the WebView otherwise draws a thick opaque classic
   bar on the main content scroller that overlaps content). Global so no current/future scroller is missed. */
#qz-app-root *{ scrollbar-width:none; -ms-overflow-style:none; }
#qz-app-root ::-webkit-scrollbar{ width:0 !important; height:0 !important; background:transparent; }
html.qz-has-track .qz-content{ padding-bottom:calc(var(--nav-h) + var(--mini-h) + var(--safe-b) + 12px); }
.qz-empty{ color:var(--qz-c2); text-align:center; padding:44px 24px; font-size:14px; }
.qz-load{ display:flex; justify-content:center; padding:48px 0; }
.qz-spin{ width:26px; height:26px; border-radius:50%; border:2.5px solid var(--qz-fill-2); border-top-color:var(--qz-c1); animation:qzspin .8s linear infinite; }
@keyframes qzspin{ to{ transform:rotate(360deg); } }

/* shelves + cards */
.qz-shelf, .qz-sec{ margin:6px 0 24px; }
.qz-shelf__h{ font-size:17px; font-weight:700; margin:0 0 12px; padding:0 16px; letter-spacing:-.2px; color:var(--qz-c1); }
.qz-ovh{ display:flex; align-items:baseline; justify-content:space-between; gap:12px; padding:0 16px; margin:0 0 12px; }
.qz-ovh .qz-shelf__h{ margin:0; padding:0; }
.qz-ovmore{ flex:0 0 auto; background:none; color:var(--qz-brand); font-size:13px; font-weight:600; padding:2px 0; }
.qz-ovmore:active{ opacity:.6; }
/* Library has 5 tabs -> let the seg bar scroll horizontally instead of clipping labels on narrow phones */
.qz-libsegs{ overflow-x:auto; scrollbar-width:none; -webkit-overflow-scrolling:touch; }
.qz-libsegs::-webkit-scrollbar{ display:none; }
.qz-libsegs .qz-seg{ flex:0 0 auto; padding:0 14px; }
.qz-shelf__row{ display:flex; gap:14px; overflow-x:auto; overflow-y:hidden; -webkit-overflow-scrolling:touch; scroll-snap-type:x proximity; padding:0 16px; }
.qz-shelf__row::-webkit-scrollbar{ display:none; }
.qz-shelf__row .qz-card{ flex:0 0 42vw; max-width:180px; scroll-snap-align:start; }
.qz-grid{ display:grid; grid-template-columns:1fr 1fr; gap:18px 14px; padding:4px 16px; }
.qz-card{ display:flex; flex-direction:column; text-align:left; width:100%; }
.qz-card__art{ width:100%; aspect-ratio:1/1; border-radius:var(--qz-r-card); overflow:hidden; background:var(--qz-fill-1); box-shadow:0 8px 22px -12px rgba(0,0,0,.7); }
.qz-card--round .qz-card__art{ border-radius:50%; }
.qz-card--round{ align-items:center; text-align:center; }
.qz-card__name{ font-size:14px; font-weight:600; margin-top:9px; line-height:1.25; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; color:var(--qz-c1); }
.qz-card__sub{ font-size:12.5px; color:var(--qz-c2); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.qz-card:active{ opacity:.62; }

/* track rows */
.qz-tlist{ padding:0 8px; }
.qz-trow{ display:flex; align-items:center; gap:12px; width:100%; text-align:left; padding:8px 8px; border-radius:12px; }
.qz-trow:active{ background:var(--qz-fill-1); }
.qz-trow.is-loading{ opacity:.5; }
.qz-trow__art{ position:relative; width:48px; height:48px; flex:0 0 auto; border-radius:8px; overflow:hidden; background:var(--qz-fill-1); }
.qz-trow__play{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.4); opacity:0; transition:opacity .12s; }
.qz-trow__play svg{ width:20px; height:20px; color:#fff; }
.qz-trow:active .qz-trow__play{ opacity:1; }
.qz-trow__meta{ flex:1 1 auto; min-width:0; }
.qz-trow__t{ display:block; font-size:14.5px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--qz-c1); }
.qz-trow__s{ display:block; font-size:12.5px; color:var(--qz-c2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.qz-trow__d{ flex:0 0 auto; font-size:12px; color:var(--qz-c3); font-variant-numeric:tabular-nums; }
/* Namespace collision with the Qobuzify RUNTIME base theme (<style id="qobuzify-ui">, used by the settings/
   extensions modal): it defines a generic .qz-card (background + border + border-radius:14px + overflow:hidden)
   and .qz-grid that share our class names and leak in for the properties our own same-named rules don't set.
   The runtime .qz-card's rounded + overflow-hidden bottom corner was shaving the bottom-left of the first
   letter of any title/subtitle that reached the card's bottom edge. Re-assert both under our root (higher
   specificity) so ONLY mobile-app styling applies. (The runtime's ::-webkit-scrollbar is likewise overridden
   above.) The qz- namespace is shared, so new mobile-app class names must avoid the runtime's set. */
#qz-app-root .qz-card{ background:none; border:0; border-radius:0; overflow:visible; transition:none; }
#qz-app-root .qz-grid{ grid-template-columns:1fr 1fr; gap:18px 14px; }

/* search */
.qz-searchbar{ position:relative; margin:2px 16px 16px; display:flex; align-items:center; }
.qz-searchbar__ic{ position:absolute; left:14px; width:18px; height:18px; color:var(--qz-c2); pointer-events:none; }
.qz-searchbar__ic svg{ width:100%; height:100%; }
.qz-searchbar__in{ width:100%; height:44px; border-radius:var(--qz-r-field); background:var(--qz-fill-1); color:var(--qz-c1); padding:0 14px 0 40px; font-size:15px; font-family:var(--qz-font); outline:none; border:1px solid transparent; }
.qz-searchbar__in::placeholder{ color:var(--qz-c3); }
.qz-searchbar__in:focus{ background:var(--qz-fill-2); border-color:var(--qz-hairline); }
.qz-results:empty{ min-height:20px; }

/* ---- search: facet tabs (M4) ---------------------------------------------- */
.qz-facets{ margin-top:-2px; }
.qz-facets[hidden]{ display:none; }
.qz-seg__n{ margin-left:6px; font-size:11px; font-weight:700; opacity:.55; font-variant-numeric:tabular-nums; }
.qz-seg.is-on .qz-seg__n{ opacity:.65; }
.qz-seg--empty{ opacity:.4; }
.qz-seg--empty.is-on{ opacity:1; }

/* ---- search: "Top result" hero (M4) --------------------------------------- */
#qz-app-root .qz-topres{ display:flex; align-items:center; gap:14px; width:calc(100% - 32px); margin:0 16px; padding:10px;
  border-radius:var(--qz-r-card); background:var(--qz-fill-1); text-align:left; }
#qz-app-root .qz-topres:active{ background:var(--qz-fill-2); }
.qz-topres__art{ width:64px; height:64px; flex:0 0 auto; border-radius:10px; overflow:hidden; background:var(--qz-fill-1); }
.qz-topres--round .qz-topres__art{ border-radius:50%; }
.qz-topres__meta{ flex:1 1 auto; min-width:0; }
.qz-topres__t{ display:block; font-size:16px; font-weight:700; letter-spacing:-.2px; color:var(--qz-c1);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.qz-topres__s{ display:block; margin-top:3px; font-size:12.5px; color:var(--qz-c2);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

/* ---- search: recent history (M4) ------------------------------------------ */
.qz-hx__head{ display:flex; align-items:baseline; justify-content:space-between; padding:0 16px; margin-bottom:4px; }
.qz-hx__head .qz-shelf__h{ margin:0; padding:0; }
.qz-hx__clear{ font-size:13px; font-weight:600; color:var(--qz-c2); padding:4px 2px; }
.qz-hx__clear:active{ opacity:.55; }
.qz-hx__list{ display:flex; flex-direction:column; }
.qz-hx__row{ display:flex; align-items:center; gap:12px; padding:10px 16px; }
.qz-hx__row:active{ background:var(--qz-fill-1); }
.qz-hx__ic{ width:20px; height:20px; flex:0 0 auto; color:var(--qz-c3); }
.qz-hx__ic svg{ width:100%; height:100%; }
.qz-hx__q{ flex:1 1 auto; min-width:0; font-size:15px; color:var(--qz-c1);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.qz-hx__del{ flex:0 0 auto; width:30px; height:30px; display:flex; align-items:center; justify-content:center;
  color:var(--qz-c3); margin-right:-6px; }
.qz-hx__del svg{ width:16px; height:16px; }
.qz-hx__del:active{ opacity:.5; }

/* ---- search: empty / prompt state (M4) ------------------------------------ */
.qz-nores{ display:flex; flex-direction:column; align-items:center; text-align:center; padding:64px 32px; }
.qz-nores__ic{ width:40px; height:40px; color:var(--qz-c3); opacity:.6; margin-bottom:14px; }
.qz-nores__ic svg{ width:100%; height:100%; }
.qz-nores__t{ font-size:16px; font-weight:700; color:var(--qz-c1); margin:0 0 6px; }
.qz-nores__s{ font-size:13.5px; color:var(--qz-c2); margin:0; max-width:260px; line-height:1.45; }

/* library segmented control — pill tabs */
.qz-segbar{ display:flex; gap:8px; padding:0 16px 16px; }
.qz-seg{ flex:1; height:36px; border-radius:var(--qz-r-chip); background:var(--qz-fill-1); color:var(--qz-c2); font-size:13.5px; font-weight:600; }
.qz-seg.is-on{ background:var(--qz-c1); color:#111; }
/* the #qz-app-root button{background:none} reset out-specifies the unprefixed .qz-seg fills above; re-assert
   the pill fills with an #qz-app-root prefix so Library / Discover sub-tabs / Search facets all render filled. */
#qz-app-root .qz-seg{ background:var(--qz-fill-1); }
#qz-app-root .qz-seg.is-on{ background:var(--qz-c1); color:#111; }

/* Discover [M4] — reuses .qz-segbar/.qz-seg; sub-tab bar sits at the very top of the scroll area */
.qz-dsegbar{ padding-top:4px; }
/* skeleton rails (first paint) */
.qz-shelf--skel .qz-skln{ position:relative; overflow:hidden; width:150px; height:15px; margin-bottom:14px; border-radius:6px; background:var(--qz-fill-1); }
.qz-skcard{ flex:0 0 42vw; max-width:180px; }
.qz-sk{ position:relative; overflow:hidden; background:var(--qz-fill-1); }
.qz-sk::after, .qz-shelf--skel .qz-skln::after{ content:""; position:absolute; inset:0; transform:translateX(-100%);
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.09),transparent); animation:qzsh 1.2s infinite; }
@keyframes qzsh{ 100%{ transform:translateX(100%); } }

/* detail header */
.qz-dhead{ display:flex; flex-direction:column; align-items:center; text-align:center; padding:8px 20px 20px; }
.qz-dhead__art{ width:58vw; max-width:280px; aspect-ratio:1/1; border-radius:var(--qz-r-art); overflow:hidden; background:var(--qz-fill-1); box-shadow:0 22px 48px -20px rgba(0,0,0,.85); }
.qz-dhead__art--round{ border-radius:50%; }
.qz-dhead__t{ font-size:23px; font-weight:700; margin-top:18px; letter-spacing:-.4px; color:var(--qz-c1); }
.qz-dhead__s{ font-size:13.5px; color:var(--qz-c2); margin-top:6px; }
.qz-dhead__play{ margin-top:18px; height:46px; padding:0 28px; border-radius:var(--qz-r-chip); background:var(--qz-c1); color:#111; font-weight:700; font-size:15px; display:inline-flex; align-items:center; gap:8px; }
.qz-dhead__play svg{ width:20px; height:20px; }
.qz-dhead__play.is-loading{ opacity:.6; }
.qz-dhead__play:active{ transform:scale(.97); }

/* mini player — floating pill, translucent over the tint */
.qz-mini{ position:absolute; left:8px; right:8px; bottom:calc(var(--nav-h) + var(--safe-b)); height:var(--mini-h);
  display:none; align-items:center; gap:10px; padding:0 8px; border-radius:16px;
  background:rgba(255,255,255,.10); backdrop-filter:blur(24px) saturate(1.4); -webkit-backdrop-filter:blur(24px) saturate(1.4);
  box-shadow:0 10px 30px -12px rgba(0,0,0,.7); border:1px solid var(--qz-hairline); overflow:hidden; z-index:4; }
html.qz-has-track .qz-mini{ display:flex; }
.qz-mini__bar{ position:absolute; top:0; left:0; right:0; height:2px; background:var(--qz-track); }
.qz-mini__bar > i{ display:block; height:100%; width:0; background:var(--qz-c1); }
.qz-mini__open{ flex:1 1 auto; min-width:0; display:flex; align-items:center; gap:10px; text-align:left; }
.qz-mini__art{ width:46px; height:46px; flex:0 0 auto; border-radius:9px; overflow:hidden; background:var(--qz-fill-1); }
.qz-mini__meta{ min-width:0; }
.qz-mini__t{ display:block; font-size:13.5px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--qz-c1); }
.qz-mini__s{ display:block; font-size:12px; color:var(--qz-c2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.qz-mini__pp, .qz-mini__nx{ width:42px; height:42px; flex:0 0 auto; display:flex; align-items:center; justify-content:center; color:var(--qz-c1); }
.qz-mini__pp svg{ width:26px; height:26px; } .qz-mini__nx svg{ width:24px; height:24px; }
.qz-mini__pp:active, .qz-mini__nx:active{ opacity:.6; }

/* bottom tab bar — transparent, minimal, white active (beta uses no colored fill) */
.qz-nav{ position:absolute; left:0; right:0; bottom:0; height:calc(var(--nav-h) + var(--safe-b)); padding-bottom:var(--safe-b);
  display:flex; align-items:stretch; z-index:5;
  background:linear-gradient(180deg, transparent, rgba(0,0,0,.28)); border-top:1px solid var(--qz-hairline);
  backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px); }
.qz-nav__tab{ flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; color:var(--qz-c-dim); font-size:11px; font-weight:600; }
.qz-nav__ic{ width:25px; height:25px; } .qz-nav__ic svg{ width:100%; height:100%; }
.qz-nav__tab.is-on{ color:var(--qz-c1); }
.qz-nav__tab:active{ transform:translateY(1px); }

/* ============================ NOW PLAYING ============================ */
/* full-screen sheet washed with the SAME album tint (a shade stronger at the top). */
.qz-np{ position:absolute; inset:0; z-index:20; display:flex; flex-direction:column;
  padding:calc(var(--safe-t) + 10px) 16px calc(var(--safe-b) + 18px);
  background:
    linear-gradient(180deg, var(--qz-tint-top) 0%, var(--qz-tint-mid) 46%, var(--qz-tint-bot) 100%),
    var(--qz-base);
  transform:translateY(100%); transition:transform .34s cubic-bezier(.22,.61,.36,1), background .6s ease; pointer-events:none; }
.qz-np.is-open{ transform:translateY(0); pointer-events:auto; }

/* drag handle (replaces the chevron; centered pill) */
.qz-np__close{ align-self:center; width:40px; height:20px; display:flex; align-items:center; justify-content:center; margin:2px 0 6px; }
.qz-np__close svg{ display:none; }
.qz-np__close::before{ content:""; width:36px; height:5px; border-radius:3px; background:var(--qz-c-dim); }

/* album art — large, ~92% width, gently rounded */
.qz-np__art{ width:100%; aspect-ratio:1/1; border-radius:var(--qz-r-art); overflow:hidden;
  background:var(--qz-fill-1); box-shadow:0 34px 70px -28px rgba(0,0,0,.9); margin:2vh 0 auto; }

/* device pill — beta "Web Player" chip, left-aligned */
.qz-np__device{ align-self:flex-start; display:inline-flex; align-items:center; gap:8px; height:36px; padding:0 16px;
  margin-top:22px; border-radius:var(--qz-r-chip); background:var(--qz-fill-1); color:var(--qz-c1); font-size:14px; font-weight:600; }
.qz-np__device-ic{ width:19px; height:19px; display:flex; } .qz-np__device-ic svg{ width:100%; height:100%; }
.qz-np__device:active{ background:var(--qz-fill-2); }

/* title + artist (left) with like + more (right) */
.qz-np__titlerow{ display:flex; align-items:center; gap:12px; width:100%; margin-top:20px; }
.qz-np__titles{ flex:1 1 auto; min-width:0; }
.qz-np__t{ font-size:26px; font-weight:700; letter-spacing:-.4px; line-height:1.12; color:var(--qz-c1); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.qz-np__s{ font-size:15px; font-weight:500; color:var(--qz-c2); margin-top:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.qz-np__like, .qz-np__more{ flex:0 0 auto; width:34px; height:34px; display:flex; align-items:center; justify-content:center; color:var(--qz-c1); }
.qz-np__like svg{ width:26px; height:26px; } .qz-np__more svg{ width:24px; height:24px; }
.qz-np__like.is-on{ color:var(--qz-brand); } .qz-np__like:active, .qz-np__more:active{ opacity:.6; }

/* progress bar */
.qz-np__bar{ position:relative; width:100%; height:5px; border-radius:3px; background:var(--qz-track); margin-top:22px; overflow:visible; touch-action:none; cursor:pointer; }
.qz-np__bar > i{ position:relative; display:block; height:100%; width:0; background:var(--qz-c1); border-radius:3px; }
.qz-np__bar::before{ content:""; position:absolute; left:0; right:0; top:-16px; bottom:-16px; }
.qz-np__bar.is-seeking{ height:7px; }
.qz-np__bar.is-seeking > i::after{ content:""; position:absolute; right:-7px; top:50%; width:14px; height:14px; border-radius:50%; background:var(--qz-c1); transform:translateY(-50%); box-shadow:0 0 10px -1px rgba(0,0,0,.5); }
.qz-np__time{ width:100%; display:flex; justify-content:space-between; margin-top:9px; font-size:12px; color:var(--qz-c3); font-variant-numeric:tabular-nums; }

/* transport — BARE white glyphs (no disc), play is largest. shuffle/repeat are secondary */
.qz-np__ctl{ display:flex; align-items:center; justify-content:space-between; width:100%; padding:0 6px; margin-top:22px; }
.qz-np__ctl button{ display:flex; align-items:center; justify-content:center; color:var(--qz-c1); }
.qz-np__sh, .qz-np__rp{ color:var(--qz-c2); }               /* dimmer secondary controls */
.qz-np__sh svg, .qz-np__rp svg{ width:var(--qz-shuf); height:var(--qz-shuf); }
.qz-np__sh.is-on, .qz-np__rp.is-on{ color:var(--qz-brand); }
.qz-np__pv svg, .qz-np__nx svg{ width:var(--qz-skip); height:var(--qz-skip); }
.qz-np__pp--big{ width:auto; height:auto; background:none; border-radius:0; color:var(--qz-c1); }
.qz-np__pp--big svg{ width:var(--qz-play); height:var(--qz-play); }
.qz-np__ctl button:active{ opacity:.6; transform:scale(.94); }

/* bottom action row — sparkle | info | queue */
.qz-np__actions{ display:flex; align-items:center; justify-content:space-between; width:100%; padding:0 28px; margin-top:24px; }
.qz-np__act{ width:34px; height:34px; display:flex; align-items:center; justify-content:center; color:var(--qz-c2); }
/* Settings > Features toggles: hide a player button live (no reload) */
html.qz-hide-lyrics .qz-np__act--lyrics{ display:none; }
html.qz-hide-sleep .qz-np__sleepbtn{ display:none; }
html.qz-hide-radio .qz-np__act[data-np="radio"]{ display:none; }
html.qz-hide-quality .qz-np__q{ display:none !important; }
.qz-np__act svg{ width:25px; height:25px; }
.qz-np__act:active{ opacity:.6; } .qz-np--lyrics .qz-np__act--lyrics{ color:var(--qz-c1); }

/* quality chip (kept; restyle to translucent, gold when hi-res) */
.qz-np__q{ align-self:flex-start; margin-top:12px; display:inline-flex; align-items:center; padding:5px 12px; border-radius:var(--qz-r-chip); font-size:12px; font-weight:600; letter-spacing:.2px; color:var(--qz-c1); background:var(--qz-fill-1); font-variant-numeric:tabular-nums; }
.qz-np__q[hidden]{ display:none; }
.qz-q{ display:inline-block; margin-left:8px; padding:1px 6px; border-radius:5px; font-size:10px; font-weight:700; letter-spacing:.3px; vertical-align:middle; }
.qz-q--hr{ color:var(--qz-hires); background:rgba(209,126,0,.16); border:1px solid rgba(209,126,0,.4); }

/* lyrics panel (kept; retinted) */
.qz-ly{ position:absolute; inset:0; z-index:1; padding:calc(var(--safe-t) + 58px) 22px calc(var(--safe-b) + 24px); opacity:0; pointer-events:none; transition:opacity .25s; overflow:hidden;
  background:linear-gradient(180deg, var(--qz-tint-top), var(--qz-tint-bot)), var(--qz-base); }
.qz-np--lyrics .qz-ly{ opacity:1; pointer-events:auto; }
.qz-ly__body{ position:relative; height:100%; overflow-y:auto; -webkit-overflow-scrolling:touch; text-align:left; padding:46vh 0 56vh;
  -webkit-mask-image:linear-gradient(180deg,transparent,#000 12%,#000 84%,transparent); mask-image:linear-gradient(180deg,transparent,#000 12%,#000 84%,transparent); }   /* M4 FIX: position:relative so lyCenter's offsetTop isn't inflated by .qz-ly padding-top. Field FIX: top/bottom runway (~half-screen) so line 1 (and the last line) can reach true center instead of clamping to scrollTop 0 and clipping under the top mask */
.qz-ly__body::-webkit-scrollbar{ display:none; }
.qz-ly__line{ margin:0 0 18px; font-size:24px; font-weight:700; line-height:1.3; letter-spacing:-.3px; color:var(--qz-c-dim); transition:color .2s, transform .26s cubic-bezier(.2,.72,.2,1.28); }
.qz-ly__line.is-active{ color:var(--qz-c1); }
.qz-ly__plain p{ margin:0 0 12px; font-size:17px; line-height:1.5; color:var(--qz-c2); }


/* word-by-word karaoke — active WORD line keeps unsung words dim, brightens sung ones (our renderer) */
.qz-ly__body{ text-align:left; }
.qz-ly__w{ transition:color .28s ease; }
.qz-ly__line--w.is-active{ color:var(--qz-c2); }
.qz-ly__line--w.is-active .qz-ly__w.is-sung{ color:var(--qz-c1); }

/* ---- M4: line-synced translation (rendered under each line) ---- */
.qz-ly__tr{ display:none; margin-top:5px; font-size:15px; font-weight:600; line-height:1.32; letter-spacing:-.1px; color:var(--qz-c-dim); }
.qz-ly--tr .qz-ly__tr{ display:block; }
.qz-ly--tr .qz-ly__line.is-active .qz-ly__tr{ color:var(--qz-c2); }

/* translation toggle — top-right pill; button[hidden] until the track actually has a translation */
#qz-app-root .qz-ly__tr-toggle{ position:absolute; top:calc(var(--safe-t) + 14px); right:14px; z-index:2;
  display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 12px; border-radius:16px;
  background:rgba(255,255,255,.10); border:1px solid var(--qz-hairline); color:var(--qz-c2);
  font-size:12.5px; font-weight:700; backdrop-filter:blur(18px); -webkit-backdrop-filter:blur(18px); }
.qz-ly__tr-toggle[hidden]{ display:none; }
.qz-ly__tr-toggle svg{ width:16px; height:16px; }
#qz-app-root .qz-ly__tr-toggle.is-on{ background:var(--qz-c1); color:#111; border-color:transparent; }
.qz-ly__tr-toggle:active{ opacity:.7; }

/* recenter pill — bottom-center; only while the user has scrolled away (.qz-ly.is-holding) */
#qz-app-root .qz-ly__recenter{ position:absolute; left:50%; bottom:calc(var(--safe-b) + 18px); transform:translate(-50%, 8px);
  z-index:2; display:inline-flex; align-items:center; gap:7px; height:36px; padding:0 16px; border-radius:18px;
  background:var(--qz-c1); color:#111; font-size:13px; font-weight:700;
  box-shadow:0 10px 26px -10px rgba(0,0,0,.7); opacity:0; pointer-events:none; transition:opacity .2s, transform .2s; }
.qz-ly__recenter svg{ width:16px; height:16px; }
.qz-ly.is-holding .qz-ly__recenter{ opacity:1; pointer-events:auto; transform:translate(-50%, 0); }
.qz-ly__recenter:active{ opacity:.8; }
/* keep the drag handle tappable above the lyrics panel (tap it to close lyrics, then NP) */
.qz-np__close{ position:relative; z-index:3; }
/* FULLSCREEN: no top title bar; float a back button (only shown on pushed screens) over the content,
   and let content run edge-to-edge under the status bar. */
.qz-hd{ position:absolute; top:0; left:0; z-index:6; height:auto; padding:calc(var(--safe-t) + 8px) 0 0 10px; background:none; border:none; backdrop-filter:none; -webkit-backdrop-filter:none; }
.qz-hd__title{ display:none; }
.qz-hd__back{ background:rgba(0,0,0,.34); -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px); }
.qz-content{ padding-top:calc(var(--safe-t) + 8px); }
/* more side breathing room so cards/albums don't clip at the edges */
.qz-shelf__h, .qz-shelf__row, .qz-grid, .qz-segbar{ padding-left:20px; padding-right:20px; }
.qz-searchbar{ margin-left:20px; margin-right:20px; }
.qz-shelf__row{ scroll-snap-type:none; scroll-padding-left:20px; }   /* snap was scrolling past the left padding, clipping the first card */

/* ============================ M1: QUEUE PANEL ============================ */
.qz-queue{ position:absolute; inset:0; z-index:2; display:flex; flex-direction:column;
  padding:calc(var(--safe-t) + 52px) 0 calc(var(--safe-b) + 16px);
  opacity:0; pointer-events:none; transition:opacity .25s;
  background:linear-gradient(180deg, var(--qz-tint-top), var(--qz-tint-bot)), var(--qz-base); }
.qz-np--queue .qz-queue{ opacity:1; pointer-events:auto; }
.qz-np--queue .qz-np__act--queue{ color:var(--qz-c1); }
.qz-queue__head{ font-size:19px; font-weight:700; letter-spacing:-.2px; padding:0 22px 6px; color:var(--qz-c1); flex:0 0 auto; }
.qz-queue__body{ flex:1 1 auto; overflow-y:auto; -webkit-overflow-scrolling:touch; padding:2px 14px;
  -webkit-mask-image:linear-gradient(180deg,transparent,#000 4%,#000 96%,transparent); mask-image:linear-gradient(180deg,transparent,#000 4%,#000 96%,transparent); }
.qz-queue__body::-webkit-scrollbar{ display:none; }
.qz-queue__sec{ font-size:11.5px; font-weight:700; text-transform:uppercase; letter-spacing:.6px; color:var(--qz-c3); padding:16px 8px 6px; }
.qz-queue__row{ display:flex; align-items:center; gap:12px; width:100%; text-align:left; padding:7px 8px; border-radius:12px; }
#qz-app-root .qz-queue__row:active{ background:var(--qz-fill-1); }
.qz-queue__row.is-auto{ opacity:.5; }
.qz-queue__art{ position:relative; width:46px; height:46px; flex:0 0 auto; border-radius:8px; overflow:hidden; background:var(--qz-fill-1); }
.qz-queue__meta{ flex:1 1 auto; min-width:0; }
.qz-queue__t{ display:block; font-size:14.5px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--qz-c1); }
.qz-queue__row.is-current .qz-queue__t{ color:var(--qz-brand); }
.qz-queue__s{ display:block; font-size:12.5px; color:var(--qz-c2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.qz-queue__eq{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; gap:2px; background:rgba(0,0,0,.42); }
.qz-queue__eq i{ width:3px; height:9px; background:#fff; border-radius:1px; transform-origin:center bottom; animation:qzeq .9s ease-in-out infinite; }
.qz-queue__eq i:nth-child(2){ animation-delay:.3s; } .qz-queue__eq i:nth-child(3){ animation-delay:.6s; }
@keyframes qzeq{ 0%,100%{ transform:scaleY(.4); } 50%{ transform:scaleY(1); } }
/* shuffle/repeat live state: repeat-one badge (.is-on colour already exists) */
.qz-np__rp{ position:relative; }
.qz-np__rp.is-one::after{ content:"1"; position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); font-size:9px; font-weight:800; line-height:1; color:var(--qz-brand); }
/* 6 bottom actions now instead of 3 - tighten side padding so they breathe evenly */
.qz-np__actions{ padding-left:14px; padding-right:14px; }

/* ============================ M1: ADD-TO-QUEUE / PLAY-NEXT / RADIO ============================ */
.qz-mtoast{ position:fixed; left:50%; bottom:calc(var(--nav-h,60px) + 34px); transform:translate(-50%,10px); z-index:2147483646;
  background:rgba(14,16,20,.97); color:#fff; font:600 13px/1 system-ui,sans-serif; padding:9px 18px; border-radius:22px;
  border:1px solid rgba(255,255,255,.12); box-shadow:0 12px 34px rgba(0,0,0,.55); opacity:0; pointer-events:none; transition:opacity .2s,transform .2s; }
.qz-mtoast.is-on{ opacity:1; transform:translate(-50%,0); }
.qz-trow{ position:relative; }
#qz-app-root .qz-trow__more{ flex:0 0 auto; width:34px; height:34px; display:flex; align-items:center; justify-content:center; color:var(--qz-c3); margin-left:2px; }
.qz-trow__more svg{ width:20px; height:20px; } .qz-trow__more:active{ opacity:.55; }
.qz-sheet{ position:fixed; inset:0; z-index:2147483645; display:flex; align-items:flex-end; justify-content:center;
  background:rgba(0,0,0,.5); opacity:0; transition:opacity .2s; }
.qz-sheet.is-on{ opacity:1; }
.qz-sheet__card{ width:100%; max-width:520px; margin:0 8px calc(env(safe-area-inset-bottom,0px) + 10px); padding:10px;
  background:linear-gradient(180deg,#16181d,#0d0f13); border:1px solid rgba(255,255,255,.1); border-radius:20px;
  box-shadow:0 -10px 40px rgba(0,0,0,.6); transform:translateY(14px); transition:transform .24s cubic-bezier(.22,.61,.36,1); }
.qz-sheet.is-on .qz-sheet__card{ transform:translateY(0); }
.qz-sheet__t{ font-size:13px; font-weight:700; color:rgba(255,255,255,.6); padding:8px 12px 10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.qz-sheet__it{ width:100%; display:flex; align-items:center; gap:14px; padding:14px 14px; border-radius:12px; color:#fff; font-size:15.5px; font-weight:600; text-align:left; }
.qz-sheet__it:active{ background:rgba(255,255,255,.08); }
.qz-sheet__it svg{ width:23px; height:23px; flex:0 0 auto; color:rgba(255,255,255,.7); }
.qz-sheet__cancel{ width:100%; margin-top:6px; padding:14px; border-radius:12px; color:var(--qz-brand); font-size:15.5px; font-weight:700; background:rgba(255,255,255,.05); }
.qz-np__act[data-np='radio'] svg{ width:25px; height:25px; }

/* ============================ M1: QUALITY SELECTOR ============================ */
#qz-app-root .qz-np__q{ background:var(--qz-fill-1); cursor:pointer; gap:6px; }
#qz-app-root .qz-np__q:active{ background:var(--qz-fill-2); }
.qz-np__q::after{ content:""; display:inline-block; width:0; height:0; margin-left:1px;
  border-left:4px solid transparent; border-right:4px solid transparent; border-top:5px solid var(--qz-c2); }
.qz-qm{ position:absolute; inset:0; z-index:30; display:flex; align-items:flex-end; opacity:0; transition:opacity .2s ease; }
.qz-qm.is-open{ opacity:1; }
.qz-qm__scrim{ position:absolute; inset:0; background:rgba(0,0,0,.5); }
.qz-qm__sheet{ position:relative; width:100%; padding:14px 10px calc(var(--safe-b) + 14px);
  background:linear-gradient(180deg,var(--qz-tint-mid),var(--qz-tint-bot)),var(--qz-base);
  border-top:1px solid var(--qz-hairline); border-radius:var(--qz-r-sheet) var(--qz-r-sheet) 0 0;
  box-shadow:0 -24px 60px -20px rgba(0,0,0,.85); transform:translateY(14px);
  transition:transform .24s cubic-bezier(.22,.61,.36,1); }
.qz-qm.is-open .qz-qm__sheet{ transform:none; }
.qz-qm__h{ display:flex; align-items:baseline; justify-content:space-between; gap:10px; padding:4px 12px 10px;
  font-size:12px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; color:var(--qz-c2); }
.qz-qm__now{ font-size:11.5px; font-weight:600; letter-spacing:0; text-transform:none; color:var(--qz-c3); font-variant-numeric:tabular-nums; }
#qz-app-root .qz-qm__row{ display:flex; align-items:center; gap:12px; width:100%; text-align:left;
  padding:13px 12px; border-radius:12px; color:var(--qz-c1); background:none; }
#qz-app-root .qz-qm__row:active{ background:var(--qz-fill-1); }
.qz-qm__row.is-disabled{ color:var(--qz-c-dim); }
.qz-qm__rl{ flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:2px; }
.qz-qm__rt{ font-size:15px; font-weight:600; }
.qz-qm__row.is-on .qz-qm__rt{ color:var(--qz-brand); }
.qz-qm__rs{ font-size:12.5px; color:var(--qz-c3); font-variant-numeric:tabular-nums; }
.qz-qm__row.is-disabled .qz-qm__rs::after{ content:" · not on your plan"; }
.qz-qm__rc{ flex:0 0 auto; width:20px; text-align:center; font-size:15px; color:var(--qz-brand); }
.qz-qm__note{ font-size:12px; color:var(--qz-c3); padding:12px 12px 2px; line-height:1.4; }

/* ============================ M1: SLEEP TIMER ============================ */
.qz-np__sleepbtn{ gap:5px; }
.qz-np__sleepbtn.is-on{ width:auto; min-width:34px; padding:0 9px; color:var(--qz-brand); }
.qz-np__sleeplab{ font-size:12px; font-weight:700; letter-spacing:.2px; font-variant-numeric:tabular-nums; }
.qz-np__sleepbtn:not(.is-on) .qz-np__sleeplab{ display:none; }
.qz-sleepsheet{ position:absolute; inset:0; z-index:8; }
.qz-sleepsheet__scrim{ position:absolute; inset:0; background:rgba(0,0,0,.55); opacity:0; transition:opacity .25s; }
.qz-sleepsheet.is-in .qz-sleepsheet__scrim{ opacity:1; }
.qz-sleepsheet__panel{ position:absolute; left:0; right:0; bottom:0; border-radius:var(--qz-r-sheet) var(--qz-r-sheet) 0 0;
  padding:10px 18px calc(var(--safe-b) + 22px);
  background:linear-gradient(180deg, var(--qz-tint-mid), var(--qz-tint-bot)), var(--qz-base);
  border-top:1px solid var(--qz-hairline); box-shadow:0 -18px 50px -20px rgba(0,0,0,.85);
  transform:translateY(100%); transition:transform .28s cubic-bezier(.2,.72,.2,1); }
.qz-sleepsheet.is-in .qz-sleepsheet__panel{ transform:translateY(0); }
.qz-sleepsheet__grip{ width:38px; height:4px; border-radius:2px; background:var(--qz-fill-2); margin:2px auto 14px; }
.qz-sleepsheet__h{ margin:0 2px 14px; font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:.6px; color:var(--qz-c2); }
.qz-sleepsheet__grid{ display:grid; grid-template-columns:repeat(5,1fr); gap:8px; margin-bottom:10px; }
#qz-app-root .qz-sleepopt{ display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px; height:58px; border-radius:14px;
  background:var(--qz-fill-1); color:var(--qz-c1); font-size:18px; font-weight:700; font-variant-numeric:tabular-nums; }
.qz-sleepopt span{ font-size:10px; font-weight:600; color:var(--qz-c3); letter-spacing:.4px; }
#qz-app-root .qz-sleepopt.is-on{ background:var(--qz-brand); color:#111; } .qz-sleepopt.is-on span{ color:rgba(0,0,0,.6); }
.qz-sleepopt:active{ transform:scale(.95); }
#qz-app-root .qz-sleepsheet__row{ display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%; padding:15px 16px; border-radius:14px;
  background:var(--qz-fill-1); color:var(--qz-c1); font-size:15px; font-weight:600; margin-top:8px; }
#qz-app-root .qz-sleepsheet__row:active{ background:var(--qz-fill-2); }
.qz-sleepsheet__row.is-on{ color:var(--qz-brand); }
.qz-sleepsheet__chev{ width:9px; height:9px; border-right:2px solid currentColor; border-bottom:2px solid currentColor; transform:rotate(-45deg); opacity:.55; }
.qz-sleepsheet__cancel{ color:#f2a3a3; }
.qz-sleepsheet__cancel[hidden]{ display:none; }
.qz-sleepsheet__sub{ font-size:12px; color:var(--qz-c3); font-variant-numeric:tabular-nums; }
.qz-sleeptoast{ position:absolute; left:50%; bottom:calc(var(--safe-b) + 110px); transform:translate(-50%,10px); z-index:40;
  max-width:80%; padding:11px 18px; border-radius:var(--qz-r-chip); font-size:13.5px; font-weight:600; color:#111; background:var(--qz-brand);
  box-shadow:0 14px 40px -12px rgba(0,0,0,.7); white-space:nowrap; opacity:0; pointer-events:none; transition:opacity .2s, transform .2s; }
.qz-sleeptoast.is-show{ opacity:1; transform:translate(-50%,0); }

/* ============================ M2: FAVOURITES / FOLLOW ============================ */
/* hearts are role=button SPANs (not <button>), so the #qz-app-root button{background:none} reset doesn't
   touch them; background-bearing rules are still #qz-app-root-prefixed to guarantee the fill survives. */
.qz-fav{ display:inline-flex; align-items:center; justify-content:center; color:var(--qz-c-dim); transition:color .15s, transform .1s; -webkit-tap-highlight-color:transparent; }
.qz-fav svg{ width:100%; height:100%; }
.qz-fav.is-on{ color:var(--qz-brand); }
.qz-fav:active{ transform:scale(.84); }
/* row heart: sits between meta and duration */
.qz-trow__fav{ flex:0 0 auto; width:34px; height:34px; padding:7px; margin-right:-2px; }
/* detail-header actions row: Play + fav/follow */
.qz-dhead__actions{ display:flex; align-items:center; justify-content:center; gap:14px; margin-top:18px; }
.qz-dhead__actions .qz-dhead__play{ margin-top:0; }
#qz-app-root .qz-dhead__fav{ width:46px; height:46px; padding:11px; border-radius:50%; background:var(--qz-fill-1); color:var(--qz-c1); flex:0 0 auto; }
#qz-app-root .qz-dhead__fav.is-on{ color:var(--qz-brand); background:rgba(222,164,66,.16); }
#qz-app-root .qz-dhead__fav:active{ background:var(--qz-fill-2); }

/* ============================ M2: EXPLICIT + CAPABILITY GATING ============================ */
#qz-app-root .qz-exp{ display:inline-flex; align-items:center; justify-content:center; margin-left:7px; min-width:15px; height:15px; padding:0 3px;
  border-radius:3px; font-size:9.5px; font-weight:700; line-height:1; vertical-align:middle; color:var(--qz-c2); background:var(--qz-fill-2); }
.qz-trow--off{ opacity:.42; }
.qz-trow--off .qz-trow__play{ display:none; }
.qz-card--off{ opacity:.5; }
/* Library now has 4 content tabs: let the pill row scroll rather than cram/wrap on narrow phones */
.qz-segbar{ overflow-x:auto; -webkit-overflow-scrolling:touch; scrollbar-width:none; }
.qz-segbar::-webkit-scrollbar{ display:none; }
.qz-seg{ flex:1 0 auto; min-width:76px; padding:0 12px; white-space:nowrap; }

/* ============================ M3: PLAYLIST MANAGEMENT ============================ */
/* In-#qz-app-root buttons that need a fill are #qz-app-root-prefixed (the button{background:none} reset).
   Body-level sheet UI (.qz-sheet is a SIBLING of #qz-app-root, so --qz-* vars DON'T cascade) uses literals. */

/* owner kebab on playlist detail header + Edit toggle in the actions row */
.qz-dhead{ position:relative; }
#qz-app-root .qz-dhead__more{ position:absolute; top:calc(var(--safe-t) + 4px); right:4px; width:40px; height:40px; display:flex; align-items:center; justify-content:center; border-radius:50%; color:var(--qz-c1); background:var(--qz-fill-1); }
#qz-app-root .qz-dhead__more:active{ background:var(--qz-fill-2); }
.qz-dhead__more svg{ width:22px; height:22px; }
#qz-app-root .qz-editbtn{ height:46px; padding:0 18px; border-radius:var(--qz-r-chip); background:var(--qz-fill-1); color:var(--qz-c1); font-weight:700; font-size:14px; display:inline-flex; align-items:center; gap:8px; }
#qz-app-root .qz-editbtn:active{ background:var(--qz-fill-2); }
.qz-editbtn svg{ width:18px; height:18px; }

/* "New playlist" dashed row (Library) */
#qz-app-root .qz-newpl{ display:flex; align-items:center; gap:12px; width:calc(100% - 40px); margin:2px 20px 16px; padding:14px 16px; border-radius:var(--qz-r-card); color:var(--qz-c1); font-size:15px; font-weight:600; text-align:left; background:var(--qz-fill-1); border:1px dashed var(--qz-fill-2); }
#qz-app-root .qz-newpl:active{ background:var(--qz-fill-2); }
.qz-newpl svg{ width:22px; height:22px; flex:0 0 auto; color:var(--qz-brand); }

/* playlist edit-mode rows (reorder + remove) */
.qz-plrow-e{ display:flex; align-items:center; gap:10px; padding:6px; border-radius:12px; background:transparent; }
.qz-plrow-e.is-dragging{ background:var(--qz-fill-2); box-shadow:0 10px 26px -10px rgba(0,0,0,.75); position:relative; z-index:3; }
.qz-plgrip{ flex:0 0 auto; width:34px; height:44px; display:flex; align-items:center; justify-content:center; color:var(--qz-c3); touch-action:none; cursor:grab; }
.qz-plgrip svg{ width:20px; height:20px; }
.qz-plrow-e__art{ width:42px; height:42px; flex:0 0 auto; border-radius:8px; overflow:hidden; background:var(--qz-fill-1); }
.qz-plrow-e__meta{ flex:1 1 auto; min-width:0; }
.qz-plmoves{ flex:0 0 auto; display:flex; flex-direction:column; }
.qz-plmv{ width:32px; height:22px; display:flex; align-items:center; justify-content:center; color:var(--qz-c2); }
.qz-plmv svg{ width:16px; height:16px; } .qz-plmv--down svg{ transform:rotate(180deg); }
.qz-plmv:active{ color:var(--qz-c1); }
.qz-plrm{ flex:0 0 auto; width:38px; height:38px; display:flex; align-items:center; justify-content:center; color:#f2a3a3; border-radius:50%; }
#qz-app-root .qz-plrm:active{ background:rgba(255,90,100,.14); }
.qz-plrm svg{ width:20px; height:20px; }

/* featured-browse entry banner (Home + Library) */
#qz-app-root .qz-featentry{ display:flex; align-items:center; gap:12px; width:calc(100% - 40px); margin:2px 20px 20px; padding:14px 16px; text-align:left; border-radius:var(--qz-r-art); background:var(--qz-fill-1); border:1px solid var(--qz-hairline); }
#qz-app-root .qz-featentry:active{ background:var(--qz-fill-2); }
.qz-featentry__ic{ width:38px; height:38px; flex:0 0 auto; display:flex; align-items:center; justify-content:center; border-radius:11px; background:rgba(255,255,255,.10); color:var(--qz-brand); }
.qz-featentry__ic svg{ width:22px; height:22px; }
.qz-featentry__tx{ flex:1 1 auto; min-width:0; }
.qz-featentry__t{ display:block; font-size:15px; font-weight:700; color:var(--qz-c1); }
.qz-featentry__s{ display:block; font-size:12.5px; color:var(--qz-c2); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.qz-featentry__chev{ flex:0 0 auto; width:22px; height:22px; color:var(--qz-c3); display:flex; } .qz-featentry__chev svg{ width:100%; height:100%; }

/* featured screen: header + type chips */
.qz-fh{ padding:calc(var(--safe-t) + 52px) 20px 4px; }
.qz-fh__title{ font-size:26px; font-weight:700; letter-spacing:-.5px; margin:0; color:var(--qz-c1); }
.qz-fh__sub{ font-size:13.5px; color:var(--qz-c2); margin-top:4px; }
.qz-chips{ display:flex; gap:8px; overflow-x:auto; overflow-y:hidden; -webkit-overflow-scrolling:touch; padding:16px 20px 8px; }
.qz-chips::-webkit-scrollbar{ display:none; }
#qz-app-root .qz-chip{ flex:0 0 auto; height:34px; padding:0 16px; border-radius:var(--qz-r-chip); background:var(--qz-fill-1); color:var(--qz-c2); font-size:13.5px; font-weight:600; white-space:nowrap; }
#qz-app-root .qz-chip.is-on{ background:var(--qz-c1); color:#111; }
.qz-chip:active{ transform:scale(.96); }
.qz-fbody{ min-height:40px; }

/* --- body-level sheets (siblings of #qz-app-root -> literals, no --qz-* vars) --- */
.qz-sheet__it--danger{ color:#f2736f; } .qz-sheet__it--danger svg{ color:#f2736f; }
/* add-to-playlist picker */
.qz-pllist{ max-height:46vh; overflow-y:auto; -webkit-overflow-scrolling:touch; margin:2px 0 4px; }
.qz-plrow{ width:100%; display:flex; align-items:center; gap:12px; padding:10px 12px; border-radius:12px; text-align:left; color:#fff; }
.qz-plrow:active{ background:rgba(255,255,255,.08); }
.qz-plrow.is-busy{ opacity:.5; pointer-events:none; }
.qz-plrow.is-dup .qz-plrow__c{ color:#dea442; }
.qz-plrow__ic{ width:40px; height:40px; flex:0 0 auto; border-radius:8px; background:rgba(255,255,255,.08); display:flex; align-items:center; justify-content:center; color:rgba(255,255,255,.7); }
.qz-plrow__ic svg{ width:20px; height:20px; }
.qz-plrow__meta{ flex:1 1 auto; min-width:0; }
.qz-plrow__n{ display:block; font-size:15px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.qz-plrow__c{ display:block; font-size:12px; color:rgba(255,255,255,.5); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.qz-plrow__go{ flex:0 0 auto; width:22px; height:22px; color:rgba(255,255,255,.7); } .qz-plrow__go svg{ width:100%; height:100%; }
.qz-plnew{ color:#dea442; } .qz-plnew svg{ color:#dea442; }
.qz-plempty{ color:rgba(255,255,255,.5); font-size:13px; text-align:center; padding:22px 12px; }
.qz-plcreate{ display:flex; gap:8px; padding:6px 6px 8px; }
.qz-plcreate__in{ flex:1 1 auto; min-width:0; height:44px; border-radius:12px; background:rgba(255,255,255,.08); color:#fff; padding:0 14px; font-size:15px; outline:none; border:1px solid transparent; }
.qz-plcreate__in:focus{ background:rgba(255,255,255,.14); border-color:rgba(255,255,255,.08); }
.qz-plcreate__go{ flex:0 0 auto; height:44px; padding:0 18px; border-radius:12px; background:#fff; color:#111; font-weight:700; font-size:14px; }
.qz-plcreate__go:disabled{ opacity:.55; }
/* create/edit form sheet */
.qz-pf{ padding:16px 16px calc(env(safe-area-inset-bottom,0px) + 14px); }
.qz-pf__h{ font-size:18px; font-weight:700; color:#fff; padding:2px 2px 14px; }
.qz-pf__in, .qz-pf__ta{ width:100%; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.08); border-radius:14px; color:#fff; font:inherit; font-size:15px; padding:12px 14px; margin-bottom:10px; }
.qz-pf__in::placeholder, .qz-pf__ta::placeholder{ color:rgba(255,255,255,.5); }
.qz-pf__in:focus, .qz-pf__ta:focus{ outline:none; border-color:#dea442; }
.qz-pf__in.is-err{ border-color:#f2736f; }
.qz-pf__ta{ resize:none; line-height:1.4; }
.qz-pf__tog{ display:flex; align-items:center; gap:12px; width:100%; text-align:left; padding:12px; border-radius:14px; background:rgba(255,255,255,.08); margin-bottom:10px; }
.qz-pf__togl{ flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:2px; }
.qz-pf__togt{ font-size:15px; font-weight:600; color:#fff; }
.qz-pf__togs{ font-size:12.5px; color:rgba(255,255,255,.5); }
.qz-pf__sw{ flex:0 0 auto; width:44px; height:26px; border-radius:999px; background:rgba(255,255,255,.14); position:relative; transition:background .18s; }
.qz-pf__sw::after{ content:""; position:absolute; top:3px; left:3px; width:20px; height:20px; border-radius:50%; background:#fff; transition:transform .18s; }
.qz-pf__tog.is-on .qz-pf__sw{ background:#dea442; }
.qz-pf__tog.is-on .qz-pf__sw::after{ transform:translateX(18px); }
.qz-pf__row{ display:flex; gap:10px; margin-top:6px; }
.qz-pf__btn{ flex:1 1 0; padding:14px; border-radius:999px; font-size:15px; font-weight:700; text-align:center; }
.qz-pf__btn--ghost{ background:rgba(255,255,255,.08); color:#fff; }
.qz-pf__btn--ghost:active{ background:rgba(255,255,255,.14); }
.qz-pf__btn--go{ background:#dea442; color:#111; }
.qz-pf__btn--go:active{ transform:scale(.98); }
.qz-pf__btn--go:disabled{ opacity:.6; }

/* ============================ SETTINGS (mobile) ============================ */
/* Own prefix qz-stg-* — the Qobuzify RUNTIME base theme owns qz-set-*, so never reuse that. In-root buttons
   that need a fill are #qz-app-root-prefixed (the button{background:none} reset). Accent = electric-blue
   literals (#3DA8FE): the mobile --qz-brand token is Qobuz-gold, but Settings is the Qobuzify surface. */
.qz-stg-top{ display:flex; align-items:center; justify-content:space-between; padding:calc(var(--safe-t) + 6px) 4px 10px; }
.qz-stg-toph{ font-size:22px; font-weight:700; letter-spacing:-.3px; margin:0; color:var(--qz-c1); }
#qz-app-root .qz-stg-gear{ flex:0 0 auto; width:40px; height:40px; display:flex; align-items:center; justify-content:center; border-radius:50%; color:var(--qz-c1); background:var(--qz-fill-1); }
#qz-app-root .qz-stg-gear:active{ background:var(--qz-fill-2); }
.qz-stg-gear svg{ width:22px; height:22px; }

.qz-stg{ padding:calc(var(--safe-t) + 56px) 16px 8px; }
.qz-stg-hd{ font-size:26px; font-weight:700; letter-spacing:-.5px; margin:0 4px 18px; color:var(--qz-c1); }

/* account header card (read-only) */
.qz-stg-acct{ display:flex; align-items:center; gap:14px; padding:16px; border-radius:var(--qz-r-art); background:var(--qz-fill-1); border:1px solid var(--qz-hairline); margin-bottom:24px; }
.qz-stg-ava{ width:52px; height:52px; flex:0 0 auto; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:22px; font-weight:700; color:#fff; background:linear-gradient(140deg,#3DA8FE,#1c6fd0); }
.qz-stg-acctx{ flex:1 1 auto; min-width:0; }
.qz-stg-acctn{ font-size:17px; font-weight:700; color:var(--qz-c1); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.qz-stg-accte{ font-size:13px; color:var(--qz-c2); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.qz-stg-plan{ flex:0 0 auto; align-self:flex-start; font-size:10.5px; font-weight:700; letter-spacing:.4px; text-transform:uppercase; color:#3DA8FE; background:rgba(61,168,254,.14); border:1px solid rgba(61,168,254,.32); padding:4px 9px; border-radius:999px; white-space:nowrap; }

/* grouped sections + rows */
.qz-stg-sec{ margin-bottom:22px; }
.qz-stg-sech{ font-size:12px; font-weight:700; letter-spacing:.7px; text-transform:uppercase; color:var(--qz-c2); padding:0 4px 8px; }
.qz-stg-note{ font-size:11.5px; color:var(--qz-c3); padding:8px 6px 2px; line-height:1.4; }
#qz-app-root .qz-stg-row{ display:flex; align-items:center; gap:12px; width:100%; text-align:left; padding:15px 16px; border-radius:var(--qz-r-card); background:var(--qz-fill-1); color:var(--qz-c1); margin-bottom:3px; }
#qz-app-root .qz-stg-row:active{ background:var(--qz-fill-2); }
#qz-app-root .qz-stg-row--static, #qz-app-root .qz-stg-row--static:active{ background:var(--qz-fill-1); }
.qz-stg-rl{ flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:3px; }
.qz-stg-rt{ font-size:15px; font-weight:600; color:var(--qz-c1); }
.qz-stg-rs{ font-size:12.5px; color:var(--qz-c2); line-height:1.4; }
.qz-stg-rv{ flex:0 1 auto; font-size:13.5px; color:var(--qz-c2); font-variant-numeric:tabular-nums; text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.qz-stg-chev{ flex:0 0 auto; width:8px; height:8px; margin-left:1px; border-right:2px solid var(--qz-c3); border-bottom:2px solid var(--qz-c3); transform:rotate(-45deg); }
#qz-app-root .qz-stg-row--danger{ justify-content:center; background:rgba(242,115,111,.12); }
#qz-app-root .qz-stg-row--danger:active{ background:rgba(242,115,111,.2); }
.qz-stg-row--danger .qz-stg-rl{ flex:0 0 auto; align-items:center; }
.qz-stg-row--danger .qz-stg-rt{ color:#f2736f; }

.qz-stg-foot{ text-align:center; font-size:12px; color:var(--qz-c3); padding:14px 0 6px; }

/* quality-picker rows inside the shared body-level .qz-sheet (siblings of #qz-app-root -> literals only) */
.qz-stg-qrow{ justify-content:space-between; }
.qz-stg-qrl{ flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:2px; }
.qz-stg-qt{ font-size:15px; font-weight:600; color:#fff; }
.qz-stg-qs{ font-size:12.5px; color:rgba(255,255,255,.5); }
.qz-stg-qrow.is-on .qz-stg-qt{ color:#3DA8FE; }
.qz-stg-qrow[disabled]{ opacity:.4; }
.qz-stg-qc{ flex:0 0 auto; width:20px; text-align:center; color:#3DA8FE; }

/* Appearance: theme row trailing swatch/name + feature toggles (reuse the .qz-pf__sw switch knob). The
   toggle on-state uses --qz-brand, which follows the active theme accent. */
.qz-stg-tval{ flex:0 1 auto; min-width:0; display:flex; align-items:center; gap:8px; overflow:hidden; }
.qz-stg-swatch{ flex:0 0 auto; width:16px; height:16px; border-radius:50%; box-shadow:inset 0 0 0 1px rgba(255,255,255,.22); }
.qz-stg-tval .qz-stg-rv{ max-width:130px; }
.qz-stg-tog.is-on .qz-pf__sw{ background:var(--qz-brand); }
.qz-stg-tog.is-on .qz-pf__sw::after{ transform:translateX(18px); }
/* theme picker rows inside the shared body-level .qz-sheet (siblings of #qz-app-root -> literals only) */
.qz-stg-throw .qz-stg-swatch{ width:18px; height:18px; }
.qz-stg-thn{ flex:1 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.qz-stg-throw.is-on .qz-stg-thn{ color:#3DA8FE; }
.qz-stg-thc{ flex:0 0 auto; width:20px; text-align:center; color:#3DA8FE; }
`;

// ------------------------------------------------------------------ lifecycle
function isNarrow() { try { return (window.innerWidth || document.documentElement.clientWidth || 0) <= MOBILE_MAX; } catch (e) { return false; } }
function appReady() { return !!document.querySelector('[class*="grid-layout--"]') && !!document.body; }
function want() { return isNarrow() && appReady(); }

function mount() {
  if (mounted) return;
  mounted = true;
  document.documentElement.classList.add(APP_CLASS);
  Q.css(CSS_ID, CSS);
  if (!document.getElementById(ROOT_ID)) document.body.appendChild(buildShell());
  setTab(curTab);
  applyFeatureFlags();          // hide any player-feature buttons the user turned off (Settings > Features)
  renderTrack(); renderTransport(true);
  loadFavIds().then(repaintFavAll);          // seed already-favourited ids, then fill hearts rendered hollow
  loadPlaylistSubs().then(repaintFavAll);    // + subscribed-playlist state (also seeds cachedMe for owner checks)
  // onChange fires on track change; the 500ms poll owns progress + play/pause-state (no store-wide subscribe,
  // which would fire hundreds of times a second during playback).
  if (!offPlay) offPlay = Q.player.onChange(function () { renderTrack(); renderTransport(true); });
  if (!poll) poll = setInterval(tickProgress, 250);   // 250ms keeps the word-by-word karaoke tight
}
function unmount() {
  if (!mounted) return;
  mounted = false;
  document.documentElement.classList.remove(APP_CLASS);
  document.documentElement.classList.remove("qz-has-track");
  var r = document.getElementById(ROOT_ID); if (r) r.remove();
  var s = document.getElementById(CSS_ID); if (s) s.remove();
  if (offPlay) { offPlay(); offPlay = null; }
  if (poll) { clearInterval(poll); poll = null; }
  sleepTimer.cancel();                 // clear any armed timer/interval so a resize-to-desktop doesn't leak it
  closeQMenu(); if (typeof closeSheet === "function") closeSheet();   // tear down quality menu + track sheet
  lyState.open = false; lyState.id = null; lyState.hasTr = false; lyState.selfScrollUntil = 0; seeking = false; qState.open = false;
  discoverRailCache = {};   // M4 FIX: drop the Discover rail cache so a remount re-fetches (transient empties don't persist across sessions)
  stack = []; root = headerEl = contentEl = miniEl = navEl = npEl = lyBody = qBody = null;
}
function evaluate() {
  if (want()) { mount(); if (mounted && !document.getElementById(ROOT_ID)) { document.body.appendChild(buildShell()); setTab(curTab); } }
  else unmount();
}

function onResize() { clearTimeout(rzT); rzT = setTimeout(evaluate, 150); }
window.addEventListener("resize", onResize);
obs = Q.observe(function () { evaluate(); }, { debounce: 350 });
evaluate();

return function cleanup() {
  window.removeEventListener("resize", onResize);
  clearTimeout(rzT);
  if (obs) { obs(); obs = null; }
  unmount();
};
