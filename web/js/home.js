import { ASSETS, batch, priceCall, parsePrice, usdToUnits, encodeCalculate, periodSeconds, words, usd6, usd8, clock, freezeText } from "./chain.js";

const ROWS = [["BTC", 7], ["BTC", 14], ["ETH", 60], ["ETH", 90]];
const $ = (s) => document.querySelector(s);

async function load() {
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
    const fees = await batch(ROWS.map(([a, d]) => ({ to: ASSETS[a].strategy, data: encodeCalculate(amounts[a], periodSeconds(d)) })));

    freezeText($("#hero-price"), usd8(prices.BTC.price).replace(/\.\d\d$/, ""));
    $("#hero-meta").textContent = "BTC price on Arbitrum, read at " + clock();

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
    $("#hero-meta").textContent = "Could not read the live price.";
    $("#hero-price").textContent = "no data";
  } finally {
    out.removeAttribute("aria-busy");
  }
}
$("#retry").addEventListener("click", load);
load();
