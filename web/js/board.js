// Every freeze: the board the keeper publishes (web/board.json), plus live worth for open cards.
import { RPC, ASSETS, SEL, words, int256 } from "./chain.js";

const SOURCES = [
  "https://raw.githubusercontent.com/jenzylove/freeze/main/web/board.json",
  "board.json",
];
const $ = (id) => document.getElementById(id);
const money = (v) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = (v) => "$" + Math.round(v).toLocaleString("en-US");
const short = (a) => a.slice(0, 6) + "..." + a.slice(-4);
const day = (s) => new Date(s * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function until(s) {
  const left = s - Date.now() / 1000;
  if (left <= 0) return "ended " + day(s);
  const h = left / 3600;
  if (h < 1) return "in " + Math.max(1, Math.round(left / 60)) + " min";
  if (h < 48) return "in " + Math.round(h) + " hours";
  return "in " + Math.round(h / 24) + " days";
}

function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 2) return "just now";
  if (m < 120) return m + " minutes ago";
  const h = Math.round(m / 60);
  return h < 48 ? h + " hours ago" : Math.round(h / 24) + " days ago";
}

async function loadBoard() {
  for (const url of SOURCES) {
    try {
      const r = await fetch(url + "?t=" + Date.now(), { cache: "no-store" });
      if (r.ok) return await r.json();
    } catch {}
  }
  throw new Error("board unavailable");
}

async function prices() {
  const body = Object.entries(ASSETS).map(([, a], i) => ({ jsonrpc: "2.0", id: i, method: "eth_call", params: [{ to: a.feed, data: SEL.latestRoundData }, "latest"] }));
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const res = await r.json();
  const out = {};
  Object.keys(ASSETS).forEach((k, i) => {
    const x = res.find((y) => y.id === i);
    if (x?.result) out[k] = Number(int256(words(x.result)[1])) / 1e8;
  });
  return out;
}

function outcome(c, px) {
  if (c.status === "cashed") {
    const by = c.paidBy === "auto cash" ? "by auto cash" : "by its owner";
    const link = c.paidTx ? ` <a href="https://arbiscan.io/tx/${esc(c.paidTx)}" target="_blank" rel="noopener">${by}</a>` : ` ${by}`;
    return `<span class="out win">Paid <b>${money(c.paid ?? 0)}</b>${link}</span>`;
  }
  if (c.status === "ended") return `<span class="out lost">Expired. Lost the ${money(c.fee)} fee.</span>`;
  const p = px[c.asset];
  const worth = p ? Math.max(0, (p - c.frozenPrice) * c.amount) : c.worthNow ?? 0;
  const chip = c.autoCash ? '<span class="chip">Auto cash on</span>' : "";
  return `<span class="out${worth > 0 ? " win" : ""}">Worth <b>${money(worth)}</b> now${chip}</span>`;
}

function render(board, px) {
  const t = board.totals;
  $("s-freezes").textContent = t.freezes;
  $("s-people").textContent = t.people;
  $("s-paid").textContent = t.paidOut >= 100 ? whole(t.paidOut) : money(t.paidOut);
  $("s-auto").textContent = board.cards.filter((c) => c.autoCash).length;

  const rows = $("rows");
  rows.querySelectorAll(".row:not(.head), .empty").forEach((n) => n.remove());
  if (!board.cards.length) {
    rows.insertAdjacentHTML("beforeend", '<li class="empty">No freezes yet. The first one will show up here.</li>');
  }
  for (const c of board.cards) {
    const size = c.amount * c.frozenPrice;
    rows.insertAdjacentHTML(
      "beforeend",
      `<li class="row">
        <a class="cardno" href="card.html?id=${esc(c.card)}">#${esc(c.card)}</a>
        <span class="what">${whole(size)} of ${esc(c.asset)}<small>by <a href="https://arbiscan.io/address/${esc(c.buyer)}" target="_blank" rel="noopener">${short(c.buyer)}</a> on <a href="https://arbiscan.io/tx/${esc(c.buyTx)}" target="_blank" rel="noopener">${day(c.opened)}</a>, fee ${money(c.fee)}</small></span>
        <span class="cell"><span class="k">Frozen at</span>${money(c.frozenPrice)}</span>
        <span class="cell"><span class="k">Ends</span>${until(c.ends)}</span>
        ${outcome(c, px)}
      </li>`,
    );
  }
  $("updated").textContent = "Updated " + ago(board.updated) + ". Worth now uses the live Chainlink price on Arbitrum.";
}

(async () => {
  let board;
  try {
    board = await loadBoard();
  } catch {
    $("state").textContent = "Couldn't load the board right now. Try again in a minute.";
    return;
  }
  render(board, {});
  try {
    render(board, await prices());
  } catch {}
})();
