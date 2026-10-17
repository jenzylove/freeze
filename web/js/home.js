import { ASSETS, batch, priceCall, parsePrice, usdToUnits, encodeCalculate, periodSeconds, words, int256, word, usd6, usd8, clock } from "./chain.js";

const $ = (s) => document.querySelector(s);
const ROWS = [["BTC", 7], ["BTC", 14], ["ETH", 60], ["ETH", 90]];
const REDUCE = matchMedia("(prefers-reduced-motion: reduce)").matches;
const NS = "http://www.w3.org/2000/svg";
const GET_ROUND = "0x9a6fc8f5"; // getRoundData(uint80)
const ROUNDS = 144; // about the last day of BTC price updates
let liveFee20 = null; // USDC 6 decimals, fee to freeze $20 of BTC for 7 days (chart label)
const VS_USD = 500; // the slider example: the largest freeze the plugin allows
let liveFeeVs = null; // fee to freeze VS_USD of BTC for 7 days

/* ---------- hero chart: real Chainlink rounds, then a line frozen at today's price ---------- */
function el(name, attrs, parent) {
  const n = document.createElementNS(NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

async function history() {
  const [latest] = await batch([priceCall("BTC")]);
  if (!latest.ok) throw new Error("Price feed read failed.");
  const w = words(latest.result);
  const id = w[0];
  const points = [{ t: Number(w[3]), p: int256(w[1]) }];
  const ids = [];
  for (let k = 1n; k <= BigInt(ROUNDS); k++) ids.push(id - k);
  for (let i = 0; i < ids.length; i += 48) {
    const res = await batch(ids.slice(i, i + 48).map((r) => ({ to: ASSETS.BTC.feed, data: GET_ROUND + word(r) })));
    for (const r of res) {
      if (!r.ok) continue;
      const x = words(r.result);
      const p = int256(x[1]);
      if (p > 0n && Number(x[3]) > 0) points.push({ t: Number(x[3]), p });
    }
  }
  points.sort((a, b) => a.t - b.t);
  if (points.length < 8) throw new Error("Too few price updates came back to draw a chart.");
  return points;
}

function drawChart(points, fee20) {
  const svg = $("#chart");
  svg.innerHTML = "";
  const narrow = svg.getBoundingClientRect().width < 640;
  const W = 1000, H = narrow ? 760 : 440, top = narrow ? 150 : 70, bottom = narrow ? 660 : 380, pastW = narrow ? 520 : 640, left = 0;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.classList.toggle("narrow", narrow);
  const now = points[points.length - 1];
  const nowP = Number(now.p) / 1e8;
  const ps = points.map((x) => Number(x.p) / 1e8);
  let lo = Math.min(...ps), hi = Math.max(...ps);
  const pad = Math.max((hi - lo) * 0.35, nowP * 0.004);
  lo -= pad; hi += pad;
  const t0 = points[0].t, t1 = now.t;
  const X = (t) => left + ((t - t0) / Math.max(1, t1 - t0)) * pastW;
  const Y = (p) => bottom - ((p - lo) / (hi - lo)) * (bottom - top);

  const defs = el("defs", {}, svg);
  const g1 = el("linearGradient", { id: "pastFill", x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el("stop", { offset: "0%", style: "stop-color:var(--ink);stop-opacity:.08" }, g1);
  el("stop", { offset: "100%", style: "stop-color:var(--ink);stop-opacity:0" }, g1);
  const g2 = el("linearGradient", { id: "upFill", x1: 0, y1: 1, x2: 0, y2: 0 }, defs);
  el("stop", { offset: "0%", style: "stop-color:var(--ice);stop-opacity:.3" }, g2);
  el("stop", { offset: "100%", style: "stop-color:var(--ice);stop-opacity:.02" }, g2);

  const grid = el("g", { class: "grid" }, svg);
  for (let i = 0; i <= 3; i++) el("line", { x1: 0, x2: W, y1: top + (i * (bottom - top)) / 3, y2: top + (i * (bottom - top)) / 3 }, grid);

  const nx = X(now.t), ny = Y(nowP);
  // future zones: above the frozen price is yours, below costs only the fee
  const up = el("rect", { class: "zone-up", x: nx, y: top - 40, width: W - nx, height: ny - (top - 40) }, svg);
  const down = el("rect", { class: "zone-down", x: nx, y: ny, width: W - nx, height: bottom + 20 - ny }, svg);
  el("line", { class: "divider", x1: nx, x2: nx, y1: top - 40, y2: bottom + 20 }, svg);

  const d = points.map((x, i) => (i ? "L" : "M") + X(x.t).toFixed(1) + " " + Y(Number(x.p) / 1e8).toFixed(1)).join(" ");
  el("path", { class: "past-fill", d: d + ` L${nx.toFixed(1)} ${bottom + 20} L${X(t0)} ${bottom + 20} Z` }, svg);
  const line = el("path", { class: "past", d }, svg);

  const freeze = el("line", { class: "freeze", x1: nx, x2: W, y1: ny, y2: ny }, svg);
  const ring = el("circle", { class: "now-ring", cx: nx, cy: ny, r: 7 }, svg);
  el("circle", { class: "now-dot", cx: nx, cy: ny, r: 6 }, svg);

  const labels = el("g", {}, svg);
  const lx = nx + 22;
  const upT = el("text", { class: "zlabel", x: lx, y: Math.max(top - 6, ny - (narrow ? 80 : 52)) }, labels);
  upT.textContent = narrow ? "Up: the gain is yours" : "Price goes up: the gain is yours";
  const dnT = el("text", { class: "zlabel soft", x: lx, y: Math.min(bottom + 4, ny + (narrow ? 100 : 62)) }, labels);
  const dnLines = narrow
    ? ["Down: you lose the fee", fee20 != null ? `${usd6(fee20)} on a $20 freeze` : ""]
    : ["Price goes down: you lose only the fee", fee20 != null ? `${usd6(fee20)} today on a $20, 7 day freeze` : ""];
  dnLines.forEach((t, i) => { if (!t) return; const ts = el("tspan", { x: lx, dy: i ? "1.4em" : 0 }, dnT); ts.textContent = t; if (i) ts.setAttribute("class", "mono-ish"); });
  const fz = el("text", { class: "axis", x: W - 4, y: ny - 10, "text-anchor": "end" }, labels);
  fz.textContent = "frozen at " + usd8(now.p).replace(/\.\d\d$/, "");

  const hrs = Math.round((t1 - t0) / 3600);
  const a1 = el("text", { class: "axis", x: 0, y: H - 8 }, svg);
  a1.textContent = hrs + "h ago";
  const a2 = el("text", { class: "axis", x: nx, y: H - 8, "text-anchor": "middle" }, svg);
  a2.textContent = "now";
  const a3 = el("text", { class: "axis", x: W, y: H - 8, "text-anchor": "end" }, svg);
  a3.textContent = narrow ? "7 days" : "next 7 days";

  if (REDUCE) return;
  const len = line.getTotalLength();
  line.style.strokeDasharray = len;
  line.style.strokeDashoffset = len;
  const t0line = performance.now();
  const draw = (t) => {
    const k = Math.min(1, (t - t0line) / 1800);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    line.style.strokeDashoffset = len * (1 - e);
    if (k < 1) requestAnimationFrame(draw);
    else line.style.strokeDasharray = "none";
  };
  requestAnimationFrame(draw);
  const fl = W - nx;
  freeze.setAttribute("x2", nx);
  setTimeout(() => {
    const start = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - start) / 900);
      const e = 1 - Math.pow(1 - k, 3);
      freeze.setAttribute("x2", nx + fl * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, 1700);
  for (const [n, delay] of [[up, 2300], [down, 2300], [labels, 2600], [ring, 1800]]) {
    n.style.opacity = 0;
    n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, delay, fill: "forwards" });
  }
}

/* The live price counts up to the real value, then turns ice blue: frozen. */
function countTo(node, target) {
  const text = usd8(target).replace(/\.\d\d$/, "");
  if (REDUCE) { node.textContent = text; node.classList.add("is-frozen"); return; }
  const goal = Number(target) / 1e8;
  const from = goal * 0.985;
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / 1700);
    const e = 1 - Math.pow(1 - k, 4);
    node.textContent = "$" + Math.round(from + (goal - from) * e).toLocaleString("en-US");
    if (k < 1) requestAnimationFrame(step);
    else { node.textContent = text; setTimeout(() => node.classList.add("is-frozen"), 300); }
  };
  requestAnimationFrame(step);
}

async function loadChart() {
  $("#chart-fail").hidden = true;
  try {
    const pts = await history();
    const last = pts[pts.length - 1];
    countTo($("#hero-price"), last.p);
    drawChart(pts, liveFee20);
    $("#hero-meta").textContent = `BTC on Arbitrum, ${pts.length} price updates, read at ${clock()}.`;
  } catch (x) {
    $("#chart").innerHTML = "";
    $("#chart-fail").hidden = false;
    $("#chart-fail-text").textContent = x.message;
    $("#hero-price").textContent = "no data";
    $("#hero-meta").textContent = "";
  }
}

/* ---------- live fees, plus the $20 BTC fee used by the chart and the slider ---------- */
async function loadFees() {
  const out = $("#fees");
  const err = $("#fees-error");
  const status = $("#fees-status");
  err.hidden = true;
  out.setAttribute("aria-busy", "true");
  status.textContent = "Reading Arbitrum...";
  try {
    const [b, e] = (await batch([priceCall("BTC"), priceCall("ETH")])).map(parsePrice);
    const prices = { BTC: b, ETH: e };
    const amounts = {};
    for (const a of ["BTC", "ETH"]) amounts[a] = usdToUnits(100, prices[a].price, ASSETS[a].decimals);
    const calls = ROWS.map(([a, d]) => ({ to: ASSETS[a].strategy, data: encodeCalculate(amounts[a], periodSeconds(d)) }));
    calls.push({ to: ASSETS.BTC.strategy, data: encodeCalculate(usdToUnits(20, b.price, 8), periodSeconds(7)) });
    calls.push({ to: ASSETS.BTC.strategy, data: encodeCalculate(usdToUnits(VS_USD, b.price, 8), periodSeconds(7)) });
    const fees = await batch(calls);
    const fVs = fees.pop();
    if (fVs.ok) { try { liveFeeVs = words(fVs.result)[1]; } catch (x) { liveFeeVs = null; } }
    const f20 = fees.pop();
    if (f20.ok) { try { liveFee20 = words(f20.result)[1]; } catch (x) { liveFee20 = null; } }

    out.innerHTML = "";
    out.classList.remove("skeleton");
    for (const a of ["BTC", "ETH"]) {
      const g = document.createElement("div");
      g.className = "fee-group";
      const head = document.createElement("div");
      head.className = "fee-head";
      const h = document.createElement("h3");
      h.textContent = a;
      const p = document.createElement("p");
      p.textContent = usd8(prices[a].price) + " today";
      head.append(h, p);
      g.appendChild(head);
      ROWS.forEach(([ra, d], i) => {
        if (ra !== a) return;
        const r = fees[i];
        const row = document.createElement("div");
        row.className = "fee-row";
        const left = document.createElement("span");
        left.textContent = d + " days";
        const right = document.createElement("strong");
        if (r.ok) {
          try { right.textContent = usd6(words(r.result)[1]); } catch (x) { right.textContent = "unreadable"; right.className = "bad"; }
        } else { right.textContent = "not available now"; right.className = "bad"; }
        row.append(left, right);
        g.appendChild(row);
      });
      out.appendChild(g);
    }
    status.textContent = "Live from Arbitrum at " + clock() + ". Each fee is the cost to freeze $100 of that coin.";
  } catch (x) {
    out.innerHTML = "";
    err.hidden = false;
    $("#fees-error-text").textContent = x.message;
    status.textContent = "";
  } finally {
    out.removeAttribute("aria-busy");
    renderVersus();
  }
}

/* ---------- spot vs freeze slider ---------- */
const money = (v) => (v < 0 ? "-$" : "+$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function setBar(bar, v, max) {
  const w = Math.min(50, (Math.abs(v) / max) * 50);
  bar.style.left = (v >= 0 ? 50 : 50 - w) + "%";
  bar.style.width = w + "%";
  bar.className = "bar " + (v >= 0 ? "up" : "down");
}
function renderVersus() {
  const pct = Number($("#vs-range").value);
  $("#vs-move").textContent = (pct > 0 ? "+" : "") + pct + "%";
  const spot = VS_USD * (pct / 100);
  $("#vs-spot").textContent = money(spot);
  $("#vs-spot").className = "res " + (spot >= 0 ? "up" : "down");
  setBar($("#vs-spot-bar"), spot, VS_USD * 0.2);
  if (liveFeeVs == null) {
    $("#vs-freeze").textContent = "no live fee";
    $("#vs-need").textContent = "Couldn't read today's fee from Arbitrum, so no number is shown.";
    $("#vs-freeze-bar").style.width = 0;
    return;
  }
  const fee = Number(liveFeeVs) / 1e6;
  const fz = Math.max(0, spot) - fee;
  $("#vs-freeze").textContent = money(fz);
  $("#vs-freeze").className = "res " + (fz >= 0 ? "up" : "down");
  setBar($("#vs-freeze-bar"), fz, VS_USD * 0.2);
  $("#vs-need").textContent = "Needs only " + usd6(liveFeeVs) + " today";
}
$("#vs-range").addEventListener("input", renderVersus);

/* ---------- chat replay plays once when it scrolls into view ---------- */
function playChat() {
  const steps = [...document.querySelectorAll("#chat .step")];
  if (REDUCE) { steps.forEach((s) => s.classList.add("in")); return; }
  let i = 0;
  const next = () => {
    if (i >= steps.length) return;
    const s = steps[i++];
    const agentish = s.classList.contains("agent") || s.classList.contains("approve") || s.classList.contains("mini-card");
    if (agentish) {
      const t = document.createElement("div");
      t.className = "typing";
      t.innerHTML = "<i></i><i></i><i></i>";
      s.before(t);
      setTimeout(() => { t.remove(); s.classList.add("in"); setTimeout(next, 650); }, 900);
    } else { s.classList.add("in"); setTimeout(next, 650); }
  };
  next();
}

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add("in");
    if (e.target.id === "chat") playChat();
    io.unobserve(e.target);
  }
}, { threshold: 0.25 });
document.querySelectorAll(".reveal").forEach((n) => io.observe(n));

$("#retry").addEventListener("click", loadFees);
$("#chart-retry").addEventListener("click", loadChart);
loadFees().then(loadChart);
